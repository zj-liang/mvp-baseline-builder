import { afterEach, describe, expect, it } from 'vitest';
import { Store } from '../server/store.js';
import { confirmationText, conceptReady, ready } from '../shared/domain.js';
import { makeConcept, makeConceptP0Analysis, makeAnalysis, decisionOptions } from './fixtures.js';

const stores: Store[] = [];
function setup() { const store = new Store(':memory:'); stores.push(store); return store; }
const premise = '我想做一个自律监督工具，有玩偶随机巡查，离席会扣心。';
const assertCode = (run: () => unknown, code: string) => expect(run).toThrow(expect.objectContaining({ code }));
function initial(store: Store) { return store.applyConcept(...(() => { const p = store.create({ conceptInput: premise }); return [p.id, p.revision, makeConcept(p)] as const; })()); }
function confirmed(store: Store) {
  let p = initial(store);
  p = store.decisions(p.id, p.revision, [{ issueId: p.intake!.questions[0]!.id, choice: 'A' }]);
  p = store.applyConcept(p.id, p.revision, makeConcept(p));
  return store.confirmConcept(p.id, p.revision);
}
afterEach(() => { for (const store of stores.splice(0)) store.close(); });

describe('Concept-first projects', () => {
  it('saves only the premise, with no early Candidate Draft or Baseline', () => {
    const store = setup(), p = store.create({ conceptInput: premise });
    expect(p.stage).toBe('concept'); expect(p.name).toBe('未命名项目');
    expect(p.intake!.conceptInput).toBe(premise); expect(p.draft.candidates).toEqual([]);
    expect(store.db.prepare('SELECT count(*) AS n FROM drafts').get()!.n).toBe(0);
    expect(store.db.prepare('SELECT count(*) AS n FROM baselines').get()!.n).toBe(0);
    assertCode(() => store.preview(p.id, p.revision), 'concept_unconfirmed');
    assertCode(() => store.commit(p.id, p.revision, confirmationText), 'concept_unconfirmed');
    assertCode(() => store.confirmConcept(p.id, p.revision), 'concept_incomplete');
  });
  it('retains the premise and applies a selected answer only after explicit submission', () => {
    const store = setup(), p = initial(store), q = p.intake!.questions[0]!;
    expect(p.intake!.definition!.productConcept).not.toContain('摄像头');
    expect(p.revision).toBe(2);
    const answered = store.decisions(p.id, p.revision, [{ issueId: q.id, choice: 'A' }]);
    expect(answered.intake!.definition).toEqual(p.intake!.definition);
    expect(answered.conversation.at(-1)!.content).toContain(q.options[0]!.answer);
    const generated = store.applyConcept(p.id, answered.revision, makeConcept(answered));
    expect(generated.intake!.conceptInput).toBe(premise);
    expect(generated.intake!.definition!.productConcept).toContain('摄像头');
    expect(conceptReady(generated.intake)).toBe(true);
  });
  it('rejects forged choice IDs, empty custom answers and stale replies atomically', () => {
    const store = setup(), p = initial(store), q = p.intake!.questions[0]!;
    assertCode(() => store.decisions(p.id, p.revision, [{ issueId: 'forged', choice: 'A' }]), 'issue_not_found');
    assertCode(() => store.decisions(p.id, p.revision, [{ issueId: q.id, choice: 'D', customAnswer: '' }]), 'invalid_choice');
    const saved = store.decisions(p.id, p.revision, [{ issueId: q.id, choice: 'D', customAnswer: '屏幕中的虚拟玩偶，通过摄像头巡查。' }]);
    assertCode(() => store.decisions(p.id, p.revision, [{ issueId: q.id, choice: 'B' }]), 'stale_revision');
    expect(saved.revision).toBe(p.revision + 1);
  });
  it('keeps undecided questions even if the model drops them', () => {
    const store = setup(), p = initial(store), q = p.intake!.questions[0]!;
    const saved = store.decisions(p.id, p.revision, [{ issueId: q.id, choice: 'C' }]);
    const result = makeConcept(saved); result.questions = [];
    const stillPending = store.applyConcept(p.id, saved.revision, result);
    expect(stillPending.intake!.questions[0]!.id).toBe(q.id);
    assertCode(() => store.confirmConcept(p.id, stillPending.revision), 'concept_incomplete');
    const decided = store.decisions(p.id, stillPending.revision, [{ issueId: q.id, choice: 'A' }]);
    const generated = store.applyConcept(p.id, decided.revision, makeConcept(decided));
    expect(conceptReady(generated.intake)).toBe(true);
  });
  it('freezes confirmed P0 IDs and sources and locks the intake stage', () => {
    const store = setup(), p = confirmed(store);
    expect(p.stage).toBe('candidate'); expect(p.name).toBe('自律玩偶');
    expect(p.draft.candidates.map(c => c.id)).toEqual(['P0-1', 'P0-2']);
    assertCode(() => store.saveConcept(p.id, p.revision, { conceptInput: 'new' }), 'concept_locked');
    const d = structuredClone(p.draft); d.candidates.pop();
    assertCode(() => store.save(p.id, p.revision, d), 'protected_fields');
  });
  it('invalidates late concept results after editing and resets only intake work', () => {
    const store = setup(), p = initial(store);
    const edited = store.saveConcept(p.id, p.revision, { conceptInput: '我想做另一个工具。' });
    expect(edited.intake!.definition).toBeNull();
    assertCode(() => store.applyConcept(p.id, p.revision, makeConcept(p)), 'stale_revision');
    const reset = store.reset(p.id, edited.revision);
    expect(reset.intake!.conceptInput).toBe('我想做另一个工具。');
    expect(reset.intake!.questions).toEqual([]); expect(reset.conversation).toHaveLength(1);
  });
  it('keeps candidate indecision blocking all-pass model output', () => {
    const store = setup(), p = confirmed(store), reviewed = store.applyAnalysis(p.id, p.revision, makeConceptP0Analysis(p));
    const q = reviewed.review!.issues[0]!;
    const pending = store.decisions(p.id, reviewed.revision, [{ issueId: q.id, choice: 'C' }]);
    const falselyPassed = makeConceptP0Analysis(pending);
    falselyPassed.issues = []; for (const i of falselyPassed.items) { i.fields.coreRule = '规则'; i.verification = makeAnalysis(p).items[1]!.verification; }
    const blocked = store.applyAnalysis(p.id, pending.revision, falselyPassed);
    expect(ready(blocked.draft, blocked.revision, blocked.review)).toBe(false);
    expect(blocked.review!.issues[0]!.id).toBe(q.id);
    assertCode(() => store.commit(p.id, blocked.revision, confirmationText), 'gates_blocked');
  });
  it('stores confirmed concept in the baseline and excludes work records', () => {
    const store = setup(), p = confirmed(store), reviewed = store.applyAnalysis(p.id, p.revision, makeConceptP0Analysis(p));
    const selected = store.decisions(p.id, reviewed.revision, [{ issueId: reviewed.review!.issues[0]!.id, choice: 'A' }]);
    const readyProject = store.applyAnalysis(p.id, selected.revision, makeConceptP0Analysis(selected));
    const committed = store.commit(p.id, readyProject.revision, confirmationText);
    expect(committed.stage).toBe('committed');
    expect(committed.baseline!.productConcept).toContain('虚拟玩偶');
    expect(committed.baseline!.baselineVersion).toBe('v1');
    expect(JSON.stringify(committed.baseline)).not.toMatch(/conceptInput|questions|decision_holds|options|conversation/);
    assertCode(() => store.feedback(p.id, committed.revision, '修改'), 'read_only');
  });
  it('rejects duplicate options and invalid proposal references without applying output', () => {
    const store = setup(), p = initial(store), result = makeConcept(p);
    result.questions[0]!.options[1]!.key = 'A';
    assertCode(() => store.applyConcept(p.id, p.revision, result), 'invalid_analysis');
    expect(store.get(p.id).revision).toBe(p.revision);
  });
  it('never applies conflict choices through ordinary answer submission', () => {
    const store = setup(), p = store.create({ name: 'conflict', productDescription: 'product', coreUserGoal: 'goal', features: ['one', 'two', 'three'] });
    const reviewed = store.applyAnalysis(p.id, p.revision, makeAnalysis(p, true)), q = reviewed.review!.issues[0]!;
    assertCode(() => store.decisions(p.id, reviewed.revision, [{ issueId: q.id, choice: 'A' }]), 'proposal_confirmation_required');
    const custom = store.decisions(p.id, reviewed.revision, [{ issueId: q.id, choice: 'D', customAnswer: '我希望只在普通状态扣心。' }]);
    expect(custom.draft.candidates.every(c => !c.confirmedException)).toBe(true);
  });
  it('reads legacy drafts and reviews without rewriting committed payloads', () => {
    const store = setup(), p = store.create({ name: 'legacy', productDescription: 'product', coreUserGoal: 'goal', features: ['one'] });
    const legacyDraft = { ...p.draft } as Partial<typeof p.draft>; delete legacyDraft.productConcept;
    store.db.prepare('UPDATE drafts SET payload=? WHERE project_id=?').run(JSON.stringify(legacyDraft), p.id);
    expect(store.get(p.id).draft.productConcept).toBe('');
    const reviewed = store.applyAnalysis(p.id, p.revision, makeAnalysis(p));
    const oldBaseline = { productDescription: 'old', coreUserGoal: 'old goal', baselineVersion: 'v1', createdAt: '2026-01-01', p0Items: reviewed.draft.candidates.map(({ source, ...c }) => c) };
    const original = JSON.stringify(oldBaseline);
    store.db.prepare('INSERT INTO baselines VALUES(?,?,?)').run(p.id, reviewed.revision, original);
    expect(store.get(p.id).baseline).toEqual(oldBaseline);
    expect(store.db.prepare('SELECT payload FROM baselines WHERE project_id=?').get(p.id)!.payload).toBe(original);
    const other = store.create({ conceptInput: premise }); expect(other.stage).toBe('concept');
    expect(store.db.prepare('SELECT payload FROM baselines WHERE project_id=?').get(p.id)!.payload).toBe(original);
  });
  it('preserves manual concept adjustments, and resets candidate IDs without deleting them', () => {
    const store = setup(), p = confirmed(store), d = structuredClone(p.draft);
    d.productConcept += ' 界面使用纸片玩偶。';
    const saved = store.save(p.id, p.revision, d);
    const reset = store.reset(p.id, saved.revision);
    expect(reset.draft.productConcept).toContain('纸片玩偶');
    expect(reset.draft.candidates.map(c => [c.id, c.source])).toEqual(p.draft.candidates.map(c => [c.id, c.source]));
  });
});
