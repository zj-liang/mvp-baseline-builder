import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { Project } from '../../shared/domain.js';
import { baselineText } from '../../src/baseline-text.js';

async function seed(page: Page, name = 'UI交互测试') {
  await page.goto('/');
  const id = await page.evaluate(async name => {
    const project = await (await fetch('/api/projects', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, productDescription: '产品内容保持原样', coreUserGoal: '保留业务流程', features: name === '批量决策测试' ? ['记录任务', '完成任务', '恢复任务'] : ['记录任务', '完成任务'] }) })).json();
    await fetch('/api/projects/' + project.id + '/analyze', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ revision: project.revision }) });
    localStorage.setItem('active-project', project.id);
    return project.id as string;
  }, name);
  await page.reload();
  await page.locator('main[aria-busy="false"]').waitFor();
  return id;
}

async function read(page: Page, id: string): Promise<Project> {
  return page.evaluate(async id => (await fetch('/api/projects/' + id)).json(), id);
}

test('unsubmitted idea is retained when leaving is cancelled, and discarded only after confirmation', async ({ page }) => {
  await page.goto('/'); await page.locator('main[aria-busy="false"]').waitFor();
  const input = page.getByLabel(/描述你想象中的产品/);
  await input.fill('用户尚未提交的原始想法');
  let writes = 0;
  page.on('request', request => { if (request.method() === 'POST') writes++; });
  page.once('dialog', dialog => dialog.dismiss());
  await page.getByRole('button', { name: '＋ 新建项目', exact: true }).click();
  await expect(input).toHaveValue('用户尚未提交的原始想法');
  page.once('dialog', dialog => dialog.accept());
  await page.getByRole('button', { name: '＋ 新建项目', exact: true }).click();
  await expect(input).toHaveValue(''); expect(writes).toBe(0);
  await input.fill('保存前核对名称');
  const name = page.getByLabel('项目名称（可选）', { exact: true });
  await name.fill('x'.repeat(204));
  await page.getByRole('button', { name: '保存设想并开始' }).click();
  await expect(name).toBeFocused(); await expect(name).toHaveValue('x'.repeat(204));
  expect(writes).toBe(0);
});

test('long edited names retain all text, focus the error, and cannot issue a save', async ({ page }) => {
  const id = await seed(page), before = await read(page, id);
  const card = page.locator('.candidate-card').first();
  await card.getByText('查看完整定义', { exact: true }).click();
  await card.getByRole('button', { name: '手动编辑', exact: true }).click();
  const name = card.getByLabel(/功能名称/);
  await name.fill('x'.repeat(204));
  let saves = 0;
  page.on('request', request => { if (request.method() === 'PUT' && request.url().endsWith('/draft')) saves++; });
  await page.getByRole('button', { name: '保存草稿', exact: true }).click();
  await expect(name).toHaveValue('x'.repeat(204)); await expect(name).toBeFocused();
  await expect(name).toHaveAttribute('aria-invalid', 'true');
  expect(saves).toBe(0); expect((await read(page, id)).draft).toEqual(before.draft);
});

test('step and decision summary transitions focus the start of the new content', async ({ page }) => {
  await seed(page);
  await page.getByRole('button', { name: '进入最终确认' }).click();
  const heading = page.getByRole('heading', { name: '最终确认', exact: true });
  await expect(heading).toBeFocused();
  expect((await heading.boundingBox())!.y).toBeGreaterThanOrEqual(0);
  await seed(page, '批量决策测试');
  await page.locator('article.issue').first().getByRole('radio', { name: /A · 方案一/ }).check();
  await page.getByRole('button', { name: /查看所选决定/ }).click();
  await expect(page.getByRole('heading', { name: '提交前请确认', exact: true })).toBeFocused();
  await page.getByRole('button', { name: '返回调整选择', exact: true }).click();
  await expect(page.getByRole('button', { name: /查看所选决定/ })).toBeFocused();
});

test('visible waiting and explicit retry preserve the failed draft without replaying decisions', async ({ page }) => {
  const id = await seed(page), before = await read(page, id);
  let attempts = 0, decisionWrites = 0, release!: () => void;
  page.on('request', request => { if (request.method() === 'POST' && /\/(decisions|commit)$/.test(request.url())) decisionWrites++; });
  await page.route('**/api/projects/*/analyze', async route => {
    attempts++;
    if (attempts > 1) { await route.continue(); return; }
    await new Promise<void>(resolve => { release = resolve; });
    await route.fulfill({ status: 502, contentType: 'application/json', body: JSON.stringify({ error: { code: 'stream_interrupted', message: 'AI 响应中断，未应用部分内容，请重试。' } }) });
  });
  await page.getByRole('button', { name: '让 AI 更新产品草案', exact: true }).click();
  await expect(page.getByText('正在审查完整 MVP…', { exact: true })).toBeVisible();
  const waiting = await page.locator('.working').boundingBox();
  expect(waiting!.y).toBeGreaterThanOrEqual(0); expect(waiting!.y + waiting!.height).toBeLessThanOrEqual(720);
  await expect(page.getByRole('button', { name: '取消 AI 请求' })).toBeEnabled();
  release();
  await expect(page.getByRole('button', { name: '重试本次审查', exact: true })).toBeVisible();
  expect((await read(page, id)).draft).toEqual(before.draft);
  expect((await read(page, id)).revision).toBe(before.revision); expect(attempts).toBe(1);
  await page.getByRole('button', { name: '重试本次审查', exact: true }).click();
  await page.locator('main[aria-busy="false"]').waitFor();
  expect(attempts).toBe(2); expect(decisionWrites).toBe(0);
  await expect(page.getByRole('button', { name: '重试本次审查', exact: true })).toHaveCount(0);
});

test('connected desktop start fits the viewport and long names do not overflow the document', async ({ page }) => {
  for (const size of [{ width: 1366, height: 768 }, { width: 1440, height: 900 }, { width: 1920, height: 1080 }]) {
    await page.setViewportSize(size); await page.goto('/');
    await expect(page.getByRole('button', { name: '调整连接与模型', exact: true })).toBeVisible();
    const action = await page.getByRole('button', { name: '保存设想并开始' }).boundingBox();
    expect(action!.y).toBeGreaterThanOrEqual(0); expect(action!.y + action!.height).toBeLessThanOrEqual(size.height);
  }
  await seed(page, 'LongProjectName'.repeat(13));
  for (const size of [{ width: 1366, height: 768 }, { width: 390, height: 844 }, { width: 683, height: 384 }]) {
    await page.setViewportSize(size);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  await expect(page.getByRole('button', { name: '进入最终确认' })).toHaveClass(/primary/);
  await expect(page.getByRole('button', { name: '让 AI 更新产品草案', exact: true })).not.toHaveClass(/primary/);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  expect(await page.getByRole('button', { name: '进入最终确认' }).evaluate(element => getComputedStyle(element).transitionDuration)).toBe('0s');
  await page.getByRole('button', { name: '进入最终确认' }).click();
  expect(await page.locator('.commit-panel').evaluate(element => getComputedStyle(element).position)).toBe('static');
  await expect(page.getByRole('checkbox')).not.toBeChecked();
  await expect(page.getByRole('button', { name: '确认并生成 Baseline v1' })).toBeDisabled();
});

test('question index retains every unanswered question and navigation does not write decisions', async ({ page }) => {
  const id = await seed(page, '批量决策测试'), before = await read(page, id);
  await expect(page.locator('article.issue')).toHaveCount(6);
  await expect(page.locator('input[type=radio]:checked')).toHaveCount(0);
  let writes = 0; page.on('request', request => { if (request.method() === 'POST') writes++; });
  const index = page.getByRole('navigation', { name: '问题目录' });
  await index.getByRole('button', { name: /1\. 批量问题 1/ }).click();
  await expect(page.locator('article.issue').first()).toBeFocused();
  await page.locator('article.issue').first().getByRole('radio', { name: /A · 方案一/ }).check();
  const summary = index.getByRole('button', { name: /前往决定汇总/ });
  await summary.click(); await page.getByRole('button', { name: '返回调整选择', exact: true }).click();
  await expect(summary).toBeFocused(); expect(writes).toBe(0);
  expect((await read(page, id)).revision).toBe(before.revision);
  await expect(page.locator('article.issue')).toHaveCount(6);
});

test('read-only baseline panel preserves the running task, locks, snapshot and exact copy', async ({ page }) => {
  const id = await seed(page);
  await page.getByRole('button', { name: '进入最终确认' }).click();
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: '确认并生成 Baseline v1' }).click();
  await page.locator('main[aria-busy="false"]').waitFor();
  const old = await read(page, id);
  await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (value: string) => sessionStorage.setItem('panel-copy', value) } }));
  await page.getByRole('button', { name: '调整连接与模型', exact: true }).click();
  await page.getByRole('button', { name: '加入新功能', exact: true }).click();
  await page.getByLabel('新功能设想', { exact: true }).fill('用户可以主动暂停监督。');
  let release!: () => void, attempts = 0, cancellations = 0, decisionWrites = 0;
  const requests: string[] = [];
  page.on('request', request => {
    if (request.method() === 'POST') {
      requests.push(request.url());
      if (request.url().endsWith('/cancel')) cancellations++;
      if (/\/(decisions|commit)$/.test(request.url())) decisionWrites++;
    }
  });
  await page.route('**/api/projects/*/addition/analyze', async route => {
    attempts++;
    const response = await route.fetch();
    await new Promise<void>(resolve => { release = resolve; });
    await route.fulfill({ response });
  });
  await page.getByRole('button', { name: '保存新功能并开始' }).click();
  const trigger = page.getByRole('button', { name: '查看当前有效基线', exact: true });
  await expect(trigger).toBeEnabled();
  await expect(page.getByLabel('选择本地项目')).toBeDisabled();
  await expect(page.getByLabel('连接方式', { exact: true })).toBeDisabled();
  await expect(page.getByLabel('审查模型', { exact: true })).toBeDisabled();
  await trigger.click();
  const panel = page.getByRole('dialog', { name: '当前有效基线 · Baseline v1', exact: true });
  await expect(panel).toBeVisible();
  await expect(panel.getByRole('heading', { name: '当前有效基线 · Baseline v1', exact: true })).toBeFocused();
  await page.screenshot({ path: '.cache/ui-current-baseline-panel.png' });
  await panel.getByRole('button', { name: '复制给 Agent · Baseline v1', exact: true }).click();
  expect(await page.evaluate(() => sessionStorage.getItem('panel-copy'))).toBe(baselineText(old.name, old.baseline!));
  await expect(panel.getByRole('button', { name: '复制给 Agent · Baseline v1', exact: true })).toBeFocused();
  await panel.getByRole('button', { name: '关闭当前有效基线', exact: true }).press('Escape');
  await expect(panel).toHaveCount(0); await expect(trigger).toBeFocused();
  await expect(page.locator('main')).toHaveAttribute('aria-busy', 'true');
  await trigger.click();
  release();
  await expect(panel).toContainText('本次请求已结束');
  await expect(page.locator('main')).toHaveAttribute('aria-busy', 'false');
  await expect(panel).toBeVisible();
  expect(await page.evaluate(() => Boolean(document.activeElement?.closest('dialog')))).toBe(true);
  await panel.getByRole('button', { name: '关闭当前有效基线', exact: true }).click();
  await expect(page.getByRole('heading', { name: '加入新功能', exact: true })).toBeFocused();
  const result = await read(page, id);
  expect(result.baseline).toEqual(old.baseline);
  expect(result.stage).toBe('addition'); expect(result.addition?.assessment?.items).toHaveLength(1);
  expect(attempts).toBe(1); expect(cancellations).toBe(0); expect(decisionWrites).toBe(0);
  expect(requests.filter(url => /\/addition(?:\/analyze)?$/.test(url))).toHaveLength(2);
});

test('temporary feedback survives same-project navigation without affecting Ready or saved rules', async ({ page }) => {
  const id = await seed(page), before = await read(page, id);
  await page.getByText('告诉 AI 我想调整什么', { exact: true }).click();
  await page.getByLabel('用自己的话描述你希望调整的内容', { exact: true }).fill('只是未提交的反馈');
  await expect(page.getByRole('button', { name: '进入最终确认' })).toBeEnabled();
  await page.getByRole('button', { name: '进入最终确认' }).click();
  await page.getByRole('button', { name: '返回 MVP 梳理', exact: true }).click();
  await page.getByText('告诉 AI 我想调整什么', { exact: true }).click();
  await expect(page.getByLabel('用自己的话描述你希望调整的内容', { exact: true })).toHaveValue('只是未提交的反馈');
  page.once('dialog', dialog => dialog.dismiss());
  await page.getByRole('button', { name: '＋ 新建项目', exact: true }).click();
  await expect(page.getByLabel('用自己的话描述你希望调整的内容', { exact: true })).toHaveValue('只是未提交的反馈');
  expect((await read(page, id)).revision).toBe(before.revision);
  expect((await read(page, id)).draft).toEqual(before.draft);
});
