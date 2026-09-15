import { test, expect, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Vec3, YardMap } from '../../src/domain/model';
import { GA01_TARGETS, readGA01Target } from '../helpers/GA01_targets';
import { readyWorkbench, importMapUI, browserSaved, storedWorkspace, checkpoint, expectVisiblePosition } from '../helpers/RF01_workbench';

test.use({ viewport: { width: 1920, height: 1080 } });
const controls = ['道路带不透明度', '建筑填充不透明度', '区域填充不透明度'] as const;
const samplePoints: Vec3[] = [[380, 1026, 0], [340, 950, 0], [440, 950, 0]];

async function setOpacity(page: Page, index: number, percent: number) {
  const slider = page.getByRole('slider', { name: controls[index]!, exact: true });
  await slider.focus(); await slider.press(percent === 100 ? 'End' : 'Home');
  if (percent !== 100) for (let i = 0; i < percent; i++) await slider.press('ArrowRight');
  await expect(slider).toHaveValue(String(percent));
}

// Same actual-canvas compositing approach as roadWidth.spec.ts; no Konva state or test hooks.
async function renderedPixels(page: Page, points: Vec3[]) {
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  const camera = page.getByTestId('camera-state');
  const view = { scale: Number(await camera.getAttribute('data-scale')), x: Number(await camera.getAttribute('data-offset-x')), y: Number(await camera.getAttribute('data-offset-y')) };
  return page.getByTestId('map-canvas').evaluate((element, { points, view }) => {
    const canvases = [...element.querySelectorAll('canvas')], box = canvases[0]!.getBoundingClientRect();
    const scratch = document.createElement('canvas'); scratch.width = Math.floor(box.width); scratch.height = Math.floor(box.height);
    const context = scratch.getContext('2d')!; context.fillStyle = '#fff'; context.fillRect(0, 0, scratch.width, scratch.height);
    for (const canvas of canvases) context.drawImage(canvas, 0, 0, scratch.width, scratch.height);
    const rgb = (ctx: CanvasRenderingContext2D, x: number, y: number) => [...ctx.getImageData(x - 1, y - 1, 3, 3).data].filter((_, index) => index % 4 !== 3);
    return points.map(point => {
      const x = Math.round(view.x + point[0] * view.scale), y = Math.round(view.y - point[1] * view.scale);
      if (x < 2 || y < 2 || x >= scratch.width - 2 || y >= scratch.height - 2) throw new Error('Sample outside visible canvas');
      const actual = rgb(context, x, y);
      context.clearRect(0, 0, scratch.width, scratch.height); context.drawImage(canvases[0]!, 0, 0, scratch.width, scratch.height);
      const background = rgb(context, x, y);
      context.fillStyle = '#fff'; context.fillRect(0, 0, scratch.width, scratch.height);
      for (const canvas of canvases) context.drawImage(canvas, 0, 0, scratch.width, scratch.height);
      return { actual, background };
    });
  }, { points, view });
}
function maxDifference(a: number[], b: number[]) { return Math.max(...a.map((value, index) => Math.abs(value - b[index]!))); }

async function current(page: Page): Promise<YardMap> {
  await browserSaved(page);
  await expect.poll(async () => (await storedWorkspace(page)).record?.draft?.contentHash).toBe(await page.getByTestId('map-hash').textContent());
  return JSON.parse((await storedWorkspace(page)).record!.draft!.mapJson) as YardMap;
}
async function undoCount(page: Page) { return Number((await page.locator('.canvas-status').textContent())!.match(/(\d+) 个撤销事务/)![1]); }

test('real CIMC drawing opacity changes rendered fills independently, preserves hits and restores view-only preferences', async ({ page, browser }, info) => {
  test.setTimeout(120000);
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const original = await readGA01Target(GA01_TARGETS.find(target => target.id === 'cimc_v02')!);
  const sample = structuredClone(original); sample.mapId = 'MAP_CIMC_DRAWING_OPACITY'; sample.metadata.name = 'CIMC 真实底图填充透明度验收副本';
  for (const key of ['nodes','roads','junctions','movements','facilities','zones','accessPoints','servicePoints','resources','extensions','extensionNamespaces','assets','backgroundLayers'] as const) (sample as unknown as Record<string, unknown>)[key] = {};
  const imagePath = resolve('.cache/BG01/calibrated-cimc/background.jpg'), calibrationPath = resolve('.cache/BG01/calibrated-cimc/calibration.json');
  const imageSHA = createHash('sha256').update(await readFile(imagePath)).digest('hex');
  expect(imageSHA).toBe('8ec6e74a72c9757f7113a440832dc9d9166518fe7f9da75979629a2cdb2ef713');
  await readyWorkbench(page); await importMapUI(page, sample);
  await page.getByRole('button', { name: '底图', exact: true }).click();
  await page.getByTestId('background-file-input').setInputFiles([imagePath, calibrationPath]);
  await expect(page.getByTestId('background-calibration-status')).toContainText('校准匹配');
  await page.getByRole('button', { name: '添加此底图', exact: true }).click();
  await expect(page.getByTestId('background-render-state')).toHaveAttribute('data-loaded', '1');
  await page.getByRole('button', { name: '适应底图', exact: true }).click();
  await page.locator('summary').filter({ hasText: /^底图显示与调整$/ }).click();
  await page.getByRole('button', { name: '收起属性面板', exact: true }).click();
  const click = async (point: Vec3) => { const target = await expectVisiblePosition(page, point); await page.mouse.click(target.x, target.y); };
  await page.getByRole('button', { name: '道路', exact: true }).click();
  await page.getByRole('button', { name: '保留原图并升级', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await click([320, 1023, 0]); await click([440, 1023, 0]); await page.keyboard.press('Enter');
  await page.getByRole('button', { name: '建筑', exact: true }).click(); await click([320, 930, 0]); await click([380, 990, 0]);
  await page.getByRole('button', { name: '区域', exact: true }).click();
  for (const point of [[420, 930, 0], [480, 930, 0], [480, 990, 0], [420, 990, 0]] as Vec3[]) await click(point);
  await page.keyboard.press('Enter'); await page.getByRole('button', { name: '选择', exact: true }).click(); await page.keyboard.press('Escape');
  const center = await expectVisiblePosition(page, [390, 990, 0]); await page.mouse.move(center.x, center.y);
  for (let i = 0; i < 6; i++) { const before = Number(await page.getByTestId('camera-state').getAttribute('data-scale')); await page.mouse.wheel(0, -120); await expect.poll(async () => Number(await page.getByTestId('camera-state').getAttribute('data-scale'))).toBeGreaterThan(before); }
  expect(Number(await page.getByTestId('camera-state').getAttribute('data-scale')) * 12).toBeGreaterThan(12);
  for (const [index, percent] of [100, 20, 20].entries()) await expect(page.getByRole('slider', { name: controls[index]!, exact: true })).toHaveValue(String(percent));
  const baseline = await current(page), mapHash = await page.getByTestId('map-hash').textContent(), history = await undoCount(page);
  expect(Object.keys(baseline.roads)).toHaveLength(1); expect(Object.keys(baseline.facilities)).toHaveLength(1); expect(Object.keys(baseline.zones)).toHaveLength(1);
  const cameraBefore = await page.getByTestId('camera-state').textContent(), canvasBox = await page.getByTestId('map-canvas').boundingBox();
  const evidence = [];
  for (let index = 0; index < controls.length; index++) {
    const before = await renderedPixels(page, samplePoints);
    await setOpacity(page, index, 0); const zero = await renderedPixels(page, samplePoints);
    await setOpacity(page, index, 100); const full = await renderedPixels(page, samplePoints);
    expect(maxDifference(full[index]!.actual, zero[index]!.actual)).toBeGreaterThan(20);
    await setOpacity(page, index, 35);
    const expected = zero[index]!.actual.map((value, channel) => value + 0.35 * (full[index]!.actual[channel]! - value));
    await expect.poll(async () => maxDifference((await renderedPixels(page, samplePoints))[index]!.actual, expected)).toBeLessThanOrEqual(3);
    const partial = await renderedPixels(page, samplePoints);
    for (let other = 0; other < controls.length; other++) {
      expect(partial[other]!.background).toEqual(before[other]!.background);
      if (other !== index) { expect(zero[other]!.actual).toEqual(before[other]!.actual); expect(full[other]!.actual).toEqual(before[other]!.actual); expect(partial[other]!.actual).toEqual(before[other]!.actual); }
    }
    expect(await current(page)).toEqual(baseline); expect(await undoCount(page)).toBe(history);
    evidence.push({ control: controls[index], zero: zero[index]!.actual, full: full[index]!.actual, partial: partial[index]!.actual, expected });
  }
  await page.screenshot({ path: info.outputPath('01-three-fills-35-percent.png') });
  for (let index = 0; index < controls.length; index++) await setOpacity(page, index, 0);
  const targets = [
    { point: [380, 1023, 0] as Vec3, edge: [380, 1023, 0] as Vec3, testId: 'road-item-' + Object.keys(baseline.roads)[0]! },
    { point: [340, 950, 0] as Vec3, edge: [320, 960, 0] as Vec3, testId: 'facilities-item-' + Object.keys(baseline.facilities)[0]! },
    { point: [440, 950, 0] as Vec3, edge: [420, 960, 0] as Vec3, testId: 'zones-item-' + Object.keys(baseline.zones)[0]! },
  ];
  await page.getByRole('button', { name: '选择', exact: true }).click();
  for (const target of targets) {
    const unselected = (await renderedPixels(page, [target.edge]))[0]!.actual;
    await click(target.point); await expect(page.getByTestId(target.testId)).toHaveClass(/selected/);
    await expect.poll(async () => maxDifference((await renderedPixels(page, [target.edge]))[0]!.actual, unselected)).toBeGreaterThan(10);
    await page.keyboard.press('Escape');
  }
  await page.screenshot({ path: info.outputPath('02-transparent-fills-outline-visible.png') });
  await page.getByRole('button', { name: '恢复默认不透明度', exact: true }).click();
  for (const [index, percent] of [100, 20, 20].entries()) await expect(page.getByRole('slider', { name: controls[index]!, exact: true })).toHaveValue(String(percent));
  for (let index = 0; index < controls.length; index++) await setOpacity(page, index, 35);
  const savedPixels = await renderedPixels(page, samplePoints);
  expect(await current(page)).toEqual(baseline); expect(await undoCount(page)).toBe(history);
  expect(await page.getByTestId('map-hash').textContent()).toBe(mapHash);
  expect(await page.getByTestId('camera-state').textContent()).toBe(cameraBefore); expect(await page.getByTestId('map-canvas').boundingBox()).toEqual(canvasBox);
  await page.getByLabel('保存选项', { exact: true }).click(); await page.getByRole('button', { name: '仅保存浏览器恢复', exact: true }).click(); await checkpoint(page, mapHash!);
  await page.reload(); await browserSaved(page); await expect(page.getByTestId('background-render-state')).toHaveAttribute('data-loaded', '1');
  for (const name of controls) await expect(page.getByRole('slider', { name, exact: true })).toHaveValue('35');
  expect((await storedWorkspace(page)).editor?.drawing).toMatchObject({ roadFillOpacity: 0.35, facilityFillOpacity: 0.35, zoneFillOpacity: 0.35 });
  await expect.poll(async () => await renderedPixels(page, samplePoints)).toEqual(savedPixels);
  expect(await current(page)).toEqual(baseline); expect(await page.getByTestId('map-hash').textContent()).toBe(mapHash);
  await page.screenshot({ path: info.outputPath('03-restored-fill-preferences.png') });
  await page.getByRole('button', { name: '道路', exact: true }).click(); await click([520, 1023, 0]);
  await setOpacity(page, 0, 20); await expect(page.getByTestId('road-draft-instruction')).toBeVisible(); await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(await current(page)).toEqual(baseline);
  await click([640, 1023, 0]); await page.keyboard.press('Enter');
  const draftFinished = await current(page); expect(Object.keys(draftFinished.roads)).toHaveLength(2); expect(Object.keys(draftFinished.nodes)).toHaveLength(4);
  await page.getByRole('button', { name: '撤销', exact: true }).click(); expect(await current(page)).toEqual(baseline); await setOpacity(page, 0, 35);
  expect(await readGA01Target(GA01_TARGETS.find(target => target.id === 'cimc_v02')!)).toEqual(original);
  expect(createHash('sha256').update(await readFile(imagePath)).digest('hex')).toBe(imageSHA); expect(errors).toEqual([]);
  await writeFile(info.outputPath('drawing-opacity-evidence.json'), JSON.stringify({ browser: browser.version(), imageSHA, mapHash, revision: baseline.revision, undoTransactions: history, independentFillPixels: evidence, transparentCanvasHits: true, restored: true, draftSurvivesDisplayChange: true, mapUnchanged: true }, null, 2));
});
