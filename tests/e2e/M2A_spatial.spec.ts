import { readFile } from 'node:fs/promises';
import { test, expect, type Page, type TestInfo } from '@playwright/test';
import type { YardMap } from '../../src/domain/model';
import { associatedFixture, missingBackgroundFixture } from '../helpers/M2A_fixtures';

async function ready(page: Page) {
  await page.goto('/');
  await expect(page.getByRole('button', { name: '保存工程', exact: true })).toBeEnabled();
}
async function saved(page: Page) { await expect(page.getByTestId('browser-save-status')).toContainText('已保存'); }
async function screenPoint(page: Page, x: number, y: number) {
  const box = await page.getByTestId('map-canvas').locator('canvas').first().boundingBox();
  expect(box).not.toBeNull();
  const camera = page.getByTestId('camera-state');
  const ox = Number(await camera.getAttribute('data-offset-x'));
  const oy = Number(await camera.getAttribute('data-offset-y'));
  const scale = Number(await camera.getAttribute('data-scale'));
  return { x: box!.x + ox + x * scale, y: box!.y + oy - y * scale };
}
async function clickWorld(page: Page, x: number, y: number) {
  const p = await screenPoint(page, x, y);
  await page.mouse.click(p.x, p.y);
}
async function download(page: Page, info: TestInfo, filename: string): Promise<YardMap> {
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出 JSON', exact: true }).click();
  const file = info.outputPath(filename);
  await (await pending).saveAs(file);
  return JSON.parse(await readFile(file, 'utf8')) as YardMap;
}
async function importMap(page: Page, map: YardMap) {
  await page.getByTestId('json-file-input').setInputFiles({ name: 'M2A-test.map.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(map)) });
  const conflict = page.getByRole('dialog', { name: '未保存编辑冲突', exact: true });
  const firstFacility = Object.keys(map.facilities)[0];
  const firstRoad = Object.keys(map.roads)[0];
  const target = page.getByTestId(firstFacility ? 'facilities-item-' + firstFacility : 'road-item-' + firstRoad);
  await expect.poll(async () => await conflict.isVisible() || await target.isVisible()).toBe(true);
  if (await conflict.isVisible()) await conflict.getByRole('button', { name: '放弃编辑并重载', exact: true }).click();
  await expect(target).toBeVisible();
}
async function dimensions(page: Page, width: number, height: number, area: number) {
  const value = async (id: string) => Number.parseFloat((await page.getByTestId(id).textContent() ?? '').replaceAll(',', ''));
  await expect.poll(() => value('polygon-width')).toBe(width);
  await expect.poll(() => value('polygon-height')).toBe(height);
  await expect.poll(() => value('polygon-area')).toBe(area);
}
async function drawFacility(page: Page) {
  await page.getByRole('button', { name: '矩形设施', exact: true }).click();
  await clickWorld(page, 0, 0);
  await clickWorld(page, 60, 30);
  await dimensions(page, 60, 30, 1800);
  return page.getByLabel('稳定 ID', { exact: true }).inputValue();
}

test('G01 real 60m x 30m facility retains world geometry after pan, zoom, browser save and refresh', async ({ page }, info) => {
  const runtimeErrors: string[] = [];
  page.on('pageerror', error => runtimeErrors.push(error.message));
  await ready(page);
  const id = await drawFacility(page);
  await page.getByLabel('名称', { exact: true }).fill('synthetic 60×30厂房');
  await page.getByRole('button', { name: '应用属性', exact: true }).click();
  await saved(page);
  const before = await download(page, info, 'facility-before.map.json');
  expect(Object.keys(before.facilities)).toEqual([id]);
  expect(before.facilities[id]!.boundary.outer).toEqual([[0, 0, 0], [60, 0, 0], [60, 30, 0], [0, 30, 0], [0, 0, 0]]);
  expect(before.facilities[id]!.heightM).toEqual({ state: 'unknown' });
  expect(before.metadata.layoutBasis).toBe('synthetic');
  await page.getByRole('button', { name: '平移', exact: true }).click();
  const p = await screenPoint(page, 80, 40);
  await page.mouse.move(p.x, p.y);
  await page.mouse.down();
  await page.mouse.move(p.x + 30, p.y - 15, { steps: 12 });
  await page.mouse.up();
  await page.mouse.wheel(0, -150);
  await dimensions(page, 60, 30, 1800);
  expect(await download(page, info, 'facility-after-view.map.json')).toEqual(before);
  await saved(page);
  await page.reload();
  await page.getByTestId('facilities-item-' + id).click();
  await dimensions(page, 60, 30, 1800);
  expect(await download(page, info, 'facility-recovered.map.json')).toEqual(before);
  expect(runtimeErrors).toEqual([]);
  await page.screenshot({ path: info.outputPath('M2A_facility_saved.png'), fullPage: true });
});

test('G04 a 100-step real facility drag with associated nodes is one undo transaction and leaves remote road nodes fixed', async ({ page }, info) => {
  await ready(page);
  await importMap(page, associatedFixture());
  await page.getByTestId('facilities-item-fA').click();
  await page.getByLabel('设施移动策略', { exact: true }).selectOption('withAssociatedNodes');
  const before = await download(page, info, 'drag-before.map.json');
  const from = await screenPoint(page, 30, 15);
  const to = await screenPoint(page, 40, 20);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 100 });
  await page.mouse.up();
  const moved = await download(page, info, 'drag-moved.map.json');
  expect(moved.facilities.fA!.boundary.outer[0]).toEqual([10, 5, 0]);
  expect(moved.nodes.nA!.position).toEqual([10, 5, 0]);
  expect(moved.nodes.nS!.position).toEqual([25, 15, 0]);
  expect(moved.nodes.nB!.position).toEqual([100, 0, 0]);
  expect(moved.roads).toEqual(before.roads);
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect(page.getByRole('button', { name: '撤销', exact: true })).toBeDisabled();
  expect(await download(page, info, 'drag-undone.map.json')).toEqual(before);
  await page.getByRole('button', { name: '重做', exact: true }).click();
  expect(await download(page, info, 'drag-redone.map.json')).toEqual(moved);
});

test('G05 real polygon drawing closes explicitly and invalid numeric vertices leave the previous map intact', async ({ page }, info) => {
  await ready(page);
  await page.getByRole('button', { name: '多边形设施', exact: true }).click();
  for (const [x, y] of [[0, 0], [60, 0], [60, 30], [0, 30]]) await clickWorld(page, x!, y!);
  await page.keyboard.press('Enter');
  await dimensions(page, 60, 30, 1800);
  const original = await download(page, info, 'polygon-valid.map.json');
  await page.getByLabel('边界编辑模式', { exact: true }).selectOption('polygon');
  await page.getByLabel('外环 顶点 2 Y (m)', { exact: true }).fill('30');
  await page.getByLabel('外环 顶点 3 Y (m)', { exact: true }).fill('0');
  await page.getByRole('button', { name: '应用属性', exact: true }).click();
  await expect(page.getByTestId('issue-panel')).toContainText('POLYGON');
  expect(await download(page, info, 'polygon-rejected.map.json')).toEqual(original);
});

test('G08 an absent background never removes rendered facilities, areas or authoritative points', async ({ page }, info) => {
  await ready(page);
  const map = missingBackgroundFixture();
  await importMap(page, map);
  await expect(page.getByTestId('readonly-notice')).toBeVisible();
  await page.getByTestId('facilities-item-fA').click();
  await dimensions(page, 60, 30, 1800);
  await expect(page.getByTestId('issue-panel')).toContainText('asset_availability');
  expect(await download(page, info, 'missing-background-preserved.map.json')).toEqual(map);
});

test('G02 true facility entrance/service creation round-trips through JSON and stays editable with stable authoritative node links', async ({ page }, info) => {
  await ready(page);
  const facilityId = await drawFacility(page);
  await page.getByRole('button', { name: '添加入口', exact: true }).click();
  const accessModal = page.getByRole('dialog', { name: '添加入口', exact: true });
  await accessModal.getByLabel('名称', { exact: true }).fill('synthetic 入口');
  await accessModal.getByLabel('所属设施', { exact: true }).selectOption(facilityId);
  await accessModal.getByLabel('定位方式', { exact: true }).selectOption('new');
  await accessModal.getByLabel('X (m)', { exact: true }).fill('0');
  await accessModal.getByLabel('Y (m)', { exact: true }).fill('0');
  await accessModal.getByRole('button', { name: '创建入口', exact: true }).click();
  await expect(accessModal).not.toBeVisible();
  const accessId = await page.getByLabel('稳定 ID', { exact: true }).inputValue();
  await page.getByRole('button', { name: '添加服务点', exact: true }).click();
  const serviceModal = page.getByRole('dialog', { name: '添加服务点', exact: true });
  await serviceModal.getByLabel('名称', { exact: true }).fill('synthetic 装卸');
  await serviceModal.getByLabel('所属设施', { exact: true }).selectOption(facilityId);
  await serviceModal.getByLabel('关联入口', { exact: true }).selectOption(accessId);
  await serviceModal.getByLabel('服务类型', { exact: true }).selectOption('loading');
  await serviceModal.getByLabel('代理到达说明', { exact: true }).fill('synthetic：该测试声明代理业务点；未建模场内转运留待场景说明');
  await serviceModal.getByLabel('定位方式', { exact: true }).selectOption('new');
  await serviceModal.getByLabel('X (m)', { exact: true }).fill('15');
  await serviceModal.getByLabel('Y (m)', { exact: true }).fill('10');
  await serviceModal.getByRole('button', { name: '创建服务点', exact: true }).click();
  await expect(serviceModal).not.toBeVisible();
  const serviceId = await page.getByLabel('稳定 ID', { exact: true }).inputValue();
  await expect(page.getByTestId('node-count')).toHaveText('2');
  await page.getByRole('button', { name: '道路折线', exact: true }).click();
  await clickWorld(page, 0, 0);
  await clickWorld(page, 15, 10);
  await expect(page.getByTestId('road-count')).toHaveText('1');
  await saved(page);
  const original = await download(page, info, 'created-associated.map.json');
  expect(original.facilities[facilityId]!.accessPointIds).toEqual([accessId]);
  expect(original.facilities[facilityId]!.servicePointIds).toEqual([serviceId]);
  expect(original.accessPoints[accessId]!.facilityId).toBe(facilityId);
  expect(original.servicePoints[serviceId]).toMatchObject({ facilityId, accessPointId: accessId });
  const accessNode = original.accessPoints[accessId]!.nodeId;
  const serviceNode = original.servicePoints[serviceId]!.nodeId;
  expect(original.nodes[accessNode]!.position).toEqual([0, 0, 0]);
  expect(original.nodes[serviceNode]!.position).toEqual([15, 10, 0]);
  expect(Object.values(original.roads)[0]).toMatchObject({ fromNodeId: accessNode, toNodeId: serviceNode });
  expect(Object.hasOwn(original.accessPoints[accessId]!, 'position')).toBe(false);
  expect(Object.hasOwn(original.servicePoints[serviceId]!, 'position')).toBe(false);
  await page.getByRole('button', { name: '新建地图', exact: true }).click();
  const newModal = page.getByRole('dialog', { name: '新建地图', exact: true });
  await newModal.getByLabel('新地图名称', { exact: true }).fill('G02 JSON重开载体');
  await newModal.getByRole('button', { name: '创建地图', exact: true }).click();
  await expect(page.getByTestId('node-count')).toHaveText('0');
  await importMap(page, original);
  await expect(page.getByTestId('readonly-notice')).not.toBeVisible();
  await page.getByTestId('facilities-item-' + facilityId).click();
  await dimensions(page, 60, 30, 1800);
  expect(await download(page, info, 'associated-reimported.map.json')).toEqual(original);
  await page.getByLabel('名称', { exact: true }).fill('JSON重开后可编辑');
  await page.getByRole('button', { name: '应用属性', exact: true }).click();
  await saved(page);
  await page.reload();
  await page.getByTestId('facilities-item-' + facilityId).click();
  await expect(page.getByLabel('名称', { exact: true })).toHaveValue('JSON重开后可编辑');
  const restored = await download(page, info, 'associated-browser-restored.map.json');
  expect(restored.accessPoints).toEqual(original.accessPoints);
  expect(restored.servicePoints).toEqual(original.servicePoints);
  expect(restored.nodes).toEqual(original.nodes);
  await page.screenshot({ path: info.outputPath('M2A_associated_restored.png'), fullPage: true });
});

test('G06 G09 grid/node snapping never creates topology; explicit split preserves physical states and design provenance', async ({ page }, info) => {
  await ready(page);
  await importMap(page, associatedFixture());
  await page.getByTestId('road-item-rAB').click();
  await page.getByLabel('道路方向', { exact: true }).selectOption('backward');
  await page.getByText('物理参数与来源', { exact: true }).click();
  await page.getByLabel('道路宽度 (m) 状态', { exact: true }).selectOption('known');
  await page.getByLabel('道路宽度 (m) 数值', { exact: true }).fill('12');
  await page.getByLabel('净高限制 (m) 状态', { exact: true }).selectOption('unrestricted');
  await page.getByLabel('承载限制 (kg) 状态', { exact: true }).selectOption('not_applicable');
  await page.getByRole('button', { name: '应用属性', exact: true }).click();
  const physical = await download(page, info, 'physical-assumptions.map.json');
  const width = physical.roads.rAB!.widthM;
  expect(width.state).toBe('known');
  if (width.state !== 'known') throw new Error('Width not committed.');
  expect(width.value).toBe(12);
  expect(width.sourceRef).toBeDefined();
  expect(physical.sources[width.sourceRef!]!.category).toBe('design_assumption');
  expect(physical.roads.rAB!.heightLimitM).toEqual({ state: 'unrestricted' });
  expect(physical.roads.rAB!.massLimitKg).toEqual({ state: 'not_applicable' });
  expect(physical.roads.rAB!.speedLimitMps).toEqual({ state: 'unknown' });
  await page.getByLabel('网格吸附', { exact: true }).selectOption('1');
  await page.getByRole('button', { name: '节点', exact: true }).click();
  await clickWorld(page, 49.7, 0.2);
  const nearNodeId = await page.getByLabel('稳定 ID', { exact: true }).inputValue();
  await expect(page.getByLabel('X (m)', { exact: true })).toHaveValue('50');
  await expect(page.getByLabel('Y (m)', { exact: true })).toHaveValue('0');
  const unsplit = await download(page, info, 'coincident-not-connected.map.json');
  expect(unsplit.roads).toEqual(physical.roads);
  expect(unsplit.nodes[nearNodeId]!.position).toEqual([50, 0, 0]);
  expect(unsplit.roads.rAB!.fromNodeId).not.toBe(nearNodeId);
  expect(unsplit.roads.rAB!.toNodeId).not.toBe(nearNodeId);
  await expect(page.getByTestId('issue-panel')).toContainText('NEAR_ROAD_UNCONNECTED');
  await page.getByLabel('网格吸附', { exact: true }).selectOption('0');
  await page.getByLabel('节点吸附', { exact: true }).check();
  await page.getByRole('button', { name: '矩形区域', exact: true }).click();
  await clickWorld(page, 50.4, 0.4);
  await clickWorld(page, 65, 15);
  const snappedZoneId = await page.getByLabel('稳定 ID', { exact: true }).inputValue();
  const snapped = await download(page, info, 'node-snapped-zone.map.json');
  expect(snapped.zones[snappedZoneId]!.boundary.outer[0]).toEqual([50, 0, 0]);
  expect(snapped.nodes).toEqual(unsplit.nodes);
  expect(snapped.roads).toEqual(physical.roads);
  await page.getByTestId('road-item-rAB').click();
  await page.getByRole('button', { name: '拆分道路', exact: true }).click();
  const splitModal = page.getByRole('dialog', { name: '拆分道路', exact: true });
  await splitModal.getByLabel('距起点距离 (m)', { exact: true }).fill('50');
  await splitModal.getByLabel('复用节点（可选）', { exact: true }).selectOption(nearNodeId);
  await splitModal.getByRole('button', { name: '确认拆分', exact: true }).click();
  await expect(splitModal).not.toBeVisible();
  const split = await download(page, info, 'explicitly-split.map.json');
  expect(Object.hasOwn(split.roads, 'rAB')).toBe(false);
  expect(Object.keys(split.roads)).toHaveLength(2);
  expect(split.nodes).toEqual(snapped.nodes);
  for (const road of Object.values(split.roads)) {
    expect(road.direction).toBe('backward');
    expect(road.widthM).toEqual(width);
    expect(road.heightLimitM).toEqual({ state: 'unrestricted' });
    expect(road.massLimitKg).toEqual({ state: 'not_applicable' });
    expect(road.speedLimitMps).toEqual({ state: 'unknown' });
  }
  const total = Object.values(split.roads).reduce((sum, road) => {
    const points = [split.nodes[road.fromNodeId]!.position, ...road.shapePoints, split.nodes[road.toNodeId]!.position];
    return sum + points.slice(1).reduce((length, p, i) => length + Math.hypot(p[0] - points[i]![0], p[1] - points[i]![1]), 0);
  }, 0);
  expect(total).toBe(100);
  expect(split.extensions['org.shipyard.editor.lineage']).toMatchObject({ roadSplits: [{ oldRoadId: 'rAB', nodeId: nearNodeId, distanceM: 50, originalLengthM: 100 }] });
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  const undone = await download(page, info, 'split-undone.map.json');
  expect(undone.roads).toEqual(physical.roads);
  expect(undone.nodes).toEqual(snapped.nodes);
  await page.getByRole('button', { name: '重做', exact: true }).click();
  expect(await download(page, info, 'split-redone.map.json')).toEqual(split);
});

test('G03 facility copy remaps member nodes without copying external roads; explicit deletion is atomic and undoable', async ({ page }, info) => {
  await ready(page);
  const original = associatedFixture();
  await importMap(page, original);
  await page.getByTestId('facilities-item-fA').click();
  await page.getByRole('button', { name: '复制', exact: true }).click();
  const copyModal = page.getByRole('dialog', { name: '复制选中对象', exact: true });
  await copyModal.getByLabel('X 偏移 (m)', { exact: true }).fill('0');
  await copyModal.getByLabel('Y 偏移 (m)', { exact: true }).fill('100');
  await copyModal.getByLabel('Z 偏移 (m)', { exact: true }).fill('0');
  await copyModal.getByRole('button', { name: '确认复制', exact: true }).click();
  await expect(copyModal).not.toBeVisible();
  const copied = await download(page, info, 'facility-copied.map.json');
  expect(Object.keys(copied.facilities)).toHaveLength(2);
  expect(Object.keys(copied.accessPoints)).toHaveLength(2);
  expect(Object.keys(copied.servicePoints)).toHaveLength(2);
  expect(Object.keys(copied.nodes)).toHaveLength(5);
  expect(copied.roads).toEqual(original.roads);
  const copyId = Object.keys(copied.facilities).find(id => id !== 'fA')!;
  const copy = copied.facilities[copyId]!;
  const accessId = copy.accessPointIds[0]!;
  const serviceId = copy.servicePointIds[0]!;
  expect(accessId).not.toBe('aA');
  expect(serviceId).not.toBe('sA');
  expect(copied.accessPoints[accessId]!.facilityId).toBe(copyId);
  expect(copied.servicePoints[serviceId]).toMatchObject({ facilityId: copyId, accessPointId: accessId });
  expect(copied.nodes[copied.accessPoints[accessId]!.nodeId]!.position).toEqual([0, 100, 0]);
  expect(copied.nodes[copied.servicePoints[serviceId]!.nodeId]!.position).toEqual([15, 110, 0]);
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  expect(await download(page, info, 'copy-undone.map.json')).toEqual(original);
  await page.getByRole('button', { name: '重做', exact: true }).click();
  expect(await download(page, info, 'copy-redone.map.json')).toEqual(copied);
  await page.getByTestId('node-item-nA').click();
  const beforeFailedDelete = await page.getByTestId('map-hash').textContent();
  await page.getByRole('button', { name: '删除', exact: true }).click();
  const nodeDeletion = page.getByRole('dialog', { name: '删除空间对象', exact: true });
  await expect(nodeDeletion.getByTestId('delete-impact')).toContainText('TOPOLOGY_DELETE_DEPENDENCIES');
  await nodeDeletion.getByRole('button', { name: '确认删除', exact: true }).click();
  await expect(nodeDeletion).toContainText('TOPOLOGY_DELETE_DEPENDENCIES');
  await expect(page.getByTestId('map-hash')).toHaveText(beforeFailedDelete!);
  await nodeDeletion.getByRole('button', { name: '取消', exact: true }).click();
  expect(await download(page, info, 'node-deletion-rejected.map.json')).toEqual(copied);
  await page.getByTestId('facilities-item-' + copyId).click();
  await page.getByRole('button', { name: '删除', exact: true }).click();
  const deleteModal = page.getByRole('dialog', { name: '删除空间对象', exact: true });
  await deleteModal.getByRole('button', { name: '确认删除', exact: true }).click();
  await expect(deleteModal).toContainText('FACILITY_HAS_POINTS');
  await expect(page.getByTestId('map-hash')).toHaveText(beforeFailedDelete!);
  await deleteModal.getByLabel('一并删除设施或区域成员入口和服务点', { exact: true }).check();
  await deleteModal.getByLabel('清理成员点不再使用的节点', { exact: true }).check();
  await deleteModal.getByRole('button', { name: '确认删除', exact: true }).click();
  await expect(deleteModal).not.toBeVisible();
  const deleted = await download(page, info, 'copy-members-deleted.map.json');
  expect(deleted.nodes).toEqual(original.nodes);
  expect(deleted.roads).toEqual(original.roads);
  expect(deleted.facilities).toEqual(original.facilities);
  expect(deleted.accessPoints).toEqual(original.accessPoints);
  expect(deleted.servicePoints).toEqual(original.servicePoints);
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  expect(await download(page, info, 'deletion-undone.map.json')).toEqual(copied);
});

test('G01 G05 requested area kinds are drawable and a facility rotation commits radian geometry rather than a canvas transform', async ({ page }, info) => {
  await ready(page);
  const facilityId = await drawFacility(page);
  for (const kind of ['work', 'buffer', 'waiting', 'water', 'obstacle']) {
    await page.getByLabel('新建区域类型', { exact: true }).selectOption(kind);
    await page.getByRole('button', { name: '矩形区域', exact: true }).click();
    await clickWorld(page, 70, 40);
    await clickWorld(page, 90, 55);
    await dimensions(page, 20, 15, 300);
  }
  const areas = await download(page, info, 'requested-zone-kinds.map.json');
  expect(Object.values(areas.zones).map(zone => zone.kind).sort()).toEqual(['buffer', 'obstacle', 'waiting', 'water', 'work']);
  expect(Object.values(areas.zones).every(zone => zone.passability === 'unknown')).toBe(true);
  await page.getByTestId('facilities-item-' + facilityId).click();
  await page.getByRole('button', { name: '旋转', exact: true }).click();
  const rotateModal = page.getByRole('dialog', { name: '旋转选中对象', exact: true });
  await rotateModal.getByLabel('旋转角度 (rad)', { exact: true }).fill(String(Math.PI / 2));
  for (const axis of ['X', 'Y', 'Z']) await rotateModal.getByLabel('中心 ' + axis + ' (m)', { exact: true }).fill('0');
  await rotateModal.getByRole('button', { name: '确认旋转', exact: true }).click();
  await expect(rotateModal).not.toBeVisible();
  const rotated = await download(page, info, 'facility-rotated.map.json');
  const outer = rotated.facilities[facilityId]!.boundary.outer;
  expect(outer[1][0]).toBeCloseTo(0, 10);
  expect(outer[1][1]).toBeCloseTo(60, 10);
  expect(outer[2][0]).toBeCloseTo(-30, 10);
  expect(outer[2][1]).toBeCloseTo(60, 10);
  expect(Object.hasOwn(rotated.facilities[facilityId]!, 'rotation')).toBe(false);
  expect(rotated.zones).toEqual(areas.zones);
  await saved(page);
  await page.reload();
  await page.getByTestId('facilities-item-' + facilityId).click();
  expect(await download(page, info, 'rotation-restored.map.json')).toEqual(rotated);
});

test('S10 G02 Ctrl+S inside a pending spatial command saves only the committed map and preserves the unfinished command', async ({ page }) => {
  await ready(page);
  await drawFacility(page);
  await saved(page);
  const hash = await page.getByTestId('map-hash').textContent();
  await page.getByRole('button', { name: '添加入口', exact: true }).click();
  const commandModal = page.getByRole('dialog', { name: '添加入口', exact: true });
  const name = commandModal.getByLabel('名称', { exact: true });
  await name.fill('尚未提交的入口');
  await name.press('Control+s');
  const saveModal = page.getByRole('dialog', { name: '有未应用输入', exact: true });
  await expect(saveModal).toBeVisible();
  await saveModal.getByRole('button', { name: '仅保存已提交地图', exact: true }).click();
  await expect(saveModal).not.toBeVisible();
  await expect(commandModal).toBeVisible();
  await expect(name).toHaveValue('尚未提交的入口');
  await expect(page.getByTestId('accessPoints-count')).toHaveText('0');
  await expect(page.getByTestId('map-hash')).toHaveText(hash!);
  await commandModal.getByRole('button', { name: '取消', exact: true }).click();
  await expect(page.getByTestId('map-hash')).toHaveText(hash!);
});
