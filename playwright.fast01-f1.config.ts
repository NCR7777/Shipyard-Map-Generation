import { defineConfig } from '@playwright/test';
import base from './playwright.config';
export default defineConfig({ ...base, testDir: './tests/e2e', testMatch: 'FAST01_tracing.spec.ts', timeout: 240000,
  outputDir: '.cache/FAST01/F1-measured/browser', reporter: [['list'], ['json', { outputFile: '.cache/FAST01/F1-measured/browser.json' }]],
  use: { ...base.use, viewport: { width: 1920, height: 1080 }, baseURL: 'http://127.0.0.1:48154', video: 'on', trace: 'on' },
  webServer: { command: 'npm run preview -- --outDir .cache/FAST01/F1/dist --port 48154 --strictPort', url: 'http://127.0.0.1:48154', reuseExistingServer: false }
});
