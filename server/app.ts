import Fastify from 'fastify';
import staticFiles from '@fastify/static';
import { z } from 'zod';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { resolve } from 'node:path';
import type { ViteDevServer } from 'vite';
import type { Auth } from './auth.js';
import type { Provider } from './provider.js';
import { Store } from './store.js';
import { AppError, publicError } from './errors.js';
import { inferenceOptionsSchema, connectionIdSchema } from '../shared/inference.js';
import type { AIState, ConnectionId, ModelCatalog } from '../shared/inference.js';
import type { AIConnections } from './ai-connections.js';
import { validateModelOptions } from './model-capabilities.js';
import { decisionBatchSchema, questionMergeSchema } from '../shared/domain.js';

export async function buildApp(options: { store: Store; auth: Auth; provider: Provider; connections?: AIConnections; dev?: boolean; staticRoot?: string; privateRoots?: string[] }) {
  const app = Fastify({ logger: false, bodyLimit: 2 * 1024 * 1024 });
  const session = randomBytes(32).toString('hex');
  const runs = new Map<string, AbortController>();
  let configurationBusy = false;
  let pendingConfiguration: Promise<void> | undefined;
  const mutation = async <T,>(work: () => Promise<T>): Promise<T> => {
    if (runs.size || configurationBusy) throw new AppError('connection_busy', 'AI 请求运行期间不能修改连接或模型配置，请先等待或取消。', 409);
    let finish!: () => void;
    pendingConfiguration = new Promise<void>(resolve => { finish = resolve; });
    configurationBusy = true;
    try { return await work(); }
    finally { configurationBusy = false; pendingConfiguration = undefined; finish(); }
  };
  const connections = () => { if (!options.connections) throw new AppError('ai_connections_unavailable', '当前运行环境不支持 API 连接设置。', 503); return options.connections; };
  // Keep account polling separate from API configuration. A slow ChatGPT read
  // must not delay switching, saving keys or loading another provider's models.
  let latestAuth: Record<string, unknown> | undefined;
  let authEpoch = 0;
  type CatalogEntry = { catalog?: ModelCatalog; expiresAt: number; pending?: Promise<ModelCatalog> };
  const catalogs = new Map<string, CatalogEntry>();
  const invalidateCatalog = (id: ConnectionId) => {
    for (const key of catalogs.keys()) if (key.startsWith(id + '/')) catalogs.delete(key);
  };
  let pendingAuth: Promise<Record<string, unknown>> | undefined;
  const readAuth = () => {
    if (!pendingAuth) {
      const epoch = authEpoch;
      const pending = options.auth.status().then(value => {
        if (epoch === authEpoch) {
          if (['profileId', 'status', 'sharing'].some(key => latestAuth?.[key] !== value[key])) invalidateCatalog('chatgpt');
          latestAuth = value;
        }
        return value;
      }).finally(() => { if (pendingAuth === pending) pendingAuth = undefined; });
      pendingAuth = pending;
    }
    return pendingAuth;
  };
  const invalidateAuth = () => { authEpoch++; latestAuth = undefined; pendingAuth = undefined; invalidateCatalog('chatgpt'); };
  const readCatalog = async (id: ConnectionId, refresh = false): Promise<ModelCatalog> => {
    const key = id + '/' + (id === 'chatgpt' ? String(latestAuth?.profileId ?? '') : '');
    const entry = catalogs.get(key);
    if (!refresh && entry?.catalog && entry.expiresAt > Date.now()) return structuredClone(entry.catalog);
    if (entry?.pending) return structuredClone(await entry.pending);
    const next: CatalogEntry = { expiresAt: 0 };
    next.pending = Promise.resolve().then(() => options.provider.catalog!(AbortSignal.timeout(30000), id)).then(value => {
      next.catalog = structuredClone(value); next.expiresAt = Date.now() + 60000; return value;
    }).finally(() => {
      next.pending = undefined;
      if (!next.catalog && catalogs.get(key) === next) catalogs.delete(key);
    });
    catalogs.set(key, next);
    return structuredClone(await next.pending);
  };
  const state = async (): Promise<AIState> => {
    const value = options.connections ? await options.connections.state() : { activeConnectionId: 'chatgpt' as const, preferences: {}, connections: [] };
    const configured = latestAuth?.status === 'connected' && latestAuth.sharing === true;
    return { ...value, connections: [{ id: 'chatgpt', configured, status: configured ? 'verified' : 'unconfigured' }, ...value.connections.filter(c => c.id !== 'chatgpt')] };
  };
  let vite: ViteDevServer | undefined;
  app.setErrorHandler((error, _request, reply) => {
    const value = publicError(error);
    void reply.status(value.status).send({ error: { code: value.code, message: value.message, retryable: value.retryable } });
  });
  app.addHook('onRequest', async (request, reply) => {
    const host = request.headers.host;
    if (!host || !/^127\.0\.0\.1(?::\d+)?$/.test(host)) throw new AppError('invalid_host', '请从 127.0.0.1 访问本地应用。', 403);
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('X-Frame-Options', 'DENY');
    if (!options.dev) reply.header('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; font-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    if (request.url.startsWith('/api/')) {
      reply.header('Cache-Control', 'no-store');
      const cookie = /(?:^|;\s*)baseline_session=([a-f0-9]{64})(?:;|$)/.exec(request.headers.cookie ?? '')?.[1];
      if (!cookie || !timingSafeEqual(Buffer.from(cookie), Buffer.from(session))) throw new AppError('local_session_required', '请先打开本地应用页面。', 403);
      const origin = request.headers.origin;
      if ((origin && origin !== `http://${host}`) || request.headers['sec-fetch-site'] === 'cross-site') throw new AppError('invalid_origin', '此操作只能从本地应用发起。', 403);
      if (!['GET', 'HEAD'].includes(request.method) && origin !== `http://${host}`) throw new AppError('invalid_origin', '写入操作需要本地页面来源。', 403);
    } else if (request.url === '/' || request.url.startsWith('/?')) {
      reply.header('Set-Cookie', `baseline_session=${session}; HttpOnly; SameSite=Strict; Path=/`);
    }
  });
  app.get('/api/auth', readAuth);
  app.get<{ Querystring: { connectionId?: string; refresh?: string } }>('/api/models', async request => {
    if (!options.provider.catalog) return { models: [], defaultModel: '' };
    const refresh = z.enum(['0', '1']).optional().parse(request.query.refresh) === '1';
    return readCatalog(connectionIdSchema.parse(request.query.connectionId ?? 'chatgpt'), refresh);
  });
  app.get('/api/ai/connections', async () => {
    // A reload must not advertise saved preferences as ready while their
    // mutation is still finishing. This waits for configuration, never inference.
    while (pendingConfiguration) await pendingConfiguration;
    return state();
  });
  app.put<{ Params: { id: string } }>('/api/ai/connections/:id/key', request => mutation(async () => {
    const id = connectionIdSchema.parse(request.params.id), body = z.strictObject({ key: z.string().min(1).max(4096) }).parse(request.body);
    await connections().saveKey(id, body.key); invalidateCatalog(id); return state();
  }));
  app.delete<{ Params: { id: string } }>('/api/ai/connections/:id/key', request => mutation(async () => { const id = connectionIdSchema.parse(request.params.id); await connections().removeKey(id); invalidateCatalog(id); return state(); }));
  app.put('/api/ai/preferences', request => mutation(async () => {
    const value = inferenceOptionsSchema.parse(request.body), id = value.connectionId ?? 'chatgpt';
    const auth = id === 'chatgpt' ? await readAuth() : null;
    if (value.model) {
      const catalog = await readCatalog(id), model = catalog.models.find(m => m.slug === value.model);
      if (!model) throw new AppError('model_unavailable', '所选模型不在当前连接目录中。', 409);
      validateModelOptions(model, value, id);
    }
    if (!value.model && (value.effort || value.thinking !== undefined)) throw new AppError('model_required', '请先选择模型。');
    await connections().preferences(id, id === 'chatgpt' && auth?.profileId ? 'chatgpt:' + String(auth.profileId) : id, value); return state();
  }));
  app.post<{ Params: { id: string }; Body: unknown }>('/api/ai/connections/:id/test', async request => {
    if (runs.size || configurationBusy) throw new AppError('connection_busy', '请先等待当前请求完成或取消。', 409);
    const id = connectionIdSchema.parse(request.params.id);
    if (id === 'chatgpt' || !options.provider.testConnection) throw new AppError('invalid_connection', '此连接请通过官方登录核验。');
    const inference = { ...inferenceOptionsSchema.parse(request.body), connectionId: id };
    if (!inference.model) throw new AppError('model_required', '请先选择测试模型。');
    connections(); const controller = new AbortController(); runs.set('__connection_test', controller);
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(180000)]);
    const aborted = () => controller.abort(); request.raw.on('aborted', aborted);
    try {
      await options.provider.testConnection(inference, signal); signal.throwIfAborted();
      await connections().testResult(id, inference.model); return state();
    } catch (error) {
      if (signal.aborted) throw new AppError('analysis_cancelled', '连接测试已取消或超时，未确认连接成功。', 409);
      const safe = publicError(error); await connections().testResult(id, inference.model, safe.message); throw error;
    } finally { runs.delete('__connection_test'); request.raw.off('aborted', aborted); }
  });
  app.post('/api/ai/test/cancel', () => { runs.get('__connection_test')?.abort(); return { cancelled: true }; });
  app.post('/api/auth/connect', request => mutation(async () => {
    const params = z.strictObject({ newProfile: z.boolean().optional(), profileId: z.string().max(100).optional(), reconsent: z.boolean().optional() }).parse(request.body);
    invalidateAuth(); options.auth.signIn(params);
    return { started: true };
  }));
  app.post('/api/auth/cancel', () => { options.auth.cancel(); invalidateAuth(); return { cancelled: true }; });
  app.post('/api/auth/sign-out', () => mutation(async () => { try { await options.auth.disconnect(); } finally { invalidateAuth(); } return readAuth(); }));
  app.post('/api/auth/select', request => mutation(async () => { const { id } = z.strictObject({ id: z.string().max(100) }).parse(request.body); try { await options.auth.select(id); } finally { invalidateAuth(); } return readAuth(); }));
  app.get('/api/projects', () => options.store.list());
  app.post('/api/projects', request => options.store.create(request.body));
  app.get<{ Params: { id: string } }>('/api/projects/:id', request => options.store.get(request.params.id));
  app.get<{ Params: { id: string; version: string } }>('/api/projects/:id/baselines/:version', request => {
    const version = z.string().regex(/^v[1-9]\d*$/).parse(request.params.version);
    return options.store.readBaseline(request.params.id, version as `v${number}`);
  });
  app.post<{ Params: { id: string } }>('/api/projects/:id/addition', request => {
    const p = z.strictObject({ revision: z.number().int().positive(), request: z.string().trim().min(1).max(12000) }).parse(request.body);
    return options.store.startAddition(request.params.id, p.revision, p.request);
  });
  app.put<{ Params: { id: string } }>('/api/projects/:id/addition', request => {
    const p = z.strictObject({ revision: z.number().int().positive(), request: z.string().trim().min(1).max(12000) }).parse(request.body);
    return options.store.saveAdditionRequest(request.params.id, p.revision, p.request);
  });
  app.post<{ Params: { id: string } }>('/api/projects/:id/addition/confirm', request => {
    const p = z.strictObject({ revision: z.number().int().positive(), confirmed: z.literal(true) }).parse(request.body);
    return options.store.confirmAddition(request.params.id, p.revision);
  });
  app.post<{ Params: { id: string } }>('/api/projects/:id/addition/discard', request => {
    const p = z.strictObject({ revision: z.number().int().positive(), confirmed: z.literal(true) }).parse(request.body);
    return options.store.discardAddition(request.params.id, p.revision);
  });
  const revisionSchema = z.number().int().positive();
  app.put<{ Params: { id: string } }>('/api/projects/:id/concept', request => {
    const { revision, ...input } = z.object({ revision: revisionSchema }).passthrough().parse(request.body);
    return options.store.saveConcept(request.params.id, revision, input);
  });
  app.post<{ Params: { id: string } }>('/api/projects/:id/concept/confirm', request => {
    const { revision, confirmed } = z.strictObject({ revision: revisionSchema, confirmed: z.literal(true) }).parse(request.body);
    void confirmed;
    return options.store.confirmConcept(request.params.id, revision);
  });
  app.post<{ Params: { id: string } }>('/api/projects/:id/decisions', request => {
    const { revision, answers, proposalAcceptances, confirmation } = decisionBatchSchema.extend({ revision: revisionSchema }).parse(request.body);
    return options.store.decisions(request.params.id, revision, answers, proposalAcceptances, confirmation);
  });
  app.post<{ Params: { id: string } }>('/api/projects/:id/questions/merge', request => {
    if (runs.has(request.params.id)) throw new AppError('analysis_busy', '当前项目正在审查，请等待或取消后再合并。', 409);
    const { revision, ...input } = questionMergeSchema.extend({ revision: revisionSchema }).parse(request.body);
    return options.store.mergeQuestions(request.params.id, revision, input);
  });
  app.post<{ Params: { id: string } }>('/api/projects/:id/feedback', request => {
    const { revision, feedback } = z.strictObject({ revision: revisionSchema, feedback: z.string().trim().min(1).max(12000) }).parse(request.body);
    return options.store.feedback(request.params.id, revision, feedback);
  });
  app.put<{ Params: { id: string } }>('/api/projects/:id/draft', request => {
    const { revision, draft, confirmExceptions } = z.strictObject({ revision: revisionSchema, draft: z.unknown(), confirmExceptions: z.boolean().optional() }).parse(request.body);
    return options.store.save(request.params.id, revision, draft, confirmExceptions);
  });
  app.post<{ Params: { id: string } }>('/api/projects/:id/answer', request => {
    const { revision, answers } = z.strictObject({ revision: revisionSchema, answers: z.array(z.strictObject({ issueId: z.string(), answer: z.string().trim().min(1).max(12000) })).min(1) }).parse(request.body);
    return options.store.answerBatch(request.params.id, revision, answers);
  });
  const analyzeHandler = async (request: { body: unknown; params: { id: string }; raw: import('node:http').IncomingMessage }, concept: boolean, addition = false, integration = false) => {
    const { revision, inference } = z.strictObject({ revision: revisionSchema, inference: inferenceOptionsSchema.optional() }).parse(request.body);
    const { id } = request.params;
    if (configurationBusy || runs.has('__connection_test')) throw new AppError('connection_busy', '请先等待连接配置或测试完成。', 409);
    if (runs.has(id)) throw new AppError('analysis_busy', '当前项目正在审查，请等待或取消。', 409);
    const project = integration ? options.store.integrationEditable(id, revision) : addition ? options.store.additionEditable(id, revision) : concept ? options.store.conceptEditable(id, revision) : options.store.candidateEditable(id, revision);
    const controller = new AbortController(); runs.set(id, controller);
    const timeoutMs = !inference?.effort || ['high', 'xhigh', 'max'].includes(inference.effort) ? 600000 : 180000;
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(timeoutMs)]);
    const aborted = () => controller.abort();
    request.raw.on('aborted', aborted);
    try {
      if ((inference?.connectionId ?? 'chatgpt') === 'chatgpt' && (await options.auth.status()).signingIn) throw new AppError('connection_busy', '请先完成或取消账号连接。', 409);
      if (concept && !options.provider.developConcept) throw new AppError('concept_provider_unavailable', '当前 Provider 不支持产品设想整理。', 503);
      if (addition && !options.provider.assessAddition) throw new AppError('addition_provider_unavailable', '当前 Provider 不支持新增功能归属整理。', 503);
      if (integration && !options.provider.reviewIntegration) throw new AppError('integration_provider_unavailable', '当前连接不支持新旧关系审查。', 503);
      const result = integration ? await options.provider.reviewIntegration!(project, signal, inference) : addition ? await options.provider.assessAddition!(project, signal, inference) : concept ? await options.provider.developConcept!(project, signal, inference) : await options.provider.analyze(project, signal, inference);
      signal.throwIfAborted();
      return integration ? options.store.applyIntegration(id, revision, result) : addition ? options.store.applyAdditionAssessment(id, revision, result) : concept ? options.store.applyConcept(id, revision, result) : options.store.applyAnalysis(id, revision, result);
    } catch (error) {
      if (signal.aborted) {
        const timedOut = signal.reason instanceof Error && signal.reason.name === 'TimeoutError';
        throw new AppError(timedOut ? 'analysis_timeout' : 'analysis_cancelled', timedOut ? '审查超过等待上限，已保存的草稿保持不变。可以重试或降低思考强度。' : '审查已取消，未应用部分或迟到的结果。', timedOut ? 504 : 409);
      }
      if (error instanceof AppError && ['invalid_analysis','existing_rule_protected','invalid_question_reference','invalid_evidence','proposal_confirmation_required','review_question_coverage_incomplete'].includes(error.code)) options.store.recordInferenceFailure(id, revision, integration ? 'feature_integration' : addition ? 'feature_addition' : concept ? 'product_concept' : 'baseline_review', error);
      throw error;
    } finally { runs.delete(id); request.raw.off('aborted', aborted); }
  };
  app.post<{ Params: { id: string } }>('/api/projects/:id/analyze', request => analyzeHandler(request, false));
  app.post<{ Params: { id: string } }>('/api/projects/:id/concept/analyze', request => analyzeHandler(request, true));
  app.post<{ Params: { id: string } }>('/api/projects/:id/integration/analyze', request => analyzeHandler(request, false, false, true));
  app.post<{ Params: { id: string } }>('/api/projects/:id/addition/analyze', request => analyzeHandler(request, false, true));
  app.post<{ Params: { id: string } }>('/api/projects/:id/cancel', request => { runs.get(request.params.id)?.abort(); return { cancelled: true }; });
  app.post<{ Params: { id: string } }>('/api/projects/:id/accept', request => {
    const { revision, proposalId } = z.strictObject({ revision: revisionSchema, proposalId: z.string() }).parse(request.body);
    return options.store.accept(request.params.id, revision, proposalId);
  });
  app.get<{ Params: { id: string }; Querystring: { revision?: string } }>('/api/projects/:id/preview', request => {
    const revision = revisionSchema.parse(Number(request.query.revision));
    return options.store.preview(request.params.id, revision);
  });
  app.post<{ Params: { id: string } }>('/api/projects/:id/commit', request => {
    const { revision, confirmation } = z.strictObject({ revision: revisionSchema, confirmation: z.string() }).parse(request.body);
    return options.store.commit(request.params.id, revision, confirmation);
  });
  app.post<{ Params: { id: string } }>('/api/projects/:id/reset', request => {
    const { revision, confirmed } = z.strictObject({ revision: revisionSchema, confirmed: z.literal(true) }).parse(request.body);
    void confirmed;
    return options.store.reset(request.params.id, revision);
  });
  if (options.dev) {
    const { createServer } = await import('vite');
    vite = await createServer({ server: { middlewareMode: true, hmr: false, fs: {
      deny: ['.env', '.env.*', '*.{crt,pem}', '**/.git/**', '**/data/**', '**/.cache/**', ...(options.privateRoots ?? []).map(path => `${path.replaceAll('\\', '/')}/**`)],
    } }, appType: 'spa' });
    app.setNotFoundHandler((request, reply) => {
      if (request.url.startsWith('/api/')) return reply.code(404).send({ error: { message: '接口不存在。' } });
      reply.hijack();
      // Preserve headers prepared by Fastify when handing the socket to Vite.
      for (const [key, value] of Object.entries(reply.getHeaders())) if (value !== undefined) reply.raw.setHeader(key, value);
      vite!.middlewares(request.raw, reply.raw, () => { reply.raw.statusCode = 404; reply.raw.end('Not found'); });
    });
  } else {
    await app.register(staticFiles, { root: options.staticRoot ?? resolve('dist') });
  }
  app.addHook('onClose', async () => { for (const run of runs.values()) run.abort(); options.auth.cancel(); await vite?.close(); });
  return app;
}
