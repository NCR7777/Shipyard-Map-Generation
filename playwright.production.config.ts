import { defineConfig } from '@playwright/test';
import base from './playwright.config';

// Explicit baseline mode keeps P1 evidence stable while later development changes the working tree.
const baseline = process.env.P1_PRODUCTION_BASELINE === '1';
const outDir = baseline ? '.cache/P2A/p1-evidence/dist' : 'dist';
const evidenceDir = baseline ? '.cache/P2A/p1-evidence' : '.cache/P2A/production-current';
export default defineConfig({
  ...base,
  testDir: './tests/production', testMatch: 'P1_production.spec.ts',
  timeout: 120000,
  outputDir: evidenceDir + '/browser',
  reporter: [['list'], ['json', { outputFile: evidenceDir + '/playwright.json' }]],
  use: { ...base.use, baseURL: 'http://127.0.0.1:4180', trace: 'off', screenshot: 'only-on-failure' },
  webServer: {
    command: 'npm run preview -- --port 4180 --strictPort --outDir ' + outDir,
    url: 'http://127.0.0.1:4180', reuseExistingServer: false, timeout: 30000,
  },
});
