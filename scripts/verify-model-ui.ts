import { chromium, expect } from '@playwright/test';

// Read the selected real connection catalog and verify saved settings; no inference,
// product creation or credentials are requested by this smoke check.
const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('http://127.0.0.1:3000');
  await page.getByLabel('审查模型', { exact: true }).waitFor();
  await page.getByRole('button', { name: '刷新模型列表', exact: true }).waitFor({ timeout: 40000 });
  await expect(page.locator('.ai-settings')).toBeEnabled({ timeout: 40000 });
  const connectionId = await page.getByLabel('连接方式', { exact: true }).inputValue();
  const catalog = await page.evaluate(async id => (await fetch('/api/models?connectionId=' + id)).json(), connectionId);
  if (!catalog.models?.length) throw new Error('未读取到真实模型目录。');
  const entry = catalog.models.find((m: { reasoning?: { efforts: string[] } }) => m.reasoning?.efforts.includes('high')) ?? catalog.models[0];
  const model = entry.slug;
  await page.getByLabel('审查模型', { exact: true }).selectOption(model);
  if (entry.reasoning?.efforts.includes('high')) await page.getByLabel('思考强度', { exact: true }).selectOption('high');
  await expect(page.locator('.ai-settings')).toBeEnabled({ timeout: 40000 });
  await page.reload();
  await page.getByRole('button', { name: '刷新模型列表', exact: true }).waitFor({ timeout: 40000 });
  await expect(page.locator('.ai-settings')).toBeEnabled({ timeout: 40000 });
  if (await page.getByLabel('审查模型', { exact: true }).inputValue() !== model) throw new Error('模型设置未恢复。');
  if (entry.reasoning?.efforts.includes('high') && await page.getByLabel('思考强度', { exact: true }).inputValue() !== 'high') throw new Error('思考强度未恢复。');
  const state = await page.evaluate(async () => ({ auth: await (await fetch('/api/auth')).json(), storage: { ...localStorage }, cookies: document.cookie }));
  if (/accessToken|refreshToken|id_token|credentials|baseline_session/.test(JSON.stringify(state))) throw new Error('发现不应暴露的凭据字段。');
  if (errors.length) throw new Error(errors.join('\n'));
  await page.screenshot({ path: '.cache/production-models.png', fullPage: true });
  console.log(JSON.stringify({ connectionId, models: catalog.models.map((m: { slug: string }) => m.slug), selectedModel: model, effort: entry.reasoning?.efforts.includes('high') ? 'high' : null, refreshPreservedSettings: true, credentialsExposed: false, pageErrors: errors }));
} finally { await browser.close(); }
