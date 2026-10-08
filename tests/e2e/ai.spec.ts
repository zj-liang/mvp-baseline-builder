import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';

async function openSettings(page: Page) {
  const button = page.getByRole('button', { name: '调整连接与模型', exact: true });
  await page.locator('main[aria-busy="false"]').waitFor();
  if (await button.count()) await button.click();
}

const headers = { origin: 'http://127.0.0.1:' + (process.env.E2E_PORT ?? '3101') };
test.beforeEach(async ({ request }) => {
  await request.get('/');
  expect((await request.put('/api/ai/preferences', { headers, data: { connectionId: 'chatgpt', model: 'gpt-6.1-sol', effort: 'high' } })).ok()).toBe(true);
});
test.afterEach(async ({ page, request }) => {
  await page.locator('main[aria-busy="false"]').waitFor();
  const response = await request.put('/api/ai/preferences', { headers, data: { connectionId: 'chatgpt', model: 'gpt-6.1-sol', effort: 'high' } });
  expect(response.status(), await response.text()).toBe(200);
});

test('unifies four connections, shows only actual model IDs, restores settings and never persists API Key in the browser', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await expect(page.getByLabel('审查模型', { exact: true })).toHaveValue('gpt-6.1-sol');
  await expect(page.getByRole('region', { name: 'AI 连接', exact: true })).not.toContainText('自动优先');
  await expect(page.getByLabel('连接方式')).toHaveValue('chatgpt');
  await openSettings(page); await page.getByLabel('连接方式').selectOption('glm');
  await page.getByText('管理连接', { exact: true }).click();
  const key = 'e2e-synthetic-glm-key';
  await page.getByLabel('API Key', { exact: true }).fill(key);
  await page.getByRole('button', { name: '保存 Key', exact: true }).click();
  await expect(page.getByLabel('API Key', { exact: true })).toHaveValue('');
  await expect(page.getByLabel('审查模型', { exact: true })).toBeEnabled();
  await page.getByLabel('审查模型', { exact: true }).selectOption('glm-5.2');
  await expect(page.getByLabel('思考模式', { exact: true })).toBeVisible();
  await expect(page.getByLabel('思考强度', { exact: true })).toHaveCount(0);
  await page.getByLabel('思考模式', { exact: true }).selectOption('off');
  await page.getByRole('button', { name: '测试连接', exact: true }).click();
  await expect(page.getByRole('region', { name: 'AI 连接', exact: true })).toContainText('验证成功');
  await page.getByLabel('审查模型', { exact: true }).selectOption('glm-5.3');
  await expect(page.getByLabel('思考模式', { exact: true })).toHaveCount(0);
  await expect(page.getByLabel('思考强度', { exact: true })).toHaveValue('max');
  await page.reload();
  await expect(page.getByLabel('连接方式')).toHaveValue('glm');
  await expect(page.getByLabel('审查模型', { exact: true })).toHaveValue('glm-5.3');
  await expect(page.getByLabel('思考强度', { exact: true })).toHaveValue('max');
  const browserState = await page.evaluate(async () => ({ local: { ...localStorage }, session: { ...sessionStorage }, connections: await (await fetch('/api/ai/connections')).json() }));
  expect(JSON.stringify(browserState)).not.toContain(key);
  await openSettings(page); await page.getByLabel('连接方式').selectOption('openai');
  await page.getByText('管理连接', { exact: true }).click();
  await page.getByLabel('API Key', { exact: true }).fill('e2e-synthetic-openai-key');
  await page.getByRole('button', { name: '保存 Key', exact: true }).click();
  await page.getByLabel('审查模型', { exact: true }).selectOption('gpt-6-astra');
  await expect(page.getByLabel('思考强度', { exact: true })).toHaveValue('high');
  await openSettings(page); await page.getByLabel('连接方式').selectOption('deepseek');
  await page.getByLabel('API Key', { exact: true }).fill('e2e-synthetic-deepseek-key');
  await page.getByRole('button', { name: '保存 Key', exact: true }).click();
  await page.getByLabel('审查模型', { exact: true }).selectOption('deepseek-flash');
  await expect(page.getByLabel('思考模式', { exact: true })).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: '.cache/ai-connections-mobile.png', fullPage: true });
  await openSettings(page); await page.getByLabel('连接方式').selectOption('glm');
  await expect(page.getByLabel('审查模型', { exact: true })).toHaveValue('glm-5.3');
  await page.getByRole('button', { name: '移除 Key', exact: true }).click();
  await expect(page.getByRole('region', { name: 'AI 连接', exact: true })).toContainText('尚未配置');
  await openSettings(page); await page.getByLabel('连接方式').selectOption('chatgpt');
  await expect(page.getByLabel('审查模型', { exact: true })).toHaveValue('gpt-6.1-sol');
  expect(errors).toEqual([]);
});

test('an API connection runs initial and feature-addition reviews through the existing confirmation flow', async ({ page, request }) => {
  expect((await request.put('/api/ai/connections/openai/key', { headers, data: { key: 'e2e-synthetic-openai-key' } })).ok()).toBe(true);
  expect((await request.put('/api/ai/preferences', { headers, data: { connectionId: 'openai', model: 'gpt-6-astra', effort: 'high' } })).ok()).toBe(true);
  await page.goto('/'); await expect(page.getByLabel('审查模型', { exact: true })).toBeEnabled();
  await expect(page.getByLabel('审查模型', { exact: true })).toHaveValue('gpt-6-astra');
  await page.evaluate(async () => {
    let p = await (await fetch('/api/projects', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'API 浏览器流程', productDescription: '监督', coreUserGoal: '专注', features: ['监督'] }) })).json();
    p = await (await fetch(`/api/projects/${p.id}/analyze`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ revision: p.revision, inference: { connectionId: 'openai', model: 'gpt-6-astra', effort: 'high' } }) })).json();
    localStorage.setItem('active-project', p.id);
  });
  await page.reload(); await page.getByRole('button', { name: '进入最终确认' }).click();
  await page.getByRole('checkbox', { name: '这就是我希望实现的第一版 MVP 产品逻辑。' }).check();
  await page.getByRole('button', { name: '确认并生成 Baseline v1' }).click();
  await page.getByRole('button', { name: '加入新功能', exact: true }).click();
  await page.getByLabel('新功能设想', { exact: true }).fill('增加主动暂停监督');
  await page.getByRole('button', { name: '保存新功能并开始' }).click();
  await page.getByRole('button', { name: '确认新增清单，审查新旧关系' }).click();
  await page.getByRole('button', { name: '进入最终确认' }).click();
  await page.getByRole('checkbox', { name: '这就是我希望更新后的当前产品逻辑。' }).check();
  await page.getByRole('button', { name: '确认并生成 Baseline v2' }).click();
  await expect(page.getByLabel('查看基线版本')).toHaveValue('v2');
  const product = await page.evaluate(async () => (await fetch('/api/projects/' + localStorage.getItem('active-project'))).json());
  expect(JSON.stringify(product.baseline)).not.toMatch(/connectionId|synthetic|effort|apiKey/);
  await openSettings(page); await page.getByLabel('连接方式').selectOption('chatgpt');
});

test('explicitly refreshes catalogs and blocks review while the saved model is unavailable', async ({ page, request }) => {
  expect((await request.put('/api/ai/connections/openai/key', { headers, data: { key: 'e2e-synthetic-openai-key' } })).ok()).toBe(true);
  expect((await request.put('/api/ai/preferences', { headers, data: { connectionId: 'openai', model: 'gpt-6.1-sol', effort: 'high' } })).ok()).toBe(true);
  const created = await request.post('/api/projects', { headers, data: { name: '目录刷新回归', productDescription: '监督', coreUserGoal: '专注', features: ['监督'] } });
  const project = await created.json();
  await page.addInitScript(id => localStorage.setItem('active-project', id), project.id);
  await page.goto('/');
  const review = page.getByRole('button', { name: 'AI 整理产品草案', exact: true });
  await expect(review).toBeEnabled();
  let refreshed = false;
  await page.route('**/api/models?**', async route => {
    const url = new URL(route.request().url());
    if (url.searchParams.get('connectionId') === 'openai' && url.searchParams.get('refresh') === '1') {
      refreshed = true; await route.fulfill({ json: { models: [], defaultModel: '' } });
    } else await route.continue();
  });
  await openSettings(page); await page.getByRole('button', { name: '刷新模型列表', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('已选模型当前不可用');
  expect(refreshed).toBe(true);
  await expect(page.getByLabel('审查模型', { exact: true })).toHaveValue('gpt-6.1-sol');
  await expect(review).toBeDisabled();
  await page.unroute('**/api/models?**');
  await openSettings(page); await page.getByRole('button', { name: '刷新模型列表', exact: true }).click();
  await expect(review).toBeEnabled();
  const saved = await request.get('/api/projects/' + project.id);
  expect((await saved.json()).revision).toBe(project.revision);
});
