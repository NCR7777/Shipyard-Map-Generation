import { defineConfig } from '@playwright/test';
import base from './playwright.config';
/** Production user workflow; adapter fault tests use the existing development config. */
export default defineConfig({ ...base, testDir: './tests/e2e', testMatch: 'BG01_editor.spec.ts', workers: 1, timeout: 240000,
  outputDir: '.cache/BG01/editor-browser/artifacts',
  reporter: [['list'], ['json', { outputFile: '.cache/BG01/editor-browser/report.json' }]],
  use: { ...base.use, baseURL: 'http://127.0.0.1:4197', trace: 'on', video: process.env.BG01_RECORD_VIDEO === '1' ? 'on' : 'off' },
  webServer: { command: 'npm run preview -- --host 127.0.0.1 --port 4197 --strictPort', url: 'http://127.0.0.1:4197', reuseExistingServer: false, timeout: 30000 },
});
