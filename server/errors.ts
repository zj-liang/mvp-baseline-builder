import { ChatGPTError } from '@siwc/local';
import { ZodError } from 'zod';

export type QuestionDiagnostic = { questionId?: string; evidenceMessageIds?: string[]; latestAnswerMessageId?: string; missingGates?: string[] };
export class AppError extends Error {
  questionDiagnostic?: QuestionDiagnostic;
  constructor(public code: string, message: string, public status = 400) { super(message); }
}
export class ModelValidationError extends AppError {
  readonly diagnostic: { stage: string; category: string; paths: string[] };
  constructor(stage: string, category: 'json' | 'schema', paths: PropertyKey[][]) {
    super('invalid_analysis', 'AI 返回的结构不符合审查要求，未应用结果，请重试。', 502);
    // Unknown property names can contain provider text/secrets. Only contract keys/IDs survive.
    const allowed = /^(items|fields|verification|gates|coveredGates|issues|resolvedQuestions|questionId|p0Ids|proposals|changes|field|value|p0Id|summary|checkedP0Ids|mode|name|description|purpose|applicableState|coreRule|kind|gate|condition|ruleA|ruleB|explanation|options|answerMode|reason|evidence|messageId|quote|quantitativeSources|definition|questions|targetP0Id|relatedP0Ids|P0-\d+)$/;
    this.diagnostic = { stage, category, paths: [...new Set(paths.slice(0, 20).map(path => path.map(k => typeof k === 'number' ? k : allowed.test(String(k)) ? String(k) : '*').join('.')))] };
  }
}
const translations: Record<string, string> = {
  sign_in_required: '请先使用 Continue with ChatGPT 登录。',
  sharing_not_enabled: '账号已连接，但尚未授权 ChatGPT Plan Usage。请主动启用授权。',
  access_denied: '授权未完成或已取消，可以重新连接。',
  connection_busy: '请先完成或取消当前账号连接操作。',
  cancelled: '请求已取消；已保存的草稿保持不变。',
  subscription_sharing_user_not_eligible: '当前 ChatGPT 账号或工作区没有可用的 Plan Usage 权限。',
  subscription_sharing_usage_limit_exceeded: '已达到 ChatGPT Plan 或此应用的使用限制，请打开 Manage usage。',
  subscription_sharing_usage_unavailable: '暂时无法确认 ChatGPT 使用额度，请稍后重试。',
  revocation_failed: '本地凭据已清除，但未能确认远程撤销。请在 ChatGPT 设置中断开此应用。',
  encryption_unavailable: 'Windows 凭据加密暂不可用；请检查当前 Windows 用户环境。',
  network_error: '无法连接 OpenAI，请检查网络后重试。',
  discovery_failed: '无法验证 OpenAI 官方登录配置，请检查网络及代理设置后重试。',
  storage_encryption_failed: 'Windows 凭据加密失败，原有凭据已保留。请检查当前 Windows 用户环境后重试。',
  storage_decryption_failed: '无法解密保存的 ChatGPT 连接，请使用原 Windows 用户和凭据存储。原文件已保留。',
  stream_interrupted: 'AI 响应中断，未应用部分内容，请重试。',
  response_incomplete: 'AI 未完成响应，未应用部分内容，请重试。',
  invalid_stream: 'AI 返回了无效响应，未修改草稿，请重试。',
  model_not_found: '此模型当前不可用，请刷新模型列表并重新选择。草稿保持不变。',
};
export function publicError(error: unknown) {
  if (error instanceof AppError) return { status: error.status, code: error.code, message: error.message, retryable: false };
  if (error instanceof ZodError) return { status: 400, code: 'invalid_input', message: '输入结构不完整或超出限制，请检查填写内容。', retryable: false };
  if (error instanceof ChatGPTError) return {
    status: 502, code: error.code,
    message: translations[error.code] ?? `ChatGPT 无法完成请求（${error.code}），请检查连接、权限或稍后重试。`,
    retryable: error.retryable,
  };
  return { status: 500, code: 'internal_error', message: '操作未完成，请重试；已保存的数据不会被自动清空。', retryable: true };
}
