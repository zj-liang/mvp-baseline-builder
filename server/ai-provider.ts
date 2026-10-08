import type { Provider } from './provider.js';
import { TaskProvider } from './provider.js';
import { APITransport } from './api-transport.js';
import type { AIConnections } from './ai-connections.js';
import type { ConnectionId, InferenceOptions } from '../shared/inference.js';
import type { Project } from '../shared/domain.js';
import { AppError } from './errors.js';

export class AIProvider implements Provider {
  private providers: Record<ConnectionId, Provider>;
  constructor(chatgpt: Provider, connections: AIConnections, fetcher: typeof fetch = fetch) {
    this.providers = { chatgpt, ...Object.fromEntries((['openai', 'deepseek', 'glm'] as const).map(id => [id, new TaskProvider(new APITransport(id, () => connections.key(id), fetcher))])) } as Record<ConnectionId, Provider>;
  }
  catalog(signal: AbortSignal, id: ConnectionId = 'chatgpt') { return this.providers[id].catalog!(signal); }
  private selected(options?: InferenceOptions) { return this.providers[options?.connectionId ?? 'chatgpt']; }
  analyze(project: Project, signal: AbortSignal, options?: InferenceOptions) { return this.selected(options).analyze(project, signal, options); }
  developConcept(project: Project, signal: AbortSignal, options?: InferenceOptions) { return this.selected(options).developConcept!(project, signal, options); }
  assessAddition(project: Project, signal: AbortSignal, options?: InferenceOptions) { return this.selected(options).assessAddition!(project, signal, options); }
  reviewIntegration(project: Project, signal: AbortSignal, options?: InferenceOptions) { return this.selected(options).reviewIntegration!(project, signal, options); }
  async testConnection(options: InferenceOptions, signal: AbortSignal) {
    const id = options.connectionId ?? 'chatgpt';
    if (id === 'chatgpt') throw new AppError('invalid_connection', 'ChatGPT 连接状态由官方登录核验。');
    const provider = this.providers[id] as TaskProvider;
    const result = await provider.testConnection(options, signal);
    return result;
  }
}
