// Back-to-back pan/zoom frame timing of the ../map and map-studio production builds on one real map (P1 acceptance).
// Same method as ../map interaction.perf: fit, middle-drag 60 steps, wheel 12 in + 12 out; windows include the settle frames.
// Build first:  npx vite build --outDir .cache/perf/studio-dist --emptyOutDir
//               npx vite build ../map --outDir <absolute map-studio>/.cache/perf/map-dist --emptyOutDir
// Run:          PERF_MAP=<map.json> [PERF_BACKGROUND=<its image>] npm run perf:compare
//               Without PERF_BACKGROUND both sides draw vectors only; with it both load the same image through their own UI.
import { expect, test, type Page } from '@playwright/test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';

const mapPath = process.env.PERF_MAP, backgroundPath = process.env.PERF_BACKGROUND;
const APPS = { map: 'http://127.0.0.1:4211', studio: 'http://127.0.0.1:4210' } as const;
type App = keyof typeof APPS;

async function instrument(page: Page) {
  await page.evaluate(() => {
    const w = window as unknown as { __perf: { frames: number[]; long: { start: number; duration: number }[] } };
    w.__perf = { frames: [], long: [] };
    new PerformanceObserver(list => { for (const e of list.getEntries()) w.__perf.long.push({ start: e.startTime, duration: e.duration }); }).observe({ type: 'longtask', buffered: false });
    const loop = (t: number) => { w.__perf.frames.push(t); requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
  });
}
const mark = (page: Page) => page.evaluate(() => performance.now());
const settle = (page: Page) => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 50)))));
function measure(page: Page, start: number, end: number) {
  return page.evaluate(([s, e]) => {
    const w = window as unknown as { __perf: { frames: number[]; long: { start: number; duration: number }[] } };
    const frames = w.__perf.frames.filter(t => t >= s && t <= e), gaps = frames.slice(1).map((t, i) => t - frames[i]!).sort((a, b) => a - b);
    const q = (p: number) => gaps.length ? gaps[Math.min(gaps.length - 1, Math.floor(p * gaps.length))]! : null;
    const long = w.__perf.long.filter(l => l.start >= s && l.start <= e);
    return { wallMs: e - s, frames: frames.length, gapP50: q(0.5), gapP95: q(0.95), gapMax: gaps.at(-1) ?? null, longTaskMs: long.reduce((n, l) => n + l.duration, 0) };
  }, [start, end] as const);
}

/** Each app's own visible way to open a file and fit the map; returns the canvas box. */
async function open(page: Page, app: App, bytes: Buffer, name: string, image: Buffer | null) {
  await page.goto(APPS[app]);
  if (app === 'map') {
    await expect(page.getByRole('button', { name: '保存工程', exact: true })).toBeEnabled({ timeout: 60000 });
    const chooser = page.waitForEvent('filechooser');
    await page.locator('.workbench-menu > summary').filter({ hasText: /^文件$/ }).click();
    await page.getByRole('button', { name: '导入 JSON 副本', exact: true }).click();
    await (await chooser).setFiles({ name: 'perf.json', mimeType: 'application/json', buffer: bytes });
    await expect(page.locator('.workbench-project-name')).toHaveText(name, { timeout: 120000 });
    // Let the old editor's autosave finish so it does not land inside a measured window.
    await expect(page.getByTestId('browser-save-status')).toContainText('已保存', { timeout: 120000 });
    if (image) {
      await page.getByTestId('background-relink-input').setInputFiles({ name: 'background.jpg', mimeType: 'image/jpeg', buffer: image });
      await expect(page.getByTestId('background-image-status')).toContainText('图片已就绪', { timeout: 120000 });
    }
    await page.getByRole('button', { name: '适应地图', exact: true }).click();
    await settle(page);
    return (await page.getByTestId('map-canvas').locator('canvas').first().boundingBox())!;
  }
  await page.getByTestId('open-file-input').setInputFiles([{ name: 'perf.json', mimeType: 'application/json', buffer: bytes },
    ...image ? [{ name: 'background.jpg', mimeType: 'image/jpeg', buffer: image }] : []]);
  await expect(page.locator('.doc-title')).toHaveText(name, { timeout: 120000 });
  if (image) await expect(page.locator('.toast')).toContainText('已载入底图', { timeout: 120000 });
  await page.getByRole('button', { name: '适应', exact: true }).click();
  await settle(page);
  return (await page.getByTestId('map-canvas').boundingBox())!;
}

for (const round of [1, 2, 3, 4]) for (const app of ['map', 'studio'] as const) test(`${app} round ${round}`, async ({ page }) => {
  test.skip(!mapPath, 'PERF_MAP is not set');
  const map = JSON.parse(await readFile(mapPath!, 'utf8'));
  if (!backgroundPath) { map.backgroundLayers = {}; map.assets = {}; }
  const box = await open(page, app, Buffer.from(JSON.stringify(map)), map.metadata.name, backgroundPath ? await readFile(backgroundPath) : null);
  await instrument(page);
  const cx = box.x + box.width / 2, cy = box.y + box.height / 2;
  let t0 = await mark(page);
  await page.mouse.move(cx, cy); await page.mouse.down({ button: 'middle' });
  for (let i = 1; i <= 60; i++) await page.mouse.move(cx + i * 4, cy + i * 2);
  await page.mouse.up({ button: 'middle' }); await settle(page);
  const pan = await measure(page, t0, await mark(page));
  t0 = await mark(page);
  await page.mouse.move(cx, cy);
  for (let i = 0; i < 12; i++) await page.mouse.wheel(0, -120);
  for (let i = 0; i < 12; i++) await page.mouse.wheel(0, 120);
  await settle(page);
  const zoom = await measure(page, t0, await mark(page));
  await mkdir('.cache/perf', { recursive: true });
  await writeFile(`.cache/perf/compare-${app}-${round}${backgroundPath ? '-bg' : ''}.json`, JSON.stringify({ app, round, map: mapPath, background: backgroundPath ?? null, pan, zoom }, null, 2));
  console.log(`${app.padEnd(6)} round ${round}  pan p50 ${pan.gapP50?.toFixed(1)} p95 ${pan.gapP95?.toFixed(1)} max ${pan.gapMax?.toFixed(1)} long ${pan.longTaskMs.toFixed(0)}`
    + `  | zoom p50 ${zoom.gapP50?.toFixed(1)} p95 ${zoom.gapP95?.toFixed(1)} max ${zoom.gapMax?.toFixed(1)} long ${zoom.longTaskMs.toFixed(0)}`);
});
