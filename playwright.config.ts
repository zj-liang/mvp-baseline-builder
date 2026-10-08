import { defineConfig } from '@playwright/test';
const port = process.env.E2E_PORT ?? '3101';
const baseURL = 'http://127.0.0.1:' + port;
export default defineConfig({
  testDir: './tests/e2e', testMatch: '*.spec.ts', workers: 1, timeout: 30000,
  use: { baseURL, browserName: 'chromium', channel: 'msedge', headless: true, screenshot: 'only-on-failure' },
  webServer: { command: 'node --import tsx tests/e2e/server.ts', url: baseURL, reuseExistingServer: false, timeout: 30000 },
});
