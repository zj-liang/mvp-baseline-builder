import { resolve } from 'node:path';
import { createAuth } from '../server/auth.js';
import { publicError } from '../server/errors.js';

// An explicit, opt-in live check. No fake sessions, developer key or API fallback.
const auth = createAuth(resolve(process.env.BASELINE_DATA_DIR ?? 'data', 'auth'));
try {
  const session = await auth.client.getSession();
  if (session.status !== 'connected' || !session.sharing) throw new Error('请先在本地 Web UI 完成 ChatGPT 登录并授权 Plan Usage。');
  const models = await auth.client.listModels();
  const model = models.find(m => m.slug === 'gpt-6.1-sol') ?? models.find(m => /^(gpt-|o\d)/.test(m.slug) && !/(image|audio|realtime)/i.test(m.slug));
  if (!model) throw new Error('当前账号没有可用的文本模型。');
  console.log(`当前账号模型目录：${models.map(m => m.slug).join(', ')}`);
  const result = await auth.client.streamResponse({ model: model.slug, input: [{ role: 'user', content: 'Return JSON with connected set to true.' }],
    reasoning: { effort: 'high' },
    text: { format: { type: 'json_schema', name: 'plan_usage_check', strict: true, schema: { type: 'object', properties: { connected: { type: 'boolean' } }, required: ['connected'], additionalProperties: false } } },
    signal: AbortSignal.timeout(60000) });
  if (JSON.parse(result.text).connected !== true) throw new Error('结构化请求返回了非预期结果。');
  console.log(`真实 ChatGPT Plan Usage 和严格结构化请求已完成。模型：${model.slug}；思考强度：high`);
} catch (error) {
  console.error(error instanceof Error && error.constructor === Error ? error.message : publicError(error).message);
  process.exitCode = 1;
}
