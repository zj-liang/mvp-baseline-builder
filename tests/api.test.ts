import { describe, expect, it } from 'vitest';
import { Store } from '../server/store.js';
import { buildApp } from '../server/app.js';
import { fixtureAuth, fixtureProvider, makeAnalysis, makeConcept, makeBatchAnalysis } from './fixtures.js';
import { proposalConfirmationText } from '../shared/domain.js';
import type { Provider } from '../server/provider.js';
import type { Analysis, ConceptAnalysis } from '../shared/domain.js';

async function setup(provider: Provider = fixtureProvider) {
  const store = new Store(':memory:'); const app = await buildApp({ store, auth: fixtureAuth, provider });
  const boot = await app.inject({ url: '/', headers: { host: '127.0.0.1:3000' } });
  const cookie = String(boot.headers['set-cookie']).split(';')[0]!;
  const headers = { host: '127.0.0.1:3000', origin: 'http://127.0.0.1:3000', cookie };
  return { store, app, headers };
}
describe('Local API boundaries and failure preservation', () => {
  it('accepts a mixed batch through the API only with explicit confirmation and preserves old clients', async () => {
    const { app, store, headers } = await setup();
    try {
      const p = store.create({ name: '批量决策测试', productDescription: 'product', coreUserGoal: 'goal', features: ['one', 'two', 'three'] });
      const reviewed = store.applyAnalysis(p.id, p.revision, makeBatchAnalysis(p));
      const payload = { revision: reviewed.revision, answers: reviewed.review!.issues.filter(i => i.kind !== 'conflict').map(i => ({ issueId: i.id, choice: 'A' })),
        proposalAcceptances: reviewed.review!.issues.filter(i => i.kind === 'conflict').map(i => ({ issueId: i.id, proposalId: i.proposals[0]!.id })) };
      const url = `/api/projects/${p.id}/decisions`;
      expect((await app.inject({ method: 'POST', url, headers, payload })).statusCode).toBe(409);
      expect(store.get(p.id)).toEqual(reviewed);
      const saved = await app.inject({ method: 'POST', url, headers, payload: { ...payload, confirmation: proposalConfirmationText } });
      expect(saved.statusCode).toBe(200); expect(saved.json().revision).toBe(reviewed.revision + 1);
      expect((await app.inject({ method: 'POST', url, headers, payload: { ...payload, confirmation: proposalConfirmationText } })).statusCode).toBe(409);
    } finally { await app.close(); store.close(); }
  });
  it('supports the complete concept API and rejects an unconfirmed commit', async () => {
    const { app, store, headers } = await setup();
    try {
      const response = await app.inject({ method: 'POST', url: '/api/projects', headers, payload: { conceptInput: '有玩偶随机巡查，离席会扣心。' } });
      expect(response.statusCode).toBe(200); const p = response.json();
      expect((await app.inject({ method: 'POST', url: `/api/projects/${p.id}/commit`, headers, payload: { revision: p.revision, confirmation: '这就是我希望实现的第一版 MVP 产品逻辑。' } })).statusCode).toBe(409);
      const generated = (await app.inject({ method: 'POST', url: `/api/projects/${p.id}/concept/analyze`, headers, payload: { revision: p.revision } })).json();
      const q = generated.intake.questions[0];
      const answered = (await app.inject({ method: 'POST', url: `/api/projects/${p.id}/decisions`, headers, payload: { revision: generated.revision, answers: [{ issueId: q.id, choice: 'A' }] } })).json();
      const analyzed = (await app.inject({ method: 'POST', url: `/api/projects/${p.id}/concept/analyze`, headers, payload: { revision: answered.revision } })).json();
      const confirmed = await app.inject({ method: 'POST', url: `/api/projects/${p.id}/concept/confirm`, headers, payload: { revision: analyzed.revision, confirmed: true } });
      expect(confirmed.statusCode).toBe(200); expect(confirmed.json().stage).toBe('candidate');
      expect(store.get(p.id).draft.productConcept).toContain('虚拟玩偶');
      const feedback = await app.inject({ method: 'POST', url: `/api/projects/${p.id}/feedback`, headers, payload: { revision: confirmed.json().revision, feedback: '巡查反馈希望更温和。' } });
      expect(feedback.statusCode).toBe(200); expect(feedback.json().conversation.at(-1).content).toContain('更温和');
    } finally { await app.close(); store.close(); }
  });
  it('preserves a saved premise when the concept provider fails', async () => {
    const { app, store, headers } = await setup({ ...fixtureProvider, async developConcept() { throw new Error('private-runtime-detail'); } });
    try {
      const p = store.create({ conceptInput: '一个模糊设想' });
      const response = await app.inject({ method: 'POST', url: `/api/projects/${p.id}/concept/analyze`, headers, payload: { revision: p.revision } });
      expect(response.statusCode).toBe(500); expect(response.body).not.toContain('private-runtime-detail');
      expect(store.get(p.id)).toEqual(p);
    } finally { await app.close(); store.close(); }
  });
  it('rejects cancelled and late concept results', async () => {
    let release!: (result: ConceptAnalysis) => void, started!: () => void;
    let didStart = new Promise<void>(resolve => { started = resolve; });
    const { app, store, headers } = await setup({ ...fixtureProvider, async developConcept() { started(); return new Promise(resolve => { release = resolve; }); } });
    try {
      const p = store.create({ conceptInput: '有玩偶巡查。' });
      const pending = app.inject({ method: 'POST', url: `/api/projects/${p.id}/concept/analyze`, headers, payload: { revision: p.revision } }).then(r => r);
      await didStart; store.saveConcept(p.id, p.revision, { conceptInput: '新的设想。' }); release(makeConcept(p));
      expect((await pending).statusCode).toBe(409); expect(store.get(p.id).intake!.conceptInput).toBe('新的设想。');
      didStart = new Promise<void>(resolve => { started = resolve; }); const current = store.get(p.id);
      const cancelled = app.inject({ method: 'POST', url: `/api/projects/${p.id}/concept/analyze`, headers, payload: { revision: current.revision } }).then(r => r);
      await didStart;
      await app.inject({ method: 'POST', url: `/api/projects/${p.id}/cancel`, headers, payload: {} }); release(makeConcept(current));
      expect((await cancelled).json().error.code).toBe('analysis_cancelled');
      expect(store.get(p.id).revision).toBe(current.revision);
    } finally { await app.close(); store.close(); }
  });
  it('validates inference options and forwards the selected model without changing product fields', async () => {
    const calls: unknown[] = [];
    const { app, store, headers } = await setup({ async catalog() { return { models: [{ slug: 'gpt-6.1-sol', displayName: 'Sol' }], defaultModel: 'gpt-6.1-sol' }; }, async analyze(p, _signal, inference) { calls.push(inference); return makeAnalysis(p); } });
    try {
      const p = store.create({ name: 'test', productDescription: 'product', coreUserGoal: 'scenario', features: ['one'] });
      expect((await app.inject({ url: '/api/models', headers })).json().defaultModel).toBe('gpt-6.1-sol');
      const bad = await app.inject({ method: 'POST', url: `/api/projects/${p.id}/analyze`, headers, payload: { revision: p.revision, inference: { effort: 'unlimited' } } });
      expect(bad.statusCode).toBe(400); expect(calls).toHaveLength(0); expect(store.get(p.id).revision).toBe(p.revision);
      const response = await app.inject({ method: 'POST', url: `/api/projects/${p.id}/analyze`, headers, payload: { revision: p.revision, inference: { model: 'gpt-6.1-sol', effort: 'high' } } });
      expect(response.statusCode).toBe(200); expect(calls).toEqual([{ model: 'gpt-6.1-sol', effort: 'high' }]);
      expect(JSON.stringify(store.preview(p.id, store.get(p.id).revision))).not.toContain('effort');
    } finally { await app.close(); store.close(); }
  });
  it('rejects cross-origin writes, missing sessions and DNS rebinding hosts', async () => {
    const { app, store, headers } = await setup();
    try {
      expect((await app.inject({ method: 'POST', url: '/api/projects', headers: { ...headers, origin: 'https://untrusted.example' }, payload: {} })).statusCode).toBe(403);
      expect((await app.inject({ url: '/api/auth', headers: { host: headers.host } })).statusCode).toBe(403);
      expect((await app.inject({ url: '/', headers: { host: 'untrusted.example' } })).statusCode).toBe(403);
      expect(JSON.stringify((await app.inject({ url: '/api/auth', headers })).json())).not.toMatch(/accessToken|refreshToken|id_token|credentials/);
    } finally { await app.close(); store.close(); }
  });
  it('keeps saved drafts unchanged after provider failure', async () => {
    const { app, store, headers } = await setup({ async analyze() { throw new Error('synthetic-secret-not-for-ui'); } });
    try {
      const p = store.create({ name: 'test', productDescription: 'product', coreUserGoal: 'scenario', features: ['one'] });
      const response = await app.inject({ method: 'POST', url: `/api/projects/${p.id}/analyze`, headers, payload: { revision: p.revision } });
      expect(response.statusCode).toBe(500); expect(response.body).not.toContain('synthetic-secret-not-for-ui');
      expect(store.get(p.id).draft).toEqual(p.draft); expect(store.get(p.id).baseline).toBeNull(); expect(store.get(p.id).review).toBeNull();
    } finally { await app.close(); store.close(); }
  });
  it('does not apply a late analysis after an edit', async () => {
    let release!: (analysis: Analysis) => void;
    let started!: () => void;
    const didStart = new Promise<void>(resolve => { started = resolve; });
    const { app, store, headers } = await setup({ analyze: async () => { started(); return new Promise<Analysis>(resolve => { release = resolve; }); } });
    try {
      const p = store.create({ name: 'test', productDescription: 'product', coreUserGoal: 'scenario', features: ['one'] });
      const request = app.inject({ method: 'POST', url: `/api/projects/${p.id}/analyze`, headers, payload: { revision: p.revision } });
      const pending = request.then(response => response);
      await didStart;
      const edited = structuredClone(p.draft); edited.productDescription = '新的描述'; store.save(p.id, p.revision, edited);
      release(makeAnalysis(p));
      expect((await pending).statusCode).toBe(409); expect(store.get(p.id).draft.productDescription).toBe('新的描述');
    } finally { await app.close(); store.close(); }
  });
  it('never applies a cancelled result even when a provider returns it late', async () => {
    let release!: (analysis: Analysis) => void;
    let started!: () => void;
    const didStart = new Promise<void>(resolve => { started = resolve; });
    const { app, store, headers } = await setup({ async analyze() { started(); return new Promise<Analysis>(resolve => { release = resolve; }); } });
    try {
      const p = store.create({ name: 'test', productDescription: 'product', coreUserGoal: 'scenario', features: ['one'] });
      const pending = app.inject({ method: 'POST', url: `/api/projects/${p.id}/analyze`, headers, payload: { revision: p.revision } }).then(response => response);
      await didStart;
      expect((await app.inject({ method: 'POST', url: `/api/projects/${p.id}/cancel`, headers, payload: {} })).statusCode).toBe(200);
      release(makeAnalysis(p));
      const response = await pending;
      expect(response.statusCode).toBe(409); expect(response.json().error.code).toBe('analysis_cancelled');
      expect(store.get(p.id).revision).toBe(p.revision); expect(store.get(p.id).review).toBeNull();
    } finally { await app.close(); store.close(); }
  });
});
