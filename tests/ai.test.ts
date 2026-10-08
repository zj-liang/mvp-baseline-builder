import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { rename } from 'node:fs/promises';
import type { CredentialEncryption } from '@siwc/local';
import { AIConnections } from '../server/ai-connections.js';
import { windowsCredentialEncryption } from '../server/auth.js';
import { ConnectionStore } from '../vendor/siwc-local/src/storage.js';
import { APITransport, readModelStream } from '../server/api-transport.js';
import { TaskProvider } from '../server/provider.js';
import { AIProvider } from '../server/ai-provider.js';
import { buildApp } from '../server/app.js';
import { Store } from '../server/store.js';
import { AppError } from '../server/errors.js';
import { glmModels, openAIModel, supportsOpenAIResponses } from '../server/model-capabilities.js';
import { fixtureAuth, fixtureProvider, makeAnalysis, makeConcept, makeAdditionAnalysis, makeAdditionReviewResponse, makeIntegration } from './fixtures.js';
import { confirmationText, evolutionConfirmationText } from '../shared/domain.js';
import type { ConnectionId } from '../shared/inference.js';

vi.mock('node:fs/promises', async load => {
  const actual = await load<typeof import('node:fs/promises')>();
  return { ...actual, rename: vi.fn(actual.rename) };
});

const directories: string[] = [];
const directory = () => { mkdirSync(resolve('.cache/tests'), { recursive: true }); const dir = mkdtempSync(resolve('.cache/tests/ai-test-')); directories.push(dir); return dir; };
afterEach(() => { vi.restoreAllMocks(); for (const dir of directories.splice(0)) { if (dirname(dir) !== resolve('.cache/tests')) throw new Error('Unsafe cleanup'); rmSync(dir, { recursive: true, force: true }); } });
const synthetic = 'synthetic-key-not-an-account';
const testEncryption: CredentialEncryption = { id: 'test-only', isAvailable: () => true,
  encrypt: text => Buffer.from(text).map(byte => byte ^ 0xa5), decrypt: bytes => Buffer.from(bytes).map(byte => byte ^ 0xa5).toString() };
const stream = (frames: Array<unknown | '[DONE]'>) => new Response(frames.map(frame => 'data: ' + (frame === '[DONE]' ? frame : JSON.stringify(frame)) + '\r\n\r\n').join(''), { headers: { 'content-type': 'text/event-stream' } });
const responses = (text: string) => stream([{ type: 'response.output_text.delta', delta: text }, { type: 'response.completed', response: { status: 'completed' } }]);
const chat = (text: string) => stream([{ choices: [{ index: 0, delta: { reasoning_content: 'TEST reasoning never becomes product content', content: text } }] }, { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }, '[DONE]']);
const models = (id: ConnectionId) => new Response(JSON.stringify({ data: [{ id: id === 'openai' ? 'gpt-6.1-sol' : 'deepseek-flash', effort: { supported_levels: ['low', 'high', 'max'], default_level: 'high' } }] }), { headers: { 'content-type': 'application/json' } });

describe('Encrypted model connections', () => {
  it.skipIf(process.platform !== 'win32')('bounds transient Windows ciphertext replacement retries and preserves data on permanent failure', async () => {
    const dir = directory(), storage = new AIConnections(dir, testEncryption), replace = vi.mocked(rename);
    await storage.saveKey('openai', synthetic);
    replace.mockClear();
    replace.mockRejectedValueOnce(Object.assign(new Error('TEST occupied ciphertext'), { code: 'EPERM' }));
    await storage.saveKey('openai', 'synthetic-replacement');
    expect(replace).toHaveBeenCalledTimes(2);
    expect(replace.mock.calls[0]).toEqual(replace.mock.calls[1]);
    expect(await storage.key('openai')).toBe('synthetic-replacement');
    const before = readFileSync(join(dir, 'model-api-keys.json'), 'utf8');
    replace.mockClear();
    for (let i = 0; i < 5; i++) replace.mockRejectedValueOnce(Object.assign(new Error('TEST persistent permission failure'), { code: 'EPERM' }));
    await expect(storage.saveKey('openai', 'must-not-replace')).rejects.toMatchObject({ code: 'ai_storage_failed', cause: { code: 'EPERM' } });
    expect(replace).toHaveBeenCalledTimes(5); expect(readFileSync(join(dir, 'model-api-keys.json'), 'utf8')).toBe(before);
    replace.mockClear(); replace.mockRejectedValueOnce(Object.assign(new Error('TEST full disk'), { code: 'ENOSPC' }));
    await expect(storage.saveKey('openai', 'must-not-replace')).rejects.toMatchObject({ code: 'ai_storage_failed' });
    expect(replace).toHaveBeenCalledOnce(); expect(await storage.key('openai')).toBe('synthetic-replacement');
  });
  it('keeps simultaneous ChatGPT and API locks independent in the same credential directory', async () => {
    const dir = directory(), chatgpt = new ConnectionStore(dir, testEncryption), api = new AIConnections(dir, testEncryption);
    let unlock!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { unlock = resolve; });
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const holding = chatgpt.withLock(async () => { entered(); await gate; });
    try {
      await ready;
      await api.saveKey('deepseek', synthetic);
      await api.preferences('deepseek', 'deepseek', { connectionId: 'deepseek', model: 'deepseek-flash' });
      expect(await api.key('deepseek')).toBe(synthetic);
      expect(existsSync(join(dir, '.chatgpt-auth.lock'))).toBe(true);
      unlock(); await holding;
      expect(existsSync(join(dir, '.chatgpt-auth.lock'))).toBe(false);
      expect(existsSync(join(dir, 'model-api-keys.json.lock'))).toBe(false);
      await chatgpt.withLock(async () => expect((await api.state()).activeConnectionId).toBe('deepseek'));
    } finally { unlock(); await holding.catch(() => {}); }
  });
  it('uses real Windows DPAPI, restores preferences and keys without exposing plaintext, and removes only the selected key', async () => {
    const dir = directory(), saved = new AIConnections(dir, windowsCredentialEncryption);
    await saved.saveKey('openai', synthetic); await saved.saveKey('deepseek', 'synthetic-deepseek');
    await saved.preferences('openai', 'openai', { connectionId: 'openai', model: 'gpt-6.1-sol', effort: 'high' });
    const ciphertext = readFileSync(join(dir, 'model-api-keys.json'), 'utf8'); expect(ciphertext).not.toContain(synthetic);
    const restored = new AIConnections(dir, windowsCredentialEncryption);
    expect(await restored.key('openai')).toBe(synthetic); expect((await restored.state()).activeConnectionId).toBe('openai');
    expect(JSON.stringify(await restored.state())).not.toContain(synthetic);
    await restored.removeKey('openai'); await expect(restored.key('openai')).rejects.toMatchObject({ code: 'api_key_required' });
    expect(await restored.key('deepseek')).toBe('synthetic-deepseek');
  }, 30000);
  it('preserves ciphertext and prior key if encryption fails, and serializes concurrent updates', async () => {
    let fail = false; const dir = directory();
    const storage = new AIConnections(dir, { ...testEncryption, encrypt: text => { if (fail) throw new Error('synthetic failure'); return testEncryption.encrypt(text); } });
    await storage.saveKey('openai', synthetic); const before = readFileSync(join(dir, 'model-api-keys.json'), 'utf8');
    fail = true; await expect(storage.saveKey('openai', 'replacement')).rejects.toMatchObject({ code: 'ai_storage_failed' });
    expect(readFileSync(join(dir, 'model-api-keys.json'), 'utf8')).toBe(before); fail = false;
    expect(await storage.key('openai')).toBe(synthetic);
    await Promise.all([storage.saveKey('glm', 'synthetic-glm'), storage.saveKey('deepseek', 'synthetic-deepseek')]);
    expect((await storage.state()).connections.filter(c => c.configured)).toHaveLength(3);
    expect(() => storage.saveKey('chatgpt', synthetic)).toThrow(expect.objectContaining({ code: 'invalid_connection' }));
  });
});

describe.each(['openai', 'deepseek', 'glm'] as const)('%s official API transport', id => {
  it('uses the same three task inputs and strict local schemas, without sending credentials as product input', async () => {
    const store = new Store(':memory:');
    try {
      const concept = store.create({ conceptInput: '监督工具，有玩偶随机巡查，离席扣心。' });
      const p = store.create({ name: 'api product', productDescription: '监督', coreUserGoal: '专注', features: ['监督'] });
      const initial = store.applyAnalysis(p.id, p.revision, makeAnalysis(p));
      const committed = store.commit(p.id, initial.revision, confirmationText);
      const addition = store.startAddition(p.id, committed.revision, '增加暂停操作');
      const classification = { items: [{ kind: 'new_p0' as const, name: '暂停', description: '主动暂停', targetP0Id: null, relatedP0Ids: ['P0-1'], reason: '独立操作', question: '' }] };
      const candidate = store.confirmAddition(p.id, store.applyAdditionAssessment(p.id, addition.revision, classification).revision);
      const outputs = [makeConcept(concept), makeAdditionReviewResponse(p), classification, makeIntegration(candidate)];
      const calls: Array<{ url: string; body: any; options: RequestInit }> = [];
      const fetcher = vi.fn(async (url: string | URL | Request, options?: RequestInit) => {
        const body = options?.body ? JSON.parse(String(options.body)) : null; calls.push({ url: String(url), body, options: options! });
        if (!body) return models(id); const text = JSON.stringify(outputs.shift()); return id === 'glm' ? chat(text) : responses(text);
      });
      const provider = new TaskProvider(new APITransport(id, async () => synthetic, fetcher as typeof fetch));
      const options = { connectionId: id, model: id === 'glm' ? 'glm-5.3' : id === 'openai' ? 'gpt-6.1-sol' : 'deepseek-flash', effort: 'high' as const };
      expect(await provider.developConcept(concept, new AbortController().signal, options)).toEqual(makeConcept(concept));
      expect(await provider.analyze(p, new AbortController().signal, options)).toEqual(makeAnalysis(p));
      expect(await provider.assessAddition(addition, new AbortController().signal, options)).toEqual(classification);
      const integrated = store.applyIntegration(p.id, candidate.revision, await provider.reviewIntegration(candidate, new AbortController().signal, options));
      expect(integrated.stage).toBe('candidate');
      outputs.push(makeAdditionReviewResponse(integrated));
      const checked = store.applyAnalysis(p.id, integrated.revision, await provider.analyze(integrated, new AbortController().signal, options));
      expect(store.preview(p.id, checked.revision).baselineVersion).toBe('v2');
      expect(store.commit(p.id, checked.revision, evolutionConfirmationText).baseline!.baselineVersion).toBe('v2');
      expect(store.readBaseline(p.id, 'v1')).toEqual(committed.baseline);
      const posts = calls.filter(c => c.body); expect(posts).toHaveLength(5);
      for (const call of posts) { expect(call.options.redirect).toBe('error'); expect((call.options.headers as any).authorization).toBe('Bearer ' + synthetic); expect(JSON.stringify(call.body)).not.toContain(synthetic); }
      expect(posts[0]!.url).toBe(id === 'glm' ? 'https://open.bigmodel.cn/api/paas/v4/chat/completions' : id === 'openai' ? 'https://api.openai.com/v1/responses' : 'https://api.deepseek.com/responses');
      if (id === 'glm') { expect(posts[0]!.body.response_format).toEqual({ type: 'json_object' }); expect(posts[0]!.body.messages[0].content).toContain('JSON Schema'); }
      else { expect(posts[0]!.body.text.format.type).toBe('json_schema'); expect(posts[0]!.body.store).toBe(false); expect(posts[0]!.body.text.format.strict).toBe(id === 'openai' ? true : undefined); }
      const lastInput = JSON.parse(id === 'glm' ? posts[2]!.body.messages[1].content : posts[2]!.body.input[0].content);
      expect(lastInput.baseline).toEqual(committed.baseline); expect(lastInput.request).toBe('增加暂停操作');
      const reviewInput = JSON.parse(id === 'glm' ? posts[4]!.body.messages[1].content : posts[4]!.body.input[0].content);
      expect(reviewInput.draft).toEqual(integrated.draft); expect(reviewInput.questions).toEqual(integrated.questions);
      const schema = id === 'glm' ? posts[4]!.body.messages[0].content : JSON.stringify(posts[4]!.body.text.format.schema);
      expect(schema).toContain('preserve'); expect(schema).not.toContain('"oneOf"');
    } finally { store.close(); }
  });
  it('rejects unavailable models and unsupported reasoning before inference', async () => {
    const fetcher = vi.fn(async () => models(id));
    const transport = new APITransport(id, async () => synthetic, fetcher as typeof fetch);
    const request = { schema: {}, name: 'test', instructions: 'JSON', input: {}, signal: new AbortController().signal };
    await expect(transport.complete({ ...request, options: { connectionId: id, model: 'unknown' } })).rejects.toMatchObject({ code: 'model_unavailable' });
    const selected = id === 'glm' ? 'glm-5.2' : id === 'openai' ? 'gpt-6.1-sol' : 'deepseek-flash';
    await expect(transport.complete({ ...request, options: { connectionId: id, model: selected, effort: id === 'glm' ? 'medium' : 'none' } })).rejects.toMatchObject({ code: 'unsupported_effort' });
    expect(fetcher.mock.calls.every(args => !String(args).includes('/responses'))).toBe(true);
  });
});

describe('Final response and safe error boundaries', () => {
  it.each([[401, 'api_key_invalid'], [403, 'api_access_denied'], [429, 'api_usage_limited'], [404, 'model_unavailable'], [500, 'api_request_failed']] as const)('hides upstream bodies for HTTP %s', async (status, code) => {
    const provider = new APITransport('openai', async () => synthetic, vi.fn().mockResolvedValue(new Response(synthetic, { status })));
    await expect(provider.catalog(new AbortController().signal)).rejects.toMatchObject({ code });
    try { await provider.catalog(new AbortController().signal); } catch (error) { expect(String(error)).not.toContain(synthetic); }
  });
  it.each(['missing_completion', 'incomplete', 'refusal', 'bad_json', 'bad_schema'] as const)('rejects %s and preserves the draft', async failure => {
    const store = new Store(':memory:');
    try {
      const p = store.create({ conceptInput: '用户设想' });
      const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => {
        if (!init?.body) return models('openai');
        if (failure === 'missing_completion') return stream([{ type: 'response.output_text.delta', delta: JSON.stringify(makeConcept(p)) }]);
        if (failure === 'incomplete') return stream([{ type: 'response.incomplete' }]);
        if (failure === 'refusal') return stream([{ type: 'response.refusal.done' }]);
        return responses(failure === 'bad_json' ? '```json\n{}\n```' : '{}');
      });
      const provider = new TaskProvider(new APITransport('openai', async () => synthetic, fetcher as typeof fetch));
      await expect(provider.developConcept(p, new AbortController().signal, { model: 'gpt-6.1-sol' })).rejects.toBeInstanceOf(AppError);
      expect(store.get(p.id)).toEqual(p);
    } finally { store.close(); }
  });
  it('requires GLM stop and DONE, ignores reasoning, and rejects truncation/cancellation', async () => {
    const signal = new AbortController();
    expect(await readModelStream(chat('{"ok":true}'), 'chat', signal.signal)).toBe('{"ok":true}');
    await expect(readModelStream(stream([{ choices: [{ index: 0, delta: { content: '{}' }, finish_reason: 'length' }] }, '[DONE]']), 'chat', signal.signal)).rejects.toMatchObject({ code: 'response_incomplete' });
    await expect(readModelStream(stream([{ choices: [{ index: 0, delta: { content: '{}' }, finish_reason: 'stop' }] }]), 'chat', signal.signal)).rejects.toMatchObject({ code: 'stream_interrupted' });
    signal.abort(); await expect(readModelStream(responses('{}'), 'responses', signal.signal)).rejects.toThrow();
  });
});

describe('AI connection API', () => {
  it('holds reload metadata until a saved preference mutation finishes, while inference remains blocked', async () => {
    const storage = new AIConnections(directory(), testEncryption), store = new Store(':memory:');
    await storage.saveKey('openai', synthetic);
    const savePreferences = storage.preferences.bind(storage);
    let finish!: () => void, entered!: () => void;
    const gate = new Promise<void>(resolve => { finish = resolve; });
    const saved = new Promise<void>(resolve => { entered = resolve; });
    vi.spyOn(storage, 'preferences').mockImplementation(async (...args) => { await savePreferences(...args); entered(); await gate; });
    const state = vi.spyOn(storage, 'state'), analyze = vi.fn(fixtureProvider.analyze);
    const app = await buildApp({ store, auth: fixtureAuth, connections: storage, provider: { ...fixtureProvider, analyze,
      catalog: async () => ({ models: [openAIModel('gpt-6.1-sol')], defaultModel: '' }) } });
    let changing: Promise<unknown> | undefined, loading: Promise<unknown> | undefined;
    try {
      const boot = await app.inject({ url: '/', headers: { host: '127.0.0.1:3000' } });
      const headers = { host: '127.0.0.1:3000', origin: 'http://127.0.0.1:3000', cookie: String(boot.headers['set-cookie']).split(';')[0]! };
      const project = store.create({ name: '连接竞态', productDescription: '监督', coreUserGoal: '专注', features: ['监督'] });
      changing = app.inject({ method: 'PUT', url: '/api/ai/preferences', headers, payload: { connectionId: 'openai', model: 'gpt-6.1-sol' } }).then(r => r);
      await Promise.race([saved, changing.then(() => { throw new Error('Preference mutation finished before the controlled barrier.'); })]);
      let completed = false;
      const reload = app.inject({ url: '/api/ai/connections', headers }).then(r => { completed = true; return r; });
      loading = reload;
      const blocked = await app.inject({ method: 'POST', url: `/api/projects/${project.id}/analyze`, headers, payload: { revision: project.revision } });
      expect(blocked.json().error.code).toBe('connection_busy'); expect(analyze).not.toHaveBeenCalled();
      expect(completed).toBe(false); expect(state).not.toHaveBeenCalled();
      finish(); await changing;
      expect((await reload).json().activeConnectionId).toBe('openai');
      expect((await app.inject({ method: 'POST', url: `/api/projects/${project.id}/analyze`, headers, payload: { revision: project.revision } })).statusCode).toBe(200);
      expect(analyze).toHaveBeenCalledOnce();
    } finally { finish(); await Promise.all([changing, loading]); await app.close(); store.close(); }
  });
  it('shares account polling while connection configuration reads use the latest completed snapshot', async () => {
    const store = new Store(':memory:'); let complete!: (value: Record<string, unknown>) => void;
    const status = vi.fn(async () => new Promise<Record<string, unknown>>(resolve => { complete = resolve; }));
    const app = await buildApp({ store, auth: { ...fixtureAuth, status }, provider: fixtureProvider });
    try {
      const boot = await app.inject({ url: '/', headers: { host: '127.0.0.1:3000' } });
      const headers = { host: '127.0.0.1:3000', cookie: String(boot.headers['set-cookie']).split(';')[0]! };
      const first = app.inject({ url: '/api/auth', headers }).then(r => r);
      await vi.waitFor(() => expect(status).toHaveBeenCalledOnce());
      const second = app.inject({ url: '/api/auth', headers }).then(r => r);
      await new Promise(resolve => setImmediate(resolve));
      const local = await app.inject({ url: '/api/ai/connections', headers });
      expect(local.statusCode).toBe(200); expect(local.json().connections[0].configured).toBe(false);
      expect(status).toHaveBeenCalledOnce(); complete({ status: 'connected', sharing: true });
      expect((await first).statusCode).toBe(200); expect((await second).json().status).toBe('connected');
      expect((await app.inject({ url: '/api/ai/connections', headers })).json().connections[0].configured).toBe(true);
      const third = app.inject({ url: '/api/auth', headers }).then(r => r);
      await vi.waitFor(() => expect(status).toHaveBeenCalledTimes(2)); complete({ status: 'disconnected', sharing: false });
      expect((await third).json().status).toBe('disconnected');
    } finally { await app.close(); store.close(); }
  });
  it('switches API connections without waiting for a pending ChatGPT poll and reuses the validated catalog', async () => {
    const storage = new AIConnections(directory(), testEncryption), store = new Store(':memory:');
    await storage.saveKey('deepseek', synthetic);
    let complete!: (value: Record<string, unknown>) => void;
    const status = vi.fn(async () => new Promise<Record<string, unknown>>(resolve => { complete = resolve; }));
    const catalog = vi.fn(async () => ({ models: [{ slug: 'deepseek-flash', displayName: 'deepseek-flash' }], defaultModel: '' }));
    const app = await buildApp({ store, auth: { ...fixtureAuth, status }, connections: storage, provider: { ...fixtureProvider, catalog } });
    let pending: Promise<unknown> | undefined;
    try {
      const boot = await app.inject({ url: '/', headers: { host: '127.0.0.1:3000' } });
      const headers = { host: '127.0.0.1:3000', origin: 'http://127.0.0.1:3000', cookie: String(boot.headers['set-cookie']).split(';')[0]! };
      pending = app.inject({ url: '/api/auth', headers }).then(r => r);
      await vi.waitFor(() => expect(status).toHaveBeenCalledOnce());
      const selected = await app.inject({ method: 'PUT', url: '/api/ai/preferences', headers, payload: { connectionId: 'deepseek', model: 'deepseek-flash' } });
      expect(selected.statusCode).toBe(200); expect(selected.json().activeConnectionId).toBe('deepseek');
      expect((await app.inject({ url: '/api/models?connectionId=deepseek', headers })).statusCode).toBe(200);
      expect(catalog).toHaveBeenCalledOnce(); expect(status).toHaveBeenCalledOnce();
      expect(JSON.stringify(await storage.state())).not.toContain(synthetic);
    } finally { complete?.({ status: 'connected', sharing: true }); await pending; await app.close(); store.close(); }
  });
  it('deduplicates catalogs and refreshes after expiry, explicit refresh, key changes and failures', async () => {
    const storage = new AIConnections(directory(), testEncryption), store = new Store(':memory:');
    await storage.saveKey('openai', synthetic);
    const catalog = vi.fn(async () => { await storage.key('openai'); return { models: [openAIModel('gpt-6.1-sol')], defaultModel: '' }; });
    const app = await buildApp({ store, auth: fixtureAuth, connections: storage, provider: { ...fixtureProvider, catalog } });
    try {
      const boot = await app.inject({ url: '/', headers: { host: '127.0.0.1:3000' } });
      const headers = { host: '127.0.0.1:3000', origin: 'http://127.0.0.1:3000', cookie: String(boot.headers['set-cookie']).split(';')[0]! };
      const get = (refresh = false) => app.inject({ url: '/api/models?connectionId=openai' + (refresh ? '&refresh=1' : ''), headers });
      const results = await Promise.all([get(), get()]); expect(results.every(r => r.statusCode === 200)).toBe(true); expect(catalog).toHaveBeenCalledOnce();
      const prefs = () => app.inject({ method: 'PUT', url: '/api/ai/preferences', headers, payload: { connectionId: 'openai', model: 'gpt-6.1-sol', effort: 'high' } });
      expect((await prefs()).statusCode).toBe(200); await get(); expect(catalog).toHaveBeenCalledOnce();
      await get(true); expect(catalog).toHaveBeenCalledTimes(2);
      const now = Date.now(); const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 61000);
      try { await get(); expect(catalog).toHaveBeenCalledTimes(3); } finally { clock.mockRestore(); }
      expect((await app.inject({ method: 'PUT', url: '/api/ai/connections/openai/key', headers, payload: { key: 'synthetic-replacement' } })).statusCode).toBe(200);
      await get(); expect(catalog).toHaveBeenCalledTimes(4);
      catalog.mockRejectedValueOnce(new AppError('api_network_error', 'TEST catalog unavailable', 502));
      expect((await get(true)).statusCode).toBe(502); expect(catalog).toHaveBeenCalledTimes(5);
      expect((await get()).statusCode).toBe(200); expect(catalog).toHaveBeenCalledTimes(6);
      catalog.mockResolvedValueOnce({ models: [], defaultModel: '' }); await get(true);
      expect((await prefs()).json().error.code).toBe('model_unavailable');
      expect((await storage.state()).preferences.openai!.model).toBe('gpt-6.1-sol');
      expect((await app.inject({ method: 'DELETE', url: '/api/ai/connections/openai/key', headers })).statusCode).toBe(200);
      expect((await get()).json().error.code).toBe('api_key_required');
    } finally { await app.close(); store.close(); }
  });
  it('invalidates ChatGPT catalogs on account changes and ignores a late pre-switch status snapshot', async () => {
    const store = new Store(':memory:'); let profileId = 'first', defer = false, finish!: (v: Record<string, unknown>) => void;
    const status = vi.fn(async () => {
      const value = { status: 'connected', sharing: true, profileId };
      return defer ? new Promise<Record<string, unknown>>(resolve => { finish = resolve; }) : value;
    });
    const catalog = vi.fn(async () => ({ models: [openAIModel('gpt-6.1-sol')], defaultModel: 'gpt-6.1-sol' }));
    const app = await buildApp({ store, auth: { ...fixtureAuth, status, select: async id => { profileId = id; defer = false; } }, provider: { ...fixtureProvider, catalog } });
    let pending: Promise<unknown> | undefined;
    try {
      const boot = await app.inject({ url: '/', headers: { host: '127.0.0.1:3000' } });
      const headers = { host: '127.0.0.1:3000', origin: 'http://127.0.0.1:3000', cookie: String(boot.headers['set-cookie']).split(';')[0]! };
      await app.inject({ url: '/api/auth', headers }); await app.inject({ url: '/api/models', headers }); expect(catalog).toHaveBeenCalledOnce();
      defer = true; pending = app.inject({ url: '/api/auth', headers }).then(r => r);
      await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
      const changed = await app.inject({ method: 'POST', url: '/api/auth/select', headers, payload: { id: 'second' } }); expect(changed.json().profileId).toBe('second');
      await app.inject({ url: '/api/models', headers }); expect(catalog).toHaveBeenCalledTimes(2);
      finish({ status: 'connected', sharing: true, profileId: 'first' }); await pending;
      await app.inject({ url: '/api/models', headers }); expect(catalog).toHaveBeenCalledTimes(2);
    } finally { finish?.({ status: 'disconnected', sharing: false }); await pending; await app.close(); store.close(); }
  });
  it('saves without inference, records explicit test outcomes, and resets verification when replacing a key', async () => {
    const storage = new AIConnections(directory(), testEncryption), store = new Store(':memory:');
    const testConnection = vi.fn().mockResolvedValue({ ok: true });
    const app = await buildApp({ store, auth: fixtureAuth, connections: storage, provider: { ...fixtureProvider, testConnection } });
    try {
      const boot = await app.inject({ url: '/', headers: { host: '127.0.0.1:3000' } });
      const headers = { host: '127.0.0.1:3000', origin: 'http://127.0.0.1:3000', cookie: String(boot.headers['set-cookie']).split(';')[0]! };
      const request = (url: string, method: 'POST' | 'PUT', payload: Record<string, unknown>) => app.inject({ url, method, headers, payload });
      expect((await request('/api/ai/connections/glm/key', 'PUT', { key: synthetic })).statusCode).toBe(200);
      expect(testConnection).not.toHaveBeenCalled();
      const success = await request('/api/ai/connections/glm/test', 'POST', { model: 'glm-5.3', effort: 'high' });
      expect(success.statusCode, success.body).toBe(200);
      expect(success.json().connections.find((c: any) => c.id === 'glm')).toMatchObject({ status: 'verified', testedModel: 'glm-5.3' });
      testConnection.mockRejectedValueOnce(new AppError('api_usage_limited', 'API 额度不足。', 429));
      expect((await request('/api/ai/connections/glm/test', 'POST', { model: 'glm-5.3' })).statusCode).toBe(429);
      expect((await storage.state()).connections.find(c => c.id === 'glm')).toMatchObject({ status: 'failed', error: 'API 额度不足。' });
      expect(testConnection).toHaveBeenCalledTimes(2);
      await request('/api/ai/connections/glm/key', 'PUT', { key: 'synthetic-replacement' });
      expect((await storage.state()).connections.find(c => c.id === 'glm')).toEqual({ id: 'glm', configured: true, status: 'configured' });
      expect(await storage.key('glm')).toBe('synthetic-replacement');
    } finally { await app.close(); store.close(); }
  });
  it('freezes connection settings during review, rejects timeout results, and retains saved product data', async () => {
    const storage = new AIConnections(directory(), testEncryption), store = new Store(':memory:');
    let complete!: (value: unknown) => void;
    const timeout = new AbortController();
    const developConcept = vi.fn(async () => new Promise(resolve => { complete = resolve; }));
    const app = await buildApp({ store, auth: fixtureAuth, connections: storage, provider: { ...fixtureProvider, developConcept: developConcept as any } });
    try {
      const boot = await app.inject({ url: '/', headers: { host: '127.0.0.1:3000' } });
      const headers = { host: '127.0.0.1:3000', origin: 'http://127.0.0.1:3000', cookie: String(boot.headers['set-cookie']).split(';')[0]! };
      await storage.saveKey('deepseek', synthetic);
      const p = store.create({ conceptInput: '监督工具，有玩偶巡查。' });
      const timer = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(timeout.signal);
      const pending = app.inject({ method: 'POST', url: `/api/projects/${p.id}/concept/analyze`, headers, payload: { revision: p.revision, inference: { connectionId: 'deepseek', model: 'deepseek-flash', effort: 'high' } } });
      await vi.waitFor(() => expect(complete).toBeTypeOf('function'));
      expect(developConcept.mock.calls[0]).toHaveLength(3);
      expect((await app.inject({ method: 'PUT', url: '/api/ai/preferences', headers, payload: { connectionId: 'openai' } })).statusCode).toBe(409);
      expect((await app.inject({ method: 'PUT', url: '/api/ai/connections/deepseek/key', headers, payload: { key: 'replacement' } })).statusCode).toBe(409);
      timeout.abort(new DOMException('TEST timeout', 'TimeoutError')); complete(makeConcept(p));
      expect((await pending).json().error.code).toBe('analysis_timeout'); expect(store.get(p.id)).toEqual(p); expect(await storage.key('deepseek')).toBe(synthetic);
      timer.mockRestore();
    } finally { await app.close(); store.close(); }
  });
  it('protects configuration, keeps credentials out of state, and blocks all mutations during a late cancelled request', async () => {
    const storage = new AIConnections(directory(), testEncryption), store = new Store(':memory:');
    let complete!: (v: unknown) => void;
    const catalog = async (_signal: AbortSignal, id: ConnectionId = 'chatgpt') => ({ models: id === 'glm' ? glmModels : [openAIModel('gpt-6.1-sol')], defaultModel: id === 'chatgpt' ? 'gpt-6.1-sol' : '' });
    const provider = { ...fixtureProvider, catalog, testConnection: async () => new Promise(resolve => { complete = resolve; }) };
    const app = await buildApp({ store, auth: fixtureAuth, connections: storage, provider });
    try {
      const boot = await app.inject({ url: '/', headers: { host: '127.0.0.1:3000' } });
      const headers = { host: '127.0.0.1:3000', origin: 'http://127.0.0.1:3000', cookie: String(boot.headers['set-cookie']).split(';')[0]! };
      const request = (method: 'PUT' | 'POST' | 'DELETE', url: string, payload?: unknown) => app.inject({ method, url, headers, ...(payload ? { payload } : {}) });
      expect((await app.inject({ method: 'PUT', url: '/api/ai/connections/openai/key', headers: { ...headers, origin: 'https://example.test' }, payload: { key: synthetic } })).statusCode).toBe(403);
      const saved = await request('PUT', '/api/ai/connections/openai/key', { key: synthetic }); expect(saved.statusCode).toBe(200); expect(saved.body).not.toContain(synthetic);
      const selected = await request('PUT', '/api/ai/preferences', { connectionId: 'openai', model: 'gpt-6.1-sol', effort: 'high' }); expect(selected.json().activeConnectionId).toBe('openai');
      const pending = request('POST', '/api/ai/connections/openai/test', { model: 'gpt-6.1-sol', effort: 'high' });
      await vi.waitFor(() => expect(complete).toBeTypeOf('function'));
      for (const [method, url, payload] of [['PUT', '/api/ai/connections/openai/key', { key: 'new' }], ['DELETE', '/api/ai/connections/openai/key', undefined], ['PUT', '/api/ai/preferences', { connectionId: 'glm' }], ['POST', '/api/auth/select', { id: 'other' }], ['POST', '/api/auth/sign-out', {}], ['POST', '/api/auth/connect', {}]] as const) expect((await request(method, url, payload)).statusCode).toBe(409);
      await request('POST', '/api/ai/test/cancel', {}); complete({ ok: true });
      expect((await pending).json().error.code).toBe('analysis_cancelled'); expect((await storage.state()).connections.find(c => c.id === 'openai')!.status).toBe('configured');
      expect(await storage.key('openai')).toBe(synthetic);
    } finally { await app.close(); store.close(); }
  });
  it('routes explicit API inference while legacy requests keep ChatGPT and omits unsupported parameters', async () => {
    const storage = new AIConnections(directory(), testEncryption), store = new Store(':memory:'); await storage.saveKey('glm', synthetic);
    const fetcher = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => chat('{"ok":true}'));
    const chatgpt = { ...fixtureProvider, analyze: vi.fn(fixtureProvider.analyze), catalog: async () => ({ models: [openAIModel('gpt-6.1-sol')], defaultModel: 'gpt-6.1-sol' }) };
    const provider = new AIProvider(chatgpt, storage, fetcher as typeof fetch);
    expect(await provider.testConnection({ connectionId: 'glm', model: 'glm-5.2', thinking: false }, new AbortController().signal)).toEqual({ ok: true });
    expect(JSON.parse(String(fetcher.mock.calls[0]![1]?.body)).thinking).toEqual({ type: 'disabled' });
    const p = store.create({ name: 'legacy', productDescription: '产品', coreUserGoal: '目标', features: ['功能'] });
    await provider.analyze(p, new AbortController().signal); expect(chatgpt.analyze).toHaveBeenCalledOnce();
    store.close();
  });
});

it('uses model capabilities and the captured key, sends no reasoning to non-reasoners, and never retries network failure', async () => {
  expect(openAIModel('gpt-5-pro').reasoning!.efforts).toEqual(['high']);
  expect(supportsOpenAIResponses('o3-mini')).toBe(true); expect(supportsOpenAIResponses('gpt-3.5-turbo')).toBe(false);
  const getKey = vi.fn().mockResolvedValueOnce(synthetic).mockResolvedValue('changed-key');
  const fetcher = vi.fn(async (_url: unknown, init?: RequestInit) => init?.body ? responses('{"ok":true}') : new Response(JSON.stringify({ data: [{ id: 'gpt-4.1-mini' }] })));
  const provider = new TaskProvider(new APITransport('openai', getKey, fetcher as typeof fetch));
  await provider.testConnection({ model: 'gpt-4.1-mini' }, new AbortController().signal);
  expect(getKey).toHaveBeenCalledOnce();
  const body = JSON.parse(String(fetcher.mock.calls[1]![1]!.body)); expect(body).not.toHaveProperty('reasoning');
  expect((fetcher.mock.calls[1]![1]!.headers as any).authorization).toBe('Bearer ' + synthetic);
  const failing = vi.fn().mockRejectedValue(new Error(synthetic));
  await expect(new APITransport('openai', async () => synthetic, failing).catalog(new AbortController().signal)).rejects.toMatchObject({ code: 'api_network_error' });
  expect(failing).toHaveBeenCalledOnce();
});
