import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Store } from '../server/store.js';
import { buildApp } from '../server/app.js';
import { confirmationText, ready } from '../shared/domain.js';
import type { Analysis, Project } from '../shared/domain.js';
import { baselineText } from '../src/baseline-text.js';
import { makeAnalysis, decisionOptions, fixtureAuth, fixtureProvider, makeConcept, customIssue } from './fixtures.js';

const stores: Store[] = [], directories: string[] = [];
const setup = (description = '个人 MVP', path = ':memory:') => {
  const store = new Store(path); stores.push(store);
  const project = store.create({ name: '方法论验证', productDescription: description, coreUserGoal: '帮助用户专注', features: ['显示状态'] });
  return { store, project };
};
afterEach(() => {
  for (const s of stores.splice(0)) { try { s.close(); } catch {} }
  for (const dir of directories.splice(0)) {
    if (!resolve(dir).startsWith(resolve(tmpdir()) + '\\') || !dir.includes('baseline-methodology-')) throw new Error('Unsafe cleanup');
    rmSync(dir, { recursive: true, force: true });
  }
});
const fails = (run: () => unknown, code: string) => expect(run).toThrow(expect.objectContaining({ code }));
function ask(store: Store, project: Project) {
  const output = makeAnalysis(project);
  output.issues = [{ kind: 'clarification', gate: 'boundary', p0Ids: ['P0-1'], title: '运行决定', question: '什么时候显示状态？', explanation: '核心生效范围需要确认。',
    condition: '', ruleA: '', ruleB: '', options: decisionOptions(['仅正常监督时显示状态。', '正常与暂停时均显示状态。']), proposals: [], questionId: null, answerMode: 'choices' }];
  return store.applyAnalysis(project.id, project.revision, output);
}
function resolveWith(project: Project, messageId: string, quote: string): Analysis {
  const output = makeAnalysis(project);
  output.resolvedQuestions = [{ questionId: project.questions.find(q => q.status !== 'resolved')!.id, reason: '后续用户资料已说明生效范围。', evidence: [{ messageId, quote }] }];
  return output;
}

describe('Purpose and persistent questions', () => {
  it('preserves an existing purpose when AI returns empty, while an explicit user clearing takes effect', () => {
    const { store, project } = setup();
    let p = store.applyAnalysis(project.id, project.revision, makeAnalysis(project));
    const known = p.draft.candidates[0]!.purpose;
    const blank = makeAnalysis(p); blank.items[0]!.fields.purpose = '';
    p = store.applyAnalysis(p.id, p.revision, blank);
    expect(p.draft.candidates[0]!.purpose).toBe(known);
    const edited = structuredClone(p.draft); edited.candidates[0]!.purpose = '';
    p = store.save(p.id, p.revision, edited);
    fails(() => store.applyAnalysis(p.id, p.revision, blank), 'review_question_coverage_incomplete');
    expect(store.get(p.id)).toEqual(p);
    blank.issues = [customIssue('clarity', 'P0-1', '你希望「显示状态」帮助用户解决什么问题？')];
    p = store.applyAnalysis(p.id, p.revision, blank);
    expect(p.draft.candidates[0]!.purpose).toBe('');
    expect(p.questions.some(q => q.question.question.includes('帮助用户解决什么问题'))).toBe(true);
    expect(p.questions[0]!.question.answerMode).toBe('custom_only');
    fails(() => store.commit(p.id, p.revision, confirmationText), 'gates_blocked');
  });
  it('retains ordinary unanswered questions across omission, partial answers, manual saves and reanalysis', () => {
    const { store, project } = setup(); let p = ask(store, project);
    const id = p.questions[0]!.id;
    const draft = structuredClone(p.draft); draft.candidates[0]!.purpose += ' 用户修改目的。';
    p = store.save(p.id, p.revision, draft);
    expect(p.questions[0]!.id).toBe(id);
    expect(p.conversation.at(-1)!.content).toContain('用户修改目的');
    p = store.applyAnalysis(p.id, p.revision, makeAnalysis(p));
    expect(p.questions[0]!.status).toBe('pending_answer');
    expect(p.status).not.toBe('Ready');
    p = store.decisions(p.id, p.revision, [{ issueId: id, choice: 'A' }]);
    const omitted = makeAnalysis(p); omitted.resolvedQuestions = [];
    p = store.applyAnalysis(p.id, p.revision, omitted);
    expect(p.questions[0]!.status).toBe('pending_review');
    fails(() => store.preview(p.id, p.revision), 'gates_blocked');
  });
  it('closes an unanswered question using later user feedback and keeps the reason outside Baseline', () => {
    const { store, project } = setup(); let p = ask(store, project);
    p = store.feedback(p.id, p.revision, '仅在正常监督时显示状态。');
    const message = p.conversation.at(-1)!;
    p = store.applyAnalysis(p.id, p.revision, resolveWith(p, message.id, '仅在正常监督时显示状态。'));
    expect(p.questions[0]!.status).toBe('resolved'); expect(p.status).toBe('Ready');
    const baseline = store.commit(p.id, p.revision, confirmationText).baseline!;
    expect(JSON.stringify(baseline)).not.toMatch(/messageId|resolvedQuestions|evidence|openedAfter/);
  });
  it.each(['foreign', 'assistant', 'fabricated', 'early'] as const)('rejects %s evidence with no partial changes', kind => {
    const { store, project } = setup(); let p = ask(store, project);
    const initial = p.conversation[0]!;
    p = store.feedback(p.id, p.revision, '仅正常监督生效。');
    let message = p.conversation.at(-1)!, quote = '仅正常监督生效。';
    if (kind === 'foreign') { const other = setup().project; message = other.conversation[0]!; quote = message.content; }
    if (kind === 'assistant') { message = p.conversation.find(m => m.role === 'assistant')!; quote = message.content; }
    if (kind === 'fabricated') quote = '消息中根本没有这段内容';
    if (kind === 'early') { message = initial; quote = initial.content; }
    fails(() => store.applyAnalysis(p.id, p.revision, resolveWith(p, message.id, quote)), 'invalid_evidence');
    expect(store.get(p.id)).toEqual(p);
  });
  it('does not close undecided questions with the undecided message, but accepts a later actual decision', () => {
    const { store, project } = setup(); let p = ask(store, project);
    p = store.decisions(p.id, p.revision, [{ issueId: p.questions[0]!.id, choice: 'C' }]);
    fails(() => store.applyAnalysis(p.id, p.revision, resolveWith(p, p.conversation.at(-1)!.id, '暂不确定')), 'invalid_evidence');
    const draft = structuredClone(p.draft); draft.candidates[0]!.coreRule = '用户明确仅在正常监督时显示状态。';
    p = store.save(p.id, p.revision, draft);
    expect(p.questions[0]!.status).toBe('undecided');
    const message = p.conversation.at(-1)!;
    const output = resolveWith(p, message.id, draft.candidates[0]!.coreRule); output.items[0]!.fields.coreRule = draft.candidates[0]!.coreRule;
    p = store.applyAnalysis(p.id, p.revision, output);
    expect(ready(p.draft, p.revision, p.review, p.questions)).toBe(true);
  });
  it('rejects manual before values and duplicate or forged question closure references', () => {
    const { store, project } = setup(); let p = ask(store, project);
    const old = p.draft.candidates[0]!.coreRule, draft = structuredClone(p.draft); draft.candidates[0]!.coreRule = '新的规则';
    p = store.save(p.id, p.revision, draft);
    fails(() => store.applyAnalysis(p.id, p.revision, resolveWith(p, p.conversation.at(-1)!.id, old)), 'invalid_evidence');
    const output = resolveWith(p, p.conversation.at(-1)!.id, '新的规则'); output.resolvedQuestions[0]!.questionId = 'forged';
    fails(() => store.applyAnalysis(p.id, p.revision, output), 'invalid_question_reference');
    output.resolvedQuestions[0]!.questionId = p.questions[0]!.id; output.resolvedQuestions.push(output.resolvedQuestions[0]!);
    fails(() => store.applyAnalysis(p.id, p.revision, output), 'invalid_question_reference');
  });
  it('does not use an old definite answer to override a newer undecided answer', () => {
    const { store, project } = setup(); let p = ask(store, project);
    const id = p.questions[0]!.id;
    p = store.decisions(p.id, p.revision, [{ issueId: id, choice: 'A' }]); const previous = p.conversation.at(-1)!;
    p = store.decisions(p.id, p.revision, [{ issueId: id, choice: 'C' }]);
    fails(() => store.applyAnalysis(p.id, p.revision, resolveWith(p, previous.id, '仅正常监督时显示状态。')), 'invalid_evidence');
    expect(store.get(p.id).questions[0]!.status).toBe('undecided');
  });
  it('rolls back an earlier valid resolution if a later closure has forged evidence', () => {
    const { store, project } = setup(); let p = ask(store, project);
    const output = makeAnalysis(p), first = p.review!.issues[0]!;
    const { id: _id, ...question } = first;
    output.issues = [{ ...question, kind: 'clarification', gate: 'clarity', questionId: null, title: '目的决定', question: '这个显示解决什么问题？', p0Ids: ['P0-1'], proposals: [] }];
    p = store.applyAnalysis(p.id, p.revision, output);
    p = store.feedback(p.id, p.revision, '仅正常监督时显示状态，帮助我了解在场情况。');
    const resolved = makeAnalysis(p);
    resolved.resolvedQuestions = p.questions.map((q, i) => ({ questionId: q.id, reason: '用户回答了', evidence: [{ messageId: i ? 'forged' : p.conversation.at(-1)!.id, quote: '仅正常监督时显示状态，帮助我了解在场情况。' }] }));
    fails(() => store.applyAnalysis(p.id, p.revision, resolved), 'invalid_evidence'); expect(store.get(p.id)).toEqual(p);
  });
  it('keeps conflict questions after omission and rejects closing or accepting an unaccepted stale proposal', () => {
    const { store } = setup(); const initial = store.create({ name: '冲突', productDescription: '产品', coreUserGoal: '目标', features: ['监督', '扣心', '免罚'] });
    let p = store.applyAnalysis(initial.id, initial.revision, makeAnalysis(initial, true));
    const oldProposal = p.review!.issues[0]!.proposals[0]!.id;
    p = store.feedback(p.id, p.revision, '我想考虑一下');
    fails(() => store.applyAnalysis(p.id, p.revision, resolveWith(p, p.conversation.at(-1)!.id, '我想考虑一下')), 'proposal_confirmation_required');
    p = store.applyAnalysis(p.id, p.revision, makeAnalysis(p));
    expect(p.questions[0]!.status).toBe('pending_answer'); expect(p.review!.issues[0]!.proposals).toEqual([]);
    fails(() => store.accept(p.id, p.revision, oldProposal), 'stale_proposal');
  });
  it('persists stable question IDs across restart and resets only working questions', () => {
    const directory = mkdtempSync(join(tmpdir(), 'baseline-methodology-')); directories.push(directory);
    const { store, project } = setup('持久化', join(directory, 'baseline.sqlite'));
    const p = ask(store, project); store.close();
    const restarted = new Store(join(directory, 'baseline.sqlite')); stores.push(restarted);
    expect(restarted.get(p.id).questions).toEqual(p.questions);
    const reset = restarted.reset(p.id, p.revision);
    expect(reset.questions).toEqual([]); expect(reset.draft.candidates[0]!.source).toBe('显示状态');
  });
});

describe('Quantitative provenance and complete options', () => {
  it('accepts simulated numeric test inputs without inventing acceptance metrics', () => {
    const { store, project } = setup(); const output = makeAnalysis(project);
    output.items[0]!.verification!.humanTest = '真人在镜头前入座、离开；另以模拟20秒推进程序计时。';
    expect(store.applyAnalysis(project.id, project.revision, output).status).toBe('Ready');
  });
  it.each(['误报率≤5%', '至少20个样本', '20个测试样本'])('rejects common unsupported metric expression %s', text => {
    const { store, project } = setup(); const output = makeAnalysis(project);
    output.items[0]!.verification!.expectedHumanResult = text;
    fails(() => store.applyAnalysis(project.id, project.revision, output), 'unsupported_metric');
    expect(store.get(project.id)).toEqual(project);
  });
  it('preserves user metrics, copies all formal requirements and excludes provenance', () => {
    const { store, project } = setup('用户要求误报率≤5%，20个样本'); const output = makeAnalysis(project);
    output.items[0]!.verification!.quantitativeRequirements = [{ metric: '误报率', target: '≤5%', sample: '20个样本' }];
    output.items[0]!.quantitativeSources = [{ requirementIndex: 0, evidence: [{ messageId: project.conversation[0]!.id, quote: '误报率≤5%，20个样本' }] }];
    const p = store.applyAnalysis(project.id, project.revision, output);
    const baseline = store.commit(p.id, p.revision, confirmationText).baseline!;
    const copied = baselineText(p.name, baseline);
    expect(copied).toContain('误报率'); expect(copied).toContain('≤5%'); expect(copied).toContain('20个样本');
    expect(copied).not.toContain('messageId'); expect(JSON.stringify(baseline)).not.toContain('quantitativeSources');
  });
  it.each(['missing', 'number', 'assistant'])('rejects %s structured metric provenance', kind => {
    const { store, project } = setup('要求误报率≤5%'); const output = makeAnalysis(project);
    output.items[0]!.verification!.quantitativeRequirements = [{ metric: '误报率', target: kind === 'number' ? '≤2%' : '≤5%', sample: null }];
    if (kind !== 'missing') {
      if (kind === 'assistant') store.message(project.id, 'assistant', '误报率≤5%');
      const p = store.get(project.id), message = kind === 'assistant' ? p.conversation.at(-1)! : p.conversation[0]!;
      output.items[0]!.quantitativeSources = [{ requirementIndex: 0, evidence: [{ messageId: message.id, quote: '误报率≤5%' }] }];
    }
    expect(() => store.applyAnalysis(project.id, project.revision, output)).toThrow();
    expect(store.get(project.id).revision).toBe(project.revision);
  });
  it('asks custom-only for a requested but undefined metric without proposing a numeric threshold', () => {
    const { store, project } = setup('用户要求误报率指标，门槛未定义'); const output = makeAnalysis(project);
    output.items[0]!.verification!.quantitativeRequirements = [{ metric: '误报率', target: null, sample: null }];
    output.items[0]!.quantitativeSources = [{ requirementIndex: 0, evidence: [{ messageId: project.conversation[0]!.id, quote: '用户要求误报率指标，门槛未定义' }] }];
    output.issues = [customIssue('verifiability', 'P0-1', '你要求的误报率门槛是什么？')];
    let p = store.applyAnalysis(project.id, project.revision, output);
    expect(p.status).not.toBe('Ready'); expect(p.questions[0]!.question.answerMode).toBe('custom_only');
    expect(p.questions[0]!.question.options.map(o => o.key)).toEqual(['C']);
    fails(() => store.decisions(p.id, p.revision, [{ issueId: p.questions[0]!.id, choice: 'A' }]), 'invalid_choice');
    p = store.decisions(p.id, p.revision, [{ issueId: p.questions[0]!.id, choice: 'D', customAnswer: '误报率≤5%，不要求样本规模。' }]);
    expect(p.questions[0]!.status).toBe('pending_review');
  });
  it('rejects vague expected results even if every model gate passes', () => {
    const { store, project } = setup(); const output = makeAnalysis(project);
    output.items[0]!.verification!.expectedHumanResult = '应该正常';
    output.issues = [customIssue('verifiability', 'P0-1', '具体观察到什么结果才算正确？')];
    const p = store.applyAnalysis(project.id, project.revision, output);
    expect(p.review!.items[0]!.gates.verifiability.status).toBe('verification_undefined');
    fails(() => store.preview(p.id, p.revision), 'gates_blocked');
  });
  it('rejects guessed numeric choices for a requested metric whose threshold is unknown', () => {
    const { store, project } = setup('用户要求误报率，门槛未定义'); const output = makeAnalysis(project);
    output.items[0]!.verification!.quantitativeRequirements = [{ metric: '误报率', target: null, sample: null }];
    output.items[0]!.quantitativeSources = [{ requirementIndex: 0, evidence: [{ messageId: project.conversation[0]!.id, quote: '用户要求误报率，门槛未定义' }] }];
    output.issues = [{ questionId: null, answerMode: 'choices', kind: 'verification', gate: 'verifiability', title: '猜测指标', question: '采用哪个门槛？', p0Ids: ['P0-1'], condition: '', ruleA: '', ruleB: '', explanation: '测试反例', options: decisionOptions(['误报率≤5%', '误报率≤10%']), proposals: [] }];
    fails(() => store.applyAnalysis(project.id, project.revision, output), 'invalid_analysis'); expect(store.get(project.id)).toEqual(project);
  });
  it('does not treat the string 未定义 as a sufficient requested metric target', () => {
    const { store, project } = setup('用户要求误报率，门槛未定义'); const output = makeAnalysis(project);
    output.items[0]!.verification!.quantitativeRequirements = [{ metric: '误报率', target: '未定义', sample: null }];
    output.items[0]!.quantitativeSources = [{ requirementIndex: 0, evidence: [{ messageId: project.conversation[0]!.id, quote: '用户要求误报率，门槛未定义' }] }];
    output.issues = [customIssue('verifiability', 'P0-1', '你要求的误报率门槛是什么？')];
    expect(store.applyAnalysis(project.id, project.revision, output).status).toBe('Verification Undefined');
  });
  it.each(['Agent', 'Human', 'Hybrid'] as const)('copies every quantitative field for %s and keeps null sample explicit', type => {
    const { store, project } = setup('用户要求误报率≤5%'); const output = makeAnalysis(project);
    Object.assign(output.items[0]!.verification!, { type, agentProcess: '输入模拟事件。', expectedAgentResult: '输出对应状态。', quantitativeRequirements: [{ metric: '误报率', target: '≤5%', sample: null }] });
    output.items[0]!.quantitativeSources = [{ requirementIndex: 0, evidence: [{ messageId: project.conversation[0]!.id, quote: '误报率≤5%' }] }];
    const p = store.applyAnalysis(project.id, project.revision, output), baseline = store.commit(p.id, p.revision, confirmationText).baseline!;
    const copied = baselineText(p.name, baseline); expect(copied).toContain('≤5%'); expect(copied).toContain('样本要求：未定义'); expect(copied).not.toContain('evidence');
    expect(copied.includes('Agent 验证步骤')).toBe(type !== 'Human'); expect(copied.includes('人工测试步骤')).toBe(type !== 'Agent');
  });
  it.each(['我会补充监督范围', '稍后确定离席时长', '之后确定样本规模'])('rejects incomplete definite option %s', answer => {
    const { store, project } = setup(); const output = makeAnalysis(project);
    const p = ask(store, project);
    const { id: _id, ...issue } = p.review!.issues[0]!;
    output.issues = [{ ...issue, kind: 'clarification', gate: 'boundary', proposals: [], options: decisionOptions([answer, '仅正常监督时显示状态。']) }];
    fails(() => store.applyAnalysis(project.id, p.revision, output), 'invalid_analysis'); expect(store.get(p.id)).toEqual(p);
  });
  it('imports surviving legacy concept questions and blocks legacy reviews until fresh review', () => {
    const directory = mkdtempSync(join(tmpdir(), 'baseline-methodology-')); directories.push(directory);
    const store = new Store(join(directory, 'baseline.sqlite')); stores.push(store);
    const p = store.create({ conceptInput: '虚拟玩偶监督' }); const definition = makeConcept(p);
    store.db.prepare('UPDATE intakes SET payload=? WHERE project_id=?').run(JSON.stringify({ conceptInput: p.intake!.conceptInput, definition: definition.definition, questions: [{ ...definition.questions[0]!, id: 'legacy-question' }] }), p.id);
    const candidate = store.create({ name: '旧项目', productDescription: '旧产品', coreUserGoal: '旧目标', features: ['监督'] });
    const reviewed = store.applyAnalysis(candidate.id, candidate.revision, makeAnalysis(candidate));
    const old = { ...reviewed.review }; delete old.ledgerVersion;
    store.db.prepare('UPDATE reviews SET payload=? WHERE project_id=?').run(JSON.stringify(old), candidate.id);
    store.db.prepare('DELETE FROM app_migrations').run(); store.close();
    const migrated = new Store(join(directory, 'baseline.sqlite')); stores.push(migrated);
    expect(migrated.get(p.id).intake!.questions[0]!.id).toBe('legacy-question');
    fails(() => migrated.preview(candidate.id, reviewed.revision), 'gates_blocked');
    expect(migrated.applyAnalysis(candidate.id, reviewed.revision, makeAnalysis(migrated.get(candidate.id))).status).toBe('Ready');
  });
  it('API rejects an invalid closure without changing saved questions, revision or draft', async () => {
    const { store, project } = setup(); const pending = ask(store, project);
    const output = resolveWith(pending, 'forged', '假引用');
    const app = await buildApp({ store, auth: fixtureAuth, provider: { ...fixtureProvider, async analyze() { return output; } } });
    try {
      const boot = await app.inject({ url: '/', headers: { host: '127.0.0.1:3000' } });
      const headers = { host: '127.0.0.1:3000', origin: 'http://127.0.0.1:3000', cookie: String(boot.headers['set-cookie']).split(';')[0]! };
      const response = await app.inject({ method: 'POST', url: `/api/projects/${pending.id}/analyze`, headers, payload: { revision: pending.revision } });
      expect(response.statusCode).toBe(502); expect(response.json().error.code).toBe('invalid_evidence'); expect(store.get(pending.id)).toEqual(pending);
    } finally { await app.close(); }
  });
});
