import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type * as Store from '../../src/app/state/store';
import type { YardMap } from '../../src/domain/model';

const example = fileURLToPath(new URL('../../examples/M2A1_synthetic_service_targets.map.json', import.meta.url));
/** The synthetic example (format 0.2.0): a workshop at 0–60 × 0–30 m, its main road rMain from the corner (0, 0) to the plain
 *  road end nRoadEast (100, 0); plus a free building 20–50 × 60–80 m. With `gate`, the free building has a gate 西门 on a
 *  public junction on its left wall (20, 70), where two public roads end. */
function mapJson(gate = false, service = false): string {
  const map = JSON.parse(readFileSync(example, 'utf8')) as Record<string, Record<string, unknown>>;
  map.facilities!.fFree = {
    name: '空置厂房', kind: 'workshop', boundary: { outer: [[20, 60, 0], [50, 60, 0], [50, 80, 0], [20, 80, 0], [20, 60, 0]], holes: [] },
    accessPointIds: gate ? ['aWest'] : [], servicePointIds: [], heightM: { state: 'unknown' }, provenance: { category: 'synthetic' },
  };
  if (gate) {
    const node = (name: string, position: number[], kind = 'ordinary') => ({ name, position, kind, provenance: { category: 'synthetic' } });
    map.nodes!.nWestGate = node('西门路口', [20, 70, 0], 'access'); map.nodes!.nW1 = node('西一', [5, 70, 0]); map.nodes!.nW2 = node('西二', [5, 76, 0]);
    map.roads!.rW1 = { ...(map.roads!.rMain as object), name: '西路一', fromNodeId: 'nWestGate', toNodeId: 'nW1', shapePoints: [] };
    map.roads!.rW2 = { ...(map.roads!.rMain as object), name: '西路二', fromNodeId: 'nWestGate', toNodeId: 'nW2', shapePoints: [] };
    map.accessPoints!.aWest = { name: '西门', facilityId: 'fFree', nodeId: 'nWestGate', provenance: { category: 'drawing' } };
    if (service) {
      map.servicePoints!.sWest = { name: '西门装卸', kind: 'loading', nodeId: 'nWestGate', facilityId: 'fFree', accessPointId: 'aWest', resourceIds: [],
        arrival: { mode: 'node_proxy', transferAssumption: 'included_in_service_duration', note: '门口作业' }, provenance: { category: 'drawing' } };
      (map.facilities!.fFree as { servicePointIds: string[] }).servicePointIds.push('sWest');
    }
  }
  return JSON.stringify(map);
}
async function open(page: Page, errors: string[], gate = false, service = false) {
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await page.getByTestId('open-file-input').setInputFiles({ name: 'nodes.map.json', mimeType: 'application/json', buffer: Buffer.from(mapJson(gate, service)) });
  await expect(page.getByTestId('map-canvas')).toHaveAttribute('data-scale', /\d/);
}
async function at(page: Page, x: number, y: number) {
  const canvas = page.getByTestId('map-canvas'), box = (await canvas.boundingBox())!;
  const [s, ox, oy] = await Promise.all(['data-scale', 'data-offset-x', 'data-offset-y'].map(async name => Number(await canvas.getAttribute(name))));
  return { x: box.x + ox! + x * s!, y: box.y + oy! - y * s! };
}
const px = async (page: Page, pixels: number) => pixels / Number(await page.getByTestId('map-canvas').getAttribute('data-scale'));
async function click(page: Page, x: number, y: number) { const p = await at(page, x, y); await page.mouse.click(p.x, p.y); }
async function drag(page: Page, from: [number, number], to: [number, number]) {
  const a = await at(page, ...from), b = await at(page, ...to);
  await page.mouse.move(a.x, a.y); await page.mouse.down(); await page.mouse.move(b.x, b.y, { steps: 12 }); await page.mouse.up();
}
async function map(page: Page): Promise<YardMap> {
  return page.evaluate(async () => {
    const store = await import(/* @vite-ignore */ '/src/app/state/' + 'store.ts') as typeof Store;
    return store.store.get().session!.map;
  });
}
const round = (point: readonly number[]) => point.map(value => Math.round(value * 1000) / 1000);
const toolbar = (page: Page) => page.getByRole('toolbar', { name: '工具' });
const undoButton = (page: Page) => toolbar(page).getByRole('button', { name: '撤销' });
const inspector = (page: Page) => page.getByRole('region', { name: '属性' });
/** Whether pixels of a colour are drawn within `radius` screen px of a map point. */
async function colourNear(page: Page, x: number, y: number, rgb: [number, number, number], radius = 4) {
  return page.evaluate(({ at, rgb, radius }) => {
    const canvas = document.querySelector<HTMLCanvasElement>('[data-testid=map-canvas] canvas')!, rect = canvas.getBoundingClientRect(), ratio = canvas.width / rect.width;
    const size = Math.round(radius * 2 * ratio) + 1;
    const data = canvas.getContext('2d')!.getImageData(Math.round((at.x - rect.left) * ratio - size / 2), Math.round((at.y - rect.top) * ratio - size / 2), size, size).data;
    for (let i = 0; i < data.length; i += 4) if (Math.hypot(data[i]! - rgb[0], data[i + 1]! - rgb[1], data[i + 2]! - rgb[2]) < 40) return true;
    return false;
  }, { at: await at(page, x, y), rgb, radius });
}
const SELECTION: [number, number, number] = [226, 121, 27], ACCESS: [number, number, number] = [47, 138, 109];
async function selectKeys(page: Page, keys: string[]) {
  await page.evaluate(async keys => {
    const store = await import(/* @vite-ignore */ '/src/app/state/' + 'store.ts') as typeof Store;
    store.select(keys);
  }, keys);
}

test('a road end node is dragged at once, without selecting it first; its road follows; one undo step', async ({ page }) => {
  const errors: string[] = []; await open(page, errors);
  // Plain nodes are hidden by default: the press at the road's end still takes its node (down and out: up would cut the workshop).
  await drag(page, [100, 0], [104, -6]);
  await expect(undoButton(page)).toHaveAttribute('title', /撤销：移动/);
  expect(round((await map(page)).nodes.nRoadEast!.position)).toEqual([104, -6, 0]);
  await undoButton(page).click();
  expect(round((await map(page)).nodes.nRoadEast!.position)).toEqual([100, 0, 0]);
  expect(errors).toEqual([]);
});

test('with plain nodes shown, a node is dragged at once and selected', async ({ page }) => {
  const errors: string[] = []; await open(page, errors);
  await page.getByRole('tab', { name: '图层' }).click();
  await page.getByLabel('显示普通节点').check();
  await drag(page, [100, 0], [103, -4]);
  await expect(undoButton(page)).toHaveAttribute('title', /撤销：移动/);
  expect(round((await map(page)).nodes.nRoadEast!.position)).toEqual([103, -4, 0]);
  await expect(inspector(page).locator('.entity-heading')).toContainText('东侧道路节点');
  expect(errors).toEqual([]);
});

test('the end handle of the selected road drags its node, and the road stays selected', async ({ page }) => {
  const errors: string[] = []; await open(page, errors);
  await click(page, 70, 0);
  await expect(inspector(page).locator('.entity-heading')).toContainText((await map(page)).roads.rMain!.name);
  await drag(page, [100, 0], [100, -6]);
  await expect(undoButton(page)).toHaveAttribute('title', /撤销：移动/);
  expect(round((await map(page)).nodes.nRoadEast!.position)).toEqual([100, -6, 0]);
  await expect(inspector(page).locator('.entity-heading')).toContainText((await map(page)).roads.rMain!.name);
  expect(errors).toEqual([]);
});

test("a building's entrances go with its outline: a corner drag carries the corner entrance and the one on the bottom edge", async ({ page }) => {
  const errors: string[] = []; await open(page, errors);
  await page.getByTestId('map-canvas').focus();
  await page.keyboard.press('e');
  await click(page, 50 + await px(page, 3), 60 - await px(page, 3));
  await page.waitForTimeout(600);
  await click(page, 35, 60 - await px(page, 5));
  await page.keyboard.press('Escape');
  const before = await map(page), [corner, bottom] = before.facilities.fFree!.accessPointIds;
  const position = (current: YardMap, id: string) => round(current.nodes[current.accessPoints[id]!.nodeId]!.position);
  expect([position(before, corner!), position(before, bottom!)]).toEqual([[50, 60, 0], [35, 60, 0]]);
  // Select the building (a click on the corner selects the entrance there: a point beats a handle), then drag its corner.
  await click(page, 35, 70); await expect(inspector(page).locator('.entity-heading')).toContainText('空置厂房');
  await drag(page, [50, 60], [52, 58]);
  await expect(undoButton(page)).toHaveAttribute('title', /撤销：修改建筑轮廓/);
  const after = await map(page);
  expect(round(after.facilities.fFree!.boundary.outer.flat() as number[])).toEqual([20, 58, 0, 52, 58, 0, 52, 80, 0, 20, 80, 0, 20, 58, 0]);
  expect([position(after, corner!), position(after, bottom!)]).toEqual([[52, 58, 0], [36, 58, 0]]);
  await undoButton(page).click();
  const undone = await map(page);
  expect([position(undone, corner!), position(undone, bottom!)]).toEqual([[50, 60, 0], [35, 60, 0]]);
  expect(errors).toEqual([]);
});

test('a gate on a public junction is split off: it moves 4 m along the wall onto its own node, the junction keeps its roads; one undo step', async ({ page }) => {
  const errors: string[] = []; await open(page, errors, true);
  await selectKeys(page, ['accessPoints/aWest']);
  const where = inspector(page).locator('.field').filter({ has: page.locator('dt', { hasText: /^位置$/ }) });
  await expect(where).toContainText('与公共道路或其他对象共用节点：保持固定，不能移动');
  const before = await map(page);
  await where.getByRole('button', { name: '拆出入口节点' }).click();
  await expect(page.getByRole('status')).toContainText('已拆出入口「西门」');
  await expect(undoButton(page)).toHaveAttribute('title', /撤销：拆出入口节点/);
  const after = await map(page), nodeId = after.accessPoints.aWest!.nodeId;
  expect(nodeId).not.toBe('nWestGate');
  expect(round(after.nodes[nodeId]!.position)).toEqual([20, 66, 0]);
  expect(after.nodes.nWestGate).toMatchObject({ position: [20, 70, 0], kind: 'ordinary' });
  expect([after.roads.rW1, after.roads.rW2]).toEqual([before.roads.rW1, before.roads.rW2]);
  expect(Object.values(after.roads).filter(road => [road.fromNodeId, road.toNodeId].sort().join() === [nodeId, 'nWestGate'].sort().join())).toHaveLength(1);
  await expect(where).toContainText('在建筑外边界上：拖动或方向键沿外边界移动');
  // Now the building's outline can change with it: the rectangle's bottom-left corner in by 2 m moves the left wall, and the
  // gate on it goes too (the old junction stays where it was, the connector stretches).
  await click(page, 35, 70); await expect(inspector(page).locator('.entity-heading')).toContainText('空置厂房');
  await drag(page, [20, 60], [22, 60]);
  await expect(undoButton(page)).toHaveAttribute('title', /撤销：修改建筑轮廓/);
  expect(round((await map(page)).nodes[nodeId]!.position)).toEqual([22, 66, 0]);
  expect(round((await map(page)).nodes.nWestGate!.position)).toEqual([20, 70, 0]);
  // Two undos: the outline, then the whole split at once.
  await undoButton(page).click(); await undoButton(page).click();
  const undone = await map(page);
  expect(undone.accessPoints.aWest!.nodeId).toBe('nWestGate');
  expect(undone.nodes[nodeId]).toBeUndefined();
  expect(Object.keys(undone.roads)).toEqual(Object.keys(before.roads));
  expect(errors).toEqual([]);
});

test('hovering a road end shows its hidden node, as what a press would drag', async ({ page }) => {
  const errors: string[] = []; await open(page, errors);
  const away = await at(page, 80, 20); await page.mouse.move(away.x, away.y);
  await page.waitForTimeout(300);
  expect(await colourNear(page, 100, 0, SELECTION)).toBe(false);
  const end = await at(page, 100 + await px(page, 3), await px(page, 2)); await page.mouse.move(end.x, end.y);
  await expect.poll(() => colourNear(page, 100, 0, SELECTION)).toBe(true);
  expect(errors).toEqual([]);
});

test('the end handle of a connector moves the entrance at its end along the wall; the connector stays selected', async ({ page }) => {
  const errors: string[] = []; await open(page, errors, true);
  await selectKeys(page, ['accessPoints/aWest']);
  await inspector(page).getByRole('button', { name: '拆出入口节点' }).click();
  await expect(page.getByRole('status')).toContainText('已拆出入口「西门」');
  const split = await map(page), nodeId = split.accessPoints.aWest!.nodeId;
  const connector = Object.entries(split.roads).find(([, road]) => [road.fromNodeId, road.toNodeId].includes(nodeId))![0];
  await selectKeys(page, ['roads/' + connector]);
  // Its end at the gate (20, 66), dragged out and down: the gate slides down the wall instead of leaving it.
  await drag(page, [20, 66], [17, 63]);
  await expect(undoButton(page)).toHaveAttribute('title', /撤销：移动/);
  expect(round((await map(page)).nodes[nodeId]!.position)).toEqual([20, 63, 0]);
  await expect(inspector(page).locator('.entity-heading')).toContainText((await map(page)).roads[connector]!.name);
  expect(errors).toEqual([]);
});

test('the preview shows the entrance moving with the outline while the corner is dragged', async ({ page }) => {
  const errors: string[] = []; await open(page, errors);
  await page.getByTestId('map-canvas').focus();
  await page.keyboard.press('e');
  await click(page, 35, 60 - await px(page, 5));
  await page.keyboard.press('Escape');
  await click(page, 35, 70); await expect(inspector(page).locator('.entity-heading')).toContainText('空置厂房');
  // The rectangle's bottom-right corner down by 6 m: mid-drag the entrance marker sits on the new bottom edge.
  const from = await at(page, 50, 60), to = await at(page, 50, 54);
  await page.mouse.move(from.x, from.y); await page.mouse.down(); await page.mouse.move(to.x, to.y, { steps: 10 });
  await expect.poll(() => colourNear(page, 35, 54, ACCESS)).toBe(true);
  expect(await colourNear(page, 35, 60, ACCESS, 2)).toBe(false);
  await page.mouse.up();
  await expect(undoButton(page)).toHaveAttribute('title', /撤销：修改建筑轮廓/);
  const entrance = (await map(page)).facilities.fFree!.accessPointIds[0]!;
  expect(round((await map(page)).nodes[(await map(page)).accessPoints[entrance]!.nodeId]!.position)).toEqual([35, 54, 0]);
  expect(errors).toEqual([]);
});

test('a gate split off with its service point: the message says so, and dragging the marker slides both along the wall', async ({ page }) => {
  const errors: string[] = []; await open(page, errors, true, true);
  await selectKeys(page, ['accessPoints/aWest']);
  await inspector(page).getByRole('button', { name: '拆出入口节点' }).click();
  await expect(page.getByRole('status')).toContainText('本建筑在原节点上的 1 个作业点随之移过去');
  const nodeId = (await map(page)).accessPoints.aWest!.nodeId;
  expect((await map(page)).servicePoints.sWest!.nodeId).toBe(nodeId);
  await page.keyboard.press('Escape');
  // The shared marker 入作 at (20, 66): a press there takes the service point; the entrance still keeps to the wall.
  await drag(page, [20, 66], [17, 62]);
  await expect(undoButton(page)).toHaveAttribute('title', /撤销：移动/);
  expect(round((await map(page)).nodes[nodeId]!.position)).toEqual([20, 62, 0]);
  expect(errors).toEqual([]);
});

test('a click at a road end selects its node whether or not the pointer rested there first; mid-road selects the road', async ({ page }) => {
  const errors: string[] = []; await open(page, errors);
  const end = await at(page, 100 - await px(page, 5), 0);
  await page.mouse.move(end.x, end.y); await page.mouse.down(); await page.mouse.up();
  await expect(inspector(page).locator('.entity-heading')).toContainText('东侧道路节点');
  await click(page, 70, 0);
  await expect(inspector(page).locator('.entity-heading')).toContainText((await map(page)).roads.rMain!.name);
  await page.waitForTimeout(300);
  await click(page, 100 - await px(page, 5), 0);
  await expect(inspector(page).locator('.entity-heading')).toContainText('东侧道路节点');
  expect(errors).toEqual([]);
});
