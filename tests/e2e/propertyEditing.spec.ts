import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Polygon, Vec3, YardMap } from '../../src/domain/model';
import { GA01_TARGETS, readGA01Target } from '../helpers/GA01_targets';
import { readyWorkbench, importMapUI, browserSaved, storedWorkspace, checkpoint, expectVisiblePosition } from '../helpers/RF01_workbench';

test.use({ viewport: { width: 1920, height: 1080 } });
type PropertyKind = 'facilities' | 'zones' | 'accessPoints' | 'servicePoints';
async function current(page: Page): Promise<YardMap> {
  await browserSaved(page);
  await expect.poll(async () => (await storedWorkspace(page)).record?.draft?.contentHash).toBe(await page.getByTestId('map-hash').textContent());
  return JSON.parse((await storedWorkspace(page)).record!.draft!.mapJson) as YardMap;
}
async function click(page: Page, point: Vec3) { const p = await expectVisiblePosition(page, point); await page.mouse.click(p.x, p.y); }
async function choose(page: Page, kind: PropertyKind, id: string) {
  await page.getByRole('button', { name: '选择', exact: true }).click();
  await page.getByTestId('object-search').fill(id); await page.getByTestId(kind + '-item-' + id).click();
}
async function realBackground(page: Page, suffix: string) {
  const original = await readGA01Target(GA01_TARGETS.find(target => target.id === 'cimc_v02')!);
  const sample = structuredClone(original); sample.mapId = 'MAP_CIMC_PROPERTIES_' + suffix; sample.metadata.name = 'CIMC 完整引用属性修改验收 ' + suffix;
  await readyWorkbench(page); await importMapUI(page, sample);
  const imagePath = resolve('.cache/BG01/calibrated-cimc/background.jpg');
  const imageSHA = createHash('sha256').update(await readFile(imagePath)).digest('hex');
  expect(imageSHA).toBe('8ec6e74a72c9757f7113a440832dc9d9166518fe7f9da75979629a2cdb2ef713');
  await page.getByRole('button', { name: '底图', exact: true }).click();
  await page.getByTestId('background-file-input').setInputFiles([imagePath, resolve('.cache/BG01/calibrated-cimc/calibration.json')]);
  await expect(page.getByTestId('background-calibration-status')).toContainText('校准匹配');
  await page.getByRole('button', { name: '添加此底图', exact: true }).click();
  await expect(page.getByTestId('background-render-state')).toHaveAttribute('data-loaded', '1');
  await page.getByRole('button', { name: '适应底图', exact: true }).click();
  await page.locator('summary').filter({ hasText: /^底图显示与调整$/ }).click();
  await page.getByRole('button', { name: '收起属性面板', exact: true }).click();
  await page.getByRole('button', { name: '道路', exact: true }).click();
  await page.getByRole('button', { name: '保留原图并升级', exact: true }).click(); await expect(page.getByRole('dialog')).toHaveCount(0);
  const baseline = await current(page); expect(baseline.schemaVersion).toBe('0.3.0');
  for (const kind of ['roads', 'nodes', 'junctions', 'movements', 'resources', 'accessPoints', 'servicePoints'] as const) expect(Object.keys(baseline[kind]).length).toBeGreaterThan(0);
  expect(baseline.coordinateFrame).toEqual(original.coordinateFrame); expect(baseline.resources).toEqual(original.resources);
  return { original, baseline, imageSHA };
}
function onlyChanged(before: YardMap, after: YardMap, kind: PropertyKind, id: string, fields: Record<string, unknown>) {
  const previous = before[kind][id]!, next = after[kind][id]!;
  expect(after.revision).toBe(before.revision + 1);
  const namespace = 'org.shipyard.fast_trace.semantic';
  const semanticFields = kind === 'facilities' || kind === 'zones' ? ['name', 'kind'].filter(field => field in fields && fields[field] !== (previous as unknown as Record<string, unknown>)[field]) : [];
  expect(next).toEqual({ ...previous, ...fields, provenance: next.provenance, ...(next.extensions ? { extensions: next.extensions } : {}) });
  expect(next.provenance.category).toBe(previous.provenance.category);
  expect(next.provenance.sourceRefs ?? []).toEqual(expect.arrayContaining(previous.provenance.sourceRefs ?? []));
  if (semanticFields.length) {
    expect(Object.fromEntries(Object.entries(next.extensions ?? {}).filter(([key]) => key !== namespace))).toEqual(Object.fromEntries(Object.entries(previous.extensions ?? {}).filter(([key]) => key !== namespace)));
    const oldFields = (previous.extensions?.[namespace] as { fields: Record<string, unknown> } | undefined)?.fields ?? {};
    const newFields = (next.extensions?.[namespace] as { fields: Record<string, unknown> }).fields;
    for (const [field, state] of Object.entries(oldFields)) if (!semanticFields.includes(field)) expect(newFields[field]).toEqual(state);
    for (const field of semanticFields) {
      const sourceRef = next.provenance.fieldSources?.[field]; expect(sourceRef).toBeTruthy(); expect(after.sources[sourceRef!]!.category).toBe('drawing');
      expect(newFields[field]).toEqual({ origin: 'manual', locked: true, sourceRef, before: (previous as unknown as Record<string, unknown>)[field], after: fields[field] });
    }
  } else expect(next.extensions).toEqual(previous.extensions);
  expect(after.extensionNamespaces).toEqual({ ...before.extensionNamespaces, ...(semanticFields.length ? { [namespace]: { version: '1.0', category: 'metadata' } } : {}) });
  for (const [sourceId, source] of Object.entries(before.sources)) expect(after.sources[sourceId]).toEqual(source);
  if (kind === 'accessPoints' || kind === 'servicePoints') { expect(next.provenance).toEqual(previous.provenance); expect(after.sources).toEqual(before.sources); }
  const normalized = structuredClone(after); normalized.revision = before.revision; normalized.sources = structuredClone(before.sources); normalized.extensionNamespaces = structuredClone(before.extensionNamespaces);
  (normalized[kind] as Record<string, unknown>)[id] = structuredClone(previous);
  // Full-map equality protects all other geometry, owner/member links, arrival paths, turns and capacities.
  expect(normalized).toEqual(before);
}
async function undoRedo(page: Page, before: YardMap, after: YardMap) {
  await page.getByRole('button', { name: '撤销', exact: true }).click(); expect(await current(page)).toEqual(before);
  await page.getByRole('button', { name: '重做', exact: true }).click(); expect(await current(page)).toEqual(after);
}
function resizedRectangle(boundary: Polygon, width: number, height: number): Polygon {
  const [x, y, z] = boundary.outer[0];
  return { outer: [[x, y, z], [x + width, y, z], [x + width, y + height, z], [x, y + height, z], [x, y, z]], holes: [] };
}
async function saveReload(page: Page, info: TestInfo, expected: YardMap, original: YardMap, imageSHA: string) {
  const mapHash = await page.getByTestId('map-hash').textContent();
  await page.getByLabel('保存选项', { exact: true }).click(); await page.getByRole('button', { name: '仅保存浏览器恢复', exact: true }).click(); await checkpoint(page, mapHash!);
  await page.screenshot({ path: info.outputPath('edited-properties.png') });
  await page.reload(); await browserSaved(page); await expect(page.getByTestId('background-render-state')).toHaveAttribute('data-loaded', '1');
  expect(await current(page)).toEqual(expected); expect(await page.getByTestId('map-hash').textContent()).toBe(mapHash);
  expect(await readGA01Target(GA01_TARGETS.find(target => target.id === 'cimc_v02')!)).toEqual(original);
  expect(createHash('sha256').update(await readFile(resolve('.cache/BG01/calibrated-cimc/background.jpg'))).digest('hex')).toBe(imageSHA);
  await writeFile(info.outputPath('property-editing-evidence.json'), JSON.stringify({ imageSHA, mapHash, schemaVersion: expected.schemaVersion, fullOriginalReferencesRetained: true, eachEditOneUndoRedo: true, saveReload: true }, null, 2));
}

test('real CIMC quick zone properties and explicit dimensions apply atomically with advanced references retained', async ({ page }, info) => {
  test.setTimeout(180000);
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const { original, baseline, imageSHA } = await realBackground(page, 'ZONE');
  await page.getByLabel('区域绘制形状', { exact: true }).selectOption('zoneRect');
  await click(page, [320, 930, 0]); await click(page, [380, 990, 0]);
  const drawn = await current(page), id = Object.keys(drawn.zones).find(id => !baseline.zones[id])!;
  expect(id).toBeTruthy(); expect(drawn.zones[id]!.kind).toBe('unclassified'); expect(drawn.zones[id]!.passability).toBe('unknown');
  await choose(page, 'zones', id); await expect(page.getByLabel('区域类型', { exact: true })).toHaveValue('unclassified');
  await expect(page.getByLabel('区域通行声明', { exact: true })).toHaveValue('unknown');
  const semantic = { name: '区域普通属性验收', kind: 'buffer', passability: 'allowed' };
  await page.getByLabel('名称', { exact: true }).fill(semantic.name); await page.getByLabel('区域类型', { exact: true }).selectOption(semantic.kind);
  await page.getByLabel('区域通行声明', { exact: true }).selectOption(semantic.passability); await page.getByRole('button', { name: '应用属性', exact: true }).click();
  const renamed = await current(page); onlyChanged(drawn, renamed, 'zones', id, semantic); expect(renamed.zones[id]!.boundary).toEqual(drawn.zones[id]!.boundary);
  await undoRedo(page, drawn, renamed);
  // A passability-only change must not be mistaken for an unsupported ownership/topology change.
  await page.getByLabel('区域通行声明', { exact: true }).selectOption('explicit_access_only'); await page.getByRole('button', { name: '应用属性', exact: true }).click();
  const declared = await current(page); onlyChanged(renamed, declared, 'zones', id, { passability: 'explicit_access_only' }); await undoRedo(page, renamed, declared);
  const width = Number(await page.getByLabel('矩形宽 (m)', { exact: true }).inputValue()) + 2;
  const height = Number(await page.getByLabel('矩形高 (m)', { exact: true }).inputValue()) + 3;
  await page.getByLabel('矩形宽 (m)', { exact: true }).fill(String(width)); await page.getByLabel('矩形高 (m)', { exact: true }).fill(String(height));
  await page.getByLabel('区域通行声明', { exact: true }).selectOption('allowed'); await page.getByRole('button', { name: '应用属性', exact: true }).click();
  const resized = await current(page); onlyChanged(declared, resized, 'zones', id, { passability: 'allowed', boundary: resizedRectangle(declared.zones[id]!.boundary, width, height) });
  await undoRedo(page, declared, resized); await saveReload(page, info, resized, original, imageSHA); expect(errors).toEqual([]);
});

test('real CIMC building and existing linked-point ordinary properties preserve geometry and explicit references', async ({ page }, info) => {
  test.setTimeout(180000);
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const { original, baseline, imageSHA } = await realBackground(page, 'BUILDING_POINTS');
  await page.getByLabel('建筑绘制形状', { exact: true }).selectOption('facilityRect');
  await click(page, [320, 930, 0]); await click(page, [380, 990, 0]);
  const drawn = await current(page), facilityId = Object.keys(drawn.facilities).find(id => !baseline.facilities[id])!;
  expect(facilityId).toBeTruthy(); expect(drawn.facilities[facilityId]!.kind).toBe('building');
  await choose(page, 'facilities', facilityId); await expect(page.getByLabel('设施类型', { exact: true })).toHaveValue('building');
  const width = Number(await page.getByLabel('矩形宽 (m)', { exact: true }).inputValue()) + 2;
  const height = Number(await page.getByLabel('矩形高 (m)', { exact: true }).inputValue()) + 3;
  await page.getByLabel('名称', { exact: true }).fill('建筑分类与尺寸验收'); await page.getByLabel('设施类型', { exact: true }).selectOption('yard');
  await page.getByLabel('矩形宽 (m)', { exact: true }).fill(String(width)); await page.getByLabel('矩形高 (m)', { exact: true }).fill(String(height));
  await page.getByRole('button', { name: '应用属性', exact: true }).click();
  const classified = await current(page); onlyChanged(drawn, classified, 'facilities', facilityId, { name: '建筑分类与尺寸验收', kind: 'yard', boundary: resizedRectangle(drawn.facilities[facilityId]!.boundary, width, height) });
  expect(classified.facilities[facilityId]!.heightM).toEqual(drawn.facilities[facilityId]!.heightM); await undoRedo(page, drawn, classified);
  const accessId = Object.keys(baseline.accessPoints)[0]!; await choose(page, 'accessPoints', accessId);
  await page.getByLabel('名称', { exact: true }).fill('真实关联入口名称验收'); await page.getByRole('button', { name: '应用属性', exact: true }).click();
  const entrance = await current(page); onlyChanged(classified, entrance, 'accessPoints', accessId, { name: '真实关联入口名称验收' }); await undoRedo(page, classified, entrance);
  const serviceId = 'SP_CR002';
  expect(baseline.servicePoints[serviceId]!.kind).toBe('other');
  expect(baseline.servicePoints[serviceId]!.extensions?.['sr02.planning']).toEqual({ capability: 'loading_and_unloading', handling: 'reserved_slot_transfer_in_service_time' });
  await choose(page, 'servicePoints', serviceId);
  await page.getByLabel('名称', { exact: true }).fill('真实关联作业点普通属性验收'); await page.getByLabel('服务类型', { exact: true }).selectOption('parking');
  await page.getByRole('button', { name: '应用属性', exact: true }).click();
  await expect(page.locator('.canvas-context [role="alert"]')).toContainText('装载和卸载能力');
  await expect(page.locator('.canvas-context [role="alert"]')).toContainText('kind=other');
  expect(await current(page)).toEqual(entrance); // Neither the otherwise-valid name nor the conflicting type may commit.
  await page.getByLabel('服务类型', { exact: true }).selectOption('other'); await page.getByRole('button', { name: '应用属性', exact: true }).click();
  const service = await current(page); onlyChanged(entrance, service, 'servicePoints', serviceId, { name: '真实关联作业点普通属性验收' });
  await undoRedo(page, entrance, service);
  await choose(page, 'facilities', facilityId); await page.getByRole('button', { name: '添加作业点', exact: true }).last().click();
  const creation = page.getByRole('dialog', { name: '添加作业点', exact: true });
  await expect(creation.getByLabel('创建时接路', { exact: true })).toHaveValue('deferred'); await expect(creation.getByLabel('作业类型', { exact: true })).toHaveValue('other');
  await creation.getByLabel('名称', { exact: true }).fill('待分类的新作业点');
  await creation.getByRole('button', { name: '在画布放置作业点', exact: true }).click();
  const ring = service.facilities[facilityId]!.boundary.outer;
  await click(page, [(ring[0][0] + ring[2][0]) / 2, (ring[0][1] + ring[2][1]) / 2, ring[0][2]]);
  await creation.getByRole('button', { name: '创建作业点', exact: true }).click(); await expect(creation).toHaveCount(0);
  const created = await current(page), newId = Object.keys(created.servicePoints).find(id => !service.servicePoints[id])!;
  expect(newId).toBeTruthy(); const freshPoint = created.servicePoints[newId]!;
  expect(freshPoint.kind).toBe('other'); expect(freshPoint.extensions?.['sr02.planning']).toBeUndefined(); expect(freshPoint.arrival).toBeUndefined(); expect(freshPoint.resourceIds).toEqual([]);
  expect(freshPoint.facilityId).toBe(facilityId); expect(created.facilities[facilityId]!.servicePointIds).toEqual([...service.facilities[facilityId]!.servicePointIds, newId]);
  expect(Object.keys(created.nodes)).toHaveLength(Object.keys(service.nodes).length + 1); expect(service.nodes[freshPoint.nodeId]).toBeUndefined();
  const normalizedCreation = structuredClone(created); delete normalizedCreation.servicePoints[newId]; delete normalizedCreation.nodes[freshPoint.nodeId];
  normalizedCreation.facilities[facilityId] = structuredClone(service.facilities[facilityId]!); normalizedCreation.revision = service.revision; normalizedCreation.sources = structuredClone(service.sources);
  expect(normalizedCreation).toEqual(service); await undoRedo(page, service, created);
  await choose(page, 'servicePoints', newId);
  await page.getByLabel('名称', { exact: true }).fill('新作业点停车类型验收'); await page.getByLabel('服务类型', { exact: true }).selectOption('parking');
  await page.getByRole('button', { name: '应用属性', exact: true }).click();
  const edited = await current(page); onlyChanged(created, edited, 'servicePoints', newId, { name: '新作业点停车类型验收', kind: 'parking' });
  await undoRedo(page, created, edited); await saveReload(page, info, edited, original, imageSHA); expect(errors).toEqual([]);
});
