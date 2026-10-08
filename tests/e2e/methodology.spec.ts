import { test, expect } from '@playwright/test';
import type { Project } from '../../shared/domain.js';
import { Store } from '../../server/store.js';
import { makeAnalysis } from '../fixtures.js';
import { baselineText } from '../../src/baseline-text.js';

const read = (page: import('@playwright/test').Page): Promise<Project> => page.evaluate(async () => (await fetch('/api/projects/' + localStorage.getItem('active-project'))).json());
test('partial complete choices, custom-only metric, persistent questions, evidence and exact formal copy', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(async () => {
    const p = await (await fetch('/api/projects', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: '方法论浏览器', productDescription: '用户要求误报率，门槛未定义', coreUserGoal: '个人监督', features: ['显示状态'] }) })).json();
    localStorage.setItem('active-project', p.id);
    await fetch(`/api/projects/${p.id}/analyze`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ revision: p.revision }) });
  });
  await page.reload();
  await expect(page.locator('article.issue')).toHaveCount(2);
  const before = await read(page), metric = page.locator('#decision-' + before.questions.find(q => q.gate === 'verifiability')!.id);
  await expect(metric.getByRole('radio')).toHaveCount(2);
  await expect(metric.getByRole('radio', { name: /^C ·/ })).not.toBeChecked();
  const choice = page.locator('#decision-' + before.questions.find(q => q.gate === 'boundary')!.id);
  await expect(choice.getByRole('radio', { name: /^A ·/ })).toBeEnabled();
  await choice.getByRole('radio', { name: /^A ·/ }).focus(); await page.keyboard.press('Space');
  await page.getByRole('button', { name: '查看所选决定' }).click();
  await page.getByRole('button', { name: '确认所选决定', exact: true }).click();
  await page.locator('main[aria-busy="false"]').waitFor();
  await expect(page.locator('article.issue')).toHaveCount(1);
  await expect(page.getByRole('button', { name: '进入最终确认' })).toBeDisabled();
  await page.getByText('查看已解决问题与依据（1）', { exact: true }).click();
  await expect(page.getByText('仅正常监督状态显示。', { exact: true })).toBeVisible();
  await page.reload(); await expect(page.locator('article.issue')).toHaveCount(1);
  expect((await read(page)).questions[0]!.status).toBe('resolved');
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('radio', { name: /^D ·/ }).check();
  await page.getByLabel('你要求的误报率门槛是什么？', { exact: true }).fill('误报率≤5%，不要求样本规模。');
  await page.reload(); await expect(page.getByLabel('你要求的误报率门槛是什么？', { exact: true })).toHaveValue('误报率≤5%，不要求样本规模。');
  await page.getByRole('button', { name: '查看所选决定' }).click(); await page.getByRole('button', { name: '确认所选决定', exact: true }).click();
  await page.locator('main[aria-busy="false"]').waitFor(); expect((await read(page)).status).toBe('Ready');
  await page.getByRole('button', { name: '进入最终确认' }).click();
  await expect(page.getByText('门槛：≤5%；样本要求：未定义', { exact: true })).toBeVisible();
  await page.getByRole('checkbox').check(); await page.getByRole('button', { name: '确认并生成 Baseline v1' }).click();
  await expect(page.getByRole('heading', { name: '产品基线', exact: true })).toBeVisible();
  await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => { sessionStorage.setItem('copied', text); } } }));
  await page.getByRole('button', { name: /复制给 Agent · Baseline v[0-9]+/ }).click();
  await expect(page.getByText(/Baseline v[0-9]+ 已复制，可直接粘贴给 Agent/)).toBeVisible();
  const copied = await page.evaluate(() => sessionStorage.getItem('copied'));
  expect(copied).toContain('≤5%'); expect(copied).toContain('样本要求：未定义'); expect(copied).not.toMatch(/evidence|messageId|openedAfter|测试用户明确/);
});

test('legacy committed payload without concept or quantitative metadata remains readable and copies unchanged', async ({ page }) => {
  const store = new Store(':memory:');
  try {
    const created = store.create({ name: '旧基线兼容', productDescription: '旧产品定义', coreUserGoal: '旧使用场景', features: ['显示状态'] });
    const reviewed = store.applyAnalysis(created.id, created.revision, makeAnalysis(created));
    const legacy = { productDescription: '旧产品定义', coreUserGoal: '旧使用场景', baselineVersion: 'v1' as const, createdAt: '2026-01-01T00:00:00.000Z',
      p0Items: reviewed.draft.candidates.map(({ source: _source, ...candidate }) => ({ ...candidate, verification: candidate.verification ? Object.fromEntries(Object.entries(candidate.verification).filter(([key]) => key !== 'quantitativeRequirements')) as typeof candidate.verification : null })) };
    const original = JSON.stringify(legacy); store.db.prepare('INSERT INTO baselines VALUES(?,?,?)').run(created.id, reviewed.revision, original);
    const project = store.get(created.id);
    await page.route('**/api/projects', route => route.request().method() === 'GET' ? route.fulfill({ json: store.list() }) : route.continue());
    await page.route('**/api/projects/' + created.id, route => route.fulfill({ json: project }));
    await page.addInitScript(id => localStorage.setItem('active-project', id), created.id);
    await page.goto('/');
    await expect(page.getByRole('heading', { name: '产品基线', exact: true })).toBeVisible();
    await expect(page.getByText('旧版本未记录产品设定', { exact: true })).toBeVisible();
    await expect(page.getByRole('navigation', { name: '主流程' }).getByRole('button')).toHaveCount(1);
    await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => { sessionStorage.setItem('legacy-copy', text); } } }));
    await page.getByRole('button', { name: /复制给 Agent · Baseline v[0-9]+/ }).click();
    await expect(page.getByText(/Baseline v[0-9]+ 已复制，可直接粘贴给 Agent/)).toBeVisible();
    expect(await page.evaluate(() => sessionStorage.getItem('legacy-copy'))).toBe(baselineText(project.name, legacy));
    expect(store.db.prepare('SELECT payload FROM baselines WHERE project_id=?').get(created.id)!.payload).toBe(original);
  } finally { store.close(); }
});
