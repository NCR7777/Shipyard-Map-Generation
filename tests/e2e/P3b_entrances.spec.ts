import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type * as Store from '../../src/app/state/store';
import type { YardMap } from '../../src/domain/model';

const example = fileURLToPath(new URL('../../examples/M2A1_synthetic_service_targets.map.json', import.meta.url));
/** The synthetic example (format 0.2.0): a workshop at 0–60 × 0–30 m with one entrance at its corner (0, 0) on a road node
 *  where two public roads end, plus a free building 20–50 × 60–80 m with no entrance, a road ending on its right wall and a
 *  public junction (two roads) on its left wall. */
type MapJson = { facilities: Record<string, { name: string } & Record<string, unknown>> };
const base = JSON.parse(readFileSync(example, 'utf8')) as MapJson;
const workshop = base.facilities.fWorkshop!.name;
function mapJson(): string {
  const map = JSON.parse(readFileSync(example, 'utf8')) as MapJson & { nodes: Record<string, unknown>; accessPoints: Record<string, unknown>; roads: Record<string, unknown> };
  // A research access point 5 m outside the workshop, on its own node; a road ending on the free building's right wall.
  map.nodes.nOut = { name: '研究接入节点', position: [30, 35, 0], kind: 'access', provenance: { category: 'design_assumption' } };
  map.accessPoints.aOut = { name: '研究接入', facilityId: 'fWorkshop', nodeId: 'nOut', provenance: { category: 'design_assumption' } };
  (map.facilities.fWorkshop as unknown as { accessPointIds: string[] }).accessPointIds.push('aOut');
  map.nodes.nGate = { name: '门口路端', position: [50, 70, 0], kind: 'ordinary', provenance: { category: 'synthetic' } };
  map.nodes.nEast = { name: '东路端', position: [70, 70, 0], kind: 'ordinary', provenance: { category: 'synthetic' } };
  map.roads.rGate = { ...(map.roads.rMain as object), name: '门口路', fromNodeId: 'nEast', toNodeId: 'nGate', shapePoints: [] };
  map.nodes.nJunction = { name: '西路口', position: [20, 70, 0], kind: 'ordinary', provenance: { category: 'synthetic' } };
  map.nodes.nWest1 = { name: '西一', position: [5, 70, 0], kind: 'ordinary', provenance: { category: 'synthetic' } };
  map.nodes.nWest2 = { name: '西二', position: [5, 76, 0], kind: 'ordinary', provenance: { category: 'synthetic' } };
  map.roads.rWest1 = { ...(map.roads.rMain as object), name: '西路一', fromNodeId: 'nJunction', toNodeId: 'nWest1', shapePoints: [] };
  map.roads.rWest2 = { ...(map.roads.rMain as object), name: '西路二', fromNodeId: 'nJunction', toNodeId: 'nWest2', shapePoints: [] };
  map.facilities.fFree = {
    name: '空置厂房', kind: 'workshop', boundary: { outer: [[20, 60, 0], [50, 60, 0], [50, 80, 0], [20, 80, 0], [20, 60, 0]], holes: [] },
    accessPointIds: [], servicePointIds: [], heightM: { state: 'unknown' }, provenance: { category: 'synthetic' },
  };
  return JSON.stringify(map);
}
async function open(page: Page, errors: string[]) {
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await page.getByTestId('open-file-input').setInputFiles({ name: 'entrances.map.json', mimeType: 'application/json', buffer: Buffer.from(mapJson()) });
  await expect(page.getByTestId('map-canvas')).toHaveAttribute('data-scale', /\d/);
}
async function at(page: Page, x: number, y: number) {
  const canvas = page.getByTestId('map-canvas'), box = (await canvas.boundingBox())!;
  const [s, ox, oy] = await Promise.all(['data-scale', 'data-offset-x', 'data-offset-y'].map(async name => Number(await canvas.getAttribute(name))));
  return { x: box.x + ox! + x * s!, y: box.y + oy! - y * s! };
}
/** Metres for a distance in screen pixels at the current zoom. */
const px = async (page: Page, pixels: number) => pixels / Number(await page.getByTestId('map-canvas').getAttribute('data-scale'));
async function click(page: Page, x: number, y: number) { const p = await at(page, x, y); await page.mouse.click(p.x, p.y); }
async function drag(page: Page, from: [number, number], to: [number, number]) {
  const a = await at(page, ...from), b = await at(page, ...to);
  await page.mouse.move(a.x, a.y); await page.mouse.down(); await page.mouse.move(b.x, b.y, { steps: 12 }); await page.mouse.up();
}
/** The open map, as the page holds it. */
async function map(page: Page): Promise<YardMap> {
  return page.evaluate(async () => {
    const store = await import(/* @vite-ignore */ '/src/app/state/' + 'store.ts') as typeof Store;
    return store.store.get().session!.map;
  });
}
/** The building's entrances in order, with their node positions (to the millimetre: a click carries screen rounding) and kinds. */
async function entrances(page: Page, facilityId: string) {
  const current = await map(page);
  return current.facilities[facilityId]!.accessPointIds.map(id => {
    const entrance = current.accessPoints[id]!, node = current.nodes[entrance.nodeId]!;
    return { name: entrance.name, position: node.position.map(value => Math.round(value * 1000) / 1000), kind: node.kind };
  });
}
/** Whether the green ring (a click would place an entrance there) is drawn at a map point. */
async function greenRingAt(page: Page, x: number, y: number) {
  return page.evaluate(({ x, y }) => {
    const canvas = document.querySelector<HTMLCanvasElement>('[data-testid=map-canvas] canvas')!, rect = canvas.getBoundingClientRect(), ratio = canvas.width / rect.width;
    const data = canvas.getContext('2d')!.getImageData(Math.round((x + 8 - rect.left) * ratio) - 3, Math.round((y - rect.top) * ratio) - 3, 7, 7).data;
    for (let i = 0; i < data.length; i += 4) if (Math.hypot(data[i]! - 46, data[i + 1]! - 154, data[i + 2]! - 90) < 60) return true;
    return false;
  }, await at(page, x, y));
}
async function selectKeys(page: Page, keys: string[]) {
  await page.evaluate(async keys => {
    const store = await import(/* @vite-ignore */ '/src/app/state/' + 'store.ts') as typeof Store;
    store.select(keys);
  }, keys);
}
const toolbar = (page: Page) => page.getByRole('toolbar', { name: '工具' });
const undoButton = (page: Page) => toolbar(page).getByRole('button', { name: '撤销' });
const inspector = (page: Page) => page.getByRole('region', { name: '属性' });
const options = (page: Page) => page.getByRole('region', { name: '绘图选项' });

test('the entrance tool adds an entrance at each click on a building outline, one undo step each, and stays for the next', async ({ page }) => {
  const errors: string[] = []; await open(page, errors);
  const before = await entrances(page, 'fWorkshop');
  await toolbar(page).getByRole('button', { name: /^入口/ }).click();
  await expect(options(page)).toContainText('点选建筑外边界添加入口');
  // 5 px outside the top edge, and 5 px inside it: both land exactly on it.
  await click(page, 20, 30 + await px(page, 5));
  await expect(page.getByRole('status')).toContainText(`已添加入口001（${workshop}）`);
  await click(page, 40, 30 - await px(page, 5));
  // Within 8 px of a corner the corner itself is taken.
  await click(page, 60 - await px(page, 4), 30 + await px(page, 3));
  expect((await entrances(page, 'fWorkshop')).slice(before.length)).toEqual([
    { name: '入口001', position: [20, 30, 0], kind: 'access' },
    { name: '入口002', position: [40, 30, 0], kind: 'access' },
    { name: '入口003', position: [60, 30, 0], kind: 'access' },
  ]);
  await expect(undoButton(page)).toHaveAttribute('title', /撤销：添加入口/);
  await undoButton(page).click();
  expect(await entrances(page, 'fWorkshop')).toHaveLength(before.length + 2);
  await undoButton(page).click(); await undoButton(page).click();
  expect(await entrances(page, 'fWorkshop')).toEqual(before);
  // Escape leaves the tool.
  await page.getByTestId('map-canvas').focus();
  await page.keyboard.press('Escape');
  await expect(toolbar(page).getByRole('button', { name: /^选择/ })).toHaveAttribute('aria-pressed', 'true');
  expect(errors).toEqual([]);
});

test('a click inside a building, well outside it, or on an existing entrance adds nothing and says why; so does a hidden layer', async ({ page }) => {
  const errors: string[] = []; await open(page, errors);
  await page.getByTestId('map-canvas').focus();
  await page.keyboard.press('e');
  await expect(options(page)).toContainText('入口');
  const before = await map(page);
  await click(page, 30, 15);
  await expect(page.getByRole('alert')).toContainText('请靠近建筑外边界点选');
  await click(page, 30, 30 + await px(page, 20));
  await expect(page.getByRole('alert')).toContainText('请靠近建筑外边界点选');
  await click(page, 20, 30);
  // A second click on the same spot within half a second is a double-click, which only finishes: wait it out.
  await page.waitForTimeout(600);
  // 3 px off: a slip, the same place.
  await click(page, 20 + await px(page, 3), 30);
  await expect(page.getByRole('alert')).toContainText('此处已有本建筑的入口「入口001」');
  const after = await map(page);
  expect(Object.keys(after.accessPoints)).toHaveLength(Object.keys(before.accessPoints).length + 1);
  // With the building layer hidden while the tool is active, nothing is placed on the (invisible) outlines.
  await page.getByRole('tab', { name: '图层' }).click();
  await page.getByRole('button', { name: '隐藏建筑' }).click();
  await click(page, 40, 30);
  await expect(page.getByRole('alert')).toContainText('建筑图层已隐藏');
  // Likewise with the entrance layer hidden: a new entrance would be invisible.
  await page.getByRole('button', { name: '显示建筑' }).click();
  await page.getByRole('button', { name: '隐藏入口' }).click();
  await click(page, 40, 30);
  await expect(page.getByRole('alert')).toContainText('入口图层已隐藏');
  expect(Object.keys((await map(page)).accessPoints)).toHaveLength(Object.keys(before.accessPoints).length + 1);
  expect(errors).toEqual([]);
});

test('started from a building, the tool keeps to that building until told otherwise', async ({ page }) => {
  const errors: string[] = []; await open(page, errors);
  await click(page, 35, 70);
  await expect(inspector(page).locator('.entity-heading')).toContainText('空置厂房');
  await inspector(page).getByRole('button', { name: '在此建筑上添加入口' }).click();
  await expect(options(page)).toContainText('只在「空置厂房」上添加');
  await click(page, 20, 30 + await px(page, 5));
  await expect(page.getByRole('alert')).toContainText('请靠近「空置厂房」的外边界');
  await click(page, 35, 60 - await px(page, 5));
  expect(await entrances(page, 'fFree')).toEqual([{ name: '入口001', position: [35, 60, 0], kind: 'access' }]);
  await options(page).getByRole('button', { name: '改为任意建筑' }).click();
  await click(page, 20, 30 + await px(page, 5));
  await expect(page.getByRole('status')).toContainText(`已添加入口001（${workshop}）`);
  expect(errors).toEqual([]);
});

test('a dragged entrance on the outline slides along it, one undo step each; one off the outline moves freely', async ({ page }) => {
  const errors: string[] = []; await open(page, errors);
  await page.getByTestId('map-canvas').focus();
  await page.keyboard.press('e');
  await click(page, 35, 60 - await px(page, 5));
  await page.keyboard.press('Escape');
  // Dragged up into the building and to the right: it stays on the bottom edge.
  await drag(page, [35, 60], [42, 66]);
  await expect(undoButton(page)).toHaveAttribute('title', /撤销：移动/);
  const [moved] = await entrances(page, 'fFree');
  expect(moved!.position[1]).toBe(60);
  expect(moved!.position[0]).toBeCloseTo(42, 0);
  // Dragged out past the corner: it stops at the corner and turns onto the next edge.
  await drag(page, [moved!.position[0]!, 60], [58, 70]);
  const [cornered] = await entrances(page, 'fFree');
  expect(cornered!.position[0]).toBe(50);
  expect(cornered!.position[1]).toBeCloseTo(70, 0);
  await undoButton(page).click();
  expect((await entrances(page, 'fFree'))[0]!.position).toEqual(moved!.position);
  // Arrow keys step it along the edge too (not off it, which the kernel would refuse).
  await click(page, moved!.position[0]!, 60);
  await page.getByTestId('map-canvas').focus();
  await page.keyboard.press('Shift+ArrowRight'); await page.keyboard.press('Shift+ArrowDown');
  // Down, across the bottom edge: it stays and says it moves only along the outline (the kernel is not asked).
  await expect(page.getByRole('status')).toContainText('入口只能沿所属建筑的外边界移动，这个方向上没有可沿的边');
  const stepped = (await entrances(page, 'fFree'))[0]!.position;
  expect(stepped[1]).toBe(60);
  expect(stepped[0]).toBeCloseTo(moved!.position[0]! + 1, 3);
  // The workshop's research access point lies 5 m outside it (as on the EA01 maps): dragged 2 m, it moves 2 m, and stays outside.
  await drag(page, [30, 35], [32, 35]);
  const outside = (await map(page)).nodes.nOut!.position;
  expect(outside[0]).toBeCloseTo(32, 0);
  expect(outside[1]).toBeCloseTo(35, 0);
  expect(errors).toEqual([]);
});

test('a road drawn from a new entrance connects to it; the finish button leaves the tool', async ({ page }) => {
  const errors: string[] = []; await open(page, errors);
  await toolbar(page).getByRole('button', { name: /^入口/ }).click();
  await click(page, 35, 60 - await px(page, 5));
  await options(page).getByRole('button', { name: '完成添加入口' }).click();
  await expect(toolbar(page).getByRole('button', { name: /^选择/ })).toHaveAttribute('aria-pressed', 'true');
  const [entrance] = (await map(page)).facilities.fFree!.accessPointIds, nodeId = (await map(page)).accessPoints[entrance!]!.nodeId;
  // Roads need format 0.3.0: the example is 0.2.0 and is upgraded first.
  await page.getByTestId('map-canvas').focus();
  await page.keyboard.press('r');
  const dialog = page.getByRole('dialog', { name: '升级地图格式' });
  await dialog.getByRole('button', { name: '升级并继续' }).click();
  await expect(dialog).toHaveCount(0);
  // From the entrance node (the road tool snaps to it) straight down, away from everything else.
  await click(page, 35, 60);
  await click(page, 35, 50);
  await page.keyboard.press('Enter');
  await expect(toolbar(page).getByRole('button', { name: '撤销' })).toHaveAttribute('title', /撤销：绘制道路/);
  const roads = Object.values((await map(page)).roads);
  expect(roads.some(road => road.fromNodeId === nodeId || road.toNodeId === nodeId)).toBe(true);
  expect(errors).toEqual([]);
});

test('the tool is refused with the entrance or node layer locked, or the building or entrance layer hidden', async ({ page }) => {
  const errors: string[] = []; await open(page, errors);
  await page.getByRole('tab', { name: '图层' }).click();
  for (const [button, undo, message] of [['锁定入口', '解锁入口', '已锁定'], ['锁定节点', '解锁节点', '已锁定'], ['隐藏建筑', '显示建筑', '建筑图层已隐藏'], ['隐藏入口', '显示入口', '入口图层已隐藏']] as const) {
    await page.getByRole('button', { name: button }).click();
    await page.getByTestId('map-canvas').focus();
    await page.keyboard.press('e');
    await expect(page.getByRole('alert')).toContainText(message);
    await expect(toolbar(page).getByRole('button', { name: /^选择/ })).toHaveAttribute('aria-pressed', 'true');
    await page.getByRole('button', { name: undo }).click();
  }
  expect(errors).toEqual([]);
});

test('a click on an existing road end on the outline makes it the entrance, already on the road', async ({ page }) => {
  const errors: string[] = []; await open(page, errors);
  const before = await map(page);
  await page.getByTestId('map-canvas').focus();
  await page.keyboard.press('e');
  await click(page, 50 + await px(page, 3), 70 + await px(page, 2));
  await expect(page.getByRole('status')).toContainText('用的是此处已有的节点「门口路端」，与其 1 条道路相连');
  const after = await map(page), [entrance] = after.facilities.fFree!.accessPointIds;
  expect(after.accessPoints[entrance!]!.nodeId).toBe('nGate');
  expect(Object.keys(after.nodes)).toHaveLength(Object.keys(before.nodes).length);
  // The road is now the entrance's connector: the building still moves, and the entrance with it.
  await page.keyboard.press('Escape');
  await click(page, 35, 70); await expect(inspector(page).locator('.entity-heading')).toContainText('空置厂房');
  await page.getByTestId('map-canvas').focus();
  await page.keyboard.press('Shift+ArrowUp');
  await expect(undoButton(page)).toHaveAttribute('title', /撤销：移动/);
  expect((await map(page)).nodes.nGate!.position.map(value => Math.round(value * 1000) / 1000)).toEqual([50, 71, 0]);
  expect(errors).toEqual([]);
});

test('a public junction on the outline is not taken for an entrance: no ring, and a click says why', async ({ page }) => {
  const errors: string[] = []; await open(page, errors);
  const before = await map(page);
  await toolbar(page).getByRole('button', { name: /^入口/ }).click();
  // Elsewhere on that wall the ring shows; at the junction it does not.
  const free = await at(page, 20 - await px(page, 3), 66);
  await page.mouse.move(free.x, free.y);
  await expect.poll(() => greenRingAt(page, 20, 66)).toBe(true);
  const junction = await at(page, 20 - await px(page, 3), 70 + await px(page, 2));
  await page.mouse.move(junction.x, junction.y);
  await page.waitForTimeout(300);
  expect(await greenRingAt(page, 20, 70)).toBe(false);
  await page.mouse.click(junction.x, junction.y);
  await expect(page.getByRole('alert')).toContainText('节点「西路口」是公共道路的节点（2 条道路在此相接），入口不能用它');
  expect(Object.keys((await map(page)).accessPoints)).toHaveLength(Object.keys(before.accessPoints).length);
  // Beside it, beyond the 6 px of one place: an entrance with its own node, to connect with a short road.
  await page.waitForTimeout(600);
  await click(page, 20 - await px(page, 3), 70 + await px(page, 12));
  await expect(page.getByRole('status')).toContainText('已添加入口001（空置厂房）');
  expect((await entrances(page, 'fFree'))[0]!.kind).toBe('access');
  expect(errors).toEqual([]);
});

test('the inspector says how an entrance moves: along the outline, freely, or not at all', async ({ page }) => {
  const errors: string[] = []; await open(page, errors);
  const where = () => inspector(page).locator('.field').filter({ has: page.locator('dt', { hasText: /^位置$/ }) });
  await selectKeys(page, ['accessPoints/aWorkshop']);
  await expect(where()).toContainText('与公共道路或其他对象共用节点：保持固定，不能移动');
  await selectKeys(page, ['accessPoints/aOut']);
  await expect(where()).toContainText('不在建筑外边界上（设计上的接入点）：自由移动');
  await page.getByTestId('map-canvas').focus();
  await page.keyboard.press('e');
  await click(page, 35, 60 - await px(page, 5));
  await page.keyboard.press('Escape');
  await selectKeys(page, ['accessPoints/' + (await map(page)).facilities.fFree!.accessPointIds[0]]);
  await expect(where()).toContainText('在建筑外边界上：拖动或方向键沿外边界移动');
  expect(errors).toEqual([]);
});

test('an entrance on a corner of the selected building: a click selects it, a drag works the corner and carries the entrance', async ({ page }) => {
  const errors: string[] = []; await open(page, errors);
  await page.getByTestId('map-canvas').focus();
  await page.keyboard.press('e');
  // The bottom-right corner (50, 60): the top of the canvas is under the tool options panel.
  await click(page, 50 + await px(page, 3), 60 - await px(page, 3));
  await page.keyboard.press('Enter');
  await expect(toolbar(page).getByRole('button', { name: /^选择/ })).toHaveAttribute('aria-pressed', 'true');
  await click(page, 35, 70); await expect(inspector(page).locator('.entity-heading')).toContainText('空置厂房');
  await click(page, 50, 60); await expect(inspector(page).locator('.entity-heading')).toContainText('入口001');
  await click(page, 35, 70); await expect(inspector(page).locator('.entity-heading')).toContainText('空置厂房');
  // Inward (outward the right wall would swallow the end of the road there, which the kernel refuses): the entrance goes too (P3f2).
  await drag(page, [50, 60], [48, 62]);
  await expect(undoButton(page)).toHaveAttribute('title', /撤销：修改建筑轮廓/);
  expect((await entrances(page, 'fFree'))[0]!.position).toEqual([48, 62, 0]);
  expect(errors).toEqual([]);
});

test('quick clicks at two places add two; redo restores each; the tool shows where the next entrance goes; the toolbar clears a restriction', async ({ page }) => {
  const errors: string[] = []; await open(page, errors);
  await toolbar(page).getByRole('button', { name: /^入口/ }).click();
  // Hovering near the top edge draws the green ring where the entrance would go.
  const near = await at(page, 25, 30 + await px(page, 4));
  await page.mouse.move(near.x, near.y);
  await expect.poll(() => greenRingAt(page, 25, 30)).toBe(true);
  // Two clicks 7 px apart within half a second (a double-click for other tools, but beyond the 6 px of one place): both are entrances.
  const a = await at(page, 22, 30), b = await at(page, 22 + await px(page, 7), 30);
  await page.mouse.click(a.x, a.y); await page.mouse.click(b.x, b.y);
  await expect.poll(async () => (await entrances(page, 'fWorkshop')).length).toBe(4);
  await undoButton(page).click(); await undoButton(page).click();
  await page.keyboard.press('Control+y');
  expect(await entrances(page, 'fWorkshop')).toHaveLength(3);
  await page.keyboard.press('Control+y');
  expect(await entrances(page, 'fWorkshop')).toHaveLength(4);
  // Started from a building, then the toolbar button: any building again.
  await click(page, 35, 70);
  await page.keyboard.press('Escape');
  await click(page, 35, 70); await inspector(page).getByRole('button', { name: '在此建筑上添加入口' }).click();
  await expect(options(page)).toContainText('只在「空置厂房」上添加');
  await toolbar(page).getByRole('button', { name: /^入口/ }).click();
  await expect(options(page)).not.toContainText('只在');
  expect(errors).toEqual([]);
});
