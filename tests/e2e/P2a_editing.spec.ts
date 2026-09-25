import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const example = fileURLToPath(new URL('../../examples/M2A1_synthetic_service_targets.map.json', import.meta.url));
/** The synthetic example plus a free building at 20–50 × 60–80 m with no members, so it can move without dependencies. */
type MapJson = { facilities: Record<string, unknown>; extensionNamespaces: Record<string, unknown>; extensions: Record<string, unknown> };
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
  await page.getByTestId('open-file-input').setInputFiles({ name: 'edit.map.json', mimeType: 'application/json', buffer: Buffer.from(text) });
  await expect(page.getByTestId('map-canvas')).toHaveAttribute('data-scale', /\d/);
}
async function at(page: Page, x: number, y: number) {
  const canvas = page.getByTestId('map-canvas'), box = (await canvas.boundingBox())!;
  const [s, ox, oy] = await Promise.all(['data-scale', 'data-offset-x', 'data-offset-y'].map(async name => Number(await canvas.getAttribute(name))));
  return { x: box.x + ox! + x * s!, y: box.y + oy! - y * s! };
}
async function click(page: Page, x: number, y: number) { const p = await at(page, x, y); await page.mouse.click(p.x, p.y); }
async function drag(page: Page, from: [number, number], to: [number, number], steps = 100, keys: string[] = []) {
  const a = await at(page, ...from), b = await at(page, ...to);
  for (const key of keys) await page.keyboard.down(key);
  await page.mouse.move(a.x, a.y); await page.mouse.down(); await page.mouse.move(b.x, b.y, { steps }); await page.mouse.up();
  for (const key of keys) await page.keyboard.up(key);
}
const heading = (page: Page) => page.getByRole('region', { name: '属性' }).locator('.entity-heading');
const overview = (page: Page) => page.getByRole('region', { name: '属性' }).getByRole('heading', { name: '地图概览' });
const undoButton = (page: Page) => page.getByRole('toolbar', { name: '工具' }).getByRole('button', { name: '撤销' });
const buildings = (page: Page) => page.getByRole('list', { name: '对象目录' }).locator('.object-group').filter({ hasText: '建筑' }).first();

test('a 100-step drag moves a building in one undo step; ending where it started changes nothing', async ({ page }) => {
  const errors: string[] = []; await open(page, errors);
  await expect(undoButton(page)).toHaveAttribute('aria-disabled', 'true');
  await drag(page, [35, 70], [55, 70]);
  await expect(heading(page)).toContainText('空置厂房');
  await expect(undoButton(page)).toHaveAttribute('aria-disabled', 'false');
  await expect(undoButton(page)).toHaveAttribute('title', /撤销：移动 1 个对象/);
  // Now 40–70 m: its old left part is empty, its new right part is it.
  await click(page, 25, 70); await expect(overview(page)).toBeVisible();
  await click(page, 65, 70); await expect(heading(page)).toContainText('空置厂房');
  await page.keyboard.press('Control+z');
  await expect(undoButton(page)).toHaveAttribute('aria-disabled', 'true');
  await click(page, 25, 70); await expect(heading(page)).toContainText('空置厂房');
  // Out and back: no transaction.
  const a = await at(page, 35, 70), b = await at(page, 60, 70);
  await page.mouse.move(a.x, a.y); await page.mouse.down(); await page.mouse.move(b.x, b.y, { steps: 20 }); await page.mouse.move(a.x, a.y, { steps: 20 }); await page.mouse.up();
  await expect(undoButton(page)).toHaveAttribute('aria-disabled', 'true');
  expect(errors).toEqual([]);
});

// Found in the P2d gates: the shown objects were computed only when a frame was drawn, so a click after a map opened but before
// its first frame (a busy machine delays frames) hit nothing. With frames blocked outright, the click must still select.
test('a click before the first frame is drawn still selects what is there', async ({ page }) => {
  await page.addInitScript(() => { window.requestAnimationFrame = () => 0; });
  const errors: string[] = []; await open(page, errors);
  await click(page, 35, 70);
  await expect(heading(page)).toContainText('空置厂房');
  expect(errors).toEqual([]);
});

// While the camera moves, ordinary nodes are left out; once it settles they are shown and hit again.
test('after a zoom settles, details left out while zooming can be clicked again', async ({ page }) => {
  const errors: string[] = []; await open(page, errors);
  await page.getByRole('tab', { name: '图层' }).click();
  await page.getByLabel('显示普通节点').check();
  const node = await at(page, 100, 0), canvas = page.getByTestId('map-canvas'), before = await canvas.getAttribute('data-scale');
  await page.mouse.move(node.x, node.y); await page.mouse.wheel(0, -240);
  // The settled camera is written to the element; the node under the pointer stays under it.
  await expect(canvas).not.toHaveAttribute('data-scale', before!);
  await click(page, 100, 0);
  await expect(heading(page)).toContainText('节点');
  expect(errors).toEqual([]);
});

// What is shown (and hit) follows the camera and the canvas size, not only the map: a far building culled at one camera or
// one width is shown and hit at the next. (Review of the P2d renderer fix: neither condition had a test.)
const farBuilding = (map: MapJson) => {
  map.facilities.fFar = { name: '远处厂房', kind: 'workshop', boundary: { outer: [[300, 300, 0], [340, 300, 0], [340, 330, 0], [300, 330, 0], [300, 300, 0]], holes: [] },
    accessPointIds: [], servicePointIds: [], heightM: { state: 'unknown' }, provenance: { category: 'synthetic' } };
};
const nextFrame = (page: Page) => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
test('after the camera jumps (fit to map), a building culled before is shown and hit', async ({ page }) => {
  const errors: string[] = []; await open(page, errors, mapJson(farBuilding));
  for (let i = 0; i < 6; i++) await page.getByRole('button', { name: '放大（=）' }).click();
  // Locate the main road: the view is centred there, the far building is off screen and left out.
  await page.getByLabel('搜索对象').fill('rMain');
  await page.getByRole('list', { name: '对象目录' }).locator('.object-row .object-main').first().click();
  await page.getByLabel('搜索对象').fill('');
  await nextFrame(page);
  const canvas = page.getByTestId('map-canvas'), before = await canvas.getAttribute('data-scale');
  await canvas.focus(); await page.keyboard.press('f');
  await expect(canvas).not.toHaveAttribute('data-scale', before!);
  await click(page, 320, 315);
  await expect(heading(page)).toContainText('远处厂房');
  expect(errors).toEqual([]);
});

test('after the canvas widens, a building culled beyond its old edge is shown and hit', async ({ page }) => {
  const errors: string[] = []; await open(page, errors, mapJson(farBuilding));
  for (let i = 0; i < 3; i++) await page.getByRole('button', { name: '放大（=）' }).click();
  const canvas = page.getByTestId('map-canvas');
  const camera = async () => Promise.all(['data-scale', 'data-offset-x', 'data-offset-y'].map(async name => Number(await canvas.getAttribute(name))));
  // Pan with the middle button until the building starts 150 px beyond the right edge (well past the 120 px margin).
  let box = (await canvas.boundingBox())!, [s, ox, oy] = await camera();
  const dx = box.width + 150 - (ox! + 300 * s!), dy = box.height / 2 - (oy! - 315 * s!);
  const start = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await page.mouse.move(start.x, start.y); await page.mouse.down({ button: 'middle' });
  await page.mouse.move(start.x + dx, start.y + dy, { steps: 10 }); await page.mouse.up({ button: 'middle' });
  await expect.poll(async () => Math.round(Number(await canvas.getAttribute('data-offset-x')) - ox!)).toBe(Math.round(dx));
  await nextFrame(page);
  // Collapsing the inspector widens the canvas; the camera stays.
  await page.getByRole('button', { name: '收起属性栏' }).click();
  await expect.poll(async () => (await canvas.boundingBox())!.width).toBeGreaterThan(box.width + 200);
  box = (await canvas.boundingBox())!; [s, ox, oy] = await camera();
  expect(ox! + 320 * s!).toBeLessThan(box.width);
  await page.mouse.click(box.x + ox! + 320 * s!, box.y + oy! - 315 * s!);
  await expect(page.getByText(/已选 1/).first()).toBeVisible();
  expect(errors).toEqual([]);
});

test('Escape during a move puts everything back without a transaction', async ({ page }) => {
  const errors: string[] = []; await open(page, errors);
  const a = await at(page, 35, 70), b = await at(page, 70, 70);
  await page.mouse.move(a.x, a.y); await page.mouse.down(); await page.mouse.move(b.x, b.y, { steps: 10 });
  await page.keyboard.press('Escape'); await page.mouse.up();
  await expect(undoButton(page)).toHaveAttribute('aria-disabled', 'true');
  await click(page, 25, 70); await expect(heading(page)).toContainText('空置厂房');
  expect(errors).toEqual([]);
});

test('shortcuts wait while a drag runs', async ({ page }) => {
  const errors: string[] = []; await open(page, errors);
  await click(page, 35, 70); await page.keyboard.press('Shift+ArrowUp');
  const a = await at(page, 35, 71), b = await at(page, 55, 71);
  await page.mouse.move(a.x, a.y); await page.mouse.down(); await page.mouse.move(b.x, b.y, { steps: 10 });
  // Neither undo nor nudges may change the map under the preview: had they run, the nudge up would be undone and
  // five nudges down added, leaving the building 6 m lower than dropped.
  await page.keyboard.press('Control+z');
  for (let i = 0; i < 5; i++) await page.keyboard.press('Shift+ArrowDown');
  await page.mouse.up();
  await expect(undoButton(page)).toHaveAttribute('title', /撤销：移动 1 个对象/);
  // Nudged to 61–81, dragged 20 m right: 40–70 × 61–81 (not 55–75).
  await click(page, 45, 78); await expect(heading(page)).toContainText('空置厂房');
  await click(page, 45, 58); await expect(overview(page)).toBeVisible();
  await page.keyboard.press('Control+z'); await page.keyboard.press('Control+z');
  await expect(undoButton(page)).toHaveAttribute('aria-disabled', 'true');
  await click(page, 25, 70); await expect(heading(page)).toContainText('空置厂房');
  expect(errors).toEqual([]);
});

test('arrow keys nudge the selection; a run of nudges is one undo step', async ({ page }) => {
  const errors: string[] = []; await open(page, errors);
  await click(page, 35, 70); await expect(heading(page)).toContainText('空置厂房');
  for (let i = 0; i < 10; i++) await page.keyboard.press('Shift+ArrowRight');
  // 10 × 1 m: now 30–60 m.
  await click(page, 55, 70); await expect(heading(page)).toContainText('空置厂房');
  await click(page, 25, 70); await expect(overview(page)).toBeVisible();
  await click(page, 55, 70); await page.keyboard.press('Control+z');
  await expect(undoButton(page)).toHaveAttribute('aria-disabled', 'true');
  await click(page, 25, 70); await expect(heading(page)).toContainText('空置厂房');
  expect(errors).toEqual([]);
});

test('Alt+drag copies at the drop place; Ctrl+D copies 10 m away and selects the copy', async ({ page }) => {
  const errors: string[] = []; await open(page, errors);
  await expect(buildings(page)).toContainText('2');
  await drag(page, [35, 70], [85, 70], 20, ['Alt']);
  await expect(buildings(page)).toContainText('3');
  await click(page, 25, 70); await expect(heading(page)).toContainText('空置厂房');
  await click(page, 85, 70); await expect(heading(page)).toContainText('空置厂房');
  await page.keyboard.press('Control+d');
  await expect(buildings(page)).toContainText('4');
  await expect(undoButton(page)).toHaveAttribute('title', /撤销：复制 1 个对象/);
  expect(errors).toEqual([]);
});

test('delete previews what goes and waits until dependencies are allowed', async ({ page }) => {
  const errors: string[] = []; await open(page, errors);
  await click(page, 30, 22); await expect(heading(page)).toContainText('合成厂房');
  await page.keyboard.press('Delete');
  const dialog = page.getByRole('dialog', { name: '删除选中对象' });
  // Focus starts on Cancel, so Enter never deletes by accident, and Escape closes.
  await expect(dialog.getByRole('button', { name: '取消' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await page.keyboard.press('Delete');
  await expect(dialog.getByRole('button', { name: '删除', exact: true })).toBeDisabled();
  await expect(dialog.getByRole('alert')).toContainText('关联点');
  await dialog.getByLabel('建筑与区域的成员入口和作业点').check();
  await dialog.getByLabel('关联的道路、转向和因此变空的路口（资源容量保留）').check();
  await expect(dialog.getByRole('button', { name: '删除', exact: true })).toBeEnabled();
  await expect(dialog.getByLabel('影响')).toContainText('入口 1');
  await dialog.getByRole('button', { name: '删除', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(buildings(page)).toContainText('1');
  await page.keyboard.press('Control+z');
  await expect(buildings(page)).toContainText('2');
  expect(errors).toEqual([]);
});

test('a move the kernel refuses says why at once and changes nothing', async ({ page }) => {
  const errors: string[] = []; await open(page, errors);
  await drag(page, [30, 22], [45, 22], 10);
  await expect(page.getByRole('alert')).toContainText('不能移动');
  await expect(undoButton(page)).toHaveAttribute('aria-disabled', 'true');
  expect(errors).toEqual([]);
});

test('locked layers and read-only maps refuse edits', async ({ page }) => {
  const errors: string[] = []; await open(page, errors);
  await page.getByRole('tab', { name: '图层' }).click();
  await page.getByRole('button', { name: '锁定建筑' }).click();
  await drag(page, [35, 70], [55, 70], 10);
  await expect(page.getByRole('alert')).toContainText('锁定');
  await expect(undoButton(page)).toHaveAttribute('aria-disabled', 'true');
  // A zone drag stretches the road to it: locked roads refuse at the press, before any preview.
  await page.getByRole('button', { name: '锁定道路' }).click();
  const zone = await at(page, 80, 40), below = await at(page, 80, 45);
  await page.mouse.move(zone.x, zone.y); await page.mouse.down(); await page.mouse.move(below.x, below.y, { steps: 10 });
  await expect(page.getByRole('alert')).toContainText('锁定的图层（道路');
  await page.mouse.up();
  await expect(undoButton(page)).toHaveAttribute('aria-disabled', 'true');
  await page.getByRole('button', { name: '解锁道路' }).click();
  await page.getByTestId('open-file-input').setInputFiles({ name: 'ro.map.json', mimeType: 'application/json', buffer: Buffer.from(mapJson(map => {
    map.extensionNamespaces['test.future_behavior'] = { version: '1', category: 'behavior' };
    map.extensions['test.future_behavior'] = { controller: 'unsupported' };
  })) });
  // Since P4a each map is a browser project with its own display settings: the new map starts unlocked.
  await expect(page.getByRole('button', { name: '锁定建筑' })).toBeVisible();
  await click(page, 35, 70); await expect(heading(page)).toContainText('空置厂房');
  await page.keyboard.press('Control+d');
  await expect(page.getByRole('alert')).toContainText('只读');
  expect(errors).toEqual([]);
});

test('rotate turns the selection about the centre of its bounds', async ({ page }) => {
  const errors: string[] = []; await open(page, errors);
  await click(page, 35, 70);
  await expect(page.getByRole('region', { name: '属性' })).toContainText('30 × 20 m');
  await page.keyboard.press('Control+k');
  await page.getByLabel('搜索命令或对象').fill('旋转');
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: '旋转选中对象' });
  await expect(dialog.getByLabel('旋转中心 X（m）')).toHaveValue('35.00');
  await dialog.getByRole('button', { name: '旋转' }).click();
  await expect(page.getByRole('region', { name: '属性' })).toContainText('20 × 30 m');
  expect(errors).toEqual([]);
});

// ../map DP07–DP10, as behaviour: zooming mid-drag keeps one commit, and hit tests use the camera the user sees at once.
test('zooming during a drag keeps one transaction and drops the object under the pointer', async ({ page }) => {
  const errors: string[] = []; await open(page, errors);
  const a = await at(page, 35, 70), mid = await at(page, 45, 70);
  await page.mouse.move(a.x, a.y); await page.mouse.down(); await page.mouse.move(mid.x, mid.y, { steps: 10 });
  await page.mouse.wheel(0, -240);
  await expect.poll(async () => Number(await page.getByTestId('map-canvas').getAttribute('data-scale'))).toBeGreaterThan(0);
  await page.waitForTimeout(300);
  const b = await at(page, 60, 70);
  await page.mouse.move(b.x, b.y, { steps: 10 }); await page.mouse.up();
  // The press was 15 m inside the building's left edge; released at x = 60 it spans 45–75.
  await click(page, 72, 70); await expect(heading(page)).toContainText('空置厂房');
  await page.keyboard.press('Control+z');
  await expect(undoButton(page)).toHaveAttribute('aria-disabled', 'true');
  expect(errors).toEqual([]);
});

test('a click right after zooming selects what is under the pointer', async ({ page }) => {
  const errors: string[] = []; await open(page, errors);
  const p = await at(page, 35, 70);
  await page.mouse.move(p.x, p.y);
  for (let i = 0; i < 3; i++) await page.mouse.wheel(0, -120);
  // No wait for the camera to settle: the wheel keeps the world point under the pointer.
  await page.mouse.click(p.x, p.y);
  await expect(heading(page)).toContainText('空置厂房');
  expect(errors).toEqual([]);
});

// Leaving with edits not yet stored: see P4a_projects (edits are saved automatically since P4a).
