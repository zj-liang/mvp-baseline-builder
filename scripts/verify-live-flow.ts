import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { chromium } from '@playwright/test';
import type { Page } from '@playwright/test';
import { createAuth, windowsCredentialEncryption } from '../server/auth.js';
import { AIConnections } from '../server/ai-connections.js';
import { ChatGPTProvider } from '../server/provider.js';
import { Store } from '../server/store.js';
import { buildApp } from '../server/app.js';
import type { Project } from '../shared/domain.js';
import { baselineText } from '../src/baseline-text.js';
import manifest from '../package.json' with { type: 'json' };

// Opt-in real inference with a scripted test user's explicit decisions.
// Only the protected auth runtime is reused; product data are fully isolated.
mkdirSync(resolve('.cache/tests'), { recursive: true });
const directory = mkdtempSync(resolve('.cache/tests/live-v2-'));
const store = new Store(join(directory, 'baseline.sqlite'));
const auth = createAuth(resolve(process.env.BASELINE_DATA_DIR ?? 'data', 'auth'));
const realProvider = new ChatGPTProvider(auth.client);
const premise = '我想做一个自律监督工具，有玩偶随机巡查，离席会扣心。';
const report: Record<string, unknown> = { version: manifest.version, liveInference: true, scriptedTestUser: true, decisionPolicy: 'Select concrete AI options together, review summary, explicitly accept proposals; custom-only questions stop this script; never bypass gates', isolatedProductData: true, reasoningEffort: 'high', premise };
let calls = 0, completed = 0;
const reserveRequest = () => { if (calls >= 6) throw new Error('已达到六次真实请求上限，未发起额外请求。'); calls++; };
const app = await buildApp({ store, auth, connections: new AIConnections(join(directory, 'auth'), windowsCredentialEncryption), provider: {
  catalog: signal => realProvider.catalog(signal),
  async developConcept(project, signal, options) {
    reserveRequest(); const result = await realProvider.developConcept(project, signal, options); completed++;
    writeFileSync(resolve('.cache/live-v2-concept.json'), JSON.stringify(result, null, 2));
    console.log('真实设想整理完成，关键问题：' + result.questions.length);
    return result;
  },
  async analyze(project, signal, options) {
    reserveRequest(); const result = await realProvider.analyze(project, signal, options); completed++;
    writeFileSync(resolve('.cache/live-v2-analysis.json'), JSON.stringify(result, null, 2));
    console.log('真实 P0 审查完成，待决定问题：' + result.issues.length);
    return result;
  },
} });
const address = await app.listen({ host: '127.0.0.1', port: 0 });
const browser = await chromium.launch({ channel: 'msedge', headless: true });
let page: Page | undefined;
try {
  const status = await auth.status();
  if (status.status !== 'connected' || !status.sharing) throw new Error('真实 ChatGPT 连接或 Plan Usage 授权不可用；请用户在正式应用完成授权。');
  const catalog = await realProvider.catalog(AbortSignal.timeout(30000)); report.model = catalog.defaultModel;
  page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  const runAI = async (click: () => Promise<unknown>) => {
    const responsePromise = page!.waitForResponse(r => /\/analyze$/.test(r.url()) && r.request().method() === 'POST', { timeout: 610000 });
    await click(); const response = await responsePromise;
    if (!response.ok()) throw new Error((await response.json()).error?.message ?? '真实推理请求失败。');
    await page!.locator('main[aria-busy="false"]').waitFor({ timeout: 10000 });
  };
  const read = async (): Promise<Project> => page!.evaluate(async () => (await fetch('/api/projects/' + localStorage.getItem('active-project'))).json());
  const answerQuestions = async (project: Project) => {
    const questions = project.questions.filter(q => q.stage === project.stage && q.status !== 'resolved').map(q => q.question);
    if (!questions.length) throw new Error('信息未就绪但没有可回答的问题；未绕过确认条件。');
    let accepts = false;
    for (const question of questions) {
      const option = question.options.find(o => !o.unsure);
      if (!option) throw new Error('此问题没有可明确选择的有效选项。');
      const card = page!.locator('#decision-' + question.id);
      await card.getByRole('radio', { name: new RegExp('^' + option.key + ' ·') }).check();
      if ('kind' in question && question.kind === 'conflict') {
        const proposal = option.proposalIndex !== null ? question.proposals[option.proposalIndex] : null;
        if (!proposal) throw new Error('冲突选项引用无效。');
        accepts = true; report.acceptedProposal = proposal.rule;
      }
    }
    await page!.getByRole('button', { name: '查看所选决定' }).click();
    await runAI(() => page!.getByRole('button', { name: accepts ? '确认所选决定并接受解决规则' : '确认所选决定', exact: true }).click());
  };
  await page.goto(address);
  await page.getByLabel('项目名称（可选）', { exact: true }).fill('V2 真实验收专用 · 隔离项目');
  await page.getByLabel('Product Concept / Experience Premise · 描述你想象中的产品', { exact: true }).fill(premise);
  await runAI(() => page!.getByRole('button', { name: '保存设想并开始' }).click());
  let project = await read();
  report.initialConceptQuestions = project.intake!.questions.length;
  if (project.stage !== 'concept' || project.baseline || project.intake!.conceptInput !== premise) throw new Error('原始设想或独立阶段未正确保存。');
  await page.screenshot({ path: '.cache/live-v2-concept.png', fullPage: true });
  for (let round = 0; project.intake!.questions.length && round < 3; round++) { await answerQuestions(project); project = await read(); }
  if (project.intake!.questions.length) { report.unresolvedConceptQuestions = project.intake!.questions; throw new Error('真实模型仍需要产品设想决定，尚未确认候选。'); }
  await runAI(() => page!.getByRole('button', { name: '确认这些设定与初始功能' }).click());
  project = await read(); const sources = project.draft.candidates.map(c => ({ id: c.id, source: c.source }));
  report.confirmedCandidateCount = sources.length;
  for (let round = 0; project.status !== 'Ready' && round < 5; round++) {
    await answerQuestions(project);
    project = await read();
  }
  if (project.status !== 'Ready') { report.unresolvedIssues = project.review?.issues; throw new Error('真实审查仍未通过全部 Gate；没有提交。'); }
  if (JSON.stringify(project.draft.candidates.map(c => ({ id: c.id, source: c.source }))) !== JSON.stringify(sources)) throw new Error('确认后的候选来源或标识发生变化。');
  await page.getByRole('heading', { name: 'MVP 梳理', exact: true }).waitFor();
  report.defaultDefinitionFieldsHidden = await page.getByLabel('Description · 希望实现什么').count() === 0;
  await page.screenshot({ path: '.cache/live-v2-candidates.png', fullPage: true });
  await page.getByRole('button', { name: '进入最终确认' }).click();
  await page.getByRole('checkbox').check(); await page.getByRole('button', { name: '确认并生成 Baseline v1' }).click();
  await page.getByRole('heading', { name: '产品基线', exact: true }).waitFor();
  project = await read();
  if (!project.baseline?.productConcept || project.baseline.p0Items.length !== sources.length) throw new Error('Baseline 没有完整包含产品设定与候选。');
  report.committed = true; report.productConcept = project.baseline.productConcept;
  report.verificationTypes = project.baseline.p0Items.map(c => ({ id: c.id, type: c.verification?.type }));
  const saved = project.baseline;
  writeFileSync(resolve('.cache/live-v2-committed.json'), JSON.stringify({ name: project.name, baseline: saved, revision: project.revision }, null, 2));
  await page.reload(); await page.getByRole('heading', { name: '产品基线', exact: true }).waitFor();
  report.browserRefreshPreservedMemory = JSON.stringify((await read()).baseline) === JSON.stringify(saved);
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  const revisionBeforeCopy = project.revision;
  await page.getByRole('button', { name: '复制给 Agent', exact: true }).click();
  await page.getByText('已复制，可直接粘贴给 Agent', { exact: true }).waitFor();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  // Windows represents clipboard newlines as CRLF. Compare every other character unchanged.
  const normalizeNewlines = (value: string) => value.replace(/\r\n/g, '\n');
  report.clipboardExactBaseline = normalizeNewlines(copied) === normalizeNewlines(baselineText(project.name, saved));
  report.clipboardNewlineNormalization = 'CRLF -> LF only';
  if (!report.clipboardExactBaseline || (await read()).revision !== revisionBeforeCopy) throw new Error('基线复制不完整或修改了产品数据。');
  report.userNavigation = await page.getByRole('navigation', { name: '主流程' }).innerText();
  const safe = await page.evaluate(async () => ({ auth: await (await fetch('/api/auth')).json(), storage: { ...localStorage }, cookies: document.cookie }));
  if (/accessToken|refreshToken|id_token|credentials|baseline_session/.test(JSON.stringify(safe))) throw new Error('前端出现认证凭据。');
  report.frontendCredentialsAbsent = true; report.pageErrors = errors;
  if (errors.length) throw new Error('前端存在运行错误。');
  await page.screenshot({ path: '.cache/live-v2-memory.png', fullPage: true });
  console.log('V2 真实模型完整流程完成：设想、决策、完整预览、用户确认、Commit 与刷新记忆。');
} catch (error) {
  report.error = error instanceof Error ? error.message : 'Unknown live verification error';
  console.error(report.error); process.exitCode = 1;
  if (page) await page.screenshot({ path: '.cache/live-v2-failure.png', fullPage: true }).catch(() => {});
} finally {
  report.attemptedRequests = calls; report.completedStructuredRequests = completed; report.maximumRequests = 6;
  writeFileSync(resolve('.cache/live-v2-validation.json'), JSON.stringify(report, null, 2));
  await browser.close(); await app.close(); store.close();
  if (dirname(resolve(directory)) !== resolve('.cache/tests')) throw new Error('拒绝清理测试目录之外的路径。');
  rmSync(directory, { recursive: true, force: true });
}
