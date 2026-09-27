import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type * as Store from '../../src/app/state/store';
import type { YardMap } from '../../src/domain/model';

const example = fileURLToPath(new URL('../../examples/M2A1_synthetic_service_targets.map.json', import.meta.url));
/** The synthetic example (0.2.0): the main road rMain from nRoadWest (0, 0) to nRoadEast (100, 0); plus a one-way stub rStub
 *  from nS1 (50, −20) to nS2 (50, −5), a lone road rLone from nL1 (120, 0) to nL2 (140, 0), a junction node nJ (160, 0) on
 *  a road to nJ2 (180, 0), a plain node nFree (60, −40) on no road, and a yard (110–130 × 10–30 m) with its gate nYardGate
 *  (110, 20) on its own node and a straight connector rYardIn from nYardOut (104, 20). */
function mapJson(): string {
  const map = JSON.parse(readFileSync(example, 'utf8')) as Record<string, Record<string, unknown>>;
  const node = (name: string, position: number[]) => ({ name, position, kind: 'ordinary', provenance: { category: 'synthetic' } });
  const main = map.roads!.rMain as object;
  map.nodes!.nS1 = node('桩一', [50, -20, 0]); map.nodes!.nS2 = node('桩二', [50, -5, 0]);
  map.roads!.rStub = { ...main, name: '支路', fromNodeId: 'nS1', toNodeId: 'nS2', direction: 'forward', shapePoints: [] };
  map.nodes!.nL1 = node('孤一', [120, 0, 0]); map.nodes!.nL2 = node('孤二', [140, 0, 0]);
  map.roads!.rLone = { ...main, name: '孤路', fromNodeId: 'nL1', toNodeId: 'nL2', shapePoints: [] };
  map.nodes!.nJ = { ...node('路口', [160, 0, 0]), kind: 'junction' }; map.nodes!.nJ2 = node('路口外', [180, 0, 0]);
  map.roads!.rJ = { ...main, name: '路口路', fromNodeId: 'nJ', toNodeId: 'nJ2', shapePoints: [] };
  map.nodes!.nFree = node('散点', [60, -40, 0]);
  map.facilities!.fYard = { name: '堆场', kind: 'yard', boundary: { outer: [[110, 10, 0], [130, 10, 0], [130, 30, 0], [110, 30, 0], [110, 10, 0]], holes: [] },
    accessPointIds: ['aYard'], servicePointIds: [], heightM: { state: 'unknown' }, provenance: { category: 'synthetic' } };
  map.nodes!.nYardGate = { ...node('堆场门', [110, 20, 0]), kind: 'access' }; map.nodes!.nYardOut = node('堆场门外', [104, 20, 0]);
  map.accessPoints!.aYard = { name: '堆场门', facilityId: 'fYard', nodeId: 'nYardGate', provenance: { category: 'synthetic' } };
  map.roads!.rYardIn = { ...main, name: '堆场接入段', fromNodeId: 'nYardOut', toNodeId: 'nYardGate', shapePoints: [] };
  return JSON.stringify(map);
}
async function open(page: Page, errors: string[]) {
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await page.getByTestId('open-file-input').setInputFiles({ name: 'topology.map.json', mimeType: 'application/json', buffer: Buffer.from(mapJson()) });
  await expect(page.getByTestId('map-canvas')).toHaveAttribute('data-scale', /\d/);
}
async function at(page: Page, x: number, y: number) {
  const canvas = page.getByTestId('map-canvas'), box = (await canvas.boundingBox())!;
  const [s, ox, oy] = await Promise.all(['data-scale', 'data-offset-x', 'data-offset-y'].map(async name => Number(await canvas.getAttribute(name))));
  return { x: box.x + ox! + x * s!, y: box.y + oy! - y * s! };
}
async function click(page: Page, x: number, y: number) { const p = await at(page, x, y); await page.mouse.click(p.x, p.y); }
/** `alt`: held from halfway and let go before the release (what the preview showed happens), or pressed only for the
 *  release; `escape`: pressed before the release. */
async function drag(page: Page, from: [number, number], to: [number, number], alt: false | 'midway' | 'release' = false, escape = false) {
  const a = await at(page, ...from), b = await at(page, ...to);
  await page.mouse.move(a.x, a.y); await page.mouse.down();
  await page.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2, { steps: 6 });
  if (alt === 'midway') await page.keyboard.down('Alt');
  await page.mouse.move(b.x, b.y, { steps: 6 });
  if (alt === 'release') await page.keyboard.down('Alt');
  if (escape) await page.keyboard.press('Escape');
  if (alt === 'midway') await page.keyboard.up('Alt');
  await page.mouse.up();
  if (alt === 'release') await page.keyboard.up('Alt');
}
async function selection(page: Page): Promise<readonly string[]> {
  return page.evaluate(async () => {
    const store = await import(/* @vite-ignore */ '/src/app/state/' + 'store.ts') as typeof Store;
    return store.store.get().selection;
  });
}
/** Whether pixels of a colour are drawn within `radius` screen px of a map point. */
async function colourNear(page: Page, x: number, y: number, rgb: [number, number, number], radius = 3) {
  return page.evaluate(({ at, rgb, radius }) => {
    const canvas = document.querySelector<HTMLCanvasElement>('[data-testid=map-canvas] canvas')!, rect = canvas.getBoundingClientRect(), ratio = canvas.width / rect.width;
    const size = Math.round(radius * 2 * ratio) + 1;
    const data = canvas.getContext('2d')!.getImageData(Math.round((at.x - rect.left) * ratio - size / 2), Math.round((at.y - rect.top) * ratio - size / 2), size, size).data;
    for (let i = 0; i < data.length; i += 4) if (Math.hypot(data[i]! - rgb[0], data[i + 1]! - rgb[1], data[i + 2]! - rgb[2]) < 30) return true;
    return false;
  }, { at: await at(page, x, y), rgb, radius });
}
async function map(page: Page): Promise<YardMap> {
  return page.evaluate(async () => {
    const store = await import(/* @vite-ignore */ '/src/app/state/' + 'store.ts') as typeof Store;
    return store.store.get().session!.map;
  });
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

test('a road end dropped on another node asks to merge them; confirmed, one undo step; with Alt it only moves', async ({ page }) => {
  const errors: string[] = []; await open(page, errors);
  const before = await map(page);
  // The lone road's west end onto the main road's east end.
  await drag(page, [120, 0], [100.3, 0.2]);
  const dialog = page.getByRole('dialog', { name: '合并节点' });
  await expect(dialog).toContainText('「孤一」并入「nRoadEast」'.replace('nRoadEast', before.nodes.nRoadEast!.name));
  await expect(dialog.getByRole('checkbox', { name: /允许新增的转向（\d+ \/ \d+ 个/ })).toBeChecked();
  // Nothing moved yet.
  expect((await map(page)).nodes.nL1!.position).toEqual([120, 0, 0]);
  await dialog.getByRole('button', { name: '确认合并节点' }).click();
  const merged = await map(page);
  expect(await selection(page)).toEqual(['nodes/nRoadEast']);
  expect(merged.nodes.nL1).toBeUndefined();
  expect(merged.roads.rLone).toMatchObject({ fromNodeId: 'nRoadEast', toNodeId: 'nL2' });
  expect(Object.values(merged.movements).filter(turn => turn.incomingArc.roadId === 'rLone' || turn.outgoingArc.roadId === 'rLone').length).toBeGreaterThan(0);
  await expect(undoButton(page)).toHaveAttribute('title', /撤销：合并节点/);
  await undoButton(page).click();
  expect(await map(page)).toEqual(before);
  // Escape before the release: nothing happens.
  await drag(page, [120, 0], [100.3, 0.2], false, true);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(await map(page)).toEqual(before);
  // Alt held while dragging, or pressed only for the release: a plain move where the pointer is, no dialog.
  await drag(page, [120, 0], [100.3, 0.2], 'midway');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const moved = (await map(page)).nodes.nL1!.position;
  expect(Math.hypot(moved[0] - 100.3, moved[1] - 0.2)).toBeLessThan(0.2);
  await undoButton(page).click();
  await drag(page, [120, 0], [100.3, 0.2], 'release');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const released = (await map(page)).nodes.nL1!.position;
  expect(Math.hypot(released[0] - 100.3, released[1] - 0.2)).toBeLessThan(0.2);
  await undoButton(page).click();
  // Shift (a horizontal or vertical move) does not snap either.
  const a = await at(page, 120, 0), b = await at(page, 100.3, 0.2);
  await page.mouse.move(a.x, a.y); await page.mouse.down(); await page.keyboard.down('Shift');
  await page.mouse.move(b.x, b.y, { steps: 8 }); await page.mouse.up(); await page.keyboard.up('Shift');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect((await map(page)).nodes.nL1!.position[1]).toBe(0);
  expect(errors).toEqual([]);
});

test('a node of another kind is not merged: released there, the node goes back and the reason is given', async ({ page }) => {
  const errors: string[] = []; await open(page, errors);
  const before = await map(page);
  await drag(page, [140, 0], [160.2, 0.2]);
  await expect(page.getByRole('alert')).toContainText('不能合并：「孤二」是普通节点，「路口」是路口节点');
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(await map(page)).toEqual(before);
  expect(errors).toEqual([]);
});

test('a dialog prepared on a map that changed since is stale: confirming says so and changes nothing more', async ({ page }) => {
  const errors: string[] = []; await open(page, errors);
  await drag(page, [120, 0], [100.3, 0.2]);
  const dialog = page.getByRole('dialog', { name: '合并节点' });
  await expect(dialog).toBeVisible();
  await page.evaluate(async () => {
    const edit = await import(/* @vite-ignore */ '/src/app/state/' + 'edit.ts') as typeof import('../../src/app/state/edit');
    edit.apply({ type: 'renameMap', name: '改名' }, '改名');
  });
  const renamed = await map(page);
  await dialog.getByRole('button', { name: '确认合并节点' }).click();
  await expect(page.getByRole('alert')).toContainText('地图在对话框打开后已改变');
  expect(await map(page)).toEqual(renamed);
  expect(errors).toEqual([]);
});

test('a road end dropped on a road\'s middle asks to connect it; the road splits there; cancelling changes nothing', async ({ page }) => {
  const errors: string[] = []; await open(page, errors);
  const before = await map(page);
  await drag(page, [50, -5], [50, 0.3]);
  const dialog = page.getByRole('dialog', { name: '把节点接到道路' });
  await expect(dialog).toContainText('距起点 50.0 m 处');
  await dialog.getByRole('button', { name: '取消' }).click();
  expect(await map(page)).toEqual(before);
  await drag(page, [50, -5], [50, 0.3]);
  // One turn unticked: the others only are allowed.
  const connect = page.getByRole('dialog', { name: '把节点接到道路' });
  await connect.getByText('逐个选择').click();
  const each = connect.locator('details input[type=checkbox]'), total = await each.count();
  expect(total).toBeGreaterThan(1);
  await each.first().uncheck();
  await expect(connect.getByRole('checkbox', { name: new RegExp(`允许新增的转向（${total - 1} / ${total} 个`) })).not.toBeChecked();
  await connect.getByRole('button', { name: '确认把节点接到道路' }).click();
  await expect(page.getByRole('status')).toContainText(`允许新增转向 ${total - 1} 个`);
  const connected = await map(page);
  expect(Object.values(connected.movements).filter(turn => turn.incomingArc.roadId === 'rStub' || turn.outgoingArc.roadId === 'rStub')).toHaveLength(total - 1);
  expect(connected.roads.rMain).toBeUndefined();
  expect(connected.nodes.nS2!.position).toEqual([50, 0, 0]);
  expect(Object.values(connected.roads).filter(road => road.fromNodeId === 'nS2' || road.toNodeId === 'nS2')).toHaveLength(3);
  await expect(undoButton(page)).toHaveAttribute('title', /撤销：把节点接到道路/);
  expect(errors).toEqual([]);
});

test('the split tool (X) splits a road where clicked, one undo step each; the new node removed again joins the roads (inspector)', async ({ page }) => {
  const errors: string[] = []; await open(page, errors);
  const before = await map(page);
  await page.getByTestId('map-canvas').focus();
  // A plain node on no road is hidden until a tool that connects shows the plain nodes.
  const NODE: [number, number, number] = [47, 111, 134];
  expect(await colourNear(page, 60, -40, NODE)).toBe(false);
  await page.keyboard.press('x');
  await expect(page.getByRole('region', { name: '绘图选项' })).toContainText('拆分道路');
  await expect.poll(() => colourNear(page, 60, -40, NODE)).toBe(true);
  await click(page, 30, 0.2);
  await expect(page.getByRole('status')).toContainText('距起点 30.0 m 处拆成两段');
  await expect(undoButton(page)).toHaveAttribute('title', /撤销：拆分道路/);
  const split = await map(page), cut = Object.keys(split.nodes).find(id => !before.nodes[id])!;
  expect(split.nodes[cut]!.position).toEqual([30, 0, 0]);
  expect(split.roads.rMain).toBeUndefined();
  // Enter ends the tool, as it does the entrance and service point tools.
  await page.getByTestId('map-canvas').focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('region', { name: '绘图选项' })).toHaveCount(0);
  // The new node has two roads: removing it joins them again.
  await selectKeys(page, ['nodes/' + cut]);
  await inspector(page).getByRole('button', { name: '删除节点并接通两条道路' }).click();
  const dialog = page.getByRole('dialog', { name: '删除节点并接通两条道路' });
  await expect(dialog.getByRole('combobox', { name: '保留的道路' })).toBeVisible();
  await dialog.getByRole('button', { name: '确认删除节点并接通两条道路' }).click();
  const joined = await map(page);
  expect(joined.nodes[cut]).toBeUndefined();
  expect(Object.values(joined.roads).filter(road => road.name === before.roads.rMain!.name)).toHaveLength(1);
  await expect(undoButton(page)).toHaveAttribute('title', /撤销：删除节点并接通两条道路/);
  expect(errors).toEqual([]);
});

test('a one-way road is reversed from its properties; the edit menu offers merging two selected nodes, the first one kept', async ({ page }) => {
  const errors: string[] = []; await open(page, errors);
  await selectKeys(page, ['roads/rStub']);
  await inspector(page).getByRole('button', { name: '反转方向' }).click();
  expect((await map(page)).roads.rStub!.direction).toBe('backward');
  await expect(undoButton(page)).toHaveAttribute('title', /撤销：反转道路方向/);
  await selectKeys(page, ['nodes/nRoadEast', 'nodes/nL1']);
  const lock = (types: string[]) => page.evaluate(async types => {
    const store = await import(/* @vite-ignore */ '/src/app/state/' + 'store.ts') as typeof Store;
    store.store.set(({ drawing }) => ({ drawing: { ...drawing, lockedTypes: types as never } }));
  }, types);
  const openMerge = async () => { await page.getByRole('button', { name: '编辑' }).click(); await page.getByRole('menuitem', { name: /合并节点/ }).click(); };
  // A locked layer the merge writes (the roads it reconnects) is said at once, and confirming is not offered.
  await lock(['roads']);
  await openMerge();
  const dialog = page.getByRole('dialog', { name: '合并节点' });
  await expect(dialog.getByRole('alert')).toContainText('道路');
  await expect(dialog.getByRole('button', { name: '确认合并节点' })).toBeDisabled();
  await dialog.getByRole('button', { name: '取消' }).click();
  await lock([]);
  await openMerge();
  await expect(dialog.getByRole('combobox', { name: '保留的节点' })).toHaveValue('nRoadEast');
  // A turn unticked, then the other node kept: the turns are those of the new merge, all ticked again.
  await dialog.getByText('逐个选择').click();
  await dialog.locator('details input[type=checkbox]').first().uncheck();
  await expect(dialog.getByRole('checkbox', { name: /允许新增的转向（/ })).not.toBeChecked();
  await dialog.getByRole('combobox', { name: '保留的节点' }).selectOption('nL1');
  await expect(dialog.getByRole('checkbox', { name: /允许新增的转向（/ })).toBeChecked();
  await dialog.getByRole('button', { name: '确认合并节点' }).click();
  const merged = await map(page);
  expect(merged.nodes.nRoadEast).toBeUndefined();
  expect(merged.nodes.nL1!.position).toEqual([120, 0, 0]);
  expect(merged.roads.rMain!.toNodeId).toBe('nL1');
  expect(errors).toEqual([]);
});

test('on a 0.3 map, bending an entrance\'s straight connector with its bend handle is refused: the building could no longer move', async ({ page }) => {
  const errors: string[] = []; await open(page, errors);
  await page.evaluate(async () => {
    const edit = await import(/* @vite-ignore */ '/src/app/state/' + 'edit.ts') as typeof import('../../src/app/state/edit');
    edit.apply({ type: 'upgradeSchema', targetVersion: '0.3.0' }, '升级');
  });
  await selectKeys(page, ['roads/rYardIn']);
  const before = (await map(page)).roads.rYardIn!.geometry;
  // The connector's middle is its bend handle on a 0.3 map.
  const a = await at(page, 107, 20), b = await at(page, 107, 23);
  await page.mouse.move(a.x, a.y); await page.mouse.down(); await page.mouse.move(b.x, b.y, { steps: 8 }); await page.mouse.up();
  await expect(page.getByRole('alert')).toContainText('「堆场」将不能移动');
  await expect(page.getByRole('alert')).toContainText('先用拆分工具（X）把它拆成两段');
  expect((await map(page)).roads.rYardIn!.geometry).toEqual(before);
  expect(errors).toEqual([]);
});
