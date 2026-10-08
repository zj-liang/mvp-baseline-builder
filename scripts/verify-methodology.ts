import { mkdirSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { createAuth } from '../server/auth.js';
import { ChatGPTProvider } from '../server/provider.js';
import { Store } from '../server/store.js';
import type { Analysis, Project } from '../shared/domain.js';
import manifest from '../package.json' with { type: 'json' };

// Explicitly bounded content investigation. Failures count. No formal project data,
// account selection changes, synthetic inference, or forced Gate success.
const maximum = 6;
mkdirSync(resolve('.cache/tests'), { recursive: true });
const directory = mkdtempSync(resolve('.cache/tests/methodology-022-'));
const store = new Store(join(directory, 'baseline.sqlite'));
const auth = createAuth(resolve(process.env.BASELINE_DATA_DIR ?? 'data', 'auth'));
const provider = new ChatGPTProvider(auth.client);
const report: { date: string; version: string; attempts: number; model?: string; results: Array<Record<string, unknown>>; error?: string } = {
  date: new Date().toISOString(), version: manifest.version, attempts: 0, results: [],
};
async function review(label: string, project: Project): Promise<Project | null> {
  if (report.attempts >= maximum) throw new Error('六次请求预算已用完');
  report.attempts++;
  const entry: Record<string, unknown> = { label, attempt: report.attempts, input: { draft: project.draft, conversation: project.conversation, questions: project.questions } };
  report.results.push(entry);
  console.log(`REQUEST ${report.attempts}/${maximum}: ${label}`);
  try {
    const result: Analysis = await provider.analyze(project, AbortSignal.timeout(600000), { effort: 'high' });
    entry.output = result;
    const applied = store.applyAnalysis(project.id, project.revision, result);
    entry.mechanism = { applied: true, status: applied.status, pending: applied.questions.filter(q => q.status !== 'resolved').length };
    console.log(`COMPLETE ${label}: ${applied.status}, ${applied.questions.filter(q => q.status !== 'resolved').length} pending`);
    return applied;
  } catch (error) {
    entry.error = error instanceof Error ? error.message : String(error);
    entry.errorCode = error && typeof error === 'object' && 'code' in error ? error.code : null;
    console.log(`FAILED ${label}: ${String(entry.error)}`);
    return null;
  } finally {
    writeFileSync(resolve('.cache/methodology-022-live.json'), JSON.stringify(report, null, 2));
  }
}
const create = (description: string, features: string[]) => store.create({ name: '隔离内容验收', productDescription: description, productConcept: description, coreUserGoal: '个人在学习时希望温和地监督在场情况。', features });
try {
  const status = await auth.status();
  if (status.status !== 'connected' || !status.sharing) throw new Error('已有连接或 Plan Usage 授权不可用');
  report.model = (await provider.catalog(AbortSignal.timeout(30000))).defaultModel;
  let simple = create('个人本机自律监督 MVP，虚拟玩偶通过摄像头监督在场，离席扣心。只验证核心主流程，不要求生产指标或防欺骗。', ['摄像头显示在场状态', '离席扣心：用户未提供离席时间、扣心方式']);
  simple = await review('GC01 / GC06 / GC11：未知阈值、Purpose 与最小验收', simple) ?? simple;
  simple = store.feedback(simple.id, simple.revision, '正常监督时摄像头无人在场连续超过10秒扣1心，同次离席只扣一次；回来重置计时。开始3颗心，扣至0结束，重新开始恢复3颗心。摄像头不可用时暂停、不扣心，恢复后用户主动继续。摄像头状态在当前界面显示。无需防照片或视频欺骗，不要求统计指标；真人入镜再离开，观察状态即可。');
  await review('GC10：后续用户资料关闭已有问题', simple);
  await review('GC12：用户已明确的量化要求', create('摄像头 MVP；用户明确要求误报率≤5%，20个样本。真实人体验收；误报率定义为实际在场却判无人次数除以在场样本数。', ['正常监督时显示摄像头有人/无人状态，镜头不可用显示不可用，不处罚。']));
  await review('GC12 / GC13：要求指标但门槛未定义', create('摄像头 MVP；用户要求误报率作为量化验收，但未定义门槛和样本规模。不要建议数字，需自定义决定。', ['正常监督时显示摄像头有人/无人状态，镜头不可用显示不可用，不处罚。']));
  await review('GC02：相同条件下直接冲突', create('个人监督 MVP，下面两条规则同时在正常监督状态生效；用户没有确认例外或优先级。', ['正常监督连续离席超过10秒扣1心，同次离席只扣一次，回来重置计时。', '正常监督连续离席60秒内不扣心，超过60秒结束免罚。']));
  await review('GC03：正常和暂停不同状态不直接冲突', create('个人监督 MVP，两条规则分别在正常监督、暂停监督状态生效；暂停由用户主动点击进入并主动点击恢复。', ['正常监督连续离席超过10秒扣1心，同次离席只扣一次，回来重置计时。', '暂停监督时离席不扣心，恢复时重置无人计时；开始3心，0心结束。']));
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error); console.error(report.error); process.exitCode = 1;
} finally {
  writeFileSync(resolve('.cache/methodology-022-live.json'), JSON.stringify(report, null, 2));
  store.close();
  if (dirname(resolve(directory)) !== resolve('.cache/tests')) throw new Error('Unsafe cleanup');
  rmSync(directory, { recursive: true, force: true });
  console.log(`ATTEMPTS=${report.attempts}/${maximum}`);
}
