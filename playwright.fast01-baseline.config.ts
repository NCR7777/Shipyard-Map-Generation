import { defineConfig } from '@playwright/test';
import base from './playwright.config';
export default defineConfig({ ...base, testDir: './tests/fast01-baseline', testMatch: 'FAST01_baseline.spec.ts', timeout: 240000,
  outputDir: '.cache/FAST01/baseline/browser', reporter: [['list'], ['json', { outputFile: '.cache/FAST01/baseline/browser.json' }]],
  use: { ...base.use, viewport: { width: 1920, height: 1080 }, baseURL: 'http://127.0.0.1:48153', video: 'on', trace: 'on' },
  webServer: { command: 'npm run preview -- --outDir .cache/FAST01/baseline/dist --port 48153 --strictPort', url: 'http://127.0.0.1:48153', reuseExistingServer: false }
});
