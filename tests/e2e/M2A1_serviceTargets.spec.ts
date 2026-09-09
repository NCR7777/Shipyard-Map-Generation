import { readFile } from 'node:fs/promises';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import type { YardMap } from '../../src/domain/model';

import { zoneServiceFixture } from '../helpers/M2A1_fixtures';

async function ready(page: Page) { await page.goto('/'); await expect(page.getByRole('button', { name: '保存工程', exact: true })).toBeEnabled(); }
async function saved(page: Page) { await expect(page.getByTestId('browser-save-status')).toContainText('已保存'); }
async function position(page: Page, x: number, y: number) {
  const box = await page.getByTestId('map-canvas').locator('canvas').first().boundingBox();
  if (!box) throw new Error('Canvas is not visible.');
  const camera = page.getByTestId('camera-state');
  return { x: box.x + Number(await camera.getAttribute('data-offset-x')) + x * Number(await camera.getAttribute('data-scale')), y: box.y + Number(await camera.getAttribute('data-offset-y')) - y * Number(await camera.getAttribute('data-scale')) };
}
async function clickWorld(page: Page, x: number, y: number) { const p = await position(page, x, y); await page.mouse.click(p.x, p.y); }
async function download(page: Page, info: TestInfo, filename: string): Promise<YardMap> {
  const pending = page.waitForEvent('download'); await page.getByRole('button', { name: '导出 JSON', exact: true }).click();
  const target = info.outputPath(filename); await (await pending).saveAs(target); return JSON.parse(await readFile(target, 'utf8')) as YardMap;
}
async function importMap(page: Page, map: YardMap) {
  await page.getByTestId('json-file-input').setInputFiles({ name: 'M2A1-input.map.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(map)) });
  const conflict = page.getByRole('dialog', { name: '未保存编辑冲突', exact: true });
  await expect.poll(async () => await conflict.isVisible() || await page.getByTestId('facilities-item-fA').isVisible()).toBe(true);
  if (await conflict.isVisible()) await conflict.getByRole('button', { name: '放弃编辑并重载', exact: true }).click();
  await expect(page.getByTestId('facilities-item-fA')).toBeVisible();
}
async function rectangle(page: Page, kind: 'facility' | 'zone', a: [number, number], b: [number, number]) {
  await page.getByRole('button', { name: kind === 'facility' ? '矩形设施' : '矩形区域', exact: true }).click();
  await clickWorld(page, ...a); await clickWorld(page, ...b);
  return page.getByLabel('稳定 ID', { exact: true }).inputValue();
}
const guard = (page: Page) => page.getByRole('dialog', { name: '未应用输入保护', exact: true });

// All creation and picking below use actual browser controls. Imports use the real JSON file input.
test('N02 an unloading target picked on an existing canvas node preserves its identity and proxy declaration after save/reload', async ({ page }, info) => {
  await ready(page);
  const facilityId = await rectangle(page, 'facility', [0, 0], [60, 30]);
  await page.getByRole('button', { name: '节点', exact: true }).click(); await clickWorld(page, 0, 0);
  const nodeId = await page.getByLabel('稳定 ID', { exact: true }).inputValue();
  const before = await download(page, info, 'before-service.map.json');
  await page.getByTestId('facilities-item-' + facilityId).click();
  await page.getByRole('button', { name: '添加服务点', exact: true }).click();
  const modal = page.getByRole('dialog', { name: '添加服务点', exact: true });
  await expect.poll(() => modal.evaluate(element => element.scrollTop)).toBe(0);
  await expect(modal.getByRole('heading', { name: '添加服务点', exact: true })).toBeInViewport();
  await modal.getByLabel('名称', { exact: true }).fill('synthetic 已有节点卸载目标');
  await modal.getByLabel('服务类型', { exact: true }).selectOption('unloading');
  await modal.getByLabel('场内转运核算', { exact: true }).selectOption('excluded_from_model');
  await modal.getByLabel('代理到达说明', { exact: true }).fill('synthetic：边界卸载代理；本批不计算室内转运');
  await modal.getByLabel('定位方式', { exact: true }).selectOption('existing');
  await modal.getByRole('button', { name: '在画布选择已有节点', exact: true }).click();
  await expect(page.getByRole('complementary', { name: '服务点画布定位' })).toBeVisible();
  await clickWorld(page, 0, 0);
  await expect(modal.getByLabel('关联节点', { exact: true })).toHaveValue(nodeId);
  await modal.getByRole('button', { name: '创建服务点', exact: true }).click();
  await expect(modal).not.toBeVisible();
  const serviceId = await page.getByLabel('稳定 ID', { exact: true }).inputValue();
  const result = await download(page, info, 'existing-node-service.map.json');
  expect(result.schemaVersion).toBe('0.2.0'); expect(result.nodes).toEqual(before.nodes);
  expect(result.servicePoints[serviceId]).toMatchObject({ nodeId, facilityId, kind: 'unloading', arrival: { mode: 'node_proxy', transferAssumption: 'excluded_from_model', note: 'synthetic：边界卸载代理；本批不计算室内转运' } });
  expect(result.facilities[facilityId]!.servicePointIds).toEqual([serviceId]);
  expect(Object.hasOwn(result.servicePoints[serviceId]!, 'position')).toBe(false);
  await saved(page); await page.reload(); await page.getByTestId('servicePoints-item-' + serviceId).click();
  await expect(page.getByLabel('权威位置节点', { exact: true })).toHaveValue(nodeId);
  await expect(page.getByLabel('服务类型', { exact: true })).toHaveValue('unloading');
  expect(await download(page, info, 'existing-target-recovered.map.json')).toEqual(result);
  await page.screenshot({ path: info.outputPath('M2A1_service_target.png'), fullPage: true });
});

test('N03 N05 a canvas-picked dedicated service node is one transaction and belongs to only the explicitly selected overlapping zone', async ({ page }, info) => {
  await ready(page);
  const firstZone = await rectangle(page, 'zone', [0, 0], [40, 40]);
  await page.getByLabel('新建区域类型', { exact: true }).selectOption('buffer');
  const secondZone = await rectangle(page, 'zone', [10, 10], [50, 50]);
  await page.getByTestId('zones-item-' + firstZone).click();
  const before = await download(page, info, 'before-zone-target.map.json');
  await page.getByRole('button', { name: '添加服务点', exact: true }).click();
  const modal = page.getByRole('dialog', { name: '添加服务点', exact: true });
  await expect(modal.getByLabel('所属区域', { exact: true })).toHaveValue(firstZone);
  await modal.getByLabel('名称', { exact: true }).fill('synthetic 区域目标草稿');
  await modal.getByLabel('代理到达说明', { exact: true }).fill('synthetic：代理场内工作位；时长留待场景明确');
  await modal.getByRole('button', { name: '在画布放置专用节点', exact: true }).click();
  await page.getByRole('button', { name: '节点', exact: true }).click();
  await expect(guard(page)).toBeVisible();
  await guard(page).getByRole('button', { name: '取消，保留输入', exact: true }).click();
  await expect(page.getByRole('complementary', { name: '服务点画布定位' })).toBeVisible();
  await clickWorld(page, 20, 20);
  await expect(modal.getByLabel('名称', { exact: true })).toHaveValue('synthetic 区域目标草稿');
  await expect(modal.getByLabel('X (m)', { exact: true })).toHaveValue('20');
  await expect(page.getByTestId('node-count')).toHaveText('0');
  await modal.getByRole('button', { name: '创建服务点', exact: true }).click();
  await expect(modal).not.toBeVisible();
  const serviceId = await page.getByLabel('稳定 ID', { exact: true }).inputValue();
  const created = await download(page, info, 'zone-target-created.map.json');
  expect(created.revision).toBe(before.revision + 1);
  expect(Object.keys(created.nodes)).toHaveLength(1);
  expect(created.servicePoints[serviceId]!.zoneId).toBe(firstZone);
  expect(created.servicePoints[serviceId]!.facilityId).toBeUndefined();
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  expect(await download(page, info, 'dedicated-target-undone.map.json')).toEqual(before);
  await page.getByRole('button', { name: '重做', exact: true }).click();
  expect(await download(page, info, 'dedicated-target-redone.map.json')).toEqual(created);
  await page.getByTestId('servicePoints-item-' + serviceId).click();
  await page.getByLabel('关联区域', { exact: true }).selectOption(secondZone);
  await page.getByRole('button', { name: '应用属性', exact: true }).click();
  await saved(page); await page.reload(); await page.getByTestId('servicePoints-item-' + serviceId).click();
  await expect(page.getByLabel('关联区域', { exact: true })).toHaveValue(secondZone);
  const reassigned = await download(page, info, 'zone-target-reassigned.map.json');
  expect(reassigned.nodes).toEqual(created.nodes);
  expect(Object.values(reassigned.servicePoints).filter(point => point.zoneId === firstZone)).toHaveLength(0);
  expect(Object.hasOwn(reassigned.zones[firstZone]!, 'servicePointIds')).toBe(false);
});


test('N25 unapplied service properties block dragging and require explicit decisions before object, tool and history changes', async ({ page }, info) => {
  await ready(page); await importMap(page, zoneServiceFixture());
  await page.getByTestId('servicePoints-item-sZone').click();
  const original = await download(page, info, 'guard-original.map.json');
  const hash = await page.getByTestId('map-hash').textContent();
  await page.getByLabel('名称', { exact: true }).fill('未应用的服务名称');
  const from = await position(page, 80, 30); const to = await position(page, 90, 35);
  await page.mouse.move(from.x, from.y); await page.mouse.down(); await page.mouse.move(to.x, to.y, { steps: 30 }); await page.mouse.up();
  await expect(page.getByTestId('map-hash')).toHaveText(hash!);
  await page.getByTestId('node-item-nB').click();
  await expect(guard(page)).toBeVisible();
  await page.screenshot({ path: info.outputPath('M2A1_unapplied_guard.png'), fullPage: true });
  await guard(page).getByRole('button', { name: '取消，保留输入', exact: true }).click();
  await expect(page.getByLabel('名称', { exact: true })).toHaveValue('未应用的服务名称');
  await page.getByLabel('名称', { exact: true }).press('Control+s');
  const saveModal = page.getByRole('dialog', { name: '有未应用输入', exact: true });
  await saveModal.getByRole('button', { name: '仅保存已提交地图', exact: true }).click();
  await expect(saveModal).not.toBeVisible();
  await expect(page.getByLabel('名称', { exact: true })).toHaveValue('未应用的服务名称');
  await expect(page.getByTestId('map-hash')).toHaveText(hash!);
  await page.getByTestId('node-item-nB').click();
  await guard(page).getByRole('button', { name: '丢弃未应用输入并继续', exact: true }).click();
  await expect(page.getByLabel('稳定 ID', { exact: true })).toHaveValue('nB');
  expect(await download(page, info, 'guard-object-switch.map.json')).toEqual(original);
  await page.getByTestId('servicePoints-item-sZone').click();
  await page.getByLabel('名称', { exact: true }).fill('工具切换前的暂存名称');
  await page.getByRole('button', { name: '节点', exact: true }).click();
  await guard(page).getByRole('button', { name: '丢弃未应用输入并继续', exact: true }).click();
  await clickWorld(page, 120, 40);
  await expect(page.getByTestId('node-count')).toHaveText('5');
  await page.getByTestId('servicePoints-item-sZone').click();
  await expect(page.getByLabel('名称', { exact: true })).toHaveValue(original.servicePoints.sZone!.name);
  await page.getByLabel('名称', { exact: true }).fill('历史切换前的暂存名称');
  await page.getByRole('button', { name: '撤销', exact: true }).focus();
  await page.keyboard.press('Control+z');
  await guard(page).getByRole('button', { name: '取消，保留输入', exact: true }).click();
  await expect(page.getByTestId('node-count')).toHaveText('5');
  await page.keyboard.press('Control+z');
  await guard(page).getByRole('button', { name: '丢弃未应用输入并继续', exact: true }).click();
  expect(await download(page, info, 'guard-history-restored.map.json')).toEqual(original);
});

test('N25 an unfinished polygon survives canceling a tool switch and disappears only after explicit discard', async ({ page }, info) => {
  await ready(page);
  await page.getByRole('button', { name: '多边形设施', exact: true }).click();
  await clickWorld(page, 0, 0); await clickWorld(page, 20, 0);
  await expect(page.getByTestId('unapplied-inputs')).toBeVisible();
  await page.getByRole('button', { name: '节点', exact: true }).click();
  await guard(page).getByRole('button', { name: '取消，保留输入', exact: true }).click();
  await clickWorld(page, 20, 20); await page.keyboard.press('Enter');
  await expect(page.getByTestId('facilities-count')).toHaveText('1');
  const first = await download(page, info, 'polygon-draft-preserved.map.json');
  expect(Object.values(first.facilities)[0]!.boundary.outer).toEqual([[0, 0, 0], [20, 0, 0], [20, 20, 0], [0, 0, 0]]);
  await page.getByRole('button', { name: '多边形设施', exact: true }).click();
  await clickWorld(page, 40, 0); await clickWorld(page, 60, 0);
  await page.getByRole('button', { name: '节点', exact: true }).click();
  await guard(page).getByRole('button', { name: '丢弃未应用输入并继续', exact: true }).click();
  await expect(page.getByTestId('unapplied-inputs')).not.toBeVisible();
  await clickWorld(page, 80, 0);
  await expect(page.getByTestId('node-count')).toHaveText('1');
  const after = await download(page, info, 'polygon-draft-discarded.map.json');
  expect(after.facilities).toEqual(first.facilities);
});

test('N09 N10 N12 a service in the middle of a road stays disconnected until explicit split; internal declarations remain unchecked', async ({ page }, info) => {
  await ready(page);
  const map = zoneServiceFixture(); map.nodes.nZone!.position = [50, 0, 0]; delete map.roads.rZone;
  await importMap(page, map); await page.getByTestId('servicePoints-item-sZone').click();
  const summary = page.getByTestId('service-connection-summary');
  await expect(summary).toContainText('SERVICE_NODE_UNCONNECTED');
  await expect(summary).toContainText('blocked');
  await page.getByTestId('road-item-rAB').click();
  await page.getByRole('button', { name: '拆分道路', exact: true }).click();
  const splitModal = page.getByRole('dialog', { name: '拆分道路', exact: true });
  await splitModal.getByLabel('距起点距离 (m)', { exact: true }).fill('50');
  await splitModal.getByLabel('复用节点（可选）', { exact: true }).selectOption('nZone');
  await splitModal.getByRole('button', { name: '确认拆分', exact: true }).click();
  await expect(splitModal).not.toBeVisible();
  const split = await download(page, info, 'target-explicit-split.map.json');
  const entryRoadId = Object.keys(split.roads).find(id => split.roads[id]!.fromNodeId === 'nA' && split.roads[id]!.toNodeId === 'nZone')!;
  expect(entryRoadId).toBeDefined();
  await page.getByTestId('servicePoints-item-sZone').click();
  await expect(summary).not.toContainText('SERVICE_NODE_UNCONNECTED');
  await expect(summary).toContainText('unchecked');
  await page.getByLabel('到达语义', { exact: true }).selectOption('explicit_internal');
  await page.getByLabel('内部路径入口节点', { exact: true }).selectOption('nA');
  await page.getByRole('button', { name: '添加内部路段', exact: true }).click();
  await page.getByLabel('内部路段 1 道路', { exact: true }).selectOption(entryRoadId);
  await page.getByRole('button', { name: '应用属性', exact: true }).click();
  await expect(summary).toContainText('continuous · 50 m');
  await expect(summary).toContainText('network_reachability');
  await expect(summary).toContainText('turn_rules');
  const declared = await download(page, info, 'target-internal-declaration.map.json');
  expect(declared.servicePoints.sZone!.arrival).toEqual({ mode: 'explicit_internal', entryNodeId: 'nA', internalPath: [{ roadId: entryRoadId, direction: 'forward' }] });
  const hash = await page.getByTestId('map-hash').textContent();
  await page.getByLabel('内部路段 1 方向', { exact: true }).selectOption('backward');
  await page.getByRole('button', { name: '应用属性', exact: true }).click();
  await expect(page.getByTestId('issue-panel')).toContainText('INTERNAL_PATH');
  await expect(page.getByTestId('map-hash')).toHaveText(hash!);
});

test('N07 a zone drag, copy and explicit member deletion retain shared-road safety and one-transaction undo', async ({ page }, info) => {
  await ready(page); const original = zoneServiceFixture(); await importMap(page, original);
  await page.getByTestId('zones-item-zA').click();
  await page.getByLabel('区域移动关联点', { exact: true }).selectOption('withAssociatedNodes');
  const from = await position(page, 72, 30); const to = await position(page, 82, 35);
  await page.mouse.move(from.x, from.y); await page.mouse.down(); await page.mouse.move(to.x, to.y, { steps: 100 }); await page.mouse.up();
  const moved = await download(page, info, 'zone-moved.map.json');
  expect(moved.nodes.nZone!.position).toEqual([90, 35, 0]);
  expect(moved.nodes.nB!.position).toEqual([100, 0, 0]);
  expect(moved.zones.zA!.boundary.outer[0]).toEqual([80, 25, 0]);
  expect(moved.roads).toEqual(original.roads);
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect(page.getByRole('button', { name: '撤销', exact: true })).toBeDisabled();
  expect(await download(page, info, 'zone-drag-undone.map.json')).toEqual(original);
  await page.getByRole('button', { name: '重做', exact: true }).click();
  await page.getByTestId('zones-item-zA').click();
  await page.getByRole('button', { name: '复制', exact: true }).click();
  const copy = page.getByRole('dialog', { name: '复制选中对象', exact: true });
  await copy.getByLabel('X 偏移 (m)', { exact: true }).fill('0'); await copy.getByLabel('Y 偏移 (m)', { exact: true }).fill('100'); await copy.getByLabel('Z 偏移 (m)', { exact: true }).fill('0');
  await copy.getByRole('button', { name: '确认复制', exact: true }).click();
  await expect(copy).not.toBeVisible();
  const copied = await download(page, info, 'zone-copied.map.json');
  const zoneId = Object.keys(copied.zones).find(id => !Object.hasOwn(original.zones, id))!;
  const service = Object.values(copied.servicePoints).find(point => point.zoneId === zoneId)!;
  expect(service).toBeDefined(); expect(copied.nodes[service.nodeId]!.position).toEqual([90, 135, 0]);
  expect(copied.roads).toEqual(original.roads);
  await page.getByTestId('zones-item-' + zoneId).click(); await page.getByRole('button', { name: '删除', exact: true }).click();
  const deletion = page.getByRole('dialog', { name: '删除空间对象', exact: true });
  await deletion.getByRole('button', { name: '确认删除', exact: true }).click();
  await expect(deletion).toContainText('ZONE_HAS_POINTS');
  await deletion.getByLabel('一并删除设施或区域成员入口和服务点', { exact: true }).check();
  await deletion.getByLabel('清理成员点不再使用的节点', { exact: true }).check();
  await deletion.getByRole('button', { name: '确认删除', exact: true }).click();
  await expect(deletion).not.toBeVisible();
  const deleted = await download(page, info, 'zone-copy-deleted.map.json');
  expect(deleted.nodes).toEqual(moved.nodes); expect(deleted.zones).toEqual(moved.zones); expect(deleted.servicePoints).toEqual(moved.servicePoints);
});

test('N06 a water-zone berth target remains a blocked draft and never changes the zone to ordinary land access', async ({ page }, info) => {
  await ready(page);
  await page.getByLabel('新建区域类型', { exact: true }).selectOption('water');
  const zoneId = await rectangle(page, 'zone', [0, 0], [30, 20]);
  await page.getByRole('button', { name: '添加服务点', exact: true }).click();
  const modal = page.getByRole('dialog', { name: '添加服务点', exact: true });
  await expect(modal).toContainText('特殊业务尚不支持');
  await modal.getByLabel('服务类型', { exact: true }).selectOption('berth');
  await modal.getByLabel('代理到达说明', { exact: true }).fill('synthetic：泊位业务声明，未声明普通陆运许可');
  await modal.getByRole('button', { name: '在画布放置专用节点', exact: true }).click(); await clickWorld(page, 0, 0);
  await modal.getByRole('button', { name: '创建服务点', exact: true }).click(); await expect(modal).not.toBeVisible();
  await expect(page.getByTestId('service-connection-summary')).toContainText('SERVICE_ZONE_LAND_ACCESS_UNSUPPORTED');
  await expect(page.getByTestId('service-connection-summary')).toContainText('blocked');
  const exported = await download(page, info, 'water-berth-draft.map.json');
  expect(exported.zones[zoneId]!.kind).toBe('water'); expect(exported.zones[zoneId]!.passability).toBe('unknown');
  expect(Object.values(exported.servicePoints)[0]).toMatchObject({ zoneId, kind: 'berth' });
  expect(exported.resources).toEqual({});
});
