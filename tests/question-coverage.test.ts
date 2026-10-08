import { afterEach, describe, expect, it } from 'vitest';
import { Store } from '../server/store.js';
import { buildApp } from '../server/app.js';
import { resolutionConstraints } from '../server/questions.js';
import { reviewResultSchema } from '../server/review-contract.js';
import { mergeConfirmationText, ready } from '../shared/domain.js';
import type { Analysis, Project, QuestionMerge } from '../shared/domain.js';
import { decisionOptions, fixtureAuth, fixtureProvider, makeAnalysis, makeAdditionReviewResponse, duplicateAnalysis } from './fixtures.js';

const stores: Store[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); });
function setup() {
  const store = new Store(':memory:'); stores.push(store);
  const project = store.create({ name: '重复问题隔离验证', productDescription: '个人监督工具', coreUserGoal: '专注工作', features: ['本地实时行为检测'] });
  return { store, project };
}

function duplicates() { const { store, project } = setup(); return { store, project: store.applyAnalysis(project.id, project.revision, duplicateAnalysis(project)) }; }
function mergeInput(project: Project, choice: QuestionMerge['answer']['choice'] = 'A'): QuestionMerge {
  const ids = project.questions.filter(q => q.stage === 'candidate' && q.status !== 'resolved').map(q => q.id);
  return { questionIds: ids, primaryQuestionId: ids[0]!, answer: { issueId: ids[0]!, choice }, confirmation: mergeConfirmationText };
}
const fails = (run: () => unknown, code: string) => expect(run).toThrow(expect.objectContaining({ code }));

describe('Multi-Gate questions and complete review coverage', () => {
  it('keeps one business decision for clarity, boundary and undefined verification', () => {
    const { store, project } = setup(), result = duplicateAnalysis(project);
    result.issues = [{ ...result.issues[0]!, coveredGates: ['clarity', 'boundary', 'verifiability'] }];
    result.items[0]!.gates.clarity.status = 'needs_clarification'; result.items[0]!.gates.boundary.status = 'needs_clarification'; result.items[0]!.verification = null;
    const p = store.applyAnalysis(project.id, project.revision, result);
    expect(p.review!.issues).toHaveLength(1); expect(p.questions).toHaveLength(1);
    for (const gate of ['clarity', 'boundary', 'verifiability'] as const) expect(p.review!.items[0]!.gates[gate].status).not.toBe('pass');
    expect(ready(p.draft, p.revision, p.review, p.questions)).toBe(false);
  });
  it('rolls back an uncovered gate without fabricating a second question', () => {
    const { store, project } = setup(), result = duplicateAnalysis(project);
    result.issues = [result.issues[0]!]; result.items[0]!.gates.boundary.status = 'needs_clarification';
    fails(() => store.applyAnalysis(project.id, project.revision, result), 'review_question_coverage_incomplete');
    expect(store.get(project.id)).toEqual(project);
  });
  it('keeps distinct decisions separate even when they share a Gate', () => {
    const { store, project } = setup(), result = duplicateAnalysis(project);
    result.issues[1] = { ...result.issues[1]!, kind: 'clarification', gate: 'clarity', coveredGates: ['clarity'], title: '摄像头不可用', question: '摄像头不可用如何处理？' };
    expect(store.applyAnalysis(project.id, project.revision, result).questions).toHaveLength(2);
  });
  it('retains prior coverage when the model rephrases a question', () => {
    const { store, project } = duplicates(), merged = store.mergeQuestions(project.id, project.revision, mergeInput(project));
    const result = duplicateAnalysis(merged); result.resolvedQuestions = [];
    result.issues = [{ ...result.issues[0]!, questionId: merged.questions[0]!.id, coveredGates: ['clarity'] }];
    const next = store.applyAnalysis(merged.id, merged.revision, result);
    expect(next.review!.issues[0]!.coveredGates).toEqual(['clarity', 'boundary']);
    expect(next.review!.items[0]!.gates.boundary.status).not.toBe('pass');
  });
  it('cannot recategorize a multi-Gate clarification as a single verification', () => {
    const { store, project } = setup(), result = duplicateAnalysis(project);
    result.issues = [{ ...result.issues[0]!, kind: 'clarification', gate: 'verifiability', coveredGates: ['verifiability', 'clarity'] }];
    const p = store.applyAnalysis(project.id, project.revision, result);
    result.issues = [{ ...result.issues[0]!, kind: 'verification', gate: 'verifiability', coveredGates: ['verifiability'], questionId: p.questions[0]!.id }];
    fails(() => store.applyAnalysis(p.id, p.revision, result), 'invalid_question_reference'); expect(store.get(p.id)).toEqual(p);
  });
  it.each([{ gates: ['clarity', 'clarity'] }, { gates: ['boundary'] }, { gates: ['clarity', 'consistency'] }] as const)('rejects invalid coverage $gates', ({ gates }) => {
    const { store, project } = setup(), result = duplicateAnalysis(project);
    result.issues = [{ ...result.issues[0]!, coveredGates: [...gates] }];
    if (gates.some(g => g === 'consistency')) result.issues = [{ ...result.issues[0]!, kind: 'verification', gate: 'verifiability' }];
    fails(() => store.applyAnalysis(project.id, project.revision, result), 'invalid_analysis'); expect(store.get(project.id)).toEqual(project);
  });
  it('requires coverage on live model output but reads old single-Gate records', () => {
    const { store, project } = duplicates(), wire = makeAdditionReviewResponse(project, duplicateAnalysis(project));
    delete (wire.issues[0] as { coveredGates?: unknown }).coveredGates;
    expect(reviewResultSchema(project).safeParse(wire).success).toBe(false);
    const old = store.ledger.list(project.id)[0]!; delete (old.question as { coveredGates?: unknown }).coveredGates; store.ledger.put(project.id, old);
    expect(store.applyAnalysis(project.id, project.revision, makeAnalysis(project)).review!.items[0]!.gates.clarity.status).not.toBe('pass');
  });
});

describe('Explicit duplicate consolidation', () => {
  it('rejects merge while a review is running without changing the draft', async () => {
    const { store, project } = duplicates();
    let release!: () => void, started!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; }), entered = new Promise<void>(resolve => { started = resolve; });
    const app = await buildApp({ store, auth: fixtureAuth, provider: { ...fixtureProvider, async analyze(p) { started(); await gate; return makeAnalysis(p); } } });
    let pending: Promise<unknown> | undefined;
    try {
      const page = await app.inject({ method: 'GET', url: '/', headers: { host: '127.0.0.1' } });
      const headers = { host: '127.0.0.1', origin: 'http://127.0.0.1', cookie: String(page.headers['set-cookie']).split(';')[0]! };
      pending = app.inject({ method: 'POST', url: `/api/projects/${project.id}/analyze`, headers, payload: { revision: project.revision } }).then(r => r);
      await entered;
      const response = await app.inject({ method: 'POST', url: `/api/projects/${project.id}/questions/merge`, headers, payload: { revision: project.revision, ...mergeInput(project) } });
      expect(response.statusCode).toBe(409); expect(response.json().error.code).toBe('analysis_busy'); expect(store.get(project.id)).toEqual(project);
    } finally { release(); await pending; await app.close(); }
  });
  it('preserves history and scope, increments once and requires a fresh review', () => {
    const { store, project } = duplicates(), [first, second] = project.questions;
    const answered = store.decisions(project.id, project.revision, [{ issueId: first!.id, choice: 'A' }, { issueId: second!.id, choice: 'D', customAnswer: '帮我填' }]);
    const merged = store.mergeQuestions(answered.id, answered.revision, mergeInput(answered));
    expect(merged.revision).toBe(answered.revision + 1); expect(merged.draft).toEqual(answered.draft); expect(merged.review).toBeNull();
    expect(merged.conversation.slice(0, answered.conversation.length)).toEqual(answered.conversation);
    const main = merged.questions.find(q => q.id === first!.id)!, historical = merged.questions.find(q => q.id === second!.id)!;
    expect(main.status).toBe('pending_review'); expect(main.question).toMatchObject({ coveredGates: ['clarity', 'boundary'], affectedFields: [{ p0Id: 'P0-1', fields: ['description', 'coreRule', 'verification'] }] });
    expect(historical).toMatchObject({ stage: 'legacy', question: answered.questions[1]!.question, lastAnswerMessageId: answered.questions[1]!.lastAnswerMessageId, merge: { targetQuestionId: first!.id, messageId: main.lastAnswerMessageId } });
    expect(ready(merged.draft, merged.revision, merged.review, merged.questions)).toBe(false);
    const result = makeAnalysis(merged); result.resolvedQuestions = result.resolvedQuestions.filter(r => r.questionId === first!.id);
    const reviewed = store.applyAnalysis(merged.id, merged.revision, result);
    expect(reviewed.status).toBe('Ready'); expect(reviewed.questions.find(q => q.id === second!.id)!.stage).toBe('legacy');
  });
  it.each(['C', 'D'] as const)('keeps %s unresolved after consolidation', choice => {
    const { store, project } = duplicates(), input = mergeInput(project, choice);
    if (choice === 'D') input.answer.customAnswer = '帮我填';
    const merged = store.mergeQuestions(project.id, project.revision, input);
    expect(merged.questions[0]!.status).toBe('undecided');
    const reviewed = store.applyAnalysis(merged.id, merged.revision, makeAnalysis(merged));
    expect(reviewed.status).not.toBe('Ready'); expect(reviewed.review!.issues).toHaveLength(1);
  });
  it.each(['unknown', 'duplicate', 'other_scope', 'conflict', 'acceptance', 'bad_answer', 'bad_primary'] as const)('rejects %s with no partial changes', kind => {
    const { store, project } = duplicates(); let input = mergeInput(project);
    if (kind === 'unknown') input.questionIds[1] = 'unknown';
    if (kind === 'duplicate') input.questionIds[1] = input.questionIds[0]!;
    if (kind === 'bad_answer') input.answer = { issueId: input.primaryQuestionId, choice: 'D', customAnswer: '' };
    if (kind === 'bad_primary') input.primaryQuestionId = input.questionIds[1]!;
    if (['other_scope', 'conflict', 'acceptance'].includes(kind)) {
      const q = store.ledger.list(project.id)[1]!;
      if (kind === 'other_scope') q.p0Ids = ['P0-other'];
      if (kind === 'conflict') q.question = { ...q.question, kind: 'conflict' } as typeof q.question;
      if (kind === 'acceptance') q.requiresAcceptance = true;
      store.ledger.put(project.id, q);
    }
    const before = store.get(project.id);
    expect(() => store.mergeQuestions(project.id, project.revision, input)).toThrow(); expect(store.get(project.id)).toEqual(before);
  });
  it('rejects stale revisions and a missing explicit confirmation', () => {
    const { store, project } = duplicates(), input = mergeInput(project);
    const next = store.feedback(project.id, project.revision, '保留当前规则');
    expect(() => store.mergeQuestions(project.id, project.revision, input)).toThrow();
    expect(() => store.mergeQuestions(next.id, next.revision, { ...input, confirmation: '' })).toThrow(); expect(store.get(project.id)).toEqual(next);
  });
});

describe('Current evidence and safe diagnostics', () => {
  it('rejects an identical older answer while allowing the latest one', () => {
    const { store, project } = duplicates(), id = project.questions[0]!.id;
    let p = store.decisions(project.id, project.revision, [{ issueId: id, choice: 'A' }]); const old = p.conversation.at(-1)!;
    p = store.decisions(p.id, p.revision, [{ issueId: id, choice: 'A' }]); const current = p.conversation.at(-1)!;
    const output = makeAnalysis(p); output.resolvedQuestions = [{ questionId: id, reason: '用户决定', evidence: [{ messageId: old.id, quote: JSON.parse(old.content).answer }] }];
    fails(() => store.applyAnalysis(p.id, p.revision, output), 'invalid_evidence'); expect(store.get(p.id)).toEqual(p);
    const constraint = resolutionConstraints(p, 'candidate').find(q => q.questionId === id)!;
    expect(constraint.allowedEvidenceMessageIds).toContain(current.id); expect(constraint.allowedEvidenceMessageIds).not.toContain(old.id);
    output.resolvedQuestions[0]!.evidence[0]!.messageId = current.id; expect(store.applyAnalysis(p.id, p.revision, output).questions[0]!.status).toBe('resolved');
  });
  it('does not treat an earlier answer to a different question in the same batch as fresh', () => {
    const { store, project } = duplicates(), [first, second] = project.questions;
    const p = store.decisions(project.id, project.revision, [{ issueId: first!.id, choice: 'A' }, { issueId: second!.id, choice: 'D', customAnswer: '采用第一题方案' }]);
    const message = p.conversation.find(m => m.id === p.questions[0]!.lastAnswerMessageId)!;
    const output = makeAnalysis(p); output.resolvedQuestions = [{ questionId: second!.id, reason: '同一决定', evidence: [{ messageId: message.id, quote: JSON.parse(message.content).answer }] }];
    fails(() => store.applyAnalysis(p.id, p.revision, output), 'invalid_evidence'); expect(store.get(p.id)).toEqual(p);
  });
  it('records only known IDs and error code, without answer text or raw response', async () => {
    const { store, project } = duplicates(), id = project.questions[0]!.id;
    let p = store.decisions(project.id, project.revision, [{ issueId: id, choice: 'A' }]); const old = p.conversation.at(-1)!;
    p = store.decisions(p.id, p.revision, [{ issueId: id, choice: 'C' }]);
    const output = makeAnalysis(p); output.resolvedQuestions = [{ questionId: id, reason: '错误的旧引用', evidence: [{ messageId: old.id, quote: JSON.parse(old.content).answer }] }];
    const app = await buildApp({ store, auth: fixtureAuth, provider: { ...fixtureProvider, async analyze() { return output; } } });
    try {
      const page = await app.inject({ method: 'GET', url: '/', headers: { host: '127.0.0.1' } });
      const headers = { host: '127.0.0.1', origin: 'http://127.0.0.1', cookie: String(page.headers['set-cookie']).split(';')[0]! };
      const response = await app.inject({ method: 'POST', url: `/api/projects/${p.id}/analyze`, headers, payload: { revision: p.revision } });
      expect(response.statusCode).toBe(502); expect(response.json().error.message).toContain('行为判定范围与可见依据'); expect(response.json().error.message).toContain('本轮审查未应用');
      const diagnostic = JSON.parse(String(store.db.prepare('SELECT payload FROM inference_failures').get()!.payload));
      expect(diagnostic).toMatchObject({ code: 'invalid_evidence', questionId: id, evidenceMessageIds: [old.id], latestAnswerMessageId: p.questions[0]!.lastAnswerMessageId });
      expect(JSON.stringify(diagnostic)).not.toContain(JSON.parse(old.content).answer); expect(store.get(p.id)).toEqual(p);
      const merged = await app.inject({ method: 'POST', url: `/api/projects/${p.id}/questions/merge`, headers, payload: { revision: p.revision, ...mergeInput(p) } });
      expect(merged.statusCode).toBe(200); expect(merged.json().revision).toBe(p.revision + 1);
    } finally { await app.close(); }
  });
});
