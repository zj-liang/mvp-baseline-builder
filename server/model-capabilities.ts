import type { ConnectionId, InferenceOptions, ModelInfo, Effort } from '../shared/inference.js';
import { AppError } from './errors.js';

export function openAIModel(slug: string, displayName = slug, chatgpt = false): ModelInfo {
  const reasoning = /^(gpt-[56]|o[134])/.test(slug) && !/-chat(?:-|$)/.test(slug);
  let efforts: Effort[] = ['low', 'medium', 'high'];
  if (/^gpt-6\.1|^gpt-6-astra/.test(slug) && !chatgpt) efforts = ['low', 'medium', 'high', 'xhigh', 'max'];
  if (/^o[134]/.test(slug)) efforts = ['low', 'medium', 'high'];
  if (!chatgpt && /-pro(?:-|$)/.test(slug)) efforts = ['high'];
  return { slug, displayName, reasoning: { efforts: reasoning ? efforts : [], ...(reasoning ? { defaultEffort: 'high' as const } : {}) } };
}
export function supportsOpenAIResponses(slug: string) {
  return /^(gpt-4\.1(?:-|$)|gpt-4o(?:-|$)|gpt-[56](?:[.-]|$)|o[134](?:-|$))/.test(slug)
    && !/(image|audio|realtime|search|transcrib|tts|instruct|codex|embedding|gpt-4o-2024-05-13|o1-(mini|preview))/i.test(slug);
}
export const glmModels: ModelInfo[] = [
  { slug: 'glm-5.2', displayName: 'glm-5.2', reasoning: { efforts: [], toggle: true } },
  { slug: 'glm-5.3', displayName: 'glm-5.3', reasoning: { efforts: ['low', 'high', 'max'], defaultEffort: 'max' } },
];
export function validateModelOptions(model: ModelInfo, options: InferenceOptions, connectionId: ConnectionId) {
  const capabilities = model.reasoning ?? { efforts: ['low', 'medium', 'high'] as Effort[] };
  if (options.effort && !capabilities.efforts.includes(options.effort)) throw new AppError('unsupported_effort', '当前模型不支持所选思考强度，请重新选择。');
  if (options.thinking !== undefined && !capabilities.toggle) throw new AppError('unsupported_thinking', '当前模型不支持切换思考模式。');
  if (options.thinking === false && options.effort) throw new AppError('unsupported_effort', '关闭思考时不能同时指定思考强度。');
  if (connectionId !== 'chatgpt' && !options.model) throw new AppError('model_required', '请先选择此 API 连接的模型。');
}
