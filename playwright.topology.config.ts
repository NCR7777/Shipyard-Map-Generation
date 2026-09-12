import { defineConfig } from '@playwright/test';
import base from './playwright.config';

// 当前生产构建；隔离浏览器数据，证据只写入缓存。
export default defineConfig({
  ...base,
  testMatch: 'TE01_*.spec.ts',
  outputDir: '.cache/TE01/production/results',
  reporter: [['list'], ['json', { outputFile: '.cache/TE01/production/report.json' }]],
  use: { ...base.use, baseURL: 'http://127.0.0.1:4195', trace: 'on' },
  webServer: {
    command: 'npm run preview -- --port 4195 --strictPort',
    url: 'http://127.0.0.1:4195', reuseExistingServer: false, timeout: 30000,
  },
});
