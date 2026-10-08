import { test, expect } from '@playwright/test';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';

async function startServer(dataPath: string): Promise<{ process: ChildProcess; url: string }> {
  const child = spawn(process.execPath, ['--import', 'tsx', 'tests/e2e/server.ts'], {
    cwd: resolve('.'), env: { ...process.env, E2E_DATA_PATH: dataPath, E2E_PORT: '0' }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  return new Promise((resolveReady, reject) => {
    let output = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('Persistent E2E server did not start.')); }, 15000);
    child.stderr?.resume();
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('exit', code => { clearTimeout(timer); if (code) reject(new Error('Persistent E2E server exited.')); });
    child.stdout?.on('data', chunk => { output += String(chunk); const url = /E2E_URL=(http:\/\/127\.0\.0\.1:\d+)/.exec(output)?.[1]; if (url) { clearTimeout(timer); resolveReady({ process: child, url }); } });
  });
}
async function stopServer(child: ChildProcess) {
  if (child.exitCode !== null) return;
  await new Promise<void>(resolveStopped => { child.once('exit', () => resolveStopped()); child.kill(); });
}
test('committed product memory survives an actual service process restart', async ({ page }) => {
  mkdirSync(resolve('.cache/tests'), { recursive: true });
  const dir = mkdtempSync(resolve('.cache/tests/browser-restart-'));
  let server: Awaited<ReturnType<typeof startServer>> | null = null;
  try {
    server = await startServer(join(dir, 'baseline.sqlite'));
    await page.goto(server.url);
    await page.getByLabel('描述你想象中的产品 · Product Concept / Experience Premise').fill('我想做一个自律监督工具，有玩偶随机巡查，离席会扣心。');
    await page.getByRole('button', { name: '保存设想并开始' }).click();
    await expect(page.getByRole('heading', { name: '玩偶是什么样的' })).toBeVisible();
    await page.getByRole('radio', { name: 'C · 暂不确定', exact: false }).check();
    await page.getByRole('button', { name: '查看所选决定' }).click();
  await page.getByRole('button', { name: '确认所选决定', exact: true }).click();
  await page.locator('main[aria-busy="false"]').waitFor();
    await page.locator('main[aria-busy="false"]').waitFor();
    const pending = await page.evaluate(async () => (await fetch('/api/projects/' + localStorage.getItem('active-project'))).json());
    await stopServer(server.process); server = await startServer(join(dir, 'baseline.sqlite'));
    await page.goto(server.url); await page.getByLabel('选择本地项目').selectOption(pending.id);
    await expect(page.getByRole('heading', { name: '产品设想', exact: true })).toBeVisible();
    const resumed = await page.evaluate(async id => (await fetch('/api/projects/' + id)).json(), pending.id);
    expect(resumed.intake).toEqual(pending.intake); expect(resumed.conversation).toEqual(pending.conversation);
    await page.getByRole('radio', { name: 'A · 方案一', exact: false }).check();
    await page.getByRole('button', { name: '查看所选决定' }).click();
  await page.getByRole('button', { name: '确认所选决定', exact: true }).click();
  await page.locator('main[aria-busy="false"]').waitFor();
    await expect(page.getByRole('button', { name: '确认这些设定与初始功能' })).toBeEnabled();
    await page.getByRole('button', { name: '确认这些设定与初始功能' }).click();
    await expect(page.getByRole('heading', { name: 'MVP 梳理', exact: true })).toBeVisible();
    await page.getByRole('radio', { name: 'A · 方案一', exact: false }).check();
    await page.getByRole('button', { name: '查看所选决定' }).click();
  await page.getByRole('button', { name: '确认所选决定', exact: true }).click();
  await page.locator('main[aria-busy="false"]').waitFor();
    await expect(page.getByRole('heading', { name: 'MVP 梳理', exact: true })).toBeVisible();
    await page.getByRole('button', { name: '进入最终确认' }).click();
    await page.getByRole('checkbox').check();
    await page.getByRole('button', { name: '确认并生成 Baseline v1' }).click();
    await expect(page.getByRole('heading', { name: '产品基线', exact: true })).toBeVisible();
    const saved = await page.evaluate(async () => { const projects = await (await fetch('/api/projects')).json(); return (await (await fetch(`/api/projects/${projects[0].id}`)).json()); });
    await stopServer(server.process); server = await startServer(join(dir, 'baseline.sqlite'));
    await page.goto(server.url);
    await page.getByLabel('选择本地项目').selectOption(saved.id);
    await expect(page.getByRole('heading', { name: '产品基线', exact: true })).toBeVisible();
    const restored = await page.evaluate(async id => (await (await fetch(`/api/projects/${id}`)).json()), saved.id);
    expect(restored.baseline).toEqual(saved.baseline);
    await expect(page.getByText('当前有效基线：v1。正在查看当前基线：v1。所有已提交快照只读。')).toBeVisible();
    await page.getByRole('button', { name: '加入新功能', exact: true }).click();
    await page.getByLabel('新功能设想', { exact: true }).fill('补充监督：用户主动暂停监督。');
    await page.getByRole('button', { name: '保存新功能并开始' }).click();
    await page.getByRole('button', { name: '确认新增清单，审查新旧关系' }).click();
    await expect(page.getByRole('heading', { name: '新旧功能确认', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '进入最终确认' })).toHaveCount(0);
    const addition = await page.evaluate(async id => (await (await fetch(`/api/projects/${id}`)).json()), saved.id);
    await stopServer(server.process); server = await startServer(join(dir, 'baseline.sqlite'));
    await page.goto(server.url); await page.getByLabel('选择本地项目').selectOption(saved.id);
    await expect(page.getByRole('heading', { name: '新旧功能确认', exact: true })).toBeVisible();
    const additionRestored = await page.evaluate(async id => (await (await fetch(`/api/projects/${id}`)).json()), saved.id);
    expect(additionRestored.addition).toEqual(addition.addition); expect(additionRestored.draft).toEqual(addition.draft); expect(additionRestored.baseline).toEqual(saved.baseline);
    expect(additionRestored.questions).toEqual(addition.questions);
    await expect(page.getByRole('button', { name: '进入最终确认' })).toHaveCount(0);
    await page.getByRole('radio', { name: 'A · 方案一', exact: false }).check();
    await page.getByRole('button', { name: '查看所选决定' }).click();
    await page.getByRole('button', { name: '确认所选决定并接受解决规则', exact: true }).click();
    await expect(page.getByRole('button', { name: '进入最终确认' })).toBeEnabled();
    await page.getByRole('button', { name: '进入最终确认' }).click();
    await page.getByRole('checkbox').check(); await page.getByRole('button', { name: '确认并生成 Baseline v2' }).click();
    await expect(page.getByRole('heading', { name: '产品基线', exact: true })).toBeVisible();
    const updated = await page.evaluate(async id => (await (await fetch(`/api/projects/${id}`)).json()), saved.id);
    await stopServer(server.process); server = await startServer(join(dir, 'baseline.sqlite'));
    await page.goto(server.url); await page.getByLabel('选择本地项目').selectOption(saved.id);
    await expect(page.getByText('当前有效基线：v2。正在查看当前基线：v2。所有已提交快照只读。')).toBeVisible();
    const current = await page.evaluate(async id => (await (await fetch(`/api/projects/${id}`)).json()), saved.id);
    expect(current.baseline).toEqual(updated.baseline);
    const historical = await page.evaluate(async id => (await (await fetch(`/api/projects/${id}/baselines/v1`)).json()), saved.id);
    expect(historical).toEqual(saved.baseline);
  } finally {
    if (server) await stopServer(server.process);
    if (dirname(resolve(dir)) !== resolve('.cache/tests')) throw new Error('Refusing to clean outside the test directory.');
    rmSync(dir, { recursive: true, force: true });
  }
});
