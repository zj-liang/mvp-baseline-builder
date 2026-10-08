import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { z } from 'zod';
import { analysisSchema, confirmationText, draftSchema, gateKeys, ready, verificationProblem,
  conceptAnalysisSchema, conceptDefinitionSchema, conceptReady, decisionBatchSchema, proposalConfirmationText, additionAnalysisSchema, evolutionConfirmationText, sameVerification, integrationAnalysisSchema, questionGates, questionMergeSchema, undecidedAnswer } from '../shared/domain.js';
import type { Analysis, Baseline, Draft, Project, ProjectSummary, Review, ConceptIntake, ConceptQuestion, DecisionOption, ReviewIssue, ReviewField } from '../shared/domain.js';
import { AppError, ModelValidationError } from './errors.js';
import { QuestionLedger, unsureOptions } from './questions.js';
import { validateQuantitative } from './evidence.js';
import type { FeatureAddition, BaselineVersion } from '../shared/domain.js';
import { editableFields } from './addition-review.js';
type StoredAddition = FeatureAddition & { originalDraft: Draft; conversationIds: string[]; questionIds: string[]; startRevision: number };

export class Store {
  readonly db: DatabaseSync;
  readonly ledger: QuestionLedger;
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS drafts(project_id TEXT PRIMARY KEY REFERENCES projects(id), revision INTEGER NOT NULL, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS conversations(id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), role TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS reviews(project_id TEXT PRIMARY KEY REFERENCES projects(id), revision INTEGER NOT NULL, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS proposals(id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), revision INTEGER NOT NULL, p0_ids TEXT NOT NULL, rule TEXT NOT NULL, accepted_at TEXT);
      CREATE TABLE IF NOT EXISTS baselines(project_id TEXT PRIMARY KEY REFERENCES projects(id), revision INTEGER NOT NULL, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS intakes(project_id TEXT PRIMARY KEY REFERENCES projects(id), revision INTEGER NOT NULL, payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS decision_holds(project_id TEXT NOT NULL REFERENCES projects(id), issue_id TEXT NOT NULL, stage TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(project_id,issue_id));
      CREATE TRIGGER IF NOT EXISTS immutable_baseline_update BEFORE UPDATE ON baselines BEGIN SELECT RAISE(ABORT, 'Baseline v1 is immutable'); END;
      CREATE TRIGGER IF NOT EXISTS immutable_baseline_delete BEFORE DELETE ON baselines BEGIN SELECT RAISE(ABORT, 'Baseline v1 is immutable'); END;
    `);
    this.ledger = new QuestionLedger(this.db);
    this.db.exec('CREATE TABLE IF NOT EXISTS app_migrations(version TEXT PRIMARY KEY); CREATE TABLE IF NOT EXISTS verification_sources(project_id TEXT NOT NULL, p0_id TEXT NOT NULL, revision INTEGER NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(project_id,p0_id));');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS baseline_versions(project_id TEXT NOT NULL REFERENCES projects(id), version INTEGER NOT NULL CHECK(version>1), revision INTEGER NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(project_id,version), UNIQUE(project_id,revision));
      CREATE TABLE IF NOT EXISTS feature_additions(project_id TEXT PRIMARY KEY REFERENCES projects(id), payload TEXT NOT NULL);
      CREATE TRIGGER IF NOT EXISTS immutable_version_update BEFORE UPDATE ON baseline_versions BEGIN SELECT RAISE(ABORT, 'Baseline snapshot is immutable'); END;
      CREATE TRIGGER IF NOT EXISTS immutable_version_delete BEFORE DELETE ON baseline_versions BEGIN SELECT RAISE(ABORT, 'Baseline snapshot is immutable'); END;
    `);
    if (!this.db.prepare('SELECT version FROM app_migrations WHERE version=?').get('0.2.2')) this.transaction(() => {
      for (const summary of this.list().filter(p => !p.committed)) {
        const project = this.get(summary.id);
        const oldIntake = this.db.prepare('SELECT payload FROM intakes WHERE project_id=?').get(project.id);
        const existing = project.stage === 'concept' ? (oldIntake ? (JSON.parse(String(oldIntake.payload)) as ConceptIntake).questions : []) : project.review?.issues ?? [];
        const holds = this.db.prepare('SELECT payload FROM decision_holds WHERE project_id=?').all(project.id).map(r => JSON.parse(String(r.payload)) as ConceptQuestion | ReviewIssue);
        for (const question of [...existing, ...holds]) {
          const old = this.ledger.list(project.id).find(q => q.id === question.id);
          this.ledger.put(project.id, { id: question.id, stage: project.stage as 'concept' | 'candidate', status: holds.some(q => q.id === question.id) ? 'undecided' : old?.status ?? 'pending_answer',
            p0Ids: 'p0Ids' in question ? question.p0Ids : [], gate: 'gate' in question ? question.gate : 'clarity', createdRevision: project.revision,
            createdBasis: '从升级前仍存在的问题或暂不确定记录导入；无法还原此前已丢失问题。', openedAfter: null, acceptedProposal: false, resolution: null,
            question: { ...question, questionId: question.id, answerMode: question.options?.length === 3 ? 'choices' : 'custom_only', options: question.options?.length ? question.options : unsureOptions() } });
        }
      }
      this.db.prepare('INSERT INTO app_migrations VALUES(?)').run('0.2.2');
    });
    this.db.exec('CREATE TABLE IF NOT EXISTS inference_failures(project_id TEXT NOT NULL, revision INTEGER NOT NULL, created_at TEXT NOT NULL, payload TEXT NOT NULL);');
    if (!this.db.prepare('SELECT version FROM app_migrations WHERE version=?').get('addition-stages-1')) this.transaction(() => {
      for (const row of this.db.prepare('SELECT project_id,payload FROM feature_additions').all()) {
        const id = String(row.project_id), old = JSON.parse(String(row.payload));
        if (old.assessment && !old.assessment.items) old.assessment = { items: [old.assessment] };
        old.members ??= old.phase === 'intake' ? [] : [{ index: 0, p0Id: old.newP0Id ?? old.assessment?.items[0]?.targetP0Id }];
        old.fieldPermissions = {};
        if (old.phase !== 'intake') {
          old.phase = 'integration'; delete old.integration;
          for (const q of this.ledger.list(id)) if (!old.questionIds.includes(q.id) && q.status !== 'resolved' && q.gate === 'consistency') {
            // Retire the placeholder as work history; retain its answers without claiming consent.
            this.ledger.put(id, { ...q, stage: q.id === old.integrationQuestionId && q.createdBasis.includes('规则衔接需用户确认') ? 'legacy' : 'integration' });
          }
          this.db.prepare('DELETE FROM reviews WHERE project_id=?').run(id);
          this.db.prepare('DELETE FROM proposals WHERE project_id=? AND accepted_at IS NULL').run(id);
          this.db.prepare('UPDATE drafts SET revision=revision+1 WHERE project_id=?').run(id);
        }
        this.writeAddition(id, old);
      }
      this.db.prepare('INSERT INTO app_migrations VALUES(?)').run('addition-stages-1');
    });
  }
  close() { this.db.close(); }
  transaction<T>(run: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = run(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  list(): ProjectSummary[] {
    return this.db.prepare(`SELECT p.id,p.name,p.created_at AS createdAt, b.project_id AS baselineId, (SELECT MAX(version) FROM baseline_versions WHERE project_id=p.id) AS latestVersion FROM projects p LEFT JOIN baselines b ON b.project_id=p.id ORDER BY p.created_at DESC,p.rowid DESC`).all()
      .map(row => ({ id: String(row.id), name: String(row.name), createdAt: String(row.createdAt), committed: Boolean(row.baselineId), ...(row.baselineId ? { currentVersion: `v${Number(row.latestVersion ?? 1)}` as BaselineVersion } : {}) }));
  }
  create(input: unknown): Project {
    if (input && typeof input === 'object' && 'conceptInput' in input) {
      const data = z.strictObject({ name: z.string().trim().max(200).optional(), conceptInput: z.string().trim().min(1).max(12000) }).parse(input);
      const id = randomUUID(), createdAt = new Date().toISOString();
      this.transaction(() => {
        this.db.prepare('INSERT INTO projects VALUES(?,?,?)').run(id, data.name || '未命名项目', createdAt);
        this.db.prepare('INSERT INTO intakes VALUES(?,?,?)').run(id, 1, JSON.stringify({ conceptInput: data.conceptInput, definition: null, questions: [] }));
        this.message(id, 'user', JSON.stringify({ conceptInput: data.conceptInput }));
      });
      return this.get(id);
    }
    const data = z.strictObject({ name: z.string().trim().min(1).max(200), productDescription: z.string().trim().min(1).max(12000),
      productConcept: z.string().max(12000).optional(),
      coreUserGoal: z.string().trim().min(1).max(12000), features: z.array(z.string().trim().min(1).max(12000)).min(1).max(50) }).parse(input);
    const id = randomUUID(), createdAt = new Date().toISOString();
    const draft: Draft = { productDescription: data.productDescription, coreUserGoal: data.coreUserGoal, productConcept: data.productConcept ?? '',
      candidates: data.features.map((source, index) => ({ id: `P0-${index + 1}`, source, name: source.slice(0, 80),
        description: source, purpose: '', applicableState: '', coreRule: '', confirmedException: '', verification: null })) };
    this.transaction(() => {
      this.db.prepare('INSERT INTO projects VALUES(?,?,?)').run(id, data.name, createdAt);
      this.db.prepare('INSERT INTO drafts VALUES(?,?,?)').run(id, 1, JSON.stringify(draft));
      this.message(id, 'user', JSON.stringify({ productDescription: data.productDescription, coreUserGoal: data.coreUserGoal, productConcept: draft.productConcept, features: data.features }));
    });
    return this.get(id);
  }
  get(id: string): Project {
    const summary = this.list().find(p => p.id === id);
    if (!summary) throw new AppError('not_found', '项目不存在。', 404);
    const draftRow = this.db.prepare('SELECT revision,payload FROM drafts WHERE project_id=?').get(id);
    const intakeRow = this.db.prepare('SELECT revision,payload FROM intakes WHERE project_id=?').get(id);
    const intake = intakeRow ? JSON.parse(String(intakeRow.payload)) as ConceptIntake : null;
    // Concept projects have no persisted Candidate Draft. This empty view keeps the
    // legacy project response usable; stage guards reject candidate operations.
    const draft: Draft = draftRow ? { productConcept: '', ...JSON.parse(String(draftRow.payload)) } :
      { productDescription: '', coreUserGoal: '', productConcept: '', candidates: [] };
    const revision = Number(draftRow?.revision ?? intakeRow!.revision);
    const reviewRow = this.db.prepare('SELECT payload FROM reviews WHERE project_id=?').get(id);
    const review = reviewRow ? JSON.parse(String(reviewRow.payload)) as Review : null;
    if (review) for (const issue of review.issues) issue.options ??= [];
    const baselineRow = this.db.prepare('SELECT payload FROM baseline_versions WHERE project_id=? ORDER BY version DESC LIMIT 1').get(id) ?? this.db.prepare('SELECT payload FROM baselines WHERE project_id=?').get(id);
    const baseline = baselineRow ? JSON.parse(String(baselineRow.payload)) as Baseline : null;
    const storedAddition = this.addition(id);
    const addition = storedAddition ? (({ originalDraft: _draft, conversationIds: _messages, questionIds: _questions, startRevision: _revision, ...value }) => value)(storedAddition) : null;
    const conversation = this.db.prepare('SELECT id,role,content,created_at AS createdAt FROM conversations WHERE project_id=? ORDER BY rowid').all(id) as Project['conversation'];
    const questions = this.ledger.list(id);
    for (const record of questions) {
      if (record.status !== 'resolved' && 'kind' in record.question && (record.question.kind === 'conflict' || record.stage === 'integration' && record.requiresAcceptance) && (record.stage === 'integration' ? addition?.integration?.revision !== revision || !addition.integration.issues.some(i => i.id === record.id) : review?.revision !== revision || !review.issues.some(i => i.id === record.id))) {
        record.question = { ...record.question, proposals: [], options: unsureOptions(), answerMode: 'custom_only' };
      }
    }
    if (intake && !draftRow) intake.questions = questions.filter(q => q.stage === 'concept' && q.status !== 'resolved').map(q => q.question as ConceptQuestion);
    let status: Project['status'] = 'Draft';
    if (baseline && !addition) status = 'Committed';
    else if (!draftRow) status = intake?.questions.length ? 'Needs Clarification' : 'Draft';
    else if (ready(draft, revision, review, questions, addition)) status = 'Ready';
    else if (addition?.phase === 'integration') status = questions.some(q => q.stage === 'integration' && q.status !== 'resolved' && 'kind' in q.question && q.question.kind === 'conflict') ? 'Conflict Detected' : 'Draft';
    else if (review) {
      const statuses = review.items.flatMap(i => gateKeys.map(key => i.gates[key].status));
      if (statuses.includes('conflict_detected')) status = 'Conflict Detected';
      else if (statuses.includes('needs_clarification')) status = 'Needs Clarification';
      else status = 'Verification Undefined';
    }
    if ((!baseline || addition) && questions.some(q => q.stage !== 'legacy' && q.status !== 'resolved') && status === 'Draft') status = 'Needs Clarification';
    return { ...summary, stage: addition ? addition.phase === 'intake' ? 'addition' : addition.phase === 'integration' ? 'integration' : 'candidate' : baseline ? 'committed' : draftRow ? 'candidate' : 'concept', intake, draft, revision, review, baseline, conversation, questions, status, addition,
      baselineHistory: baseline ? [this.readBaseline(id, 'v1'), ...this.db.prepare('SELECT payload FROM baseline_versions WHERE project_id=? ORDER BY version').all(id).map(r => JSON.parse(String(r.payload)) as Baseline)].map(b => ({ version: b.baselineVersion, createdAt: b.createdAt })) : [] };
  }
  editable(id: string, revision: number): Project {
    const project = this.get(id);
    if (project.baseline && !['integration', 'review'].includes(project.addition?.phase ?? '')) throw new AppError('read_only', '已提交基线只读；请通过加入新功能建立独立草稿。', 409);
    if (project.revision !== revision) throw new AppError('stale_revision', '草稿已变更，请刷新并重新审查当前内容。', 409);
    return project;
  }
  candidateEditable(id: string, revision: number): Project {
    const project = this.editable(id, revision);
    if (project.stage !== 'candidate') throw new AppError('concept_unconfirmed', '请先确认产品设定与初始功能，再进入候选审查。', 409);
    return project;
  }
  conceptEditable(id: string, revision: number): Project {
    const project = this.editable(id, revision);
    if (project.stage !== 'concept') throw new AppError('concept_locked', '初始功能已经确认，请在候选工作区调整产品定义。', 409);
    return project;
  }
  private addition(id: string): StoredAddition | null {
    const row = this.db.prepare('SELECT payload FROM feature_additions WHERE project_id=?').get(id);
    return row ? JSON.parse(String(row.payload)) as StoredAddition : null;
  }
  private writeAddition(id: string, value: StoredAddition) {
    this.db.prepare('INSERT INTO feature_additions VALUES(?,?) ON CONFLICT(project_id) DO UPDATE SET payload=excluded.payload').run(id, JSON.stringify(value));
  }
  readBaseline(id: string, version: BaselineVersion): Baseline {
    if (!/^v[1-9]\d*$/.test(version)) throw new AppError('invalid_version', '基线版本无效。');
    const number = Number(version.slice(1));
    if (!Number.isSafeInteger(number)) throw new AppError('invalid_version', '基线版本无效。');
    const row = number === 1 ? this.db.prepare('SELECT payload FROM baselines WHERE project_id=?').get(id) : this.db.prepare('SELECT payload FROM baseline_versions WHERE project_id=? AND version=?').get(id, number);
    if (!row) throw new AppError('not_found', '基线版本不存在。', 404);
    return JSON.parse(String(row.payload)) as Baseline;
  }
  startAddition(id: string, revision: number, request: string): Project {
    const text = z.string().trim().min(1).max(12000).parse(request);
    return this.transaction(() => {
      const p = this.get(id);
      if (!p.baseline || p.addition) throw new AppError('addition_unavailable', '请先提交基线，或继续当前新增功能草稿。', 409);
      if (p.revision !== revision) throw new AppError('stale_revision', '项目已变更，请刷新。', 409);
      // Build from the saved current snapshot, keeping the established sources.
      const draft: Draft = { productDescription: p.baseline.productDescription, coreUserGoal: p.baseline.coreUserGoal, productConcept: p.baseline.productConcept ?? '',
        candidates: p.baseline.p0Items.map(c => ({ ...structuredClone(c), source: p.draft.candidates.find(old => old.id === c.id)?.source ?? c.description })) };
      this.writeAddition(id, { request: text, baseVersion: p.baseline.baselineVersion, phase: 'intake', assessment: null, editableP0Ids: [], originalDraft: draft,
        startRevision: revision, conversationIds: p.conversation.map(m => m.id), questionIds: p.questions.map(q => q.id) });
      this.writeDraft(id, revision + 1, draft);
      this.message(id, 'user', JSON.stringify({ decision: '用户提出新增功能，尚未确认归属。', request: text, baseVersion: p.baseline.baselineVersion }));
      return this.get(id);
    });
  }
  additionEditable(id: string, revision: number): Project {
    const p = this.get(id);
    if (p.revision !== revision) throw new AppError('stale_revision', '新增功能草稿已变更，请刷新。', 409);
    if (p.addition?.phase !== 'intake') throw new AppError('addition_locked', '当前没有待确认归属的新增功能。', 409);
    return p;
  }
  saveAdditionRequest(id: string, revision: number, request: string): Project {
    const text = z.string().trim().min(1).max(12000).parse(request);
    return this.transaction(() => {
      const p = this.additionEditable(id, revision), addition = this.addition(id)!;
      this.writeAddition(id, { ...addition, request: text, assessment: null });
      this.writeDraft(id, revision + 1, p.draft);
      this.message(id, 'user', JSON.stringify({ decision: '用户补充新增功能设想。', request: text }));
      return this.get(id);
    });
  }
  applyAdditionAssessment(id: string, revision: number, raw: unknown): Project {
    const assessment = additionAnalysisSchema.parse(raw);
    return this.transaction(() => {
      const p = this.additionEditable(id, revision), ids = new Set(p.draft.candidates.map(c => c.id));
      for (const item of assessment.items) if (item.relatedP0Ids.some(key => !ids.has(key)) || new Set(item.relatedP0Ids).size !== item.relatedP0Ids.length ||
          (item.kind === 'existing_p0' ? !item.targetP0Id || !ids.has(item.targetP0Id) : item.targetP0Id !== null) ||
          (item.kind === 'needs_clarification' ? !item.question.trim() : !item.name.trim() || !item.description.trim())) {
        throw new AppError('invalid_analysis', '功能归属或关联引用不完整，结果未应用。', 502);
      }
      this.writeAddition(id, { ...this.addition(id)!, assessment });
      this.writeDraft(id, revision + 1, p.draft);
      return this.get(id);
    });
  }
  confirmAddition(id: string, revision: number): Project {
    return this.transaction(() => {
      const p = this.additionEditable(id, revision), addition = this.addition(id)!, a = addition.assessment;
      if (!a || a.items.some(item => item.kind === 'needs_clarification')) throw new AppError('addition_incomplete', '请先整理并确认全部功能归属。', 409);
      if (p.draft.candidates.length + a.items.filter(item => item.kind === 'new_p0').length > 50) throw new AppError('candidate_limit', '当前功能已达到容量上限，不能新增。', 409);
      let number = Math.max(0, ...p.draft.candidates.map(c => Number(/^P0-(\d+)$/.exec(c.id)?.[1] ?? 0)));
      addition.members = a.items.map((item, index) => {
        const p0Id = item.kind === 'new_p0' ? 'P0-' + (++number) : item.targetP0Id!;
        if (item.kind === 'new_p0') p.draft.candidates.push({ id: p0Id, source: item.description, name: item.name, description: item.description,
          purpose: '', applicableState: '', coreRule: '', confirmedException: '', verification: null });
        return { index, p0Id };
      });
      addition.editableP0Ids = [...new Set(addition.members.map(m => m.p0Id))];
      addition.fieldPermissions = {}; addition.phase = 'integration';
      this.writeAddition(id, addition);
      this.writeDraft(id, revision + 1, p.draft);
      this.message(id, 'user', JSON.stringify({ decision: '用户明确确认完整新增清单与归属，进入新旧关系审查；未授权覆盖旧规则。', request: addition.request, assessment: a, members: addition.members }));
      return this.get(id);
    });
  }
  discardAddition(id: string, revision: number): Project {
    return this.transaction(() => {
      const p = this.get(id), addition = this.addition(id);
      if (!addition || p.revision !== revision) throw new AppError('stale_revision', '新增草稿不存在或已变更。', 409);
      this.writeDraft(id, revision + 1, addition.originalDraft);
      for (const m of p.conversation.filter(m => !addition.conversationIds.includes(m.id))) this.db.prepare('DELETE FROM conversations WHERE id=? AND project_id=?').run(m.id, id);
      for (const q of p.questions.filter(q => !addition.questionIds.includes(q.id))) this.db.prepare('DELETE FROM question_ledger WHERE project_id=? AND id=?').run(id, q.id);
      this.db.prepare('DELETE FROM decision_holds WHERE project_id=?').run(id);
      this.db.prepare('DELETE FROM proposals WHERE project_id=? AND revision>?').run(id, addition.startRevision);
      this.db.prepare('DELETE FROM verification_sources WHERE project_id=?').run(id);
      this.db.prepare('DELETE FROM feature_additions WHERE project_id=?').run(id);
      return this.get(id);
    });
  }
  integrationEditable(id: string, revision: number): Project {
    const project = this.editable(id, revision);
    if (project.stage !== 'integration') throw new AppError('integration_unavailable', '请先确认完整新增清单，再审查新旧关系。', 409);
    return project;
  }
  recordInferenceFailure(id: string, revision: number, stage: string, error: unknown) {
    const diagnostic = { ...(error instanceof ModelValidationError ? error.diagnostic : { stage, category: 'business', paths: [] }),
      ...(error instanceof AppError ? { code: error.code, ...error.questionDiagnostic } : {}) };
    this.db.prepare('INSERT INTO inference_failures VALUES(?,?,?,?)').run(id, revision, new Date().toISOString(), JSON.stringify(diagnostic));
  }
  applyIntegration(id: string, revision: number, raw: unknown): Project {
    const result = integrationAnalysisSchema.parse(raw);
    return this.transaction(() => {
      const p = this.integrationEditable(id, revision), ids = p.draft.candidates.map(c => c.id);
      if (result.checkedP0Ids.length !== ids.length || new Set(result.checkedP0Ids).size !== ids.length || result.checkedP0Ids.some(id => !ids.includes(id))) throw new AppError('invalid_analysis', '新旧关系未完整检查全部 P0，未应用结果。', 502);
      for (const issue of result.issues) {
        this.validateOptions(issue.options, issue.proposals.length > 0 || issue.kind === 'conflict', issue.proposals.length, issue.answerMode);
        if (new Set(issue.p0Ids).size !== issue.p0Ids.length || issue.p0Ids.some(id => !ids.includes(id))) throw new AppError('invalid_analysis', '关系审查引用未知或重复功能。', 502);
        for (const proposal of issue.proposals) if (new Set(proposal.changes.map(c => c.p0Id + ':' + c.field)).size !== proposal.changes.length || proposal.changes.some(c => !issue.p0Ids.includes(c.p0Id))) throw new AppError('invalid_analysis', '方案包含重复或未关联的规则变更。', 502);
      }
      this.ledger.resolve(p, 'integration', result.resolvedQuestions, result.issues);
      const registered = result.issues.map(issue => this.ledger.register(p, 'integration', { ...issue, id: '', proposals: issue.proposals.map(prop => ({ ...prop, id: randomUUID() })) }));
      if (new Set(registered.map(q => q.id)).size !== registered.length) throw new AppError('invalid_question_reference', '问题引用重复。', 502);
      const current = new Set(registered.map(q => q.id));
      for (const q of this.ledger.list(id).filter(q => q.stage === 'integration' && q.status !== 'resolved')) if (!current.has(q.id) && 'proposals' in q.question && q.question.proposals.length) this.ledger.put(id, { ...q, question: { ...q.question, proposals: [], options: unsureOptions(), answerMode: 'custom_only' } });
      const issues = this.ledger.list(id).filter(q => q.stage === 'integration' && q.status !== 'resolved').map(q => q.question as ReviewIssue);
      if (issues.length > 100) throw new AppError('invalid_analysis', '当前必要决定超过容量，已有草稿保留。', 502);
      const next = revision + 1;
      this.writeDraft(id, next, p.draft);
      this.writeAddition(id, { ...this.addition(id)!, phase: issues.length ? 'integration' : 'review', integration: { revision: next, summary: result.summary, issues } });
      for (const issue of issues) for (const proposal of issue.proposals) this.db.prepare('INSERT INTO proposals VALUES(?,?,?,?,?,NULL)').run(proposal.id, id, next, JSON.stringify(issue.p0Ids), proposal.rule);
      this.message(id, 'assistant', result.summary);
      return this.get(id);
    });
  }
  private allowChanges(id: string, ids: string[], fields: ReviewField[]) {
    const addition = this.addition(id);
    if (addition) {
      const permissions = addition.fieldPermissions ?? {};
      for (const key of ids) permissions[key] = [...new Set([...(permissions[key] ?? []), ...fields])];
      this.writeAddition(id, { ...addition, fieldPermissions: permissions, editableP0Ids: [...new Set([...addition.editableP0Ids, ...ids])] });
    }
  }
  private writeIntake(id: string, revision: number, intake: ConceptIntake) {
    this.db.prepare('UPDATE intakes SET revision=?,payload=? WHERE project_id=?').run(revision, JSON.stringify(intake), id);
  }
  saveConcept(id: string, revision: number, input: unknown): Project {
    const data = z.strictObject({ conceptInput: z.string().trim().min(1).max(12000), definition: conceptDefinitionSchema.nullable().optional() }).parse(input);
    return this.transaction(() => {
      const project = this.conceptEditable(id, revision), intake = structuredClone(project.intake!);
      const changed = intake.conceptInput !== data.conceptInput;
      intake.conceptInput = data.conceptInput;
      if (changed) {
        intake.definition = null; intake.questions = [];
      } else if (data.definition !== undefined) intake.definition = data.definition;
      this.writeIntake(id, revision + 1, intake);
      this.message(id, 'user', JSON.stringify({ conceptInput: intake.conceptInput, decision: '用户编辑了产品设想或整理结果。', definition: intake.definition }));
      return this.get(id);
    });
  }
  private validateOptions(options: DecisionOption[], conflict = false, proposalCount = 0, answerMode = 'choices') {
    const custom = answerMode === 'custom_only';
    if ((custom ? options.length !== 1 || options[0]?.key !== 'C' || !options[0]?.unsure : options.length !== 3 || new Set(options.map(o => o.key)).size !== 3) || options.some(o =>
      (!conflict && o.proposalIndex !== null) || (o.unsure && o.proposalIndex !== null) ||
      (!o.unsure && /我会补充|稍后确定|之后确定|以后再定|稍后补充|待补充|待确定|另行确定/.test(o.answer)) ||
      (conflict && !o.unsure && (o.proposalIndex === null || o.proposalIndex >= proposalCount)))) {
      throw new AppError('invalid_analysis', 'AI 选项或解决规则的引用无效，结果未应用。', 502);
    }
  }
  applyConcept(id: string, revision: number, raw: unknown): Project {
    const result = conceptAnalysisSchema.parse(raw);
    for (const question of result.questions) this.validateOptions(question.options, false, 0, question.answerMode);
    return this.transaction(() => {
      const project = this.conceptEditable(id, revision);
      this.ledger.resolve(project, 'concept', result.resolvedQuestions, result.questions);
      const registered = result.questions.map(q => this.ledger.register(project, 'concept', { ...q, id: '' }));
      if (new Set(registered.map(q => q.id)).size !== registered.length) throw new AppError('invalid_question_reference', '问题引用重复。', 502);
      const questions = this.ledger.active(project, 'concept') as ConceptQuestion[];
      if (questions.length > 100) throw new AppError('invalid_analysis', '当前必要问题超过容量，请合并相关业务问题后重试；已有设想与台账保留。', 502);
      this.writeIntake(id, revision + 1, { ...project.intake!, definition: result.definition, questions });
      this.message(id, 'assistant', questions.length ? questions.map(q => q.question).join('\n') : '产品设想已整理，请确认设定与初始功能。');
      return this.get(id);
    });
  }
  confirmConcept(id: string, revision: number): Project {
    return this.transaction(() => {
      const project = this.conceptEditable(id, revision);
      if (!conceptReady(project.intake)) throw new AppError('concept_incomplete', '请先完成产品设定、初始功能及关键问题，再确认。', 409);
      const d = project.intake!.definition!;
      const draft: Draft = { productDescription: d.productDescription, coreUserGoal: d.coreUserGoal, productConcept: d.productConcept,
        candidates: d.features.map((f, index) => ({ id: `P0-${index + 1}`, source: f.description, name: f.name,
          description: f.description, purpose: '', applicableState: '', coreRule: '', confirmedException: '', verification: null })) };
      this.db.prepare('INSERT INTO drafts VALUES(?,?,?)').run(id, revision + 1, JSON.stringify(draft));
      if (project.name === '未命名项目' && d.name.trim()) this.db.prepare('UPDATE projects SET name=? WHERE id=?').run(d.name.trim(), id);
      this.message(id, 'user', JSON.stringify({ decision: '用户主动确认产品设定与全部初始功能。', definition: d }));
      return this.get(id);
    });
  }
  decisions(id: string, revision: number, input: unknown, acceptances: unknown = [], confirmation?: string): Project {
    const { answers, proposalAcceptances } = decisionBatchSchema.parse({ answers: input, proposalAcceptances: acceptances, confirmation });
    return this.transaction(() => {
      const project = this.editable(id, revision), concept = project.stage === 'concept';
      const questions = project.questions.filter(q => q.status !== 'resolved' && q.stage === project.stage).map(q => q.question);
      const ids = [...answers, ...proposalAcceptances].map(a => a.issueId);
      if (ids.some(issueId => !questions.some(q => q.id === issueId))) throw new AppError('issue_not_found', '问题已失效，请重新读取当前草稿。', 409);
      if (!ids.length || ids.length > questions.length || new Set(ids).size !== ids.length) throw new AppError('invalid_answers', '回答数量或问题标识无效。');
      if (proposalAcceptances.length && (concept || confirmation !== proposalConfirmationText)) throw new AppError('proposal_confirmation_required', '请明确确认所选决定并接受解决规则。', 409);
      if (project.stage === 'integration') {
        const changes = new Map<string, string>();
        for (const acceptance of proposalAcceptances) {
          const issue = questions.find(q => q.id === acceptance.issueId);
          if (!issue || !('proposals' in issue)) continue;
          for (const change of issue.proposals.find(p => p.id === acceptance.proposalId)?.changes ?? []) {
            const key = change.p0Id + ':' + change.field;
            if (changes.has(key) && changes.get(key) !== change.value) throw new AppError('incompatible_decisions', '所选方案对同一规则要求不同结果，请调整选择后再确认。', 409);
            changes.set(key, change.value);
          }
        }
      }
      for (const answer of answers) {
        const issue = questions.find(q => q.id === answer.issueId);
        if (!issue) throw new AppError('issue_not_found', '问题已失效，请重新读取当前草稿。', 409);
        const option = issue.options.find(o => o.key === answer.choice);
        const value = answer.choice === 'D' ? answer.customAnswer?.trim() : option?.answer;
        if (!value || (answer.choice !== 'D' && !option)) throw new AppError('invalid_choice', '请选择当前选项，或填写自定义回答。');
        if (!concept && 'proposals' in issue && (issue.kind === 'conflict' || project.stage === 'integration' && issue.proposals.length) && option && !option.unsure) throw new AppError('proposal_confirmation_required', '冲突解决规则需要通过明确的接受操作生效。', 409);
        const unsure = option?.unsure || undecidedAnswer(value);
        if (unsure) {
          const hold = concept ? issue : { ...issue, kind: 'clarification', proposals: [],
            explanation: '用户尚未决定此项规则，需要明确回答后才能通过审查。',
            options: issue.options.map(o => ({ ...o, proposalIndex: null })) };
          this.db.prepare('INSERT OR REPLACE INTO decision_holds VALUES(?,?,?,?)').run(id, issue.id, project.stage, JSON.stringify(hold));
        } else this.db.prepare('DELETE FROM decision_holds WHERE project_id=? AND issue_id=?').run(id, issue.id);
        const messageId = this.message(id, 'user', JSON.stringify({ issueId: issue.id, question: issue.question, ...('p0Ids' in issue ? { p0Ids: issue.p0Ids } : {}), choice: answer.choice, answer: value, undecided: Boolean(unsure) }));
        this.ledger.answer(id, issue.id, Boolean(unsure), false, messageId);
        if (project.stage === 'candidate' && !unsure && 'p0Ids' in issue && issue.kind !== 'conflict') for (const scope of issue.affectedFields ?? []) this.allowChanges(id, [scope.p0Id], scope.fields);
      }
      // Apply in review order so overlapping P0 receive a stable ordering of rules.
      for (const issue of questions) {
        const acceptance = proposalAcceptances.find(a => a.issueId === issue.id);
        if (!acceptance) continue;
        if (!('kind' in issue) || (issue.kind !== 'conflict' && project.stage !== 'integration') || !issue.proposals.some(p => p.id === acceptance.proposalId) ||
          (issue.options.length && !issue.options.some(o => !o.unsure && o.proposalIndex !== null && issue.proposals[o.proposalIndex]?.id === acceptance.proposalId))) {
          throw new AppError('stale_proposal', '解决规则不属于当前有效冲突，请重新读取草稿。', 409);
        }
        const proposal = this.db.prepare('SELECT * FROM proposals WHERE id=? AND project_id=? AND revision=? AND accepted_at IS NULL').get(acceptance.proposalId, id, revision);
        if (!proposal) throw new AppError('stale_proposal', '建议已失效，请重新审查。', 409);
        const p0Ids = JSON.parse(String(proposal.p0_ids)) as string[];
        if (project.stage === 'integration') {
          const accepted = issue.proposals.find(prop => prop.id === acceptance.proposalId)!;
          for (const change of accepted.changes ?? []) {
            const c = project.draft.candidates.find(c => c.id === change.p0Id)!;
            if (c[change.field] !== change.value) {
              c[change.field] = change.value;
              if (['description','applicableState','coreRule','confirmedException'].includes(change.field)) {
                c.verification = null; this.allowChanges(id, [c.id], ['verification']);
              }
            }
          }
        } else for (const c of project.draft.candidates.filter(c => p0Ids.includes(c.id))) { c.confirmedException = [c.confirmedException, String(proposal.rule)].filter(Boolean).join('\n'); c.verification = null; }
        this.db.prepare('UPDATE proposals SET accepted_at=? WHERE id=?').run(new Date().toISOString(), acceptance.proposalId);
        this.db.prepare('DELETE FROM decision_holds WHERE project_id=? AND issue_id=?').run(id, issue.id);
        const messageId = this.message(id, 'user', JSON.stringify({ issueId: issue.id, acceptedProposal: true, rule: String(proposal.rule) }));
        this.ledger.answer(id, issue.id, false, true, messageId);
        if (project.stage === 'candidate') {
          this.allowChanges(id, p0Ids, ['verification']);
          for (const scope of issue.affectedFields ?? []) this.allowChanges(id, [scope.p0Id], scope.fields);
        }
      }
      if (proposalAcceptances.some(a => !questions.some(q => q.id === a.issueId))) throw new AppError('issue_not_found', '问题已失效，请重新读取当前草稿。', 409);
      if (concept) this.writeIntake(id, revision + 1, project.intake!);
      else this.writeDraft(id, revision + 1, project.draft);
      return this.get(id);
    });
  }
  feedback(id: string, revision: number, text: string): Project {
    if (!text.trim() || text.length > 12000) throw new AppError('invalid_feedback', '请用自己的话说明想调整的内容。');
    return this.transaction(() => {
      const project = this.candidateEditable(id, revision);
      this.message(id, 'user', JSON.stringify({ decision: '用户提出产品调整意图；已接受例外仍以候选字段为准。', feedback: text.trim() }));
      this.writeDraft(id, revision + 1, project.draft);
      return this.get(id);
    });
  }
  mergeQuestions(id: string, revision: number, input: unknown): Project {
    const merge = questionMergeSchema.parse(input);
    return this.transaction(() => {
      const project = this.candidateEditable(id, revision);
      if (new Set(merge.questionIds).size !== merge.questionIds.length || !merge.questionIds.includes(merge.primaryQuestionId) || merge.answer.issueId !== merge.primaryQuestionId) throw new AppError('invalid_question_merge', '请选择不同的问题，并为主问题确认本次答复。');
      const records = merge.questionIds.map(questionId => project.questions.find(q => q.id === questionId && q.stage === 'candidate' && q.status !== 'resolved'));
      if (records.some(q => !q || !('kind' in q.question) || q.question.kind === 'conflict' || q.requiresAcceptance || q.acceptedProposal || q.question.proposals.length)) throw new AppError('invalid_question_merge', '只能合并当前有效的普通问题，冲突或需要接受方案的问题不能合并。', 409);
      const selected = records as import('../shared/domain.js').QuestionRecord[];
      const primary = selected.find(q => q.id === merge.primaryQuestionId)!;
      if (selected.some(q => JSON.stringify([...q.p0Ids].sort()) !== JSON.stringify([...primary.p0Ids].sort()))) throw new AppError('invalid_question_merge', '合并问题必须关联相同的功能。', 409);
      const question = primary.question as ReviewIssue;
      const option = question.options.find(o => o.key === merge.answer.choice);
      const answer = merge.answer.choice === 'D' ? merge.answer.customAnswer?.trim() : option?.answer;
      if (!answer || (merge.answer.choice !== 'D' && !option)) throw new AppError('invalid_choice', '请选择主问题的当前选项，或填写自定义答复。');
      const unsure = Boolean(option?.unsure || undecidedAnswer(answer));
      const coveredGates = [...new Set(selected.flatMap(q => questionGates(q.question as ReviewIssue)))];
      if (question.kind === 'verification' && coveredGates.length > 1) throw new AppError('invalid_question_merge', '请选择普通澄清作为主问题，单独验证问题不能覆盖其他审查内容。');
      const affectedFields = primary.p0Ids.flatMap(p0Id => {
        const fields = [...new Set(selected.flatMap(q => (q.question as ReviewIssue).affectedFields?.find(s => s.p0Id === p0Id)?.fields ?? []))];
        return fields.length ? [{ p0Id, fields }] : [];
      });
      const messageId = this.message(id, 'user', JSON.stringify({ decision: merge.confirmation, questionIds: merge.questionIds, issueId: primary.id, question: question.question, p0Ids: primary.p0Ids, choice: merge.answer.choice, answer, undecided: unsure }));
      this.ledger.put(id, { ...primary, question: { ...question, coveredGates, affectedFields }, status: unsure ? 'undecided' : 'pending_review', lastAnswerMessageId: messageId, resolution: null });
      for (const record of selected.filter(q => q.id !== primary.id)) this.ledger.put(id, { ...record, stage: 'legacy', merge: { targetQuestionId: primary.id, originalStage: 'candidate', messageId, revision: revision + 1 } });
      for (const record of selected) this.db.prepare('DELETE FROM decision_holds WHERE project_id=? AND issue_id=?').run(id, record.id);
      if (unsure) this.db.prepare('INSERT INTO decision_holds VALUES(?,?,?,?)').run(id, primary.id, 'candidate', JSON.stringify({ ...question, coveredGates, affectedFields }));
      else for (const scope of affectedFields) this.allowChanges(id, [scope.p0Id], scope.fields);
      this.writeDraft(id, revision + 1, project.draft);
      return this.get(id);
    });
  }
  private writeDraft(id: string, revision: number, draft: Draft) {
    this.db.prepare('UPDATE drafts SET revision=?,payload=? WHERE project_id=?').run(revision, JSON.stringify(draft), id);
    this.db.prepare('DELETE FROM reviews WHERE project_id=?').run(id);
    this.db.prepare('DELETE FROM proposals WHERE project_id=? AND accepted_at IS NULL').run(id);
  }
  save(id: string, revision: number, value: unknown, confirmExceptions = false): Project {
    return this.transaction(() => {
      const project = this.candidateEditable(id, revision), draft = draftSchema.parse(value);
      if (project.intake && !draft.productConcept.trim()) throw new AppError('concept_required', '请保留核心产品设定。');
      if (draft.candidates.length !== project.draft.candidates.length || draft.candidates.some(c => {
        const old = project.draft.candidates.find(p => p.id === c.id);
        return !old || old.source !== c.source || (old.confirmedException !== c.confirmedException && (!confirmExceptions || !old.confirmedException.trim()));
      }) || new Set(draft.candidates.map(c => c.id)).size !== draft.candidates.length) {
        throw new AppError('protected_fields', '不能删除初始 P0、修改原始来源或绕过建议确认写入例外规则。');
      }
      this.writeDraft(id, revision + 1, draft);
      for (const c of draft.candidates) {
        const old = project.draft.candidates.find(p => p.id === c.id)!;
        if (['description','applicableState','coreRule','confirmedException'].some(key => c[key as keyof typeof c] !== old[key as keyof typeof old]) && sameVerification(c.verification, old.verification)) {
          c.verification = null; this.allowChanges(id, [c.id], ['verification']);
        }
      }
      // Persist invalidated verification with this same revision, not a second revision.
      this.db.prepare('UPDATE drafts SET payload=? WHERE project_id=?').run(JSON.stringify(draft), id);
      for (const c of draft.candidates) this.allowChanges(id, [c.id], (['name','description','purpose','applicableState','coreRule','verification'] as const).filter(key => JSON.stringify(c[key]) !== JSON.stringify(project.draft.candidates.find(old => old.id === c.id)![key])));
      const changes: Array<{ p0Id?: string; field: string; before: unknown; after: unknown }> = [];
      for (const field of ['productDescription', 'coreUserGoal', 'productConcept'] as const) if (draft[field] !== project.draft[field]) changes.push({ field, before: project.draft[field], after: draft[field] });
      for (const candidate of draft.candidates) {
        const old = project.draft.candidates.find(c => c.id === candidate.id)!;
        for (const field of ['name','description','purpose','applicableState','coreRule','confirmedException','verification'] as const) if (JSON.stringify(candidate[field]) !== JSON.stringify(old[field])) changes.push({ p0Id: candidate.id, field, before: old[field], after: candidate[field] });
      }
      this.message(id, 'user', JSON.stringify({ decision: '用户手动保存实际变更；before 是历史值，after 才是当前决定。', changes }));
      for (const candidate of draft.candidates) {
        const old = project.draft.candidates.find(c => c.id === candidate.id)!;
        if (old.confirmedException !== candidate.confirmedException) this.message(id, 'user', JSON.stringify({ p0Id: candidate.id, decision: '用户明确修改了先前接受的例外规则；当前草稿为准。', confirmedException: candidate.confirmedException }));
      }
      return this.get(id);
    });
  }
  message(id: string, role: 'user' | 'assistant', content: string) {
    const messageId = randomUUID();
    this.db.prepare('INSERT INTO conversations VALUES(?,?,?,?,?)').run(messageId, id, role, content, new Date().toISOString());
    return messageId;
  }
  answer(id: string, revision: number, issueId: string, answer: string) {
    return this.answerBatch(id, revision, [{ issueId, answer }]);
  }
  answerBatch(id: string, revision: number, answers: Array<{ issueId: string; answer: string }>) {
    this.candidateEditable(id, revision);
    return this.decisions(id, revision, answers.map(a => ({ issueId: a.issueId, choice: 'D', customAnswer: a.answer })));
  }
  applyAnalysis(id: string, revision: number, raw: unknown): Project {
    const result = analysisSchema.parse(raw);
    return this.transaction(() => {
      const project = this.candidateEditable(id, revision);
      this.validateAnalysis(project.draft, result);
      this.ledger.resolve(project, 'candidate', result.resolvedQuestions, result.issues);
      if (project.addition) for (const item of result.items) {
        const c = project.draft.candidates.find(c => c.id === item.id)!;
        const allowed = editableFields(project, c.id);
        if (Object.entries(item.fields).some(([key, value]) => c[key as keyof typeof item.fields] !== value && !allowed.includes(key as ReviewField)) || !sameVerification(c.verification, item.verification) && !allowed.includes('verification')) {
          throw new AppError('existing_rule_protected', 'AI 尝试改写未获确认的现有字段。旧基线与草稿已保留，请先明确相关决定再审查。', 502);
        }
      }
      validateQuantitative(project, result);
      const draft = structuredClone(project.draft);
      for (const candidate of draft.candidates) {
        const item = result.items.find(i => i.id === candidate.id)!;
        const purpose = item.fields.purpose.trim() ? item.fields.purpose : candidate.purpose;
        const verification = project.addition && sameVerification(candidate.verification, item.verification) ? candidate.verification : item.verification;
        Object.assign(candidate, item.fields, { purpose, verification });
      }
      const nextRevision = revision + 1;
      const registered = result.issues.map(issue => this.ledger.register(project, 'candidate', { ...issue, id: '', proposals: issue.proposals.map(p => ({ ...p, id: randomUUID() })) }));
      if (new Set(registered.map(q => q.id)).size !== registered.length) throw new AppError('invalid_question_reference', '问题引用重复。', 502);
      const review: Review = { revision: nextRevision, ledgerVersion: 1, items: result.items.map(i => ({ id: i.id, gates: structuredClone(i.gates) })), issues: [] };
      // Fresh proposals are valid only for this result. Persisted questions stay open
      // when omitted; their old proposal IDs are not carried into a new revision.
      const currentIds = new Set(registered.map(q => q.id));
      for (const record of this.ledger.list(id).filter(q => q.stage === 'candidate' && q.status !== 'resolved')) {
        if (!currentIds.has(record.id) && 'kind' in record.question && record.question.kind === 'conflict') this.ledger.put(id, { ...record, question: { ...record.question, proposals: [], options: unsureOptions(), answerMode: 'custom_only' } });
      }
      for (const candidate of draft.candidates) {
        const item = review.items.find(i => i.id === candidate.id)!;
        const missingPurpose = !candidate.purpose.trim();
        const missingClarity = !candidate.name.trim() || !candidate.description.trim() || missingPurpose;
        const missingBoundary = !candidate.applicableState.trim() || !candidate.coreRule.trim();
        if (missingClarity) item.gates.clarity = { status: 'needs_clarification', reason: '名称、行为描述或用户意图仍有缺失。' };
        if (missingBoundary) item.gates.boundary = { status: 'needs_clarification', reason: '需要明确生效状态与核心规则。' };
        const problem = verificationProblem(candidate.verification);
        if (problem) item.gates.verifiability = { status: 'verification_undefined', reason: problem };
        const missingGates = gateKeys.filter(gate => item.gates[gate].status !== 'pass' && !this.ledger.list(id).some(q => q.stage === 'candidate' && q.status !== 'resolved' && q.p0Ids.includes(candidate.id) && questionGates(q.question as ReviewIssue).includes(gate)));
        if (missingGates.length) {
          const labels = { clarity: '行为明确', boundary: '生效条件与边界', consistency: '规则一致性', verifiability: '验证要求' };
          const error = new AppError('review_question_coverage_incomplete', `「${candidate.name || candidate.id}」的审查不完整：${missingGates.map(g => labels[g]).join('、')}尚未通过，却没有对应问题。已保存的草稿与答复保留，本轮审查未应用。请主动重试。`, 502);
          error.questionDiagnostic = { missingGates: missingGates.map(g => candidate.id + ':' + g) };
          throw error;
        }
      }
      review.issues = this.ledger.list(id).filter(q => q.stage === 'candidate' && q.status !== 'resolved').map(q => q.question as ReviewIssue);
      if (review.issues.length > 100) throw new AppError('invalid_analysis', '当前必要问题超过容量，请合并相关业务问题后重试；已有草稿与台账保留。', 502);
      // Every unresolved ledger entry overrides a model pass, including omissions.
      for (const item of review.items) {
        for (const issue of review.issues.filter(issue => issue.p0Ids.includes(item.id))) {
          for (const gate of questionGates(issue)) item.gates[gate] = { status: issue.kind === 'conflict' ? 'conflict_detected' : issue.kind === 'verification' ? 'verification_undefined' : 'needs_clarification', reason: issue.explanation || issue.question };
        }
      }
      this.writeDraft(id, nextRevision, draft);
      this.db.prepare('INSERT INTO reviews VALUES(?,?,?)').run(id, nextRevision, JSON.stringify(review));
      for (const issue of review.issues) for (const proposal of issue.proposals) {
        this.db.prepare('INSERT INTO proposals VALUES(?,?,?,?,?,NULL)').run(proposal.id, id, nextRevision, JSON.stringify(issue.p0Ids), proposal.rule);
      }
      for (const item of result.items) this.db.prepare('INSERT OR REPLACE INTO verification_sources VALUES(?,?,?,?)').run(id, item.id, nextRevision, JSON.stringify(item.quantitativeSources));
      this.message(id, 'assistant', review.issues.length ? review.issues.map(i => `${i.title}：${i.question}`).join('\n') : '当前候选已完成全局审查；请查看 Verification 和完整预览。');
      return this.get(id);
    });
  }
  private validateAnalysis(draft: Draft, result: Analysis) {
    for (const issue of result.issues) {
      const gates = questionGates(issue);
      if (new Set(gates).size !== gates.length || !gates.includes(issue.gate) || (issue.kind === 'conflict' && (gates.length !== 1 || gates[0] !== 'consistency')) || (issue.kind === 'verification' && (gates.length !== 1 || gates[0] !== 'verifiability'))) throw new AppError('invalid_analysis', '问题关联的审查项无效，本轮结果未应用。', 502);
    }
    for (const issue of result.issues) if (new Set((issue.affectedFields ?? []).map(s => s.p0Id)).size !== (issue.affectedFields ?? []).length || issue.affectedFields?.some(s => !issue.p0Ids.includes(s.p0Id) || new Set(s.fields).size !== s.fields.length)) throw new AppError('invalid_analysis', '业务决定引用了重复或无关的可调整字段。', 502);
    for (const issue of result.issues) this.validateOptions(issue.options, issue.kind === 'conflict', issue.proposals.length, issue.answerMode);
    const ids = new Set(draft.candidates.map(c => c.id));
    if (result.items.length !== ids.size || new Set(result.items.map(i => i.id)).size !== ids.size || result.items.some(i => !ids.has(i.id)) || result.issues.some(i => new Set(i.p0Ids).size !== i.p0Ids.length || i.p0Ids.some(id => !ids.has(id)))) {
      throw new AppError('invalid_analysis', 'AI 未完整保留初始 P0 或引用了未知功能，结果未应用。', 502);
    }
    if (result.issues.some(i => (i.kind === 'conflict' && (new Set(i.p0Ids).size < 1 || i.gate !== 'consistency' || !i.condition.trim() || !i.ruleA.trim() || !i.ruleB.trim() || !i.explanation.trim())) ||
        !i.question.trim() || i.proposals.some(p => i.kind !== 'conflict' || !p.rule.trim()))) {
      throw new AppError('invalid_analysis', 'AI 冲突说明或问题结构不完整，结果未应用。', 502);
    }
  }
  accept(id: string, revision: number, proposalId: string): Project {
    const project = this.candidateEditable(id, revision);
    const issue = project.review?.issues.find(i => i.kind === 'conflict' && i.proposals.some(p => p.id === proposalId));
    if (!issue) throw new AppError('stale_proposal', '建议已失效，请重新审查。', 409);
    return this.decisions(id, revision, [], [{ issueId: issue.id, proposalId }], proposalConfirmationText);
  }
  preview(id: string, revision: number): Baseline {
    const project = this.candidateEditable(id, revision);
    if (!ready(project.draft, revision, project.review, project.questions, project.addition)) throw new AppError('gates_blocked', '存在未解决问题、缺失验证或过期审查，不能进入提交预览。', 409);
    return this.baseline(project.draft, '提交时生成', project.baseline ? `v${Number(project.baseline.baselineVersion.slice(1)) + 1}` : 'v1');
  }
  private baseline(draft: Draft, createdAt: string, baselineVersion: BaselineVersion = 'v1'): Baseline {
    return { productDescription: draft.productDescription, coreUserGoal: draft.coreUserGoal, productConcept: draft.productConcept, baselineVersion, createdAt,
      p0Items: draft.candidates.map(({ source: _source, ...candidate }) => candidate) };
  }
  commit(id: string, revision: number, confirmation: string): Project {
    return this.transaction(() => {
      const current = this.get(id);
      const updating = Boolean(current.addition || current.baseline && current.baseline.baselineVersion !== 'v1');
      if (confirmation !== (updating ? evolutionConfirmationText : confirmationText)) throw new AppError('confirmation_required', '请主动确认当前完整产品逻辑。');
      const existing = this.db.prepare('SELECT revision FROM baseline_versions WHERE project_id=? ORDER BY version DESC LIMIT 1').get(id) ?? this.db.prepare('SELECT revision FROM baselines WHERE project_id=?').get(id);
      if (existing && !current.addition) {
        if (Number(existing.revision) !== revision) throw new AppError('stale_revision', '此项目已提交另一份预览，基线快照只读。', 409);
        return this.get(id);
      }
      const project = this.candidateEditable(id, revision);
      const preview = this.preview(id, revision);
      const payload = JSON.stringify(this.baseline(project.draft, new Date().toISOString(), preview.baselineVersion));
      if (project.addition) {
        if (project.addition.baseVersion !== project.baseline?.baselineVersion) throw new AppError('stale_baseline', '当前基线已变化，请重新整理。', 409);
        this.db.prepare('INSERT INTO baseline_versions VALUES(?,?,?,?)').run(id, Number(preview.baselineVersion.slice(1)), revision, payload);
        this.db.prepare('DELETE FROM feature_additions WHERE project_id=?').run(id);
      } else this.db.prepare('INSERT INTO baselines VALUES(?,?,?)').run(id, revision, payload);
      return this.get(id);
    });
  }
  reset(id: string, revision: number): Project {
    return this.transaction(() => {
      const project = this.editable(id, revision);
      if (project.addition) throw new AppError('addition_reset_forbidden', '新增功能草稿请使用放弃本次新增，当前基线会保留。', 409);
      this.db.prepare('DELETE FROM decision_holds WHERE project_id=?').run(id);
      this.ledger.clear(id);
      this.db.prepare('DELETE FROM verification_sources WHERE project_id=?').run(id);
      if (project.stage === 'concept') {
        this.writeIntake(id, revision + 1, { conceptInput: project.intake!.conceptInput, definition: null, questions: [] });
        this.db.prepare('DELETE FROM conversations WHERE project_id=?').run(id);
        this.message(id, 'user', JSON.stringify({ conceptInput: project.intake!.conceptInput }));
        return this.get(id);
      }
      const draft: Draft = { ...project.draft, candidates: project.draft.candidates.map(c => ({ ...c, name: c.source.slice(0, 80), description: c.source, purpose: '', applicableState: '', coreRule: '', confirmedException: '', verification: null })) };
      this.writeDraft(id, revision + 1, draft);
      this.db.prepare('DELETE FROM proposals WHERE project_id=?').run(id);
      this.db.prepare('DELETE FROM conversations WHERE project_id=?').run(id);
      this.message(id, 'user', JSON.stringify({ productDescription: draft.productDescription, coreUserGoal: draft.coreUserGoal, features: draft.candidates.map(c => c.source) }));
      return this.get(id);
    });
  }
}
