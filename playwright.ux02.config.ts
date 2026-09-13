import { defineConfig } from '@playwright/test';
import base from './playwright.config';
const evidence = process.env.UX02_RUN_DIR ?? '.cache/UX02/ui-release';
export default defineConfig({
  ...base, testDir: './tests/e2e', testMatch: 'UX02*.spec.ts', timeout: 180000,
  outputDir: evidence + '/artifacts',
  reporter: [['list'], ['json', { outputFile: evidence + '/report.json' }]],
  use: { ...base.use, baseURL: 'http://127.0.0.1:4196', trace: 'on', screenshot: 'only-on-failure' },
  webServer: { command: 'npm run preview -- --host 127.0.0.1 --port 4196 --strictPort', url: 'http://127.0.0.1:4196', reuseExistingServer: false, timeout: 30000 },
});
