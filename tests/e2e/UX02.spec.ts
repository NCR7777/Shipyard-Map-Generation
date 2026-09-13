import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import type { Polygon, Provenance, Vec3, YardMap } from '../../src/domain/model';
import { browserSaved, checkpoint, expectVisiblePosition, exportMapUI, importMapUI, readyWorkbench, selectBrowserTarget, storedWorkspace } from '../helpers/RF01_workbench';
import { drawingControl } from '../helpers/workbenchUi';

// Frozen actual inputs, never a recreated map. Explicit roots allow independent reproduction.
const cimcPath = resolve(process.env.UX02_MQ01_ROOT ?? '../../projects/MQ01_Repair_20260913', 'cimc/map.json');
const sr03Path = resolve(process.env.SHIPYARD_TEST_DATA_ROOT ?? '.cache/GA01/data-root', 'projects/shipyard_simulation_SR03/SR03_A/map.json');
const bgRoot = resolve(process.env.UX02_CALIBRATION_DIR ?? '.cache/BG01/calibrated-cimc-final');
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
async function frozen(path: string, expected: string) {
  let bytes: Buffer;
  try { bytes = await readFile(path); } catch (cause) { throw new Error('blocked_input: required UX02 original missing: ' + path, { cause }); }
  expect(sha(bytes), 'blocked_input: frozen SHA mismatch ' + path).toBe(expected);
  return { bytes, map: JSON.parse(bytes.toString('utf8')) as YardMap };
}
const cimc = () => frozen(cimcPath, '98f2fe6c3bbb290ac70fb6dde19e64fa2b25dc537e8d66720b0f6e7866273a27');
const sr03 = () => frozen(sr03Path, 'f0f296242d1aa95ff5b7c3806f852353fffdaecc519261e8ff7b3b30d106e73a');
async function choose(page: Page, kind: string, id: string, locate = false) {
  if (!await page.getByTestId('object-search').isVisible()) await page.getByRole('button', { name: '切换对象面板', exact: true }).click();
  await page.getByTestId('object-search').fill(id);
  await page.getByTestId((kind === 'nodes' ? 'node' : kind === 'roads' ? 'road' : kind) + '-item-' + id).click();
  await expect(page.getByLabel('稳定 ID', { exact: true })).toHaveValue(id);
  if (locate) await page.getByRole('button', { name: '定位 ' + id, exact: true }).click();
}
async function detail(page: Page, name: string) {
  const summary = page.locator('summary').filter({ hasText: new RegExp('^' + name + '$') });
  if (!await summary.evaluate(el => (el.parentElement as HTMLDetailsElement).open)) await summary.click();
}
async function hash(page: Page) { return (await page.getByTestId('map-hash').textContent())!; }
async function history(page: Page) { return Number((await page.locator('.canvas-status').textContent())!.match(/(\d+) 个撤销事务/)![1]); }
async function current(page: Page, info: TestInfo, name: string) { return (await exportMapUI(page, info, name)).map; }
async function undoRedo(page: Page, info: TestInfo, before: YardMap, after: YardMap, label: string) {
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  expect(await current(page, info, label + '-undo')).toEqual(before);
  await page.getByRole('button', { name: '重做', exact: true }).click();
  expect(await current(page, info, label + '-redo')).toEqual(after);
}
async function roundtrip(page: Page, info: TestInfo, expected: YardMap, label: string, background = false) {
  const contentHash = await hash(page), version = (await storedWorkspace(page)).record!.storageVersion;
  await page.getByRole('button', { name: '保存工程', exact: true }).click(); await selectBrowserTarget(page);
  const record = await checkpoint(page, contentHash, version);
  expect(JSON.parse(record.checkpoint!.mapJson)).toEqual(expected);
  await page.reload(); await expect(page.getByTestId('map-hash')).toHaveText(contentHash, { timeout: 30000 });
  if (background) await expect(page.getByTestId('background-render-state')).toHaveAttribute('data-loaded', '1', { timeout: 30000 });
  const exported = await exportMapUI(page, info, label + '-refreshed'); expect(exported.map).toEqual(expected);
  await importMapUI(page, expected, await readFile(exported.path));
  expect(await current(page, info, label + '-reimported')).toEqual(expected);
  if (background) await expect(page.getByTestId('background-render-state')).toHaveAttribute('data-loaded', '1', { timeout: 30000 });
}
const source = { name: '编辑器人工几何设计假设', category: 'design_assumption' as const, description: '用户在本地米制编辑器中修改的几何字段；保留原始来源，未经现场测量或地理配准核验。' };
function attribute(map: YardMap, provenance: Provenance, field: string) {
  map.sources.source_editor_geometry = source;
  provenance.sourceRefs = [...new Set([...(provenance.sourceRefs ?? []), ...(provenance.fieldSources?.[field] ? [provenance.fieldSources[field]!] : []), 'source_editor_geometry'])];
  provenance.fieldSources = { ...provenance.fieldSources, [field]: 'source_editor_geometry' };
}
function shifted(polygon: Polygon): Polygon {
  const move = ([x,y,z]: Vec3): Vec3 => [x-10,y+5,z];
  return { outer: polygon.outer.map(move) as Polygon['outer'], holes: polygon.holes.map(r => r.map(move) as Polygon['outer']) };
}

// Ordinary UI and downloads establish success. IndexedDB is read only for persisted checkpoint receipts.
test('UX02 real MQ01 CIMC calibrated contour, business identity relocation and sparse road width', async ({ page }, info) => {
  test.setTimeout(180000); const errors: string[] = []; page.on('pageerror', e => errors.push(e.message));
  const input = await cimc(); const imagePath = resolve(bgRoot, 'background.jpg'), calibrationPath = resolve(bgRoot, 'calibration.json');
  expect(sha(await readFile(imagePath))).toBe('8ec6e74a72c9757f7113a440832dc9d9166518fe7f9da75979629a2cdb2ef713');
  expect(sha(await readFile(calibrationPath))).toBe('f7d3c735f12d891fd20125a7495a274e959de27c496301eda4d34a32446777db');
  await readyWorkbench(page); await importMapUI(page, input.map, input.bytes);
  await page.getByRole('button', { name: '底图', exact: true }).click();
  await page.getByTestId('background-file-input').setInputFiles([imagePath, calibrationPath]);
  await expect(page.getByTestId('background-calibration-status')).toContainText('校准匹配');
  await page.getByRole('button', { name: '添加此底图', exact: true }).click();
  await expect(page.getByTestId('background-render-state')).toHaveAttribute('data-loaded', '1', { timeout: 30000 });
  await browserSaved(page); const before = await current(page, info, 'cimc-calibrated');
  const vector = structuredClone(before); vector.revision = input.map.revision; vector.sources = input.map.sources; vector.assets = input.map.assets; vector.backgroundLayers = input.map.backgroundLayers;
  expect(vector).toEqual(input.map); expect(Object.values(before.backgroundLayers)[0]!.imageToWorld).toEqual([1,0,0,-1,0,1340]);
  await page.screenshot({ path: info.outputPath('cimc-before.png'), fullPage: true });
  await choose(page, 'facilities', 'F_CR002', true);
  await page.getByLabel('边界编辑模式', { exact: true }).selectOption('polygon'); await detail(page, '边界顶点 · m');
  await page.getByLabel('外环 顶点 2 X (m)', { exact: true }).fill('199.75');
  await page.getByLabel('外环 顶点 3 X (m)', { exact: true }).fill('199.75');
  const h = await history(page); await page.getByRole('button', { name: '应用属性', exact: true }).click();
  await expect.poll(() => history(page)).toBe(h+1);
  const contour = await current(page, info, 'cimc-contour'); const expected = structuredClone(before); expected.revision++;
  expected.facilities.F_CR002!.boundary.outer[1][0] = 199.75; expected.facilities.F_CR002!.boundary.outer[2][0] = 199.75;
  attribute(expected, expected.facilities.F_CR002!.provenance, 'boundary'); expect(contour).toEqual(expected);
  await undoRedo(page, info, before, contour, 'contour');
  await (await drawingControl(page, '网格吸附')).selectOption('0'); await (await drawingControl(page, '节点吸附')).uncheck();
  await choose(page, 'facilities', 'F_CR002');
  await page.getByRole('button', { name: '编辑内部', exact: true }).click();
  await expect(page.locator('.canvas-context')).toContainText('公共路网固定');
  await choose(page, 'nodes', 'N_CR_58611c2314', true);
  await expect(page.getByLabel('X (m)', { exact: true })).toBeDisabled();
  const publicPoint = await expectVisiblePosition(page, [300,1023,0]);
  await page.mouse.move(publicPoint.x, publicPoint.y); await page.mouse.down();
  await page.mouse.move(publicPoint.x+12, publicPoint.y-8, { steps: 20 }); await page.mouse.up();
  expect(await current(page, info, 'cimc-internal-public-anchor-guard')).toEqual(contour); expect(await history(page)).toBe(h+1);
  await choose(page, 'accessPoints', 'AP_CR002', true);
  const mark = await expectVisiblePosition(page, [285,1023,0]); await page.mouse.click(mark.x, mark.y);
  await expect(page.locator('.canvas-context')).toContainText('此节点有多个业务身份');
  await page.locator('.canvas-context').getByRole('button', { name: '入口 · ' + contour.accessPoints.AP_CR002!.name, exact: true }).click();
  await page.getByRole('button', { name: '在画布重新定位', exact: true }).click(); await page.keyboard.press('Escape');
  expect(await current(page, info, 'cimc-relocate-cancel')).toEqual(contour); expect(await history(page)).toBe(h+1);
  await page.getByRole('button', { name: '在画布重新定位', exact: true }).click();
  const target = await expectVisiblePosition(page, [285,1023.1,0]); await page.mouse.click(target.x, target.y);
  await expect.poll(() => history(page)).toBe(h+2);
  const moved = await current(page, info, 'cimc-point-moved');
  expect(moved.nodes.N_CR_f12fb4afb8!.position[0]).toBeCloseTo(285, 8); expect(moved.nodes.N_CR_f12fb4afb8!.position[1]).toBeCloseTo(1023.1, 8);
  const expectedMove = structuredClone(contour); expectedMove.revision++; expectedMove.nodes.N_CR_f12fb4afb8!.position = moved.nodes.N_CR_f12fb4afb8!.position;
  expect(expectedMove.nodes.N_CR_f12fb4afb8!.position[2]).toBe(0); attribute(expectedMove, expectedMove.nodes.N_CR_f12fb4afb8!.provenance, 'position');
  expect(moved).toEqual(expectedMove); await undoRedo(page, info, contour, moved, 'point');
  await page.getByRole('button', { name: '退出内部编辑', exact: true }).click();
  await choose(page, 'roads', 'R_CR_b0741fb08f');
  await page.getByLabel('道路宽度 (m) 数值', { exact: true }).fill('7.5'); await page.getByRole('button', { name: '应用属性', exact: true }).click();
  await expect.poll(() => history(page)).toBe(h+3);
  const narrowed = await current(page, info, 'cimc-road-width'); const expectedWidth = structuredClone(moved); expectedWidth.revision++;
  const width = narrowed.roads.R_CR_b0741fb08f!.widthM; expect(width.state).toBe('known'); if (width.state !== 'known') throw Error('width was not committed');
  expect(width.value).toBe(7.5); expect(width.sourceRef).toBeTruthy();
  expectedWidth.sources[width.sourceRef!] = { name: '道路参数设计假设', category: 'design_assumption', description: '用户数值输入，未经现场核验' };
  expectedWidth.roads.R_CR_b0741fb08f!.widthM = { state: 'known', value: 7.5, sourceRef: width.sourceRef };
  expectedWidth.roads.R_CR_b0741fb08f!.provenance.fieldSources = { ...expectedWidth.roads.R_CR_b0741fb08f!.provenance.fieldSources, widthM: width.sourceRef! };
  expect(narrowed).toEqual(expectedWidth); await undoRedo(page, info, moved, narrowed, 'width');
  await page.screenshot({ path: info.outputPath('cimc-after.png'), fullPage: true }); await roundtrip(page, info, narrowed, 'cimc-final', true);
  await page.screenshot({path:info.outputPath('cimc-restored.png'),fullPage:true});
  await cimc(); expect(sha(await readFile(imagePath))).toBe('8ec6e74a72c9757f7113a440832dc9d9166518fe7f9da75979629a2cdb2ef713');
  expect(sha(await readFile(calibrationPath))).toBe('f7d3c735f12d891fd20125a7495a274e959de27c496301eda4d34a32446777db'); expect(errors).toEqual([]);
});

test('UX02 real synthetic SR03 A parking owner drag moves three slots and eight internal nodes in one transaction', async ({ page }, info) => {
  test.setTimeout(150000); const errors: string[] = []; page.on('pageerror', e => errors.push(e.message)); const input = await sr03(); await readyWorkbench(page); await importMapUI(page, input.map, input.bytes);
  await (await drawingControl(page, '网格吸附')).selectOption('1'); await (await drawingControl(page, '节点吸附')).uncheck();
  await choose(page, 'zones', 'Z_005', true); await page.screenshot({ path: info.outputPath('sr03-before.png'), fullPage: true });
  const beforeHash = await hash(page), h = await history(page);
  const from = await expectVisiblePosition(page, [459,94,0]), to = await expectVisiblePosition(page, [449,99,0]);
  await page.mouse.move(from.x,from.y); await page.mouse.down(); await page.mouse.move(to.x,to.y,{steps:100});
  expect(await hash(page)).toBe(beforeHash); expect(await history(page)).toBe(h); await page.mouse.up();
  await expect.poll(() => history(page)).toBe(h+1);
  const moved = await current(page, info, 'sr03-owner-moved'), expected = structuredClone(input.map); expected.revision++;
  const nodeIds = ['N_0031','N_0032','N_0033','N_0035','N_0036','N_0037','N_0038','N_0039'];
  expected.zones.Z_005!.boundary = shifted(expected.zones.Z_005!.boundary); attribute(expected, expected.zones.Z_005!.provenance, 'boundary');
  const slots = (expected.zones.Z_005!.extensions!['sr02.planning'] as { slots:{boundary:Polygon}[] }).slots; expect(slots).toHaveLength(3);
  slots.forEach((slot,i) => { slot.boundary = shifted(slot.boundary); attribute(expected, expected.zones.Z_005!.provenance, 'extensions/sr02.planning/slots/' + i + '/boundary'); });
  for (const id of nodeIds) { const [x,y,z] = expected.nodes[id]!.position; expected.nodes[id]!.position = [x-10,y+5,z]; attribute(expected, expected.nodes[id]!.provenance, 'position'); }
  const internal = Object.values(expected.junctions).filter(j => j.boundary && j.nodeIds.every(n => nodeIds.includes(n))); expect(internal).toHaveLength(2);
  internal.forEach(j => { j.boundary = shifted(j.boundary!); attribute(expected, j.provenance, 'boundary'); });
  expect(moved).toEqual(expected); // Includes every public anchor, road ref, source, service, resource and slot capacity.
  await undoRedo(page, info, input.map, moved, 'sr03-owner'); await page.screenshot({path:info.outputPath('sr03-after.png'),fullPage:true});
  await roundtrip(page, info, moved, 'sr03-final'); await page.screenshot({path:info.outputPath('sr03-restored.png'),fullPage:true}); await sr03(); expect(errors).toEqual([]);
});

test('UX02 real road units, explicit width clear preview, invalid draft and no-op preserve hidden declarations exactly', async ({ page }, info) => {
  test.setTimeout(120000); const input = await cimc(); await readyWorkbench(page); await importMapUI(page, input.map, input.bytes);
  await choose(page, 'roads', 'R_CR_b0741fb08f'); const beforeHash = await hash(page), h = await history(page);
  await expect(page.getByLabel('稳定 ID', {exact:true})).toBeHidden(); await detail(page, '通行限制与来源');
  await page.getByLabel('速度显示单位', {exact:true}).selectOption('m/s'); await page.getByLabel('质量显示单位', {exact:true}).selectOption('kg');
  await page.getByLabel('速度显示单位', {exact:true}).selectOption('km/h'); await page.getByLabel('质量显示单位', {exact:true}).selectOption('t');
  await page.getByRole('button', {name:'应用属性',exact:true}).click(); expect(await hash(page)).toBe(beforeHash); expect(await history(page)).toBe(h);
  await page.getByLabel('道路宽度 (m) 数值', {exact:true}).fill(''); await expect(page.locator('.property-content')).toContainText('应用后将改为未知，尚未提交');
  await page.getByLabel('道路宽度 (m) 数值', {exact:true}).fill('8'); await page.getByRole('button', {name:'应用属性',exact:true}).click();
  expect(await current(page,info,'unit-and-width-noop')).toEqual(input.map); expect(await history(page)).toBe(h);
  await page.getByLabel('道路宽度 (m) 数值', {exact:true}).fill('-1'); await page.getByRole('button', {name:'应用属性',exact:true}).click();
  await expect(page.getByRole('alert')).toBeVisible(); expect(await hash(page)).toBe(beforeHash); expect(await history(page)).toBe(h);
  await page.getByLabel('道路宽度 (m) 数值', {exact:true}).fill('8'); await page.getByRole('button', {name:'应用属性',exact:true}).click();
  const originalName = input.map.roads.R_CR_b0741fb08f!.name; await page.getByLabel('名称', {exact:true}).fill(originalName + '（显示命名测试）');
  await page.getByRole('button', {name:'应用属性',exact:true}).click(); const renamed = await current(page,info,'sparse-name');
  const expected = structuredClone(input.map); expected.revision++; expected.roads.R_CR_b0741fb08f!.name += '（显示命名测试）'; expect(renamed).toEqual(expected);
  await undoRedo(page, info, input.map, renamed, 'sparse-name'); await roundtrip(page,info,renamed,'units-saved');
  await choose(page,'roads','R_CR_b0741fb08f'); await detail(page,'通行限制与来源');
  await expect(page.getByLabel('速度显示单位',{exact:true})).toHaveValue('km/h'); await expect(page.getByLabel('质量显示单位',{exact:true})).toHaveValue('t'); await cimc();
});
