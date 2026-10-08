import { describe, expect, it, vi } from 'vitest';
import { Store } from '../server/store.js';
import { buildApp } from '../server/app.js';
import { ChatGPTProvider, additionInstructions } from '../server/provider.js';
import type { ChatGPTClient } from '@siwc/local';
import type { AdditionAnalysis } from '../shared/domain.js';
import { confirmationText, evolutionConfirmationText } from '../shared/domain.js';
import { fixtureAuth, fixtureProvider, makeAnalysis, makeAdditionAnalysis, makeAdditionReviewResponse, makeIntegration } from './fixtures.js';
import { candidate } from './addition-helpers.js';
import { ModelValidationError } from '../server/errors.js';

const assessment: AdditionAnalysis = { items: [{ kind: 'new_p0', name: '暂停监督', description: '主动暂停监督', targetP0Id: null, relatedP0Ids: ['P0-1'], reason: '独立的主动控制能力', question: '' }] };
const setup = () => {
  const store = new Store(':memory:');
  let p = store.create({ name: 'api演化', productDescription: '监督', coreUserGoal: '专注', features: ['监督'] });
  p = store.applyAnalysis(p.id, p.revision, makeAnalysis(p));
  return { store, p: store.commit(p.id, p.revision, confirmationText) };
};
describe('Feature addition API and structured provider', () => {
  it.each(['cancel','stale','invalid'] as const)('relationship %s preserves draft and records only safe diagnostics', async mode => {
    const { store, p } = setup(); const started = candidate(store, p);
    let complete!: (value: import('../shared/domain.js').IntegrationAnalysis) => void;
    let reject!: (error: unknown) => void;
    const app = await buildApp({ store, auth: fixtureAuth, provider: { ...fixtureProvider, reviewIntegration: async () => new Promise((resolve, fail) => { complete = resolve; reject = fail; }) } });
    try {
      const boot = await app.inject({ url: '/', headers: { host: '127.0.0.1:3000' } });
      const headers = { host: '127.0.0.1:3000', origin: 'http://127.0.0.1:3000', cookie: String(boot.headers['set-cookie']).split(';')[0]! };
      const path = '/api/projects/' + p.id;
      const pending = app.inject({ method: 'POST', url: path + '/integration/analyze', headers, payload: { revision: started.revision } });
      await vi.waitFor(() => expect(complete).toBeTypeOf('function'));
      if (mode === 'cancel') await app.inject({ method: 'POST', url: path + '/cancel', headers, payload: {} });
      if (mode === 'stale') store.discardAddition(p.id, started.revision);
      const saved = store.get(p.id);
      if (mode === 'invalid') reject(new ModelValidationError('feature_integration','schema',[['issues',0,'synthetic-secret']])); else complete(makeIntegration(started));
      const response = await pending;
      expect(response.json().error.code).toBe(mode === 'cancel' ? 'analysis_cancelled' : mode === 'stale' ? 'read_only' : 'invalid_analysis');
      expect(store.get(p.id)).toEqual(saved);
      const failures = store.db.prepare('SELECT payload FROM inference_failures').all();
      if (mode === 'invalid') { expect(failures).toHaveLength(1); expect(String(failures[0]!.payload)).toContain('issues.0.*'); expect(JSON.stringify(failures)).not.toContain('synthetic-secret'); }
      else expect(failures).toHaveLength(0);
    } finally { await app.close(); store.close(); }
  });
  it('sends saved baseline and request with strict schema and supplies full drafts to subsequent reviews', async () => {
    const { store, p } = setup();
    try {
      const started = store.startAddition(p.id, p.revision, '暂停监督');
      const mock = { listModels: vi.fn().mockResolvedValue([{ slug: 'gpt-6.1-sol' }]), streamResponse: vi.fn().mockResolvedValue({ text: JSON.stringify(assessment) }) };
      const provider = new ChatGPTProvider(mock as unknown as ChatGPTClient);
      await provider.assessAddition(started, new AbortController().signal);
      const request = mock.streamResponse.mock.calls[0]![0];
      expect(request.instructions).toBe(additionInstructions); expect(request.text.format.strict).toBe(true);
      expect(JSON.parse(request.input[0].content)).toEqual({ baseline: p.baseline, request: '暂停监督' });
      expect(JSON.stringify(request.text.format.schema)).not.toContain('oneOf');
      const c = store.confirmAddition(p.id, store.applyAdditionAssessment(p.id, started.revision, assessment).revision);
      mock.streamResponse.mockResolvedValueOnce({ text: JSON.stringify(makeIntegration(c)) });
      const integrated=store.applyIntegration(c.id,c.revision,await provider.reviewIntegration(c,new AbortController().signal));
      expect(integrated.stage).toBe('candidate');
      mock.streamResponse.mockResolvedValueOnce({ text: JSON.stringify(makeAdditionReviewResponse(integrated)) });
      const checked=store.applyAnalysis(c.id,integrated.revision,await provider.analyze(integrated,new AbortController().signal));
      expect(store.preview(c.id, checked.revision).baselineVersion).toBe('v2');
      expect(store.commit(c.id, checked.revision, evolutionConfirmationText).baseline!.baselineVersion).toBe('v2');
      expect(store.readBaseline(c.id, 'v1')).toEqual(p.baseline);
      const input = JSON.parse(mock.streamResponse.mock.calls[1]![0].input[0].content);
      expect(input.draft.candidates).toHaveLength(2); expect(input.baseline).toEqual(p.baseline); expect(input.addition.members).toEqual(c.addition!.members);
      mock.streamResponse.mockResolvedValueOnce({ text: '{}' });
      await expect(provider.assessAddition(started, new AbortController().signal)).rejects.toMatchObject({ code: 'invalid_analysis' });
    } finally { store.close(); }
  });
  it('enforces session/origin, explicit membership confirmation, snapshot reading and stale preview rejection', async () => {
    const { store, p } = setup(), app = await buildApp({ store, auth: fixtureAuth, provider: fixtureProvider });
    try {
      const boot = await app.inject({ url: '/', headers: { host: '127.0.0.1:3000' } });
      const headers = { host: '127.0.0.1:3000', origin: 'http://127.0.0.1:3000', cookie: String(boot.headers['set-cookie']).split(';')[0]! };
      const path = '/api/projects/' + p.id;
      expect((await app.inject({ method: 'POST', url: path + '/addition', headers: { ...headers, origin: 'https://example.test' }, payload: { revision: p.revision, request: '暂停监督' } })).statusCode).toBe(403);
      let current = (await app.inject({ method: 'POST', url: path + '/addition', headers, payload: { revision: p.revision, request: '暂停监督' } })).json();
      expect((await app.inject({ method: 'POST', url: path + '/addition/confirm', headers, payload: { revision: current.revision, confirmed: true } })).statusCode).toBe(409);
      current = (await app.inject({ method: 'POST', url: path + '/addition/analyze', headers, payload: { revision: current.revision } })).json();
      expect((await app.inject({ method: 'POST', url: path + '/addition/confirm', headers, payload: { revision: current.revision, confirmed: false } })).statusCode).not.toBe(200);
      current = (await app.inject({ method: 'POST', url: path + '/addition/confirm', headers, payload: { revision: current.revision, confirmed: true } })).json();
      expect((await app.inject({method:'POST',url:path+'/analyze',headers,payload:{revision:current.revision}})).statusCode).toBe(409);
      current=(await app.inject({method:'POST',url:path+'/integration/analyze',headers,payload:{revision:current.revision}})).json();
      expect(current.stage).toBe('candidate');
      current=(await app.inject({method:'POST',url:path+'/analyze',headers,payload:{revision:current.revision}})).json();
      const preview = await app.inject({ url: path + '/preview?revision=' + current.revision, headers });
      expect(preview.json().baselineVersion).toBe('v2');
      const edited = store.save(p.id, current.revision, { ...current.draft, coreUserGoal: '用户更新目标' });
      const stale = await app.inject({ method: 'POST', url: path + '/commit', headers, payload: { revision: current.revision, confirmation: evolutionConfirmationText } });
      expect(stale.json().error.code).toBe('stale_revision'); expect(store.get(p.id).baseline).toEqual(p.baseline);
      expect((await app.inject({ url: path + '/baselines/v1', headers })).json()).toEqual(p.baseline);
      expect((await app.inject({ url: path + '/baselines/v2', headers })).statusCode).toBe(404);
      expect((await app.inject({ url: path + '/baselines/v9007199254740992', headers })).json().error.code).toBe('invalid_version');
      const ready = store.applyAnalysis(p.id, edited.revision, makeAdditionAnalysis(edited));
      const done = await app.inject({ method: 'POST', url: path + '/commit', headers, payload: { revision: ready.revision, confirmation: evolutionConfirmationText } });
      expect(done.statusCode).toBe(200); expect(done.json().baseline.baselineVersion).toBe('v2');
      expect((await app.inject({ url: path + '/baselines/v2', headers })).json()).toEqual(done.json().baseline);
    } finally { await app.close(); store.close(); }
  });
  it('never applies a cancelled classifier result, including a provider returning after cancellation', async () => {
    const { store, p } = setup(); let complete!: (value: AdditionAnalysis) => void;
    const started = store.startAddition(p.id, p.revision, '暂停监督');
    const app = await buildApp({ store, auth: fixtureAuth, provider: { ...fixtureProvider, assessAddition: async () => new Promise(resolve => { complete = resolve; }) } });
    try {
      const boot = await app.inject({ url: '/', headers: { host: '127.0.0.1:3000' } });
      const headers = { host: '127.0.0.1:3000', origin: 'http://127.0.0.1:3000', cookie: String(boot.headers['set-cookie']).split(';')[0]! };
      const path = '/api/projects/' + p.id;
      const pending = app.inject({ method: 'POST', url: path + '/addition/analyze', headers, payload: { revision: started.revision } });
      await vi.waitFor(() => expect(complete).toBeTypeOf('function'));
      await app.inject({ method: 'POST', url: path + '/cancel', headers, payload: {} });
      complete(assessment);
      expect((await pending).json().error.code).toBe('analysis_cancelled'); expect(store.get(p.id)).toEqual(started);
    } finally { await app.close(); store.close(); }
  });
});
