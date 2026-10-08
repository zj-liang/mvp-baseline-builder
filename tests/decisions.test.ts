import { afterEach, describe, expect, it } from 'vitest';
import { Store } from '../server/store.js';
import { proposalConfirmationText } from '../shared/domain.js';
import { makeBatchAnalysis, makeConcept, resolutions } from './fixtures.js';

const stores: Store[] = [];
afterEach(() => { for (const s of stores.splice(0)) s.close(); });
function setup() {
  const store = new Store(':memory:'); stores.push(store);
  const p = store.create({ name: '批量决策测试', productDescription: 'product', coreUserGoal: 'goal', features: ['one', 'two', 'three'] });
  const reviewed = store.applyAnalysis(p.id, p.revision, makeBatchAnalysis(p));
  const answers = reviewed.review!.issues.filter(i => i.kind !== 'conflict').map(i => ({ issueId: i.id, choice: 'A' }));
  const acceptances = reviewed.review!.issues.filter(i => i.kind === 'conflict').map(i => ({ issueId: i.id, proposalId: i.proposals[0]!.id }));
  return { store, reviewed, answers, acceptances };
}
describe('Concentrated decisions', () => {
  it('saves four answers and two overlapping proposals in one revision and invalidates review', () => {
    const { store, reviewed: p, answers, acceptances } = setup();
    const saved = store.decisions(p.id, p.revision, answers, [...acceptances].reverse(), proposalConfirmationText);
    expect(saved.revision).toBe(p.revision + 1); expect(saved.review).toBeNull(); expect(saved.baseline).toBeNull();
    const rule = saved.draft.candidates[1]!.confirmedException;
    expect(rule.indexOf('第一条解决规则')).toBeLessThan(rule.indexOf('第二条解决规则'));
    expect(saved.conversation.filter(c => c.role === 'user' && c.content.includes('批量决定'))).toHaveLength(4);
    expect(store.db.prepare('SELECT count(*) AS n FROM proposals WHERE accepted_at IS NOT NULL').get()!.n).toBe(2);
    expect(() => store.preview(p.id, saved.revision)).toThrow(expect.objectContaining({ code: 'gates_blocked' }));
    expect(() => store.decisions(p.id, p.revision, answers)).toThrow(expect.objectContaining({ code: 'stale_revision' }));
  });
  it('requires explicit proposal confirmation, including a proposal-only batch', () => {
    const { store, reviewed: p, acceptances } = setup();
    expect(() => store.decisions(p.id, p.revision, [], acceptances)).toThrow(expect.objectContaining({ code: 'proposal_confirmation_required' }));
    expect(store.get(p.id)).toEqual(p);
    expect(store.decisions(p.id, p.revision, [], acceptances, proposalConfirmationText).revision).toBe(p.revision + 1);
  });
  it('rolls back answers, holds and an earlier valid acceptance when a later proposal is forged', () => {
    const { store, reviewed: p, answers, acceptances } = setup();
    const mixed = [...answers]; mixed[0]!.choice = 'C';
    expect(() => store.decisions(p.id, p.revision, mixed, [acceptances[0]!, { ...acceptances[1]!, proposalId: 'forged' }], proposalConfirmationText)).toThrow(expect.objectContaining({ code: 'stale_proposal' }));
    expect(store.get(p.id)).toEqual(p);
    expect(store.db.prepare('SELECT count(*) AS n FROM decision_holds').get()!.n).toBe(0);
    expect(store.db.prepare('SELECT count(*) AS n FROM proposals WHERE accepted_at IS NOT NULL').get()!.n).toBe(0);
  });
  it('rejects duplicate issue submissions and proposals from another conflict', () => {
    const { store, reviewed: p, answers, acceptances } = setup();
    expect(() => store.decisions(p.id, p.revision, [answers[0], answers[0]])).toThrow(expect.objectContaining({ code: 'invalid_answers' }));
    expect(() => store.decisions(p.id, p.revision, [], [{ issueId: acceptances[0]!.issueId, proposalId: acceptances[1]!.proposalId }], proposalConfirmationText)).toThrow(expect.objectContaining({ code: 'stale_proposal' }));
    expect(store.get(p.id)).toEqual(p);
  });
  it('keeps more than two concept questions and accepts all four together', () => {
    const store = new Store(':memory:'); stores.push(store);
    const p = store.create({ conceptInput: '一个模糊设想' }); const output = makeConcept(p);
    output.questions = Array.from({ length: 4 }, (_, i) => ({ ...output.questions[0]!, title: `整体决定 ${i}`, question: `整体问题 ${i}？` }));
    const generated = store.applyConcept(p.id, p.revision, output);
    expect(generated.intake!.questions).toHaveLength(4);
    const answered = store.decisions(p.id, generated.revision, generated.intake!.questions.map(q => ({ issueId: q.id, choice: 'C' })));
    output.questions = [];
    const pending = store.applyConcept(p.id, answered.revision, output);
    expect(pending.intake!.questions).toHaveLength(4);
    expect(() => store.confirmConcept(p.id, pending.revision)).toThrow(expect.objectContaining({ code: 'concept_incomplete' }));
    const resolved = store.decisions(p.id, pending.revision, pending.intake!.questions.map(q => ({ issueId: q.id, choice: 'D', customAnswer: '这是明确的用户决定。' })));
    output.resolvedQuestions = resolutions(resolved);
    expect(store.applyConcept(p.id, resolved.revision, output).intake!.questions).toEqual([]);
  });
});
