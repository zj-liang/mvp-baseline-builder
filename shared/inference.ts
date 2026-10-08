import { z } from 'zod';

export const connectionIdSchema = z.enum(['chatgpt', 'openai', 'deepseek', 'glm']);
export type ConnectionId = z.infer<typeof connectionIdSchema>;
export const effortSchema = z.enum(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);
export type Effort = z.infer<typeof effortSchema>;
export const inferenceOptionsSchema = z.strictObject({
  connectionId: connectionIdSchema.optional(),
  model: z.string().trim().min(1).max(100).optional(),
  effort: effortSchema.optional(),
  thinking: z.boolean().optional(),
});
export type InferenceOptions = z.infer<typeof inferenceOptionsSchema>;
export type ModelInfo = { slug: string; displayName: string; reasoning?: { efforts: Effort[]; defaultEffort?: Effort; toggle?: boolean } };
export interface ModelCatalog { models: ModelInfo[]; defaultModel: string }
export const connectionLabels: Record<ConnectionId, string> = { chatgpt: 'ChatGPT 账号', openai: 'OpenAI API', deepseek: 'DeepSeek API', glm: '智谱 GLM API' };
export type ConnectionState = { id: ConnectionId; configured: boolean; status: 'unconfigured' | 'configured' | 'verified' | 'failed'; testedModel?: string; error?: string };
export type AIState = { activeConnectionId: ConnectionId; connections: ConnectionState[]; preferences: Partial<Record<string, InferenceOptions>> };
