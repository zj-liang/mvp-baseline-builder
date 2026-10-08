import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { Store } from '../server/store.js';
import { confirmationText, ready, verificationProblem } from '../shared/domain.js';
import type { Analysis, Project, Verification } from '../shared/domain.js';
import { makeAnalysis, customIssue } from './fixtures.js';

const stores: Store[] = [];
const newStore = (path = ':memory:') => { const store = new Store(path); stores.push(store); return store; };
const create = (store: Store, count = 3) => store.create({ name: '专注监督', productDescription: '一个摄像头自律监督工具。', coreUserGoal: '用户在专注工作时监督离席并得到反馈。', features: ['摄像头监督', '离席超过 10 秒扣心', '允许离席 60 秒免罚'].slice(0, count) });
afterEach(() => { for (const store of stores.splice(0)) { try { store.close(); } catch {} } });
const assertCode = (work: () => unknown, code: string) => { expect(work).toThrow(expect.objectContaining({ code })); };

describe('Candidate / Canonical Memory separation', () => {
  it('does not write initial candidates or AI proposals into product memory', () => {
    const store = newStore(); const p = create(store);
    expect(p.baseline).toBeNull();
    const reviewed = store.applyAnalysis(p.id, p.revision, makeAnalysis(p, true));
    expect(reviewed.status).toBe('Conflict Detected');
    expect(reviewed.baseline).toBeNull();
    expect(reviewed.draft.candidates.every(c => c.confirmedException === '')).toBe(true);
    expect(store.db.prepare('SELECT count(*) AS n FROM baselines').get()?.n).toBe(0);
    assertCode(() => store.commit(p.id, reviewed.revision, confirmationText), 'gates_blocked');
  });
  it('requires active proposal acceptance, then invalidates review until reanalysis', () => {
    const store = newStore(), p = create(store);
    const reviewed = store.applyAnalysis(p.id, p.revision, makeAnalysis(p, true));
    const proposal = reviewed.review!.issues[0]!.proposals[0]!;
    const accepted = store.accept(p.id, reviewed.revision, proposal.id);
    expect(accepted.review).toBeNull(); expect(accepted.baseline).toBeNull();
    expect(accepted.draft.candidates[0]!.confirmedException).toBe('');
    expect(accepted.draft.candidates[1]!.confirmedException).toBe(proposal.rule);
    assertCode(() => store.preview(p.id, accepted.revision), 'gates_blocked');
    const resolved = store.applyAnalysis(p.id, accepted.revision, makeAnalysis(accepted, true));
    expect(resolved.status).toBe('Ready');
    expect(resolved.draft.candidates[1]!.confirmedException).toBe(proposal.rule);
  });
  it('does not silently delete, merge or rename source IDs', () => {
    const store = newStore(), p = create(store);
    const bad = makeAnalysis(p); bad.items.pop();
    assertCode(() => store.applyAnalysis(p.id, p.revision, bad), 'invalid_analysis');
    expect(store.get(p.id).revision).toBe(p.revision);
    const edited = structuredClone(p.draft); edited.candidates.pop();
    assertCode(() => store.save(p.id, p.revision, edited), 'protected_fields');
    edited.candidates = [edited.candidates[0]!, edited.candidates[0]!, p.draft.candidates[2]!];
    assertCode(() => store.save(p.id, p.revision, edited), 'protected_fields');
  });
  it('cannot bypass proposal confirmation through draft payload', () => {
    const store = newStore(), p = create(store); const draft = structuredClone(p.draft);
    draft.candidates[0]!.confirmedException = '未经接受的 AI 建议';
    assertCode(() => store.save(p.id, p.revision, draft), 'protected_fields');
    assertCode(() => store.save(p.id, p.revision, draft, true), 'protected_fields');
  });
  it('allows an explicit user revision of an accepted exception, with fresh review required', () => {
    const store = newStore(), p = create(store);
    const reviewed = store.applyAnalysis(p.id, p.revision, makeAnalysis(p, true));
    const accepted = store.accept(p.id, reviewed.revision, reviewed.review!.issues[0]!.proposals[0]!.id);
    const draft = structuredClone(accepted.draft); draft.candidates[1]!.confirmedException = '用户修改为只允许 30 秒临时离席。';
    assertCode(() => store.save(p.id, accepted.revision, draft), 'protected_fields');
    const saved = store.save(p.id, accepted.revision, draft, true);
    expect(saved.review).toBeNull(); expect(saved.draft.candidates[1]!.confirmedException).toContain('30 秒');
    expect(saved.conversation.at(-1)!.content).toContain('当前草稿为准');
  });
});

describe('Hard gates and current revision', () => {
  it.each(['clarity', 'boundary', 'consistency', 'verifiability'] as const)('blocks commit when %s is not passed', key => {
    const store = newStore(), p = create(store); const analysis = makeAnalysis(p);
    analysis.items[0]!.gates[key].status = key === 'verifiability' ? 'verification_undefined' : 'needs_clarification';
    analysis.issues = [customIssue(key, 'P0-1', '请明确这一产品决定。')];
    const reviewed = store.applyAnalysis(p.id, p.revision, analysis);
    assertCode(() => store.preview(p.id, reviewed.revision), 'gates_blocked');
    assertCode(() => store.commit(p.id, reviewed.revision, confirmationText), 'gates_blocked');
  });
  it('does not trust a model pass for missing verification or core fields', () => {
    const store = newStore(), p = create(store); const analysis = makeAnalysis(p);
    analysis.items[0]!.verification = null; analysis.items[1]!.fields.purpose = '';
    analysis.issues = [customIssue('verifiability', 'P0-1', '怎样观察并验证监督行为？'), customIssue('clarity', 'P0-2', '这一功能希望解决什么问题？')];
    const reviewed = store.applyAnalysis(p.id, p.revision, analysis);
    expect(reviewed.review!.items[0]!.gates.verifiability.status).toBe('verification_undefined');
    expect(reviewed.review!.items[1]!.gates.clarity.status).toBe('needs_clarification');
    expect(ready(reviewed.draft, reviewed.revision, reviewed.review)).toBe(false);
  });
  it('invalidates review and rejects the old preview and late AI responses after editing', () => {
    const store = newStore(), p = create(store);
    const reviewed = store.applyAnalysis(p.id, p.revision, makeAnalysis(p));
    store.preview(p.id, reviewed.revision);
    const edited = structuredClone(reviewed.draft); edited.candidates[0]!.purpose = '新的用户意图';
    const saved = store.save(p.id, reviewed.revision, edited);
    expect(saved.review).toBeNull();
    assertCode(() => store.commit(p.id, reviewed.revision, confirmationText), 'stale_revision');
    assertCode(() => store.applyAnalysis(p.id, reviewed.revision, makeAnalysis(reviewed)), 'stale_revision');
    expect(store.get(p.id).draft.candidates[0]!.purpose).toBe('新的用户意图');
  });
  it('saves legacy custom answers atomically and rejects stale issues', () => {
    const store = newStore(), p = create(store); const analysis = makeAnalysis(p, true);
    analysis.issues.push({ ...analysis.issues[0]!, kind: 'clarification', gate: 'boundary', proposals: [], options: analysis.issues[0]!.options.map(o => ({ ...o, proposalIndex: null })), title: '另一处边界', question: '第二个问题？' });
    const reviewed = store.applyAnalysis(p.id, p.revision, analysis);
    const saved = store.answerBatch(p.id, reviewed.revision, reviewed.review!.issues.map(i => ({ issueId: i.id, answer: '这是我的产品决定。' })));
    expect(saved.revision).toBe(reviewed.revision + 1); expect(saved.review).toBeNull();
    expect(saved.conversation.filter(c => c.content.includes('这是我的产品决定。'))).toHaveLength(2);
    assertCode(() => store.answer(p.id, saved.revision, 'old', '回答'), 'issue_not_found');
  });
  it('treats uncertain consistency as clarification and accepts separate states', () => {
    const store = newStore(), p = create(store); const uncertain = makeAnalysis(p, true);
    uncertain.issues[0]!.kind = 'clarification'; uncertain.issues[0]!.proposals = [];
    uncertain.issues[0]!.options = uncertain.issues[0]!.options.map(o => ({ ...o, proposalIndex: null }));
    const reviewed = store.applyAnalysis(p.id, p.revision, uncertain);
    expect(reviewed.status).toBe('Needs Clarification');
    const answered = store.answer(reviewed.id, reviewed.revision, reviewed.review!.issues[0]!.id, '免罚仅在暂停监督状态生效，不同于普通监督。');
    const separate = makeAnalysis(answered); separate.items[2]!.fields.applicableState = '暂停监督状态，不同于普通监督';
    expect(store.applyAnalysis(p.id, answered.revision, separate).status).toBe('Ready');
  });
});

describe('Verification definitions', () => {
  const base: Verification = { type: 'Agent', agentProcess: '输入', expectedAgentResult: '结果', agentSideReview: '', humanTest: '', observability: '', expectedHumanResult: '' };
  it('requires agent steps and expectations for Type A', () => { expect(verificationProblem(base)).toBeNull(); expect(verificationProblem({ ...base, agentProcess: '' })).not.toBeNull(); });
  it('requires human process, review, observability and expectation for Type B', () => {
    const human: Verification = { ...base, type: 'Human', agentSideReview: '代码检查', humanTest: '真人验证', observability: '实时状态', expectedHumanResult: '结果一致' };
    expect(verificationProblem(human)).toBeNull();
    for (const key of ['agentSideReview', 'humanTest', 'observability', 'expectedHumanResult']) expect(verificationProblem({ ...human, [key]: '' })).not.toBeNull();
  });
  it('requires both flows for Hybrid', () => {
    expect(verificationProblem({ ...base, type: 'Hybrid' })).not.toBeNull();
    expect(verificationProblem({ ...base, type: 'Hybrid', agentSideReview: '检查', humanTest: '实际测试', observability: '无需额外工具', expectedHumanResult: '达到预期' })).toBeNull();
  });
});

describe('Whole-baseline confirmation and persistence', () => {
  function reviewed(store: Store): Project { const p = create(store); return store.applyAnalysis(p.id, p.revision, makeAnalysis(p)); }
  it('requires the exact active confirmation and commits once', () => {
    const store = newStore(), p = reviewed(store);
    assertCode(() => store.commit(p.id, p.revision, ''), 'confirmation_required');
    const committed = store.commit(p.id, p.revision, confirmationText);
    expect(committed.status).toBe('Committed');
    expect(store.commit(p.id, p.revision, confirmationText).baseline).toEqual(committed.baseline);
    expect(store.db.prepare('SELECT count(*) AS n FROM baselines').get()?.n).toBe(1);
    const serialized = JSON.stringify(committed.baseline);
    expect(serialized).not.toMatch(/conversation|gates|proposals|source|Passed|Failed/);
    expect(committed.baseline!.p0Items).toHaveLength(3);
  });
  it('enforces read-only at API logic and database level', () => {
    const store = newStore(), p = reviewed(store); store.commit(p.id, p.revision, confirmationText);
    assertCode(() => store.save(p.id, p.revision, p.draft), 'read_only');
    assertCode(() => store.reset(p.id, p.revision), 'read_only');
    assertCode(() => store.applyAnalysis(p.id, p.revision, makeAnalysis(p)), 'read_only');
    expect(() => store.db.prepare('UPDATE baselines SET payload=? WHERE project_id=?').run('{}', p.id)).toThrow('immutable');
    expect(() => store.db.prepare('DELETE FROM baselines WHERE project_id=?').run(p.id)).toThrow('immutable');
  });
  it('preserves committed baselines across restart and new projects', () => {
    mkdirSync(resolve('.cache/tests'), { recursive: true }); const dir = mkdtempSync(resolve('.cache/tests/persistence-'));
    const file = join(dir, 'baseline.sqlite');
    const first = new Store(file); const p = reviewed(first); const baseline = first.commit(p.id, p.revision, confirmationText).baseline; first.close();
    const second = new Store(file);
    try { expect(second.get(p.id).baseline).toEqual(baseline); create(second); expect(second.list()).toHaveLength(2); expect(second.get(p.id).baseline).toEqual(baseline); }
    finally { second.close(); rmSync(dir, { recursive: true, force: true }); }
  });
  it('reset keeps original candidate IDs and inputs but removes the working context', () => {
    const store = newStore(), p = reviewed(store); const reset = store.reset(p.id, p.revision);
    expect(reset.baseline).toBeNull(); expect(reset.review).toBeNull(); expect(reset.conversation).toHaveLength(1);
    expect(reset.draft.candidates.map(c => [c.id, c.source])).toEqual(p.draft.candidates.map(c => [c.id, c.source]));
    expect(reset.draft.candidates.every(c => c.verification === null && c.confirmedException === '')).toBe(true);
  });
});
