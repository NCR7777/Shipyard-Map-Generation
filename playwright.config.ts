import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/e2e', fullyParallel: false, workers: 1,
  timeout: 45000, expect: { timeout: 7000 },
  reporter: [['list']],
  use: { baseURL: 'http://127.0.0.1:4200', headless: true, viewport: { width: 1440, height: 900 }, trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: [{ name: 'chrome', use: { browserName: 'chromium', channel: process.env.PW_CHANNEL ?? 'chrome' } }],
  webServer: { command: 'npm run dev -- --port 4200', url: 'http://127.0.0.1:4200', reuseExistingServer: false, timeout: 30000 },
});
