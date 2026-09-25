import { expect, test, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { initialPlacement } from '../../src/app/canvas/backgroundAdjust';
import { toSceneSnapshot } from '../../src/compiler/scene';
import type * as BackgroundEdit from '../../src/app/state/backgroundEdit';
import type * as Project from '../../src/app/state/project';
import { newMap } from '../../src/domain/factory';
import { loadMap } from '../../src/domain/load';
import { backgroundFrame, backgroundPoint } from '../../src/geometry/backgrounds';
import { backgroundMap, QUADRANT_POINTS, quadrantPng } from '../helpers/P1B_backgroundMap';

const EXAMPLE = readFileSync(fileURLToPath(new URL('../../examples/M2A1_synthetic_service_targets.map.json', import.meta.url)), 'utf8');
const png = quadrantPng();
const image = (name: string, buffer: Buffer) => ({ name, mimeType: 'image/png', buffer });
const json = (name: string, text: string) => ({ name, mimeType: 'application/json', buffer: Buffer.from(text) });
const COLORS = { red: [220, 40, 40], blue: [40, 80, 220], green: [40, 170, 60], yellow: [230, 200, 40], none: [247, 249, 250] } as const;
type Transform = [number, number, number, number, number, number];

async function at(page: Page, x: number, y: number) {
  const canvas = page.getByTestId('map-canvas'), box = (await canvas.boundingBox())!;
  const [s, ox, oy] = await Promise.all(['data-scale', 'data-offset-x', 'data-offset-y'].map(async name => Number(await canvas.getAttribute(name))));
  return { x: box.x + ox! + x * s!, y: box.y + oy! - y * s! };
}
async function colourAt(page: Page, x: number, y: number): Promise<keyof typeof COLORS | 'outside'> {
  const point = await at(page, x, y);
  const rgb = await page.evaluate(({ x, y }) => {
    const canvas = document.querySelector<HTMLCanvasElement>('[data-testid=map-canvas] canvas')!, rect = canvas.getBoundingClientRect(), ratio = canvas.width / rect.width;
    if (x < rect.left || y < rect.top || x >= rect.right || y >= rect.bottom) return null;
    return [...canvas.getContext('2d')!.getImageData(Math.round((x - rect.left) * ratio), Math.round((y - rect.top) * ratio), 1, 1).data].slice(0, 3);
  }, point);
  if (!rgb) return 'outside';
  const distance = (a: readonly number[], b: readonly number[]) => Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!);
  return (Object.keys(COLORS) as (keyof typeof COLORS)[]).sort((a, b) => distance(rgb, COLORS[a]) - distance(rgb, COLORS[b]))[0]!;
}
async function click(page: Page, x: number, y: number) { const p = await at(page, x, y); await page.mouse.click(p.x, p.y); }
/** Presses at one world point and releases at another in small steps; `before` runs while the button is still down. */
async function drag(page: Page, from: { x: number; y: number }, to: { x: number; y: number }, options: { shift?: boolean; before?: () => Promise<void> } = {}) {
  await page.mouse.move(from.x, from.y); await page.mouse.down();
  if (options.shift) await page.keyboard.down('Shift');
  for (let step = 1; step <= 6; step++) await page.mouse.move(from.x + (to.x - from.x) * step / 6, from.y + (to.y - from.y) * step / 6);
  if (options.before) await options.before();
  await page.mouse.up();
  if (options.shift) await page.keyboard.up('Shift');
}
const inspector = (page: Page) => page.getByRole('region', { name: '属性' });
const undoButton = (page: Page) => page.getByRole('toolbar', { name: '工具' }).getByRole('button', { name: '撤销' });
const layer = (page: Page, name = '四色测试底图') => page.getByRole('group', { name: '底图 ' + name });
const finish = (page: Page) => inspector(page).getByRole('button', { name: '完成调整' });
/** The selected background layer as the inspector's raw JSON shows it. */
async function selectedLayer(page: Page): Promise<{ imageToWorld: Transform; method: string; assetId: string; provenance: { sourceRefs: string[] } }> {
  return JSON.parse((await inspector(page).locator('.raw-json pre').textContent())!);
}
const transform = async (page: Page) => (await selectedLayer(page)).imageToWorld;
function watchErrors(page: Page): string[] { const errors: string[] = []; page.on('pageerror', error => errors.push(error.message)); return errors; }
async function openMap(page: Page, files: Parameters<ReturnType<Page['getByTestId']>['setInputFiles']>[0]) {
  await page.goto('/');
  await page.getByTestId('open-file-input').setInputFiles(files);
  await expect(page.getByTestId('map-canvas')).toHaveAttribute('data-scale', /\d/);
}
async function adjustFromLayers(page: Page, name = '四色测试底图') {
  await page.getByRole('tab', { name: '图层' }).click();
  await expect(layer(page, name).locator('.badge')).toHaveText('就绪');
  await layer(page, name).getByRole('button', { name: '适应底图' }).click();
  await layer(page, name).getByRole('button', { name: '调整底图' }).click();
  await expect(finish(page)).toBeVisible();
}
/** Selects a background layer through the object list's search (the list is virtualised; a source may share its name). */
async function pick(page: Page, name: string) {
  await page.getByRole('tab', { name: '对象' }).click();
  await page.getByLabel('搜索对象').fill(name);
  await page.getByRole('list', { name: '对象目录' }).getByRole('button', { name: new RegExp('^' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*(bg|background_)') }).click();
}
/** The background test map made read-only by an extension whose behaviour this tool does not know. */
function readOnlyMap(): string {
  const map = JSON.parse(backgroundMap({ mapId: 'map_readonly' })) as { extensionNamespaces: Record<string, unknown> };
  map.extensionNamespaces['test.future_behavior'] = { version: '1', category: 'behavior' };
  return JSON.stringify(map);
}
const close = (actual: readonly number[], expected: readonly number[], digits: number) => actual.forEach((value, index) => expect(value, `index ${index}`).toBeCloseTo(expected[index]!, digits));

test('a blank map starts from an image: 1 m per pixel at the origin, adjusting at once, then scaled from a known length', async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto('/');
  await page.getByRole('button', { name: '新建地图…' }).click();
  await page.getByRole('button', { name: '创建地图' }).click();
  const hint = page.getByRole('note').filter({ hasText: '空白地图' });
  await expect(hint).toBeVisible();
  // A calibration file in a geographically anchored frame cannot place an image on a new map (no anchor): said plainly, nothing added.
  const frame = { ...newMap('m', 'x', '0.3.0').coordinateFrame, geographicAnchor: { crs: 'EPSG:32652', coordinateOrder: 'EN', method: 'survey', origin: [0, 0, 0], rotationRad: 0 } };
  const anchored = JSON.stringify({ format: 'BG01_background_calibration_v1', image: { sha256: createHash('sha256').update(png).digest('hex'), widthPx: 64, heightPx: 48 },
    coordinateFrame: frame, pixelConvention: 'pixel_corner_top_left_x_right_y_down', imageToWorld: [1, 0, 0, -1, 0, 48], sourceEvidence: [{ name: 's.csv', sha256: 'b'.repeat(64), jsonPath: '/' }] });
  await page.getByTestId('add-background-input').setInputFiles([image('site.png', png), json('site.calibration.json', anchored)]);
  await expect(page.getByRole('alert')).toContainText('地理锚点（EPSG:32652）');
  await expect(hint).toBeVisible();
  // The hint's button opens the chooser (image and calibration files together).
  const chooser = page.waitForEvent('filechooser');
  await hint.getByRole('button', { name: '添加底图…' }).click();
  const picker = await chooser;
  expect(picker.isMultiple()).toBe(true);
  await picker.setFiles(image('site.png', png));
  await expect(finish(page)).toBeVisible();
  await expect(hint).toBeHidden();
  await expect(page.getByRole('status')).toContainText('未校准');
  expect(await transform(page)).toEqual([1, 0, 0, -1, 0, 48]);
  await expect.poll(() => colourAt(page, 16, 36)).toBe('red');
  await expect.poll(() => colourAt(page, 48, 12)).toBe('yellow');
  await expect(undoButton(page)).toHaveAttribute('title', /撤销：添加底图/);

  // 48 m on the image (8,12)–(56,12) is really 96 m: the image doubles about the first point.
  await inspector(page).getByRole('button', { name: '量距定比例' }).click();
  await expect(inspector(page).getByRole('status')).toContainText('第一个点');
  // A point off the image is refused.
  await page.getByRole('button', { name: '缩小（-）' }).click();
  await click(page, 8, 56);
  await expect(page.getByRole('alert')).toContainText('要点在底图上');
  await expect(inspector(page).getByRole('status')).toContainText('第一个点');
  await click(page, 8, 12);
  await expect(inspector(page).getByRole('status')).toContainText('第二个点');
  await click(page, 56, 12);
  const length = inspector(page).getByLabel('实际长度');
  await expect(length).toBeFocused();
  // Escape in the length field ends measuring at once.
  await length.press('Escape');
  await expect(inspector(page).getByRole('button', { name: '量距定比例' })).toBeVisible();
  await inspector(page).getByRole('button', { name: '量距定比例' }).click();
  await click(page, 8, 12); await click(page, 56, 12);
  await expect(length).toBeFocused();
  await length.fill('96'); await length.press('Enter');
  await expect(undoButton(page)).toHaveAttribute('title', /撤销：量距定比例/);
  const scaled = await transform(page);
  expect(scaled[0]).toBeCloseTo(2, 2); expect(scaled[3]).toBeCloseTo(-2, 2); expect(scaled[1]).toBe(0); expect(scaled[2]).toBe(0);
  close(backgroundPoint(scaled, [8, 36]), [8, 12], 1);
  await expect(inspector(page).getByRole('button', { name: '量距定比例' })).toBeVisible();
  await undoButton(page).click();
  expect(await transform(page)).toEqual([1, 0, 0, -1, 0, 48]);
  expect(errors).toEqual([]);
});

test('dragging moves, a corner resizes keeping the aspect ratio, the top handle rotates; one undo step each, Escape cancels', async ({ page }) => {
  const errors = watchErrors(page);
  await openMap(page, [json('bg.map.json', backgroundMap()), image('bg.png', png)]);
  await adjustFromLayers(page);
  await drag(page, await at(page, 150, 30), await at(page, 160, 20));
  await expect(undoButton(page)).toHaveAttribute('title', /撤销：移动底图/);
  const moved = await transform(page);
  close(moved, [1, 0, 0, -1, 130, 38], 0);

  // Escape during a drag: the image goes back and nothing is recorded.
  await drag(page, await at(page, 150, 20), await at(page, 175, 5), { before: () => page.keyboard.press('Escape') });
  expect(await transform(page)).toEqual(moved);
  // Drawn back where it is, not where the cancelled drag had it (that would leave x < 155 empty).
  await expect.poll(() => colourAt(page, moved[4] + 5, moved[5] - 8)).toBe('red');
  await expect(undoButton(page)).toHaveAttribute('title', /撤销：移动底图/);
  await expect(finish(page)).toBeVisible();

  // Bottom-right corner (pixel 64,48) dragged outward: the top-left corner stays exactly, both axes scale alike.
  const corner = backgroundPoint(moved, [64, 48]);
  await drag(page, await at(page, corner[0], corner[1]), await at(page, corner[0] + 32, corner[1] - 10));
  await expect(undoButton(page)).toHaveAttribute('title', /撤销：缩放底图/);
  const resized = await transform(page);
  expect(resized.slice(4)).toEqual(moved.slice(4));
  expect(resized[0]).toBeCloseTo(-resized[3], 12);
  expect(resized[0]).toBeGreaterThan(1.2);

  // The rotation handle sits 28 px above the middle of the top edge; Shift turns in 15° steps about the centre.
  const frame = backgroundFrame(resized, 64, 48), top = backgroundPoint(resized, [32, 0]), handle = await at(page, top[0], top[1]);
  const right = await at(page, frame.center[0] + 40, frame.center[1] + 10);
  await drag(page, { x: handle.x, y: handle.y - 28 }, right, { shift: true });
  await expect(undoButton(page)).toHaveAttribute('title', /撤销：旋转底图/);
  const turned = await transform(page), after = backgroundFrame(turned, 64, 48);
  expect(after.rotationRad).not.toBe(0);
  expect(after.rotationRad / (Math.PI / 12)).toBeCloseTo(Math.round(after.rotationRad / (Math.PI / 12)), 9);
  close(after.center, frame.center, 6);

  // Arrow keys: 0.1 m steps; a run of them is one undo step and one lineage record in the map (not one per press).
  const records = (await selectedLayer(page)).provenance.sourceRefs.length;
  await page.getByTestId('map-canvas').focus();
  for (let i = 0; i < 20; i++) await page.keyboard.press('ArrowRight');
  await expect(undoButton(page)).toHaveAttribute('title', /撤销：微调底图/);
  const nudged = await selectedLayer(page);
  expect(nudged.imageToWorld[4]).toBeCloseTo(turned[4] + 2, 9);
  expect(nudged.provenance.sourceRefs.length).toBe(records + 1);
  await undoButton(page).click();
  expect(await transform(page)).toEqual(turned);
  // A run that comes back where it began leaves the image exactly there and no undo step.
  await page.getByTestId('map-canvas').focus();
  for (const key of ['ArrowRight', 'ArrowRight', 'ArrowLeft', 'ArrowLeft']) await page.keyboard.press(key);
  await expect(undoButton(page)).toHaveAttribute('title', /撤销：旋转底图/);
  expect(await transform(page)).toEqual(turned);
  expect(errors).toEqual([]);
});

test('numeric fields are typed only while adjusting; a typed corner is stored exactly and untouched fields keep full precision', async ({ page }) => {
  const errors = watchErrors(page);
  const odd = [0.5, 0, 0, -0.5, 120.123456789, 48.987654321];
  await openMap(page, [json('bg.map.json', backgroundMap({ transform: odd })), image('bg.png', png)]);
  await pick(page, '四色测试底图');
  await expect(inspector(page).getByText('底图平时锁定')).toBeVisible();
  await expect(inspector(page).getByLabel('左上角 X')).toHaveCount(0);
  // Selected but locked: arrows and Delete say what to do instead, and change nothing.
  await page.getByTestId('map-canvas').focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('status')).toContainText('平时锁定');
  await page.keyboard.press('Delete');
  await expect(page.getByRole('status')).toContainText('「删除底图」按钮');
  expect(await transform(page)).toEqual(odd);
  await expect(undoButton(page)).toBeDisabled();
  await inspector(page).getByRole('button', { name: '调整位置与比例' }).click();
  await expect(finish(page)).toBeVisible();
  const field = (label: string) => inspector(page).getByLabel(label, { exact: true });

  // 0.1 is stored as typed; moving by the difference (120.123456789 + (0.1 − 120.123456789)) would give 0.09999999999999432.
  await field('左上角 X').fill('0.1'); await field('左上角 X').press('Enter');
  await expect(undoButton(page)).toHaveAttribute('title', /撤销：调整底图/);
  expect(await transform(page)).toEqual([0.5, 0, 0, -0.5, 0.1, 48.987654321]);
  await field('底图宽度').fill('64'); await field('底图宽度').press('Enter');
  let t = await transform(page);
  close(t, [1, 0, 0, -1, 0.1, 48.987654321], 12);
  expect(t.slice(4)).toEqual([0.1, 48.987654321]);
  await inspector(page).getByLabel('保持宽高比').uncheck();
  await field('底图高度').fill('96'); await field('底图高度').press('Enter');
  t = await transform(page);
  close(t, [1, 0, 0, -2, 0.1, 48.987654321], 12);
  await field('米每像素').fill('0.25'); await field('米每像素').press('Enter');
  close(await transform(page), [0.25, 0, 0, -0.5, 0.1, 48.987654321], 12);
  const centre = backgroundFrame(await transform(page), 64, 48).center;
  await field('底图角度').fill('15'); await field('底图角度').press('Enter');
  const turned = backgroundFrame(await transform(page), 64, 48);
  expect(turned.rotationRad).toBeCloseTo(Math.PI / 12, 12);
  close(turned.center, centre, 9);

  // Bad input stays for correction; Escape restores it; nothing is recorded.
  await field('底图宽度').fill('0'); await field('底图宽度').press('Enter');
  await expect(inspector(page).getByRole('alert')).toContainText('大于 0');
  await field('底图宽度').press('Escape');
  await expect(undoButton(page)).toHaveAttribute('title', /撤销：调整底图/);
  // Escape outside a field ends adjusting; the numbers are shown again, not editable.
  await page.getByTestId('map-canvas').focus();
  await page.keyboard.press('Escape');
  await expect(inspector(page).getByText('底图平时锁定')).toBeVisible();
  await expect(field('左上角 X')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('over existing content an image covers it; a calibration file places it exactly; wrong or repeated input changes nothing', async ({ page }) => {
  const errors = watchErrors(page);
  await openMap(page, json('plain.map.json', EXAMPLE));
  const loaded = loadMap(EXAMPLE); if (!loaded.ok) throw new Error('example');
  await page.getByTestId('add-background-input').setInputFiles(image('photo.png', png));
  await expect(finish(page)).toBeVisible();
  expect(await transform(page)).toEqual(initialPlacement(64, 48, toSceneSnapshot(loaded.map).bounds));
  expect((await selectedLayer(page)).method).toBe('manual');
  await page.keyboard.press('Escape');

  // The same image again is refused, not stacked.
  await page.getByTestId('add-background-input').setInputFiles(image('again.png', png));
  await expect(page.getByRole('alert')).toContainText('已是底图');
  await page.getByRole('tab', { name: '图层' }).click();
  await expect(page.locator('.background-layer')).toHaveCount(1);

  // A standard calibration file for another image: placed as it says, recorded as calibrated, not adjusting.
  const small = quadrantPng(32, 24), sha = createHash('sha256').update(small).digest('hex');
  const calibration = (frame = loaded.map.coordinateFrame) => JSON.stringify({
    format: 'BG01_background_calibration_v1', image: { sha256: sha, widthPx: 32, heightPx: 24 }, coordinateFrame: frame,
    pixelConvention: 'pixel_corner_top_left_x_right_y_down', imageToWorld: [2, 0, 0, -2, -80, 120],
    sourceEvidence: [{ name: 'survey.csv', sha256: 'a'.repeat(64), jsonPath: '/points' }],
  });
  // Wrong frame: refused with the reason; the map is unchanged.
  await page.getByTestId('add-background-input').setInputFiles([image('small.png', small), json('small.calibration.json', calibration({ ...loaded.map.coordinateFrame, lengthUnit: 'ft' } as never))]);
  await expect(page.getByRole('alert')).toContainText('BG_FRAME');
  await expect(page.locator('.background-layer')).toHaveCount(1);
  await expect(undoButton(page)).toHaveAttribute('title', /撤销：添加底图/);
  // A JSON that is not a calibration of this image is refused as well.
  await page.getByTestId('add-background-input').setInputFiles([image('small.png', small), json('other.json', '{"hello": 1}')]);
  await expect(page.getByRole('alert')).toContainText('校准文件未通过');
  await expect(page.locator('.background-layer')).toHaveCount(1);
  await page.getByTestId('add-background-input').setInputFiles([image('small.png', small), json('small.calibration.json', calibration())]);
  await expect(page.getByRole('status')).toContainText('按校准文件放置');
  await expect(page.locator('.background-layer')).toHaveCount(2);
  await expect(layer(page, 'small.png')).toContainText('按校准文件放置');
  await expect(finish(page)).toHaveCount(0);
  await pick(page, 'small.png');
  const added = await selectedLayer(page);
  expect(added.imageToWorld).toEqual([2, 0, 0, -2, -80, 120]);
  expect(added.method).toBe('affine');
  // Replacing this layer's image with the other layer's image is refused, as adding it again is.
  await page.getByRole('tab', { name: '图层' }).click();
  const chooser = page.waitForEvent('filechooser');
  await layer(page, 'small.png').getByRole('button', { name: '替换图片…' }).click();
  await (await chooser).setFiles(image('photo-again.png', png));
  await expect(page.getByRole('alert')).toContainText('已是底图');
  await expect(undoButton(page)).toHaveAttribute('title', /撤销：添加底图/);
  expect(errors).toEqual([]);
});

test('replacing keeps the ground and is one undo step; the same image only reloads; deleting is undoable with the image kept', async ({ page }) => {
  const errors = watchErrors(page);
  await openMap(page, [json('bg.map.json', backgroundMap()), image('bg.png', png)]);
  await page.getByRole('tab', { name: '图层' }).click();
  await expect(layer(page).locator('.badge')).toHaveText('就绪');
  const replace = async (buffer: Buffer, name: string) => {
    const chooser = page.waitForEvent('filechooser');
    await layer(page).getByRole('button', { name: '替换图片…' }).click();
    await (await chooser).setFiles(image(name, buffer));
  };
  // Twice the pixels over the same ground.
  await replace(quadrantPng(128, 96), 'sharper.png');
  await expect(page.getByRole('status')).toContainText('保持原来的地面范围');
  await expect(undoButton(page)).toHaveAttribute('title', /撤销：替换底图图片/);
  await layer(page).getByRole('button', { name: '适应底图' }).click();
  for (const [colour, [x, y]] of Object.entries(QUADRANT_POINTS)) await expect.poll(() => colourAt(page, x, y)).toBe(colour);
  await pick(page, '四色测试底图');
  expect(await transform(page)).toEqual([0.5, 0, 0, -0.5, 120, 48]);
  // One undo brings back both the image and its transform.
  await undoButton(page).click();
  expect(await transform(page)).toEqual([1, 0, 0, -1, 120, 48]);
  expect((await selectedLayer(page)).assetId).toBe('imgQuadrants');
  await expect(undoButton(page)).toBeDisabled();

  await page.getByRole('tab', { name: '图层' }).click();
  await replace(png, 'same.png');
  await expect(page.getByRole('status')).toContainText('同一张');
  await expect(undoButton(page)).toBeDisabled();
  // Replacing while adjusting keeps adjusting. Another aspect ratio: corner and width kept, not stretched, and the user is told to check.
  await adjustFromLayers(page);
  const chooser = page.waitForEvent('filechooser');
  await inspector(page).getByRole('button', { name: '替换图片…' }).click();
  await (await chooser).setFiles(image('wide.png', quadrantPng(128, 48)));
  await expect(page.getByRole('alert')).toContainText('宽高比与原图不同');
  await expect(finish(page)).toBeVisible();
  expect(await transform(page)).toEqual([0.5, 0, 0, -0.5, 120, 48]);

  await layer(page).getByRole('button', { name: '删除底图' }).click();
  await expect(page.getByRole('status')).toContainText('已删除底图');
  await expect(page.locator('.background-layer')).toHaveCount(0);
  await expect(undoButton(page)).toHaveAttribute('title', /撤销：删除底图/);
  await undoButton(page).click();
  await expect(layer(page).locator('.badge')).toHaveText('就绪');
  await layer(page).getByRole('button', { name: '适应底图' }).click();
  await expect.poll(() => colourAt(page, 124, 46)).toBe('red');
  expect(errors).toEqual([]);
});

test('adjusting is the only way to move an image, and ends with another selection, tool, lock, hide or map', async ({ page }) => {
  const errors = watchErrors(page);
  await openMap(page, [json('bg.map.json', backgroundMap()), image('bg.png', png)]);
  // Not adjusting: a drag over the image moves nothing (a box selection starts instead).
  await page.getByRole('tab', { name: '图层' }).click();
  await layer(page).getByRole('button', { name: '适应底图' }).click();
  await drag(page, await at(page, 150, 30), await at(page, 170, 10));
  await expect(undoButton(page)).toBeDisabled();

  await adjustFromLayers(page);
  // Adjusting: presses belong to the image only; outside it nothing is selected.
  await click(page, 100, 0);
  await expect(finish(page)).toBeVisible();
  // Backspace never deletes the image, and Delete does not when the focus is on an unrelated control.
  await undoButton(page).focus();
  for (const key of ['Backspace', 'Delete']) {
    await page.keyboard.press(key);
    await expect(page.getByRole('status')).toContainText('焦点在画布或底图面板上按 Delete');
  }
  await expect(page.locator('.background-layer')).toHaveCount(1);
  // Selecting another object ends adjusting.
  await page.getByRole('tab', { name: '对象' }).click();
  await page.getByLabel('搜索对象').fill('fWorkshop');
  await page.getByRole('list', { name: '对象目录' }).getByRole('button', { name: /fWorkshop$/ }).click();
  await expect(finish(page)).toHaveCount(0);
  // A drawing tool ends adjusting.
  await adjustFromLayers(page);
  await page.getByTestId('map-canvas').focus();
  await page.keyboard.press('n');
  await expect(finish(page)).toHaveCount(0);
  await page.keyboard.press('v');
  // Locking the background type refuses adjusting and adding.
  await page.getByRole('button', { name: '锁定底图' }).click();
  await layer(page).getByRole('button', { name: '调整底图' }).click();
  await expect(page.getByRole('alert')).toContainText('底图图层已锁定');
  await expect(finish(page)).toHaveCount(0);
  // Adding is refused too, before anything is read or stored.
  await page.getByTestId('add-background-input').setInputFiles(image('another.png', quadrantPng(20, 10)));
  await expect(page.getByRole('alert')).toContainText('已锁定');
  await expect(page.locator('.background-layer')).toHaveCount(1);
  await page.getByRole('button', { name: '解锁底图' }).click();
  // Every change also writes a lineage source: with sources locked, adjusting is refused up front, not change by change.
  await page.getByRole('button', { name: '锁定来源' }).click();
  await layer(page).getByRole('button', { name: '调整底图' }).click();
  await expect(page.getByRole('alert')).toContainText('已锁定的图层（来源）');
  await expect(finish(page)).toHaveCount(0);
  await page.getByRole('button', { name: '解锁来源' }).click();
  // Hiding the background type hides every image and ends adjusting.
  await adjustFromLayers(page);
  await page.getByRole('row', { name: /底图/ }).getByRole('button', { name: '隐藏底图' }).click();
  await expect(finish(page)).toHaveCount(0);
  await expect.poll(() => colourAt(page, ...QUADRANT_POINTS.red)).toBe('none');
  // Adding while the type is hidden works, and says why adjusting did not start.
  await page.getByTestId('add-background-input').setInputFiles(image('hidden.png', quadrantPng(20, 10)));
  await expect(page.getByRole('status')).toContainText('暂不能调整');
  await expect(page.locator('.background-layer')).toHaveCount(2);
  await undoButton(page).click();
  await expect(page.locator('.background-layer')).toHaveCount(1);
  await page.getByRole('row', { name: /底图/ }).getByRole('button', { name: '显示底图' }).click();
  await layer(page).getByRole('button', { name: '适应底图' }).click();
  await expect.poll(() => colourAt(page, ...QUADRANT_POINTS.red)).toBe('red');
  // Delete while adjusting removes the layer, also with the focus still on the panel button; undo brings it back.
  await adjustFromLayers(page);
  await expect(layer(page).getByRole('button', { name: '调整底图' })).toBeFocused();
  await page.keyboard.press('Delete');
  await expect(page.locator('.background-layer')).toHaveCount(0);
  await page.keyboard.press('Control+z');
  await expect(page.locator('.background-layer')).toHaveCount(1);
  // Also with the focus in the inspector (on its「完成调整」button).
  await adjustFromLayers(page);
  await finish(page).focus();
  await page.keyboard.press('Delete');
  await expect(page.locator('.background-layer')).toHaveCount(0);
  await page.keyboard.press('Control+z');
  await expect(page.locator('.background-layer')).toHaveCount(1);
  // Opening another map ends adjusting.
  await adjustFromLayers(page);
  await page.getByTestId('open-file-input').setInputFiles(json('plain.map.json', EXAMPLE));
  await expect(page.getByText('没有底图。')).toBeVisible();
  await expect(finish(page)).toHaveCount(0);
  // On a read-only map adjusting is refused.
  await page.getByTestId('open-file-input').setInputFiles([json('readonly.map.json', readOnlyMap()), image('bg.png', png)]);
  await expect(layer(page).locator('.badge')).toHaveText('就绪');
  await layer(page).getByRole('button', { name: '调整底图' }).click();
  await expect(page.getByRole('alert')).toContainText('只读');
  await expect(finish(page)).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('an image read while another map opens, stored while an undo brings back its twin, or replacing a layer deleted meanwhile, is not used', async ({ page }) => {
  const errors = watchErrors(page);
  await openMap(page, [json('bg.map.json', backgroundMap()), image('bg.png', png)]);
  await page.getByRole('tab', { name: '图层' }).click();
  await expect(layer(page).locator('.badge')).toHaveText('就绪');
  // The read is held until another map has opened: nothing is added to either map.
  await page.evaluate(async bytes => {
    // The page's own module instances, as the dev server serves them.
    const edit = await import(/* @vite-ignore */ '/src/app/state/' + 'backgroundEdit.ts') as typeof BackgroundEdit;
    const data = new Uint8Array(bytes).buffer;
    const hold = window as unknown as Record<string, unknown>;
    const read = new Promise<ArrayBuffer>(resolve => { hold.release = () => resolve(data); });
    hold.adding = edit.addBackground([{ name: 'late.png', size: data.byteLength, read: () => read, text: async () => '' }]);
  }, [...quadrantPng(40, 30)]);
  await page.getByTestId('open-file-input').setInputFiles(json('plain.map.json', EXAMPLE));
  await expect(page.getByText('没有底图。')).toBeVisible();
  expect(await page.evaluate(() => { const hold = window as unknown as Record<string, () => void>; hold.release!(); return hold.adding as unknown as Promise<boolean>; })).toBe(false);
  await expect(page.getByRole('alert')).toContainText('打开了另一张地图');
  await expect(page.locator('.background-layer')).toHaveCount(0);

  // Deleted, added again while the bytes are being stored, and meanwhile the deletion undone: the image is not added twice.
  await openMap(page, [json('bg2.map.json', backgroundMap({ mapId: 'map_twin' })), image('bg.png', png)]);
  await page.getByRole('tab', { name: '图层' }).click();
  await expect(layer(page).locator('.badge')).toHaveText('就绪');
  await layer(page).getByRole('button', { name: '删除底图' }).click();
  await expect(page.locator('.background-layer')).toHaveCount(0);
  await page.evaluate(async bytes => {
    const edit = await import(/* @vite-ignore */ '/src/app/state/' + 'backgroundEdit.ts') as typeof BackgroundEdit;
    const project = await import(/* @vite-ignore */ '/src/app/state/' + 'project.ts') as typeof Project;
    const data = new Uint8Array(bytes).buffer, hold = window as unknown as Record<string, unknown>, target = project.projectStore;
    const put = target.putAssetBytes.bind(target);
    const released = new Promise<void>(resolve => { hold.release = resolve; });
    target.putAssetBytes = async (...args: Parameters<typeof put>) => { hold.storing = true; await released; target.putAssetBytes = put; return put(...args); };
    hold.adding = edit.addBackground([{ name: 'again.png', size: data.byteLength, read: async () => data, text: async () => '' }]);
  }, [...png]);
  await expect.poll(() => page.evaluate(() => (window as unknown as Record<string, unknown>).storing === true)).toBe(true);
  await undoButton(page).click();
  await expect(page.locator('.background-layer')).toHaveCount(1);
  expect(await page.evaluate(() => { const hold = window as unknown as Record<string, () => void>; hold.release!(); return hold.adding as unknown as Promise<boolean>; })).toBe(false);
  await expect(page.getByRole('alert')).toContainText('已是底图');
  await expect(page.locator('.background-layer')).toHaveCount(1);

  // A replacement whose layer is deleted while its bytes are being stored: refused with a message, no error thrown.
  await page.evaluate(async bytes => {
    const edit = await import(/* @vite-ignore */ '/src/app/state/' + 'backgroundEdit.ts') as typeof BackgroundEdit;
    const project = await import(/* @vite-ignore */ '/src/app/state/' + 'project.ts') as typeof Project;
    const data = new Uint8Array(bytes).buffer, hold = window as unknown as Record<string, unknown>, target = project.projectStore;
    const put = target.putAssetBytes.bind(target);
    const released = new Promise<void>(resolve => { hold.release = resolve; });
    hold.storing = false;
    target.putAssetBytes = async (...args: Parameters<typeof put>) => { hold.storing = true; await released; target.putAssetBytes = put; return put(...args); };
    hold.replacing = edit.replaceBackground('bgQuadrants', { name: 'sharper.png', size: data.byteLength, read: async () => data, text: async () => '' });
  }, [...quadrantPng(128, 96)]);
  await expect.poll(() => page.evaluate(() => (window as unknown as Record<string, unknown>).storing === true)).toBe(true);
  await layer(page).getByRole('button', { name: '删除底图' }).click();
  await expect(page.locator('.background-layer')).toHaveCount(0);
  expect(await page.evaluate(() => { const hold = window as unknown as Record<string, () => void>; hold.release!(); return hold.replacing as unknown as Promise<boolean>; })).toBe(false);
  await expect(page.getByRole('alert')).toContainText('已不在当前地图中');
  await undoButton(page).click();
  await expect(layer(page).locator('.badge')).toHaveText('就绪');
  expect(errors).toEqual([]);
});

test('an added image and its placement survive a reload', async ({ page }) => {
  const errors = watchErrors(page);
  await page.goto('/');
  await page.getByRole('button', { name: '新建地图…' }).click();
  await page.getByRole('button', { name: '创建地图' }).click();
  await page.getByTestId('add-background-input').setInputFiles(image('site.png', png));
  await expect(finish(page)).toBeVisible();
  await inspector(page).getByLabel('左上角 X', { exact: true }).fill('7');
  await inspector(page).getByLabel('左上角 X', { exact: true }).press('Enter');
  await expect(undoButton(page)).toHaveAttribute('title', /撤销：调整底图/);
  await expect(page.getByTestId('save-status')).toHaveText(/已自动保存|已保存/);
  await page.reload();
  await page.getByRole('tab', { name: '图层' }).click();
  await expect(layer(page, 'site.png').locator('.badge')).toHaveText('就绪');
  await layer(page, 'site.png').getByRole('button', { name: '适应底图' }).click();
  await expect.poll(() => colourAt(page, 7 + 16, 36)).toBe('red');
  await expect.poll(() => colourAt(page, 7 + 48, 12)).toBe('yellow');
  expect(errors).toEqual([]);
});
