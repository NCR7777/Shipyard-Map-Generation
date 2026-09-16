import { expect, test, type Page } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import type { Vec3 } from '../../src/domain/model';
import { canvasClick, chooseSpatial, classificationBackground, savedMap, unchangedNetwork } from '../helpers/classificationWorkbench';
import { browserSaved, exportMapUI } from '../helpers/RF01_workbench';
import { drawingControl, openDrawingSettings } from '../helpers/workbenchUi';
import { readGA01Target } from '../helpers/GA01_targets';

test.use({ viewport: { width: 1920, height: 1080 } });

// Composite pixels of the actual editor canvas, independent of scene/color helpers.
async function pixel(page: Page, point: Vec3): Promise<number[]> {
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  const camera = page.getByTestId('camera-state');
  const view = { scale: Number(await camera.getAttribute('data-scale')), x: Number(await camera.getAttribute('data-offset-x')), y: Number(await camera.getAttribute('data-offset-y')) };
  return page.getByTestId('map-canvas').evaluate((element, { point, view }) => {
    const canvases = [...element.querySelectorAll('canvas')], box = canvases[0]!.getBoundingClientRect();
    const scratch = document.createElement('canvas'); scratch.width = Math.floor(box.width); scratch.height = Math.floor(box.height);
    const context = scratch.getContext('2d')!;
    context.fillStyle = '#fff'; context.fillRect(0, 0, scratch.width, scratch.height);
    for (const canvas of canvases) context.drawImage(canvas, 0, 0, scratch.width, scratch.height);
    const x = Math.round(view.x + point[0] * view.scale), y = Math.round(view.y - point[1] * view.scale);
    if (x < 2 || y < 2 || x >= scratch.width - 2 || y >= scratch.height - 2) throw new Error('Color sample outside visible canvas');
    return [...context.getImageData(x, y, 1, 1).data].slice(0, 3);
  }, { point, view });
}
async function opacity(page: Page, collection: 'facilities' | 'zones', value: number) {
  const label = collection === 'facilities' ? '建筑填充不透明度' : '区域填充不透明度';
  const slider = await drawingControl(page, label);
  await slider.focus(); await slider.press(value === 100 ? 'End' : 'Home');
  if (value !== 100) for (let index = 0; index < value; index++) await slider.press('ArrowRight');
  await expect(slider).toHaveValue(String(value));
}
async function classify(page: Page, collection: 'facilities' | 'zones', classId: string) {
  await page.getByLabel(collection === 'facilities' ? '建筑分类' : '区域分类', { exact: true }).selectOption(classId);
  await page.getByRole('button', { name: '应用属性', exact: true }).click();
  return savedMap(page);
}

test('real CIMC canvas colors follow classification through opacity, undo and reload without changing geometry', async ({ page }, info) => {
  test.setTimeout(180000); const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const { baseline, target, original, imageSHA } = await classificationBackground(page, 'COLORS');
  // Keep all original entities; place test-only outlines outside existing roads/buildings.
  await (await drawingControl(page, '节点吸附')).uncheck();
  await page.getByLabel('建筑绘制形状', { exact: true }).selectOption('facilityRect');
  await canvasClick(page, [30, 930, 0]); await canvasClick(page, [90, 990, 0]);
  const withBuilding = await savedMap(page), buildingId = Object.keys(withBuilding.facilities).find(id => !baseline.facilities[id])!;
  expect(buildingId).toBeTruthy();
  await page.getByLabel('区域绘制形状', { exact: true }).selectOption('zoneRect');
  await canvasClick(page, [30, 830, 0]); await canvasClick(page, [90, 890, 0]);
  const drawn = await savedMap(page), zoneId = Object.keys(drawn.zones).find(id => !withBuilding.zones[id])!;
  expect(zoneId).toBeTruthy();
  await opacity(page, 'facilities', 100); await opacity(page, 'zones', 100);
  await chooseSpatial(page, 'facilities', buildingId);
  const workshop = await classify(page, 'facilities', 'workshop');
  const buildingPoint: Vec3 = [50, 950, 0];
  await expect.poll(() => pixel(page, buildingPoint)).toEqual([223, 118, 40]);
  const warehouse = await classify(page, 'facilities', 'warehouse');
  await expect.poll(() => pixel(page, buildingPoint)).toEqual([135, 88, 184]);
  await page.getByRole('button', { name: '撤销', exact: true }).click(); expect(await savedMap(page)).toEqual(workshop);
  await expect.poll(() => pixel(page, buildingPoint)).toEqual([223, 118, 40]);
  await page.getByRole('button', { name: '重做', exact: true }).click(); expect(await savedMap(page)).toEqual(warehouse);
  await expect.poll(() => pixel(page, buildingPoint)).toEqual([135, 88, 184]);
  // Selection changes the outline, not the classification's interior color.
  await page.keyboard.press('Escape'); await expect.poll(() => pixel(page, buildingPoint)).toEqual([135, 88, 184]);
  await chooseSpatial(page, 'zones', zoneId);
  await classify(page, 'zones', 'dry_dock');
  const zonePoint: Vec3 = [50, 850, 0];
  await expect.poll(() => pixel(page, zonePoint)).toEqual([71, 125, 194]);
  await expect(page.getByLabel('干船坞深度 (m)', { exact: true })).toHaveValue('');
  await expect(page.getByLabel('区域分类', { exact: true }).locator('option:checked')).toHaveText('岸式干船坞');
  await classify(page, 'zones', 'floating_dock');
  await expect.poll(() => pixel(page, zonePoint)).toEqual([106, 103, 169]);
  await expect(page.getByLabel('干船坞深度 (m)', { exact: true })).toHaveCount(0);
  await classify(page, 'zones', 'dock_unspecified');
  await expect.poll(() => pixel(page, zonePoint)).toEqual([122, 135, 149]);
  const classified = await classify(page, 'zones', 'yard');
  await expect.poll(() => pixel(page, zonePoint)).toEqual([83, 168, 144]);
  unchangedNetwork(drawn, classified);
  for (const collection of ['facilities', 'zones'] as const) for (const [id, entity] of Object.entries(drawn[collection])) expect(classified[collection][id]!.boundary).toEqual(entity.boundary);
  await opacity(page, 'zones', 0); const transparent = await pixel(page, zonePoint);
  await opacity(page, 'zones', 100); const opaque = await pixel(page, zonePoint);
  await opacity(page, 'zones', 35);
  const expected = transparent.map((value, channel) => value + 0.35 * (opaque[channel]! - value));
  await expect.poll(async () => Math.max(...(await pixel(page, zonePoint)).map((value, channel) => Math.abs(value - expected[channel]!)))).toBeLessThanOrEqual(3);
  expect(await savedMap(page)).toEqual(classified);
  const partial = await pixel(page, zonePoint);
  await openDrawingSettings(page);
  const classificationPanel = page.locator('summary').filter({ hasText: /^建筑与区域分类$/ });
  if (!await classificationPanel.evaluate(element => (element.parentElement as HTMLDetailsElement).open)) await classificationPanel.click();
  const legend = page.locator('summary').filter({ hasText: /^分类颜色图例$/ });
  if (!await legend.evaluate(element => (element.parentElement as HTMLDetailsElement).open)) await legend.click();
  await expect(page.getByLabel('分类颜色图例', { exact: true })).toContainText('仓库');
  await expect(page.getByLabel('分类颜色图例', { exact: true })).toContainText('堆场');
  const exported = await exportMapUI(page, info, 'classification-colors'); expect(exported.map).toEqual(classified);
  await page.reload(); await browserSaved(page); expect(await savedMap(page)).toEqual(classified);
  await expect(page.getByTestId('background-render-state')).toHaveAttribute('data-loaded', '1');
  await expect.poll(() => pixel(page, zonePoint)).toEqual(partial);
  await page.getByRole('button', { name: '适应地图', exact: true }).click();
  await page.screenshot({ path: info.outputPath('real-background-classification-colors.png') });
  expect(await readGA01Target(target)).toEqual(original); expect(errors).toEqual([]);
  await writeFile(info.outputPath('color-evidence.json'), JSON.stringify({ imageSHA, buildingId, zoneId, selectedFillPreserved: true, pixelRGB: { workshop: [223,118,40], warehouse: [135,88,184], dryDock: [71,125,194], floatingDock: [106,103,169], dockUnspecified: [122,135,149], yard: [83,168,144] }, transparent, opaque, partial, unchangedGeometryAndReferences: true, undoRedo: true, exportReload: true }, null, 2));
});
