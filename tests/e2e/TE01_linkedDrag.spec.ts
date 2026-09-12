import { readFile } from 'node:fs/promises';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { newMap, newNode, newRoad, newServicePoint } from '../../src/domain/factory';
import type { YardMap } from '../../src/domain/model';

async function exported(page: Page, info: TestInfo, name: string): Promise<YardMap> {
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出 JSON', exact: true }).click();
  const path = info.outputPath(name + '.map.json'); await (await download).saveAs(path);
  return JSON.parse(await readFile(path, 'utf8')) as YardMap;
}
async function drag(page: Page, from: [number, number], to: [number, number]) {
  const box = await page.getByTestId('map-canvas').locator('canvas').first().boundingBox();
  if (!box) throw Error('canvas unavailable');
  const camera = page.getByTestId('camera-state');
  const scale = Number(await camera.getAttribute('data-scale'));
  const ox = Number(await camera.getAttribute('data-offset-x')), oy = Number(await camera.getAttribute('data-offset-y'));
  await page.mouse.move(box.x + ox + from[0] * scale, box.y + oy - from[1] * scale);
  await page.mouse.down(); await page.mouse.move(box.x + ox + to[0] * scale, box.y + oy - to[1] * scale, { steps: 40 }); await page.mouse.up();
}
test('a selected service node can preview a topology connection; a drop without target still rejects unsupported ordinary movement', async ({ page }, info) => {
  const map = newMap('TE01_linked_drag', 'synthetic linked-node topology test');
  for (const [id, position] of [['a', [0, 0, 0]], ['b', [100, 0, 0]], ['sp', [50, 40, 0]], ['home', [50, 80, 0]]] as const) map.nodes[id] = newNode([...position]);
  map.nodes.sp!.kind = 'service';
  map.roads.main = { ...newRoad('a', 'b'), direction: 'both' };
  map.roads.branch = { ...newRoad('home', 'sp'), direction: 'both' };
  map.servicePoints.service = { ...newServicePoint('sp'), arrival: { mode: 'node_proxy', transferAssumption: 'excluded_from_model', note: 'synthetic test only' } };
  map.junctions.home_junction = { name: 'home junction', nodeIds: ['home'], model: 'explicit_movements', resourceIds: ['resource'], provenance: { category: 'synthetic' } };
  map.resources.resource = { name: 'retained resource', kind: 'junction_conflict', capacityUnit: 'vehicle', capacity: { state: 'known', value: 1 }, controlModel: 'exclusive', appliesTo: [{ entityType: 'junctions', entityId: 'home_junction' }], provenance: { category: 'synthetic' } };
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('/'); await expect(page.getByRole('button', { name: '保存工程', exact: true })).toBeEnabled();
  await page.getByTestId('json-file-input').setInputFiles({ name: 'TE01-linked.synthetic.map.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(map)) });
  await expect(page.getByLabel('地图名称', { exact: true })).toHaveValue(map.metadata.name);
  await page.getByTestId('node-item-sp').click();
  await page.getByLabel('网格吸附', { exact: true }).selectOption('0');
  await page.getByLabel('节点吸附', { exact: true }).uncheck();
  await page.getByLabel('拓扑吸附', { exact: true }).check();
  await page.getByRole('button', { name: '适应地图', exact: true }).click();
  const hash = await page.getByTestId('map-hash').textContent();
  await drag(page, [50, 40], [56, 40]);
  await expect(page.getByTestId('issue-panel')).toContainText('LOCAL_POINT_DEPENDENCY');
  await expect(page.getByTestId('map-hash')).toHaveText(hash!);
  await expect(page.locator('.canvas-status')).toContainText('0 个撤销事务');
  expect(await exported(page, info, 'unsupported-no-target')).toEqual(map);
  await drag(page, [50, 40], [50, 0]);
  const modal = page.getByRole('dialog', { name: '确认连接道路', exact: true });
  await expect(modal).toBeVisible();
  await expect(page.getByTestId('map-hash')).toHaveText(hash!);
  await modal.getByRole('button', { name: '取消', exact: true }).click();
  expect(await exported(page, info, 'cancelled-topology')).toEqual(map);
  await drag(page, [50, 40], [50, 0]);
  await modal.getByLabel('允许新增方向兼容转向', { exact: true }).check();
  await modal.getByRole('button', { name: '确认拓扑编辑', exact: true }).click();
  await expect(modal).not.toBeVisible();
  await expect(page.locator('.canvas-status')).toContainText('1 个撤销事务');
  const connected = await exported(page, info, 'connected');
  expect(connected.nodes.sp!.position[0]).toBeCloseTo(50, 8); expect(connected.nodes.sp!.position[1]).toBe(0);
  expect(connected.servicePoints).toEqual(map.servicePoints); expect(connected.resources).toEqual(map.resources);
  expect(connected.coordinateFrame).toEqual(map.coordinateFrame); expect(connected.revision).toBe(map.revision + 1);
  expect(connected.roads.main).toBeUndefined(); expect(Object.keys(connected.roads)).toHaveLength(3);
  await page.getByRole('button', { name: '撤销', exact: true }).click(); expect(await exported(page, info, 'undo')).toEqual(map);
  await page.getByRole('button', { name: '重做', exact: true }).click(); expect(await exported(page, info, 'redo')).toEqual(connected);
  expect(errors).toEqual([]);
});


test('merging into an existing target respects unchanged target junction and resource locks', async ({ page }, info) => {
  const map = newMap('TE01_target_locks', 'synthetic target-dependency locking');
  for (const [id, position] of [['a', [0, 0, 0]], ['b', [10, 0, 0]], ['target', [0, 1, 0]], ['u', [0, 10, 0]]] as const) map.nodes[id] = newNode([...position]);
  map.roads.sourceRoad = { ...newRoad('a', 'b'), direction: 'both' };
  map.roads.targetRoad = { ...newRoad('target', 'u'), direction: 'both' };
  map.junctions.targetJunction = { name: 'target junction', nodeIds: ['target'], model: 'explicit_movements', resourceIds: ['targetResource'], provenance: { category: 'synthetic' } };
  map.resources.targetResource = { name: 'target resource', kind: 'junction_conflict', capacityUnit: 'vehicle', capacity: { state: 'known', value: 1 }, controlModel: 'exclusive', appliesTo: [{ entityType: 'junctions', entityId: 'targetJunction' }], provenance: { category: 'synthetic' } };
  await page.goto('/'); await expect(page.getByRole('button', { name: '保存工程', exact: true })).toBeEnabled();
  await page.getByTestId('json-file-input').setInputFiles({ name: 'TE01-target-locks.synthetic.map.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(map)) });
  await expect(page.getByLabel('地图名称', { exact: true })).toHaveValue(map.metadata.name);
  await page.getByTestId('node-item-a').click();
  await page.getByTestId('node-item-target').click({ modifiers: ['Shift'] });
  const layers = page.getByText('基础图层与标签', { exact: true });
  if (await layers.locator('..').getAttribute('open') === null) await layers.click();
  const hash = await page.getByTestId('map-hash').textContent();
  for (const kind of ['junctions', 'resources'] as const) {
    await page.getByTestId('layer-locked-' + kind).check();
    await page.getByRole('button', { name: '合并节点', exact: true }).click();
    const modal = page.getByRole('dialog', { name: '合并节点', exact: true });
    await expect(modal.getByLabel('保留节点', { exact: true })).toHaveValue('target');
    await expect(modal.getByTestId('topology-impact')).toContainText('junctions/targetJunction');
    await expect(modal.getByTestId('topology-impact')).toContainText('resources/targetResource');
    await modal.getByRole('button', { name: '确认拓扑编辑', exact: true }).click();
    await expect(modal).toContainText('LOCKED_DEPENDENCY');
    await expect(page.getByTestId('map-hash')).toHaveText(hash!);
    await expect(page.locator('.canvas-status')).toContainText('0 个撤销事务');
    await modal.getByRole('button', { name: '取消', exact: true }).click();
    expect(await exported(page, info, 'locked-target-' + kind)).toEqual(map);
    await page.getByTestId('layer-locked-' + kind).uncheck();
  }
});
