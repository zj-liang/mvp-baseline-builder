import { z } from 'zod';
import type { InferenceTransport, InferenceRequest } from './provider.js';
import type { ConnectionId, Effort, ModelCatalog } from '../shared/inference.js';
import { effortSchema } from '../shared/inference.js';
import { glmModels, openAIModel, supportsOpenAIResponses, validateModelOptions } from './model-capabilities.js';
import { AppError } from './errors.js';

type APIId = Exclude<ConnectionId, 'chatgpt'>;
const endpoints: Record<APIId, string> = { openai: 'https://api.openai.com/v1', deepseek: 'https://api.deepseek.com', glm: 'https://open.bigmodel.cn/api/paas/v4' };
function remoteError(status: number): AppError {
  if (status === 401) return new AppError('api_key_invalid', 'API Key 无效或已失效，请更换后重试。', 401);
  if (status === 403) return new AppError('api_access_denied', '此 API 连接没有请求权限，请检查厂商账号权限。', 403);
  if (status === 429) return new AppError('api_usage_limited', 'API 额度不足或请求受限，请到所选厂商查看额度并稍后重试。', 429);
  if (status === 404) return new AppError('model_unavailable', '所选 API 模型不可用，请重新选择。', 409);
  return new AppError('api_request_failed', '厂商未能完成请求，请检查模型支持和网络后重试。', 502);
}
const object = (value: unknown): value is Record<string, any> => Boolean(value && typeof value === 'object' && !Array.isArray(value));

// Read final output only. Reasoning text and upstream error bodies never leave this adapter.
export async function readModelStream(response: Response, protocol: 'responses' | 'chat', signal: AbortSignal): Promise<string> {
  if (!response.body || (response.headers.get('content-type') && !response.headers.get('content-type')!.toLowerCase().startsWith('text/event-stream'))) { await response.body?.cancel().catch(() => {}); throw new AppError('invalid_stream', '厂商没有返回有效响应流。', 502); }
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let pending = '', lines: string[] = [], eventSize = 0, text = '', completed = false, stopped = false, done = false;
  const dispatch = () => {
    const raw = lines.join('\n'); lines = []; eventSize = 0;
    if (!raw) return;
    if (raw === '[DONE]') { done = true; return; }
    let event: unknown; try { event = JSON.parse(raw); } catch { throw new AppError('invalid_stream', '厂商响应流结构无效。', 502); }
    if (!object(event) || event.error || event.type === 'error' || event.type === 'response.failed') throw new AppError('api_request_failed', '厂商响应失败，草稿保持不变。', 502);
    if (protocol === 'responses') {
      if (event.type === 'response.incomplete') throw new AppError('response_incomplete', '响应未完成，草稿保持不变。', 502);
      if (event.type === 'response.refusal.delta' || event.type === 'response.refusal.done') throw new AppError('model_refused', '模型拒绝了本次请求，草稿保持不变。', 502);
      if (event.type === 'response.output_text.delta' && typeof event.delta === 'string') text += event.delta;
      if (event.type === 'response.completed') {
        if (event.response?.status && event.response.status !== 'completed') throw new AppError('response_incomplete', '响应未完成。', 502);
        const output = event.response?.output;
        if (Array.isArray(output)) {
          const content = output.flatMap((item: any) => item.type === 'message' && Array.isArray(item.content) ? item.content : []);
          if (content.some((item: any) => item.type === 'refusal')) throw new AppError('model_refused', '模型拒绝了本次请求。', 502);
          const final = content.filter((item: any) => item.type === 'output_text' && typeof item.text === 'string').map((item: any) => item.text).join('');
          if (final) text = final;
        }
        completed = true;
      }
    } else {
      if (!Array.isArray(event.choices)) throw new AppError('invalid_stream', '厂商响应流结构无效。', 502);
      const choice = event.choices.find((item: any) => item.index === 0);
      if (choice) {
        if (choice.delta?.refusal) throw new AppError('model_refused', '模型拒绝了本次请求。', 502);
        if (typeof choice.delta?.content === 'string') text += choice.delta.content;
        if (choice.finish_reason && choice.finish_reason !== 'stop') throw new AppError('response_incomplete', '模型响应被截断或未正常完成。', 502);
        if (choice.finish_reason === 'stop') stopped = true;
      }
    }
    if (text.length > 16 * 1024 * 1024) throw new AppError('response_too_large', '模型响应超过容量，未应用。', 502);
  };
  const line = (value: string) => {
    if (!value) { dispatch(); return; }
    if (value.startsWith('data:')) { const data = value.slice(5).replace(/^ /, ''); eventSize += data.length; if (eventSize > 4 * 1024 * 1024) throw new AppError('invalid_stream', '响应流事件超过容量。', 502); lines.push(data); }
  };
  try {
    for (;;) {
      signal.throwIfAborted(); const chunk = await reader.read(); pending += decoder.decode(chunk.value, { stream: !chunk.done });
      let consumed = 0;
      for (let index = 0; index < pending.length; index++) {
        const char = pending[index]; if (char !== '\n' && char !== '\r') continue;
        if (char === '\r' && index === pending.length - 1 && !chunk.done) break;
        line(pending.slice(consumed, index)); if (char === '\r' && pending[index + 1] === '\n') index++; consumed = index + 1;
      }
      pending = pending.slice(consumed);
      if (pending.length > 4 * 1024 * 1024) throw new AppError('invalid_stream', '响应流事件超过容量。', 502);
      if (chunk.done) { if (pending) line(pending); dispatch(); break; }
      if (protocol === 'responses' ? completed : stopped && done) break;
    }
    signal.throwIfAborted();
    if (!(protocol === 'responses' ? completed : stopped && done)) throw new AppError('stream_interrupted', '响应在完成前中断，草稿保持不变。', 502);
    return text;
  } catch (error) { if (signal.aborted) throw signal.reason; if (error instanceof AppError) throw error; throw new AppError('stream_interrupted', '响应在完成前中断，草稿保持不变。', 502); }
  finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

export class APITransport implements InferenceTransport {
  constructor(private id: APIId, private getKey: () => Promise<string>, private fetcher: typeof fetch = fetch) {}
  private async request(path: string, key: string, signal: AbortSignal, body?: unknown): Promise<Response> {
    let response: Response;
    try { response = await this.fetcher(endpoints[this.id] + path, { method: body ? 'POST' : 'GET', headers: { authorization: `Bearer ${key}`, accept: body ? 'text/event-stream' : 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), redirect: 'error', signal }); }
    catch { signal.throwIfAborted(); throw new AppError('api_network_error', '无法连接所选模型厂商，请检查网络后重试。', 502); }
    if (!response.ok) { await response.body?.cancel().catch(() => {}); throw remoteError(response.status); }
    return response;
  }
  async catalog(signal: AbortSignal): Promise<ModelCatalog> {
    const key = await this.getKey(); signal.throwIfAborted();
    return this.loadCatalog(signal, key);
  }
  private async loadCatalog(signal: AbortSignal, key: string): Promise<ModelCatalog> {
    if (this.id === 'glm') return { models: structuredClone(glmModels), defaultModel: '' };
    const response = await this.request('/models', key, signal);
    try {
      const raw = await response.text(); if (raw.length > 4 * 1024 * 1024) throw new Error();
      const result = z.object({ data: z.array(z.object({ id: z.string().min(1).max(100), name: z.string().max(200).optional(), effort: z.object({ supported_levels: z.array(effortSchema), default_level: effortSchema.optional() }).optional() })) }).parse(JSON.parse(raw));
      const models = result.data.filter(m => this.id === 'deepseek' ? /^deepseek-/.test(m.id) : supportsOpenAIResponses(m.id)).map(m => this.id === 'openai' ? openAIModel(m.id) : ({ slug: m.id, displayName: m.name ?? m.id, reasoning: { efforts: m.effort?.supported_levels ?? ['low', 'high', 'max'] as Effort[], defaultEffort: m.effort?.default_level ?? 'high', toggle: true } }));
      if (!models.length) throw new Error(); return { models, defaultModel: '' };
    } catch { signal.throwIfAborted(); throw new AppError('invalid_model_catalog', '厂商模型目录无效或没有可用文本模型。', 502); }
  }
  async complete(request: InferenceRequest): Promise<string> {
    const { options, signal, instructions, input, schema, name } = request;
    const key = await this.getKey(); signal.throwIfAborted();
    const catalog = await this.loadCatalog(signal, key), model = catalog.models.find(m => m.slug === options.model);
    if (!model) throw new AppError('model_unavailable', '所选模型不在此连接的模型目录中，请重新选择。', 409);
    validateModelOptions(model, options, this.id);
    let body: Record<string, unknown>;
    if (this.id === 'glm') body = { model: model.slug, stream: true, response_format: { type: 'json_object' },
      messages: [{ role: 'system', content: instructions + '\n仅返回完整 JSON 对象，严格遵守以下 JSON Schema：\n' + JSON.stringify(schema) }, { role: 'user', content: JSON.stringify(input) }],
      ...(options.effort ? { reasoning_effort: options.effort } : {}), ...(options.thinking !== undefined ? { thinking: { type: options.thinking ? 'enabled' : 'disabled' } } : {}) };
    else body = { model: model.slug, stream: true, store: false, instructions, input: [{ role: 'user', content: JSON.stringify(input) }], text: { format: { type: 'json_schema', name, schema, ...(this.id === 'openai' ? { strict: true } : {}) } },
      ...(options.effort || options.thinking === false ? { reasoning: { effort: options.thinking === false ? 'none' : options.effort } } : {}) };
    return readModelStream(await this.request(this.id === 'glm' ? '/chat/completions' : '/responses', key, signal, body), this.id === 'glm' ? 'chat' : 'responses', signal);
  }
}
