import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type * as Store from '../../src/app/state/store';

const example = fileURLToPath(new URL('../../examples/M2A1_synthetic_service_targets.map.json', import.meta.url));
/** The synthetic example plus a free building at 20–50 × 60–80 m with no entrances or service points and no road near it,
 *  so the kernel accepts outline changes (an entrance left off the outline or an overlapping road band would be refused). */
type MapJson = { facilities: Record<string, unknown>; extensionNamespaces: Record<string, unknown>; extensions: Record<string, unknown>; nodes: Record<string, unknown>; servicePoints: Record<string, unknown> };
const exampleJson = JSON.parse(readFileSync(example, 'utf8')) as { zones: Record<string, { name: string }>; servicePoints: Record<string, { name: string }> };
function mapJson(change: (map: MapJson) => void = () => {}): string {
  const map = JSON.parse(readFileSync(example, 'utf8')) as MapJson;
  map.facilities.fFree = {
    name: '空置厂房', kind: 'workshop', boundary: { outer: [[20, 60, 0], [50, 60, 0], [50, 80, 0], [20, 80, 0], [20, 60, 0]], holes: [] },
    accessPointIds: [], servicePointIds: [], heightM: { state: 'unknown' }, provenance: { category: 'synthetic' },
  };
  change(map);
  return JSON.stringify(map);
}
async function open(page: Page, errors: string[], text = mapJson()) {
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await page.getByTestId('open-file-input').setInputFiles({ name: 'handles.map.json', mimeType: 'application/json', buffer: Buffer.from(text) });
  await expect(page.getByTestId('map-canvas')).toHaveAttribute('data-scale', /\d/);
}
const scale = async (page: Page) => Number(await page.getByTestId('map-canvas').getAttribute('data-scale'));
async function at(page: Page, x: number, y: number) {
  const canvas = page.getByTestId('map-canvas'), box = (await canvas.boundingBox())!;
  const [s, ox, oy] = await Promise.all(['data-scale', 'data-offset-x', 'data-offset-y'].map(async name => Number(await canvas.getAttribute(name))));
  return { x: box.x + ox! + x * s!, y: box.y + oy! - y * s! };
}
/** page.mouse.click has no modifiers option: held keys go through the keyboard. */
async function click(page: Page, x: number, y: number, keys: string[] = []) {
  const p = await at(page, x, y);
  for (const key of keys) await page.keyboard.down(key);
  await page.mouse.click(p.x, p.y);
  for (const key of keys) await page.keyboard.up(key);
}
async function drag(page: Page, from: [number, number], to: [number, number], steps = 50) {
  const a = await at(page, ...from), b = await at(page, ...to);
  await page.mouse.move(a.x, a.y); await page.mouse.down(); await page.mouse.move(b.x, b.y, { steps }); await page.mouse.up();
}
const inspector = (page: Page) => page.getByRole('region', { name: '属性' });
const field = (page: Page, label: string) => inspector(page).locator('.field').filter({ hasText: new RegExp('^' + label) });
const heading = (page: Page) => inspector(page).locator('.entity-heading');
const undoButton = (page: Page) => page.getByRole('toolbar', { name: '工具' }).getByRole('button', { name: '撤销' });
const outline = (page: Page) => page.getByRole('region', { name: '轮廓编辑' });
const handles = (page: Page, count: number) => expect(page.getByTestId('map-canvas')).toHaveAttribute('data-handles', String(count));
async function upgrade(page: Page, key: string) {
  await page.keyboard.press(key);
  const dialog = page.getByRole('dialog', { name: '升级地图格式' });
  await dialog.getByRole('button', { name: '升级并继续' }).click();
  await expect(dialog).toHaveCount(0);
}

test('a rectangle corner resizes with the opposite corner fixed, in one undo step; Escape cancels', async ({ page }) => {
  const errors: string[] = []; await open(page, errors);
  await click(page, 35, 70); await expect(heading(page)).toContainText('空置厂房');
  await expect(outline(page).getByRole('radio', { name: '矩形约束' })).toHaveAttribute('aria-checked', 'true');
  // Four corners and the four edge midpoints.
  await handles(page, 8);
  await expect(field(page, '外包尺寸')).toContainText('30 × 20 m');
  // Pressing the corner of a selected building resizes it instead of moving it.
  await drag(page, [50, 80], [60, 90]);
  await expect(field(page, '外包尺寸')).toContainText('40 × 30 m');
  await expect(undoButton(page)).toHaveAttribute('title', /撤销：修改建筑轮廓/);
  // The corner at (20, 60) stayed: both its neighbourhood and the new far corner are the building.
  await click(page, 21, 61); await expect(heading(page)).toContainText('空置厂房');
  await click(page, 58, 88); await expect(heading(page)).toContainText('空置厂房');
  await page.keyboard.press('Control+z');
  await expect(field(page, '外包尺寸')).toContainText('30 × 20 m');
  await expect(undoButton(page)).toHaveAttribute('aria-disabled', 'true');
  // Escape mid-drag: nothing changes.
  const a = await at(page, 50, 80), b = await at(page, 65, 95);
  await page.mouse.move(a.x, a.y); await page.mouse.down(); await page.mouse.move(b.x, b.y, { steps: 10 });
  await page.keyboard.press('Escape'); await page.mouse.up();
  await expect(field(page, '外包尺寸')).toContainText('30 × 20 m');
  await expect(undoButton(page)).toHaveAttribute('aria-disabled', 'true');
  await expect(heading(page)).toContainText('空置厂房');
  // The handles are back (the listener once kept the first render's empty target and dropped them).
  await handles(page, 8);
  // Shift+click on a handle is still a selection click: it takes the building out of the selection.
  await click(page, 50, 80, ['Shift']);
  await expect(inspector(page).getByRole('heading', { name: '地图概览' })).toBeVisible();
  expect(errors).toEqual([]);
});

// ../map DP10: after a wheel zoom the handle uses the new camera; the grab offset is kept in metres.
test('zooming during a handle drag keeps the corner under the pointer', async ({ page }) => {
  const errors: string[] = []; await open(page, errors);
  await click(page, 35, 70);
  const a = await at(page, 50, 80), mid = await at(page, 55, 85);
  await page.mouse.move(a.x, a.y); await page.mouse.down(); await page.mouse.move(mid.x, mid.y, { steps: 10 });
  await page.mouse.wheel(0, -240);
  await page.waitForTimeout(300);
  const b = await at(page, 60, 90);
  await page.mouse.move(b.x, b.y, { steps: 10 }); await page.mouse.up();
  await expect(field(page, '外包尺寸')).toContainText('40 × 30 m');
  await page.keyboard.press('Control+z');
  await expect(undoButton(page)).toHaveAttribute('aria-disabled', 'true');
  expect(errors).toEqual([]);
});

test('an object too small on screen shows no handles', async ({ page }) => {
  const errors: string[] = []; await open(page, errors);
  await click(page, 35, 70); await handles(page, 8);
  const p = await at(page, 35, 70);
  await page.mouse.move(p.x, p.y);
  for (let i = 0; i < 4; i++) await page.mouse.wheel(0, 600);
  await handles(page, 0);
  await expect(heading(page)).toContainText('空置厂房');
  expect(errors).toEqual([]);
});

test('a rectangle takes a new vertex from an edge midpoint and becomes a free polygon, in one undo step', async ({ page }) => {
  const errors: string[] = []; await open(page, errors);
  await click(page, 35, 70);
  await expect(outline(page).getByRole('radio', { name: '矩形约束' })).toHaveAttribute('aria-checked', 'true');
  await expect(outline(page)).toContainText('拖动边中点插入顶点');
  // Bottom edge midpoint dragged down 5 m: 600 + 30 × 5 / 2.
  await drag(page, [35, 60], [35, 55]);
  await expect(field(page, '净面积')).toContainText('675');
  await expect(undoButton(page)).toHaveAttribute('title', /撤销：插入顶点（矩形改为多边形）/);
  // No longer a rectangle: five vertices and five midpoints, free editing only.
  await expect(outline(page).getByRole('radio')).toHaveCount(0);
  await handles(page, 10);
  await page.keyboard.press('Control+z');
  await expect(field(page, '净面积')).toContainText('600');
  await handles(page, 8);
  // A click (no drag) inserts the vertex exactly at the midpoint: the outline and area stay, so a moved edge cannot overlap a
  // road or leave an entrance off the outline; the vertex can be dragged afterwards.
  // Alt+click there cycles the selection and Shift+click toggles it, as elsewhere: neither inserts.
  await click(page, 35, 60, ['Alt']);
  await expect(undoButton(page)).toHaveAttribute('aria-disabled', 'true');
  await click(page, 35, 70); await expect(heading(page)).toContainText('空置厂房');
  await click(page, 35, 60, ['Shift']);
  await expect(inspector(page).getByRole('heading', { name: '地图概览' })).toBeVisible();
  await click(page, 35, 70); await expect(heading(page)).toContainText('空置厂房');
  await click(page, 35, 60);
  await expect(page.getByRole('status')).toContainText('已在边的中点插入顶点，矩形改为自由多边形');
  await expect(undoButton(page)).toHaveAttribute('title', /撤销：插入顶点（矩形改为多边形）/);
  await expect(field(page, '净面积')).toContainText('600');
  await handles(page, 10);
  expect(errors).toEqual([]);
});

test('an edge midpoint or corner yields to a point marker on it; a thin shape offers no midpoints, so a press in its middle moves it', async ({ page }) => {
  const errors: string[] = []; await open(page, errors, mapJson(map => {
    map.facilities.fThin = { name: '细长棚', kind: 'workshop', boundary: { outer: [[20, 90, 0], [80, 90, 0], [80, 91, 0], [20, 91, 0], [20, 90, 0]], holes: [] },
      accessPointIds: [], servicePointIds: [], heightM: { state: 'unknown' }, provenance: { category: 'synthetic' } };
    // An entrance at the free building's corner (50, 60).
    (map.facilities.fFree as { accessPointIds: string[] }).accessPointIds = ['aCorner'];
    map.nodes.nCorner = { name: '角门节点', position: [50, 60, 0], kind: 'access', provenance: { category: 'synthetic' } };
    (map as unknown as { accessPoints: Record<string, unknown> }).accessPoints.aCorner = { name: '角门', facilityId: 'fFree', nodeId: 'nCorner', provenance: { category: 'synthetic' } };
    // A service point 1 m inside the corner (20, 80).
    (map.facilities.fFree as { servicePointIds: string[] }).servicePointIds = ['sCorner'];
    map.nodes.nInside = { name: '角内节点', position: [21, 79, 0], kind: 'service', provenance: { category: 'synthetic' } };
    map.servicePoints.sCorner = { name: '角内作业点', kind: 'other', nodeId: 'nInside', facilityId: 'fFree', resourceIds: [], provenance: { category: 'synthetic' } };
  }));
  // The building's corner handle lies under its entrance: the click selects the entrance, the outline is unchanged.
  await click(page, 35, 70); await expect(heading(page)).toContainText('空置厂房');
  await click(page, 50, 60); await expect(heading(page)).toContainText('角门');
  await expect(undoButton(page)).toHaveAttribute('aria-disabled', 'true');
  // A service point 1 m inside the opposite corner (20, 80) is within its reach, but the corner is nearer the press: it resizes.
  await click(page, 35, 70); await expect(heading(page)).toContainText('空置厂房');
  await drag(page, [20, 80], [15, 85]);
  await expect(undoButton(page)).toHaveAttribute('title', /撤销：修改建筑轮廓/);
  await expect(field(page, '外包尺寸')).toContainText('35 × 25 m');
  await page.keyboard.press('Control+z');
  // The waiting zone (70–90 × 30–50) has its unloading point in the middle of its bottom edge (80, 30).
  await click(page, 80, 40); await expect(heading(page)).toContainText(exampleJson.zones.zWaiting!.name);
  await handles(page, 8);
  await click(page, 80, 30); await expect(heading(page)).toContainText(exampleJson.servicePoints.sZoneUnload!.name);
  await expect(undoButton(page)).toHaveAttribute('aria-disabled', 'true');
  // A zone takes a vertex like a building.
  await click(page, 80, 40); await click(page, 70, 40);
  await expect(undoButton(page)).toHaveAttribute('title', /撤销：插入顶点（矩形改为多边形）/);
  await page.keyboard.press('Control+z');
  // 1 m thick: its edge midpoints are closer than 17 px to the opposite edge, so only the corners are offered.
  expect(await scale(page)).toBeLessThan(17);
  await click(page, 50, 90.5); await expect(heading(page)).toContainText('细长棚');
  await handles(page, 4);
  await drag(page, [50, 90.5], [50, 95.5]);
  await expect(undoButton(page)).toHaveAttribute('title', /撤销：移动/);
  await page.keyboard.press('Control+z');
  // At 14 px per metre (14 px thick) a press in the middle would still reach a long-edge midpoint (7 px): none is offered.
  await page.evaluate(async () => {
    const { store } = await import(/* @vite-ignore */ '/src/app/state/' + 'store.ts') as typeof Store;
    const host = document.querySelector<HTMLElement>('[data-testid=map-canvas]')!;
    store.set({ frameRequest: { camera: { scale: 14, offsetX: host.clientWidth / 2 - 50 * 14, offsetY: host.clientHeight / 2 + 90.5 * 14 } } });
  });
  await expect(page.getByTestId('map-canvas')).toHaveAttribute('data-scale', '14');
  await handles(page, 4);
  await drag(page, [50, 90.5], [50, 93]);
  await expect(undoButton(page)).toHaveAttribute('title', /撤销：移动/);
  expect(errors).toEqual([]);
});

test('when the kernel refuses a vertex inserted on an object with an existing problem, it says why and nothing changes', async ({ page }) => {
  // The free building's service point lies outside it and declares an explicit internal route (as two buildings of the
  // Geoje map do): every outline change of that building is re-checked and refused (SPATIAL_SERVICE_OUTSIDE_OWNER).
  const errors: string[] = []; await open(page, errors, mapJson(map => {
    (map.facilities.fFree as { servicePointIds: string[] }).servicePointIds = ['sOut'];
    map.nodes.nOut = { name: '棚外节点', position: [35, 95, 0], kind: 'service', provenance: { category: 'synthetic' } };
    map.servicePoints.sOut = { name: '棚外作业点', kind: 'other', nodeId: 'nOut', facilityId: 'fFree', resourceIds: [], arrival: { mode: 'explicit_internal', internalPath: [] }, provenance: { category: 'synthetic' } };
  }));
  await click(page, 35, 70); await expect(heading(page)).toContainText('空置厂房');
  await click(page, 35, 60);
  await expect(page.getByRole('alert')).toContainText('服务节点位于声明 owner 面外');
  await expect(undoButton(page)).toHaveAttribute('aria-disabled', 'true');
  await handles(page, 8);
  expect(errors).toEqual([]);
});

test('free outline editing moves, inserts and Alt-deletes vertices', async ({ page }) => {
  const errors: string[] = []; await open(page, errors);
  await click(page, 35, 70);
  await outline(page).getByRole('radio', { name: '自由多边形' }).click();
  await expect(outline(page)).toContainText('Alt+点击顶点删除');
  await handles(page, 8);
  await expect(field(page, '净面积')).toContainText('600');
  // A trapezoid: (30 + 35) / 2 × 20.
  await drag(page, [50, 80], [55, 80]);
  await expect(field(page, '净面积')).toContainText('650');
  // No longer a rectangle: only free editing is offered.
  await expect(outline(page).getByRole('radio')).toHaveCount(0);
  // Dragging the bottom edge midpoint inserts a vertex: + 30 × 5 / 2.
  await drag(page, [35, 60], [35, 55]);
  await expect(field(page, '净面积')).toContainText('725');
  await handles(page, 10);
  // A cancelled insert (Escape, or the window losing focus) leaves the handles as they were: no extra vertex, no leftover preview.
  for (const cancel of ['escape', 'blur'] as const) {
    const m = await at(page, 20, 70), out = await at(page, 14, 70);
    await page.mouse.move(m.x, m.y); await page.mouse.down(); await page.mouse.move(out.x, out.y, { steps: 5 });
    await handles(page, 12);
    if (cancel === 'escape') await page.keyboard.press('Escape'); else await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    await page.mouse.up();
    await handles(page, 10);
    await expect(field(page, '净面积')).toContainText('725');
  }
  await click(page, 35, 55, ['Alt']);
  await expect(field(page, '净面积')).toContainText('650');
  await expect(heading(page)).toContainText('空置厂房');
  for (let i = 0; i < 3; i++) await page.keyboard.press('Control+z');
  await expect(field(page, '净面积')).toContainText('600');
  await expect(undoButton(page)).toHaveAttribute('aria-disabled', 'true');
  expect(errors).toEqual([]);
});

test('road handles: width is a manual image estimate, anchors move, a bend makes a curve, a double-click straightens it', async ({ page }) => {
  const errors: string[] = []; await open(page, errors);
  await upgrade(page, 'r');
  await click(page, 65, 58); await click(page, 85, 58); await click(page, 85, 70);
  await page.keyboard.press('Enter');
  await page.keyboard.press('v');
  await expect(heading(page)).toContainText('道路');
  // The width is an editable field since P2d: its value is in the input.
  const width = inspector(page).getByLabel('宽度', { exact: true });
  await expect(width).toHaveValue('12');
  await expect(field(page, '几何')).toContainText('折线 · 内部锚点 1 个');
  // The two ends (P3f2), one anchor, a bend per span, two width handles; a straight span has no tangents.
  await handles(page, 7);
  // The width handle sits beside the road at half its length (16 m along: x = 81), just outside the band.
  const outset = Math.max(0, 16 / await scale(page) - 6);
  await drag(page, [81, 64 + outset], [81, 67 + outset]);
  await expect(width).toHaveValue('18');
  await expect(inspector(page).getByLabel('宽度依据').locator('option:checked')).toHaveText('依据：人工影像宽度估计');
  await expect(undoButton(page)).toHaveAttribute('title', /撤销：修改道路宽度/);
  await page.keyboard.press('Control+z');
  await expect(width).toHaveValue('12');
  // The interior anchor.
  await drag(page, [85, 58], [88, 61]);
  await expect(field(page, '长度（派生）')).toContainText((Math.hypot(23, 3) + Math.hypot(3, 9)).toFixed(2));
  await expect(undoButton(page)).toHaveAttribute('title', /撤销：修改道路形状/);
  // The bend handle of the first span sits at its middle.
  await drag(page, [76.5, 59.5], [76.5, 64]);
  await expect(field(page, '几何')).toContainText('含曲线段 · 内部锚点 1 个');
  await handles(page, 9);
  const bend = await at(page, 76.5, 64); await page.mouse.dblclick(bend.x, bend.y);
  await expect(field(page, '几何')).toContainText('折线 · 内部锚点 1 个');
  await expect(heading(page)).toContainText('道路');
  expect(errors).toEqual([]);
});

test('locked layers and read-only maps show no handles; a press there does not resize', async ({ page }) => {
  const errors: string[] = []; await open(page, errors);
  await click(page, 35, 70); await expect(outline(page)).toBeVisible(); await handles(page, 8);
  await page.getByRole('tab', { name: '图层' }).click();
  await page.getByRole('button', { name: '锁定建筑' }).click();
  await expect(outline(page)).toHaveCount(0); await handles(page, 0);
  await drag(page, [50, 80], [60, 90], 10);
  await expect(page.getByRole('alert')).toContainText('锁定');
  await expect(field(page, '外包尺寸')).toContainText('30 × 20 m');
  await expect(undoButton(page)).toHaveAttribute('aria-disabled', 'true');
  await page.getByRole('button', { name: '解锁建筑' }).click();
  await page.getByTestId('open-file-input').setInputFiles({ name: 'ro.map.json', mimeType: 'application/json', buffer: Buffer.from(mapJson(map => {
    map.extensionNamespaces['test.future_behavior'] = { version: '1', category: 'behavior' };
    map.extensions['test.future_behavior'] = { controller: 'unsupported' };
  })) });
  await click(page, 35, 70); await expect(heading(page)).toContainText('空置厂房');
  await expect(outline(page)).toHaveCount(0); await handles(page, 0);
  await drag(page, [50, 80], [60, 90], 10);
  await expect(field(page, '外包尺寸')).toContainText('30 × 20 m');
  expect(errors).toEqual([]);
});
