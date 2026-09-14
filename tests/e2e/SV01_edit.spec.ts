import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import type { Provenance, YardMap } from '../../src/domain/model';
import { exportMapUI, importMapUI, readyWorkbench } from '../helpers/RF01_workbench';
import { openChecks, revealProperty, saveToBrowser } from '../helpers/workbenchUi';

const path = resolve(process.env.UX02_MQ01_ROOT ?? '../../projects/MQ01_Repair_20260913', 'geoje/map.json');
const sha256 = 'c39ebb10a02e61047fb5de0e5d19a4ddf02d19b9f6e3e67ad7fc355740b5ae27';
const cases = [
  { id: 'F_GJ_MR_045', nodes: ['N_MR_8bad8c4f48bb'], fixed: 'N_MR_28aee709ec34' },
  { id: 'F_GJ_MR_061', nodes: ['N_MR_bfa2b4ba6915', 'N_MR_eafaae5d7910'], fixed: 'N_MR_e29d76f56696' },
];
function attribute(map: YardMap, provenance: Provenance, field: string) {
  map.sources.source_editor_geometry = { name: '编辑器人工几何设计假设', category: 'design_assumption', description: '用户在本地米制编辑器中修改的几何字段；保留原始来源，未经现场测量或地理配准核验。' };
  provenance.sourceRefs = [...new Set([...(provenance.sourceRefs ?? []), ...(provenance.fieldSources?.[field] ? [provenance.fieldSources[field]!] : []), 'source_editor_geometry'])];
  provenance.fieldSources = { ...provenance.fieldSources, [field]: 'source_editor_geometry' };
}
for (const target of cases) test('SV01 real Geoje ' + target.id + ' keeps legacy outside-service warning while translating private contents safely', async ({ page }, info) => {
  test.setTimeout(180000);
  let bytes: Buffer; try { bytes = await readFile(path); } catch (cause) { throw new Error('blocked_input: required real Geoje map missing: ' + path, { cause }); }
  expect(createHash('sha256').update(bytes).digest('hex'), 'blocked_input: frozen Geoje source SHA').toBe(sha256);
  const original = JSON.parse(bytes.toString('utf8')) as YardMap;
  const bundles: string[] = [], errors: string[] = [];
  page.on('response', response => { if (/\/assets\/[^/]+\.js$/.test(new URL(response.url()).pathname)) bundles.push(response.url()); });
  page.on('pageerror', error => errors.push(error.message));
  await readyWorkbench(page); await importMapUI(page, original, bytes);
  await page.getByTestId('object-search').fill(target.id); await page.getByTestId('facilities-item-' + target.id).click();
  await page.getByRole('button', { name: '定位 ' + target.id, exact: true }).click();
  await page.screenshot({ path: info.outputPath('geoje-before.png'), fullPage: true });
  const beforeArea = await page.getByTestId('polygon-area').textContent();
  await (await revealProperty(page, '平移 X (m)')).fill('0.25'); await page.getByLabel('平移 Y (m)', { exact: true }).fill('0.125');
  await page.getByRole('button', { name: '应用平移', exact: true }).click();
  await expect(page.locator('.canvas-status')).toContainText('1 个撤销事务');
  const moved = (await exportMapUI(page, info, target.id + '-moved')).map;
  const expected = structuredClone(original); expected.revision++;
  const facility = expected.facilities[target.id]!;
  for (const ring of [facility.boundary.outer, ...facility.boundary.holes]) for (const point of ring) { point[0] += 0.25; point[1] += 0.125; }
  attribute(expected, facility.provenance, 'boundary');
  for (const id of target.nodes) {
    expected.nodes[id]!.position[0] += 0.25; expected.nodes[id]!.position[1] += 0.125;
    attribute(expected, expected.nodes[id]!.provenance, 'position');
  }
  expect(moved).toEqual(expected);
  expect(moved.nodes[target.fixed]).toEqual(original.nodes[target.fixed]);
  expect(moved.coordinateFrame).toEqual(original.coordinateFrame); expect(moved.resources).toEqual(original.resources);
  expect(moved.roads).toEqual(original.roads); expect(moved.movements).toEqual(original.movements);
  await expect(page.getByTestId('polygon-area')).toHaveText(beforeArea!);
  await openChecks(page);
  const warning = page.getByTestId('issue-panel').locator('.issue-item.warning').filter({ has: page.getByRole('button', { name: /^SPATIAL_SERVICE_OUTSIDE_OWNER .*旧越界仍待修复/ }) });
  await expect(warning).toHaveCount(1); await expect(warning).toContainText('SP_MR_' + target.id);
  await warning.getByRole('button').scrollIntoViewIfNeeded();
  await page.screenshot({ path: info.outputPath('geoje-moved-with-warning.png'), fullPage: true });
  await page.getByRole('button', { name: '检查与问题', exact: true }).click();
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  expect((await exportMapUI(page, info, target.id + '-undo')).map).toEqual(original);
  await page.getByRole('button', { name: '重做', exact: true }).click();
  expect((await exportMapUI(page, info, target.id + '-redo')).map).toEqual(moved);
  await saveToBrowser(page); await expect(page.getByTestId('browser-save-status')).toHaveText('浏览器草稿已保存');
  const movedHash = await page.getByTestId('map-hash').textContent(); await page.reload();
  await expect(page.getByTestId('map-hash')).toHaveText(movedHash!, { timeout: 30000 });
  const exported = await exportMapUI(page, info, target.id + '-refreshed'); expect(exported.map).toEqual(moved);
  await importMapUI(page, moved, await readFile(exported.path));
  expect((await exportMapUI(page, info, target.id + '-roundtrip')).map).toEqual(moved);
  expect(createHash('sha256').update(await readFile(path)).digest('hex')).toBe(sha256);
  expect(errors).toEqual([]);
  await info.attach('geoje-source-and-bundle', { body: JSON.stringify({ path, sha256Before: sha256, sha256After: sha256, facilityId: target.id, movedNodeIds: target.nodes, fixedPublicNodeId: target.fixed, deltaM: [0.25, 0.125, 0], oldWarningRetained: true, loadedBundles: [...new Set(bundles)] }), contentType: 'application/json' });
});
