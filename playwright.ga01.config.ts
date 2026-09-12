import { defineConfig } from '@playwright/test';
import base from './playwright.config';

const evidence = '.cache/GA01/' + (process.env.GA01_PHASE ?? 'A') + '-production-current';
export default defineConfig(base, {
  testMatch: 'GA01_maps.spec.ts', timeout: 150000,
  outputDir: evidence + '/results',
  reporter: [['list'], ['json', { outputFile: evidence + '/report.json' }]],
  use: { ...base.use, baseURL: 'http://127.0.0.1:4194' },
  webServer: { command: 'npm run preview -- --port 4194 --strictPort', url: 'http://127.0.0.1:4194', reuseExistingServer: false, timeout: 30000 },
});
