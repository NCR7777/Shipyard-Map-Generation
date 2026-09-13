import { defineConfig } from '@playwright/test';
import base from './playwright.config';
const evidence = process.env.UX02_RUN_DIR ?? '.cache/UX02/regression-release';
export default defineConfig({ ...base, testDir: './tests/e2e', testIgnore: ['MQ01_repaired.spec.ts', 'BG01_assets.spec.ts', 'UX02*.spec.ts'], workers: 1,
  outputDir: evidence + '/artifacts', reporter: [['list'], ['json', { outputFile: evidence + '/report.json' }]],
  use: { ...base.use, baseURL: 'http://127.0.0.1:4194' },
  webServer: { command: 'npm run preview -- --host 127.0.0.1 --port 4194 --strictPort', url: 'http://127.0.0.1:4194', reuseExistingServer: false, timeout: 30000 },
});
