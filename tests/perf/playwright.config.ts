import { defineConfig } from '@playwright/test';
// Serves two prebuilt production builds side by side; see compare.perf.ts for the build commands.
const preview = (port: number, dir: string) => ({ command: `npx vite preview --host 127.0.0.1 --port ${port} --strictPort --outDir "${dir}"`,
  cwd: '../..', url: `http://127.0.0.1:${port}`, reuseExistingServer: false, timeout: 60000 });
export default defineConfig({
  testDir: '.', testMatch: 'compare.perf.ts', workers: 1, timeout: 600000, reporter: [['list']],
  use: { headless: true, trace: 'off', viewport: { width: 1600, height: 1000 } },
  projects: [{ name: 'chrome', use: { browserName: 'chromium', channel: 'chrome' } }],
  webServer: [preview(4210, process.env.STUDIO_DIST ?? '.cache/perf/studio-dist'), preview(4211, process.env.MAP_DIST ?? '.cache/perf/map-dist')],
});
