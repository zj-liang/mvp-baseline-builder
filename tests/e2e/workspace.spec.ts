import { test, expect } from '@playwright/test';
import type { Project } from '../../shared/domain.js';
import { baselineText } from '../../src/baseline-text.js';

async function read(page: import('@playwright/test').Page): Promise<Project> {
  return page.evaluate(async () => (await fetch('/api/projects/' + localStorage.getItem('active-project'))).json());
}
test('all six decisions, two proposals, legacy navigation and one global update', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(async () => {
    const p = await (await fetch('/api/projects', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: '批量决策测试', productDescription: '批量产品', coreUserGoal: '集中决定', features: ['监督', '扣心', '免罚'] }) })).json();
    localStorage.setItem('active-project', p.id);
    await fetch('/api/projects/' + p.id + '/analyze', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ revision: p.revision }) });
    localStorage.setItem('step:' + p.id, '4');
  });
  await page.reload();
  await expect(page.getByRole('heading', { name: 'MVP 梳理', exact: true })).toBeVisible();
  await expect(page.getByRole('navigation', { name: '主流程' }).getByRole('button')).toHaveCount(3);
  await expect(page.locator('article.issue')).toHaveCount(6);
  await expect(page.locator('input[type=radio]:checked')).toHaveCount(0);
  await page.screenshot({ path: '.cache/workspace-021.png', fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: '.cache/workspace-mobile-021.png', fullPage: true });
  await page.setViewportSize({ width: 1280, height: 720 });
  const before = await read(page);
  for (const legacy of ['1', '2', '3']) {
    await page.evaluate(({ id, step }) => { localStorage.removeItem('view:' + id); localStorage.setItem('step:' + id, step); }, { id: before.id, step: legacy });
    await page.reload(); await expect(page.getByRole('heading', { name: 'MVP 梳理', exact: true })).toBeVisible();
  }
  await page.getByRole('button', { name: '处理问题', exact: true }).first().click();
  expect(await page.evaluate(() => document.activeElement?.id)).toMatch(/^decision-/);
  const cards = page.locator('article.issue');
  for (let i = 0; i < 6; i++) await cards.nth(i).getByRole('radio', { name: 'A · 方案一', exact: false }).check();
  await page.reload(); await expect(page.locator('input[type=radio]:checked')).toHaveCount(6);
  await page.getByRole('button', { name: '查看所选决定' }).click();
  await expect(page.getByRole('region', { name: '决定确认汇总' }).locator('.proposal')).toHaveCount(2);
  const summary = page.getByRole('region', { name: '决定确认汇总' });
  await expect(summary).toContainText('已确认例外');
  await expect(summary).toContainText('当前内容无已确认例外');
  await expect(summary).toContainText('接受后的内容');
  expect(await summary.locator('.proposal-change').count()).toBeGreaterThanOrEqual(2);
  await page.screenshot({ path: '.cache/ui-proposal-comparison.png' });
  expect((await read(page)).revision).toBe(before.revision);
  expect((await read(page)).draft.candidates.every(c => !c.confirmedException)).toBe(true);
  let updates = 0;
  page.on('request', r => { if (r.url().endsWith('/analyze') && r.method() === 'POST') updates++; });
  await page.getByRole('button', { name: '确认所选决定并接受解决规则', exact: true }).click();
  await page.locator('main[aria-busy="false"]').waitFor();
  expect(updates).toBe(1); const ready = await read(page);
  expect(ready.status).toBe('Ready'); expect(ready.revision).toBe(before.revision + 2);
  await expect(page.locator('.feature-status').filter({ hasText: '已明确' })).toHaveCount(3);
  await page.getByRole('navigation').getByRole('button', { name: '产品设想' }).click();
  await page.getByText('调整产品背景与核心设定', { exact: true }).click();
  await page.getByLabel('核心产品设定', { exact: true }).fill('用户确认的核心设定。');
  await page.getByRole('button', { name: '保存草稿', exact: true }).click();
  await page.locator('main[aria-busy="false"]').waitFor();
  await page.getByRole('button', { name: '继续 MVP 梳理' }).click();
  await expect(page.locator('.feature-status').filter({ hasText: '待整理' })).toHaveCount(3);
  await expect(page.getByRole('button', { name: '进入最终确认' })).toBeDisabled();
});

test('confirmed baseline copies exactly, recovers from clipboard denial and restores the final preview safely', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(async () => {
    const p = await (await fetch('/api/projects', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: '复制基线测试', productDescription: '完整产品', coreUserGoal: '完整场景', features: ['监督'] }) })).json();
    localStorage.setItem('active-project', p.id);
    await fetch('/api/projects/' + p.id + '/analyze', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ revision: p.revision }) });
    localStorage.setItem('step:' + p.id, '5');
  });
  await page.reload();
  await expect(page.getByRole('heading', { name: '最终确认', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: /复制给 Agent · Baseline v[0-9]+/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '确认并生成 Baseline v1' })).toBeDisabled();
  await page.getByRole('checkbox').check(); await page.reload();
  await expect(page.getByRole('checkbox')).not.toBeChecked();
  await page.getByRole('checkbox').check(); await page.getByRole('button', { name: '确认并生成 Baseline v1' }).click();
  await expect(page.getByRole('heading', { name: '产品基线', exact: true })).toBeVisible();
  const before = await read(page), expected = baselineText(before.name, before.baseline!);
  await expect(page.getByRole('navigation').getByRole('button')).toHaveCount(1);
  await page.screenshot({ path: '.cache/baseline-021.png', fullPage: true });
  let requests = 0; page.on('request', r => { if (/\/(analyze|decisions|commit)$/.test(r.url())) requests++; });
  await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => { sessionStorage.setItem('test-copied', text); } } }));
  await page.getByRole('button', { name: /复制给 Agent · Baseline v[0-9]+/ }).click();
  await expect(page.getByText(/Baseline v[0-9]+ 已复制，可直接粘贴给 Agent/)).toBeVisible();
  expect(await page.evaluate(() => sessionStorage.getItem('test-copied'))).toBe(expected);
  await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => { throw new Error('denied'); } } }));
  await page.getByRole('button', { name: /复制给 Agent · Baseline v[0-9]+/ }).click();
  await expect(page.getByText(/Baseline v[0-9]+ 已复制，可直接粘贴给 Agent/)).toHaveCount(0);
  await expect(page.getByLabel('完整基线文本', { exact: true })).toHaveValue(expected);
  await page.getByRole('button', { name: '选中全文', exact: true }).click();
  expect(await page.getByLabel('完整基线文本').evaluate((e: HTMLTextAreaElement) => e.selectionEnd - e.selectionStart)).toBe(expected.length);
  expect(requests).toBe(0); expect((await read(page)).baseline).toEqual(before.baseline); expect((await read(page)).revision).toBe(before.revision);
  await page.reload(); await expect(page.getByRole('heading', { name: '产品基线', exact: true })).toBeVisible();
});
