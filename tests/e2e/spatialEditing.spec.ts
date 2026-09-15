import { expect, test, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Polygon, Vec3, YardMap } from '../../src/domain/model';
import { GA01_TARGETS, readGA01Target } from '../helpers/GA01_targets';
import { readyWorkbench, importMapUI, browserSaved, storedWorkspace, checkpoint, expectVisiblePosition } from '../helpers/RF01_workbench';

test.use({ viewport: { width: 1920, height: 1080 } });
const imageSHA = '8ec6e74a72c9757f7113a440832dc9d9166518fe7f9da75979629a2cdb2ef713';
async function current(page: Page): Promise<YardMap> {
  await browserSaved(page);
  await expect.poll(async () => (await storedWorkspace(page)).record?.draft?.contentHash).toBe(await page.getByTestId('map-hash').textContent());
  return JSON.parse((await storedWorkspace(page)).record!.draft!.mapJson) as YardMap;
}
async function click(page: Page, point: Vec3) { const p = await expectVisiblePosition(page, point); await page.mouse.click(p.x, p.y); }
async function drag(page: Page, from: Vec3, to: Vec3) {
  const a = await expectVisiblePosition(page, from), b = await expectVisiblePosition(page, to);
  await page.mouse.move(a.x, a.y); await page.mouse.down(); await page.mouse.move(b.x, b.y, { steps: 20 }); await page.mouse.up();
}
async function undoRedo(page: Page, before: YardMap, after: YardMap) {
  expect(after.revision).toBe(before.revision + 1);
  await page.getByRole('button', { name: '撤销', exact: true }).click(); expect(await current(page)).toEqual(before);
  await page.getByRole('button', { name: '重做', exact: true }).click(); expect(await current(page)).toEqual(after);
}
async function realBackground(page: Page, name: string) {
  const original = await readGA01Target(GA01_TARGETS.find(target => target.id === 'cimc_v02')!);
  const map = structuredClone(original); map.mapId = 'MAP_CIMC_' + name; map.metadata.name = 'CIMC 真实底图 ' + name + ' 验收副本';
  for (const key of ['nodes', 'roads', 'junctions', 'movements', 'facilities', 'zones', 'accessPoints', 'servicePoints', 'resources', 'extensions', 'extensionNamespaces', 'assets', 'backgroundLayers'] as const) (map as unknown as Record<string, unknown>)[key] = {};
  const imagePath = resolve('.cache/BG01/calibrated-cimc/background.jpg');
  expect(createHash('sha256').update(await readFile(imagePath)).digest('hex')).toBe(imageSHA);
  await readyWorkbench(page); await importMapUI(page, map);
  await page.getByRole('button', { name: '底图', exact: true }).click();
  await page.getByTestId('background-file-input').setInputFiles([imagePath, resolve('.cache/BG01/calibrated-cimc/calibration.json')]);
  await expect(page.getByTestId('background-calibration-status')).toContainText('校准匹配');
  await page.getByRole('button', { name: '添加此底图', exact: true }).click();
  await expect(page.getByTestId('background-render-state')).toHaveAttribute('data-loaded', '1');
  await page.getByRole('button', { name: '适应底图', exact: true }).click();
  await page.locator('summary').filter({ hasText: /^底图显示与调整$/ }).click();
  await page.getByRole('button', { name: '收起属性面板', exact: true }).click();
  await page.getByRole('button', { name: '道路', exact: true }).click();
  await page.getByRole('button', { name: '保留原图并升级', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const center = await expectVisiblePosition(page, [450, 1040, 0]); await page.mouse.move(center.x, center.y);
  for (let i = 0; i < 5; i++) { const scale = Number(await page.getByTestId('camera-state').getAttribute('data-scale')); await page.mouse.wheel(0, -120); await expect.poll(async () => Number(await page.getByTestId('camera-state').getAttribute('data-scale'))).toBeGreaterThan(scale); }
  return original;
}
function expectRectangle(polygon: Polygon) {
  expect(polygon.outer).toHaveLength(5); expect(polygon.outer[4]).toEqual(polygon.outer[0]); expect(polygon.holes).toEqual([]);
  const edges = polygon.outer.slice(0, -1).map((a, i) => { const b = polygon.outer[i + 1]!; return [b[0] - a[0], b[1] - a[1]]; });
  edges.forEach((a, i) => { const b = edges[(i + 1) % 4]!; expect(a[0]! * b[0]! + a[1]! * b[1]!).toBeCloseTo(0, 6); expect(Math.hypot(...a)).toBeGreaterThan(10); });
  expect(Math.abs(edges[0]![0]!)).toBeGreaterThan(1); expect(Math.abs(edges[0]![1]!)).toBeGreaterThan(1);
}

for (const kind of ['facilities', 'zones'] as const) test('real CIMC ' + kind + ' three-point rectangles and polygons support canvas edits in one history', async ({ page, browser }, info) => {
  test.setTimeout(120000);
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const original = await realBackground(page, 'SPATIAL_' + kind);
  const shape = page.getByRole('combobox', { name: kind === 'facilities' ? '建筑绘制形状' : '区域绘制形状', exact: true });
  await shape.selectOption(kind === 'facilities' ? 'facilityOrientedRect' : 'zoneOrientedRect');
  await click(page, [320, 1020, 0]); await click(page, [320, 1020, 0]); // Invalid second point leaves the first point usable.
  await click(page, [400, 1050, 0]); await click(page, [390, 1090, 0]);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const created = await current(page), rectId = Object.keys(created[kind])[0]!;
  expect(Object.keys(created[kind])).toHaveLength(1); expectRectangle(created[kind][rectId]!.boundary);
  await page.getByRole('button', { name: '选择', exact: true }).click(); await click(page, [355, 1050, 0]);
  await expect(page.getByTestId('boundary-handles')).toHaveAttribute('data-mode', 'rectangle');
  const corners = created[kind][rectId]!.boundary.outer, from = corners[2]!, fixed = corners[0]!;
  await drag(page, from, [from[0] + 20, from[1] + 12, from[2]]);
  const resized = await current(page); expectRectangle(resized[kind][rectId]!.boundary);
  expect(resized[kind][rectId]!.boundary.outer[0]).toEqual(fixed); expect(resized[kind][rectId]!.boundary).not.toEqual(created[kind][rectId]!.boundary);
  expect(resized.nodes).toEqual(created.nodes); expect(resized.roads).toEqual(created.roads); await undoRedo(page, created, resized);
  await shape.selectOption(kind === 'facilities' ? 'facilityPolygon' : 'zonePolygon');
  for (const point of [[470, 1000, 0], [560, 1000, 0], [575, 1035, 0], [535, 1070, 0], [480, 1050, 0]] as Vec3[]) await click(page, point);
  await page.keyboard.press('Enter'); await expect(page.getByRole('dialog')).toHaveCount(0);
  const polygons = await current(page), polygonId = Object.keys(polygons[kind]).find(id => id !== rectId)!;
  expect(Object.keys(polygons[kind])).toHaveLength(2); expect(polygons[kind][polygonId]!.boundary.outer).toHaveLength(6);
  await page.getByRole('button', { name: '选择', exact: true }).click(); await click(page, [520, 1030, 0]);
  await expect(page.getByTestId('boundary-handles')).toHaveAttribute('data-mode', 'polygon');
  const ring = polygons[kind][polygonId]!.boundary.outer, midpoint: Vec3 = [(ring[0][0] + ring[1][0]) / 2, (ring[0][1] + ring[1][1]) / 2, 0];
  await click(page, midpoint);
  const inserted = await current(page); expect(inserted[kind][polygonId]!.boundary.outer).toHaveLength(7);
  expect(inserted[kind][polygonId]!.boundary.outer[1]).toEqual(midpoint); await undoRedo(page, polygons, inserted);
  const moved: Vec3 = [midpoint[0], midpoint[1] - 12, 0]; await drag(page, midpoint, moved);
  const dragged = await current(page); expect(dragged[kind][polygonId]!.boundary.outer[1]).not.toEqual(midpoint); await undoRedo(page, inserted, dragged);
  await page.keyboard.down('Alt'); await click(page, dragged[kind][polygonId]!.boundary.outer[1]); await page.keyboard.up('Alt');
  const removed = await current(page); expect(removed[kind][polygonId]!.boundary).toEqual(polygons[kind][polygonId]!.boundary); await undoRedo(page, dragged, removed);
  expect(removed[kind][rectId]).toEqual(resized[kind][rectId]); expect(removed.nodes).toEqual(created.nodes); expect(removed.roads).toEqual(created.roads);
  await page.screenshot({ path: info.outputPath('01-' + kind + '-canvas-edited.png') });
  const hash = await page.getByTestId('map-hash').textContent(); await page.getByLabel('保存选项', { exact: true }).click();
  await page.getByRole('button', { name: '仅保存浏览器恢复', exact: true }).click(); await checkpoint(page, hash!);
  await page.reload(); await browserSaved(page); await expect(page.getByTestId('background-render-state')).toHaveAttribute('data-loaded', '1');
  expect(await current(page)).toEqual(removed); expect(await readGA01Target(GA01_TARGETS.find(target => target.id === 'cimc_v02')!)).toEqual(original); expect(errors).toEqual([]);
  await writeFile(info.outputPath('spatial-editing-evidence.json'), JSON.stringify({ browser: browser.version(), imageSHA, kind, mapHash: hash, threePointRectangle: true, invalidBaseRetry: true, rectangleDragKeepsRightAngles: true, polygonCanvasInsertDragDelete: true, eachEditOneUndo: true, saveReload: true }, null, 2));
});

test('real CIMC unconnected entrances and work points reuse their nodes when drawing a later road', async ({ page, browser }, info) => {
  test.setTimeout(120000);
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const original = await realBackground(page, 'DEFERRED_POINTS');
  await click(page, [320, 1000, 0]); await click(page, [320, 1100, 0]); await page.keyboard.press('Enter');
  await page.getByLabel('建筑绘制形状', { exact: true }).selectOption('facilityRect');
  await click(page, [400, 1020, 0]); await click(page, [470, 1080, 0]);
  const base = await current(page), facilityId = Object.keys(base.facilities)[0]!, publicRoadId = Object.keys(base.roads)[0]!;
  expect(Object.keys(base.nodes)).toHaveLength(2); expect(Object.keys(base.roads)).toHaveLength(1);
  const ring = base.facilities[facilityId]!.boundary.outer, gate: Vec3 = [ring[0][0], (ring[0][1] + ring[2][1]) / 2, 0];
  const chooseOwner = async () => { await page.getByRole('button', { name: '选择', exact: true }).click(); await page.getByTestId('object-search').fill(facilityId); await page.getByTestId('facilities-item-' + facilityId).click(); };
  await chooseOwner(); await page.getByRole('button', { name: '添加入口', exact: true }).last().click();
  const accessDialog = page.getByRole('dialog', { name: '添加入口', exact: true });
  await expect(accessDialog.getByLabel('创建时接路', { exact: true })).toHaveValue('deferred');
  await accessDialog.getByRole('button', { name: '在画布放置入口', exact: true }).click();
  const near = await expectVisiblePosition(page, gate); await page.mouse.move(near.x - 4, near.y); await page.mouse.click(near.x - 4, near.y);
  await expect(accessDialog).toBeVisible(); await accessDialog.getByRole('button', { name: '创建入口', exact: true }).click(); await expect(accessDialog).toHaveCount(0);
  const entrance = await current(page), accessId = Object.keys(entrance.accessPoints)[0]!, access = entrance.accessPoints[accessId]!, gateNode = entrance.nodes[access.nodeId]!;
  expect(gateNode.position[0]).toBeCloseTo(gate[0], 8); expect(Math.abs(gateNode.position[1] - gate[1])).toBeLessThanOrEqual(1.5 / near.scale);
  expect(Object.keys(entrance.nodes)).toHaveLength(3); expect(entrance.roads).toEqual(base.roads);
  for (const [id, node] of Object.entries(base.nodes)) expect(entrance.nodes[id]).toEqual(node);
  expect(entrance.facilities[facilityId]!.accessPointIds).toEqual([accessId]); expect(entrance.facilities[facilityId]!.boundary).toEqual(base.facilities[facilityId]!.boundary);
  await undoRedo(page, base, entrance);
  await chooseOwner(); await page.getByRole('button', { name: '添加作业点', exact: true }).last().click();
  const serviceDialog = page.getByRole('dialog', { name: '添加作业点', exact: true });
  await expect(serviceDialog.getByLabel('创建时接路', { exact: true })).toHaveValue('deferred'); await expect(serviceDialog.getByLabel('作业类型', { exact: true })).toHaveValue('other');
  await serviceDialog.getByRole('button', { name: '在画布放置作业点', exact: true }).click(); await click(page, [435, 1050, 0]);
  await serviceDialog.getByRole('button', { name: '创建作业点', exact: true }).click(); await expect(serviceDialog).toHaveCount(0);
  const service = await current(page), serviceId = Object.keys(service.servicePoints)[0]!, work = service.servicePoints[serviceId]!;
  expect(Object.keys(service.nodes)).toHaveLength(4); expect(work.nodeId).not.toBe(access.nodeId); expect(work.kind).toBe('other'); expect(work.arrival).toBeUndefined(); expect(work.resourceIds).toEqual([]);
  expect(service.roads).toEqual(base.roads); expect(service.accessPoints).toEqual(entrance.accessPoints);
  for (const [id, node] of Object.entries(entrance.nodes)) expect(service.nodes[id]).toEqual(node);
  await undoRedo(page, entrance, service);
  await page.getByTestId('object-search').fill(''); await click(page, gateNode.position); await page.keyboard.press('f'); await page.keyboard.press('r');
  await click(page, gateNode.position); await expect(page.getByTestId('road-draft-instruction')).toBeVisible();
  const publicRoad = base.roads[publicRoadId]!, publicA = base.nodes[publicRoad.fromNodeId]!.position;
  await click(page, [publicA[0], gateNode.position[1], 0]); await page.keyboard.press('Enter');
  const connected = await current(page);
  expect(Object.keys(connected.roads)).toHaveLength(3); expect(Object.keys(connected.nodes)).toHaveLength(5);
  const connector = Object.values(connected.roads).filter(road => road.fromNodeId === access.nodeId || road.toNodeId === access.nodeId);
  expect(connector).toHaveLength(1); const otherId = connector[0]!.fromNodeId === access.nodeId ? connector[0]!.toNodeId : connector[0]!.fromNodeId;
  expect(connected.nodes[otherId]!.position[0]).toBeCloseTo(publicA[0], 8);
  expect(Object.values(connected.roads).filter(road => road.fromNodeId === otherId || road.toNodeId === otherId)).toHaveLength(3);
  expect(connected.accessPoints).toEqual(service.accessPoints); expect(connected.servicePoints).toEqual(service.servicePoints); expect(connected.facilities).toEqual(service.facilities);
  for (const [id, node] of Object.entries(service.nodes)) expect(connected.nodes[id]).toEqual(node);
  await undoRedo(page, service, connected);
  await page.screenshot({ path: info.outputPath('02-deferred-points-connected.png') });
  const hash = await page.getByTestId('map-hash').textContent(); await page.getByLabel('保存选项', { exact: true }).click(); await page.getByRole('button', { name: '仅保存浏览器恢复', exact: true }).click(); await checkpoint(page, hash!);
  await page.reload(); await browserSaved(page); await expect(page.getByTestId('background-render-state')).toHaveAttribute('data-loaded', '1'); expect(await current(page)).toEqual(connected);
  expect(await readGA01Target(GA01_TARGETS.find(target => target.id === 'cimc_v02')!)).toEqual(original); expect(errors).toEqual([]);
  await writeFile(info.outputPath('deferred-points-evidence.json'), JSON.stringify({ browser: browser.version(), imageSHA, mapHash: hash, outsideBoundaryOffsetPixels: 4, projectedGatePosition: gateNode.position, entranceAndServiceInitiallyUnconnected: true, explicitRReusesEntranceNode: access.nodeId, publicRoadSplitNode: otherId, eachEditOneUndo: true, saveReload: true }, null, 2));
});