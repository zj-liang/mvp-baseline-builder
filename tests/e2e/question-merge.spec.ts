import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import type { Project } from '../../shared/domain.js';
import { mergeConfirmationText } from '../../shared/domain.js';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

async function read(page: Page): Promise<Project> {
  return page.evaluate(async () => (await fetch('/api/projects/' + localStorage.getItem('active-project'))).json());
}
async function seed(page: Page) {
  mkdirSync(resolve('.cache/question-review-fix'), { recursive: true });
  await page.goto('/');
  await page.evaluate(async () => {
    const post = async (url: string, body: unknown) => (await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })).json();
    const p = await post('/api/projects', { name: '重复问题隔离验证', productDescription: '一个通过摄像头观察行为的个人监督工具。', coreUserGoal: '学习和工作时保持专注', features: ['本地实时行为检测'] });
    const reviewed = await post('/api/projects/' + p.id + '/analyze', { revision: p.revision });
    await post('/api/projects/' + p.id + '/decisions', { revision: reviewed.revision, answers: [{ issueId: reviewed.questions[0].id, choice: 'A' }, { issueId: reviewed.questions[1].id, choice: 'D', customAnswer: '帮我填' }] });
    localStorage.setItem('active-project', p.id);
  });
  await page.reload();
  await expect(page.locator('article.issue')).toHaveCount(2);
}
async function chooseMerge(page: Page, choice: 'A' | 'C') {
  await page.getByRole('button', { name: '合并重复问题', exact: true }).click();
  const panel = page.getByRole('region', { name: '合并重复问题', exact: true });
  await expect(panel.getByRole('button', { name: mergeConfirmationText })).toBeDisabled();
  const boxes = panel.getByRole('checkbox');
  await boxes.nth(0).focus(); await page.keyboard.press('Space'); await boxes.nth(1).check();
  const p = await read(page);
  await panel.getByLabel('保留为主问题').selectOption(p.questions[0]!.id);
  await expect(panel.getByRole('radio', { checked: true })).toHaveCount(0);
  await panel.getByRole('radio', { name: new RegExp('^' + choice + ' ·') }).check();
  return panel;
}

test('explicit merge survives refresh, retains history and review failure, then becomes ready on fresh evidence', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await seed(page); const before = await read(page);
  await chooseMerge(page, 'A');
  await page.reload();
  const panel = page.getByRole('region', { name: '合并重复问题', exact: true });
  await expect(panel.getByRole('checkbox', { checked: true })).toHaveCount(2);
  await expect(panel.getByRole('radio', { name: /^A ·/ })).toBeChecked();
  await expect(panel.getByText('已保存答复：帮我填', { exact: true })).toBeVisible();
  await expect(panel.getByRole('button', { name: mergeConfirmationText })).toBeEnabled();
  mkdirSync(resolve('.cache/question-review-fix'), { recursive: true });
  await page.screenshot({ path: '.cache/question-review-fix/merge-confirmation-1440.png', fullPage: true });
  await panel.screenshot({ path: '.cache/question-review-fix/merge-panel-1440.png' });
  await page.route('**/api/projects/*/analyze', async route => {
    await route.fulfill({ status: 502, json: { error: { code: 'invalid_evidence', message: '「行为判定范围与可见依据」：问题关闭不能引用比该题最新决定更旧的答复。已保存的答复保留，本轮审查未应用。', retryable: false } } });
  }, { times: 1 });
  await panel.getByRole('button', { name: mergeConfirmationText }).click();
  await expect(page.getByRole('alert')).toContainText('本轮审查未应用');
  const merged = await read(page);
  expect(merged.revision).toBe(before.revision + 1); expect(merged.draft).toEqual(before.draft);
  expect(merged.questions.filter(q => q.stage === 'candidate')).toHaveLength(1);
  expect(merged.questions[1]!.merge?.targetQuestionId).toBe(merged.questions[0]!.id);
  expect(merged.questions[0]!.status).toBe('pending_review');
  await expect(page.locator('article.issue')).toHaveCount(1);
  await expect(page.getByRole('button', { name: '进入最终确认' })).toBeDisabled();
  await page.getByRole('button', { name: '重试本次审查' }).click();
  await expect(page.getByRole('button', { name: '进入最终确认' })).toBeEnabled();
  await expect(page.locator('article.issue')).toHaveCount(0);
  await page.getByText('查看已合并问题与历史答复（1）', { exact: true }).click();
  await expect(page.getByText('帮我填', { exact: true })).toBeVisible();
  await page.reload();
  expect((await read(page)).status).toBe('Ready');
  await page.screenshot({ path: '.cache/question-review-fix/merged-ready-1440.png', fullPage: true });
});

test('narrow screen explicit unsure merge remains one unresolved decision after refresh', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await seed(page); const panel = await chooseMerge(page, 'C');
  await expect(panel.getByRole('button', { name: mergeConfirmationText })).toBeEnabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: '.cache/question-review-fix/merge-confirmation-390.png', fullPage: true });
  await panel.screenshot({ path: '.cache/question-review-fix/merge-panel-390.png' });
  await panel.getByRole('button', { name: mergeConfirmationText }).click();
  await expect(page.locator('article.issue')).toHaveCount(1);
  await page.reload();
  const p = await read(page);
  expect(p.questions.find(q => q.stage === 'candidate')!.status).toBe('undecided');
  await expect(page.getByRole('button', { name: '进入最终确认' })).toBeDisabled();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
