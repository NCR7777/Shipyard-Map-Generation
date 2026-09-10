import { readFile } from 'node:fs/promises';
import { cpus, platform, release } from 'node:os';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import type { Polygon, Vec3, YardMap } from '../../src/domain/model';
import { P1_TARGETS, P1_COLLECTIONS, readP1Target, type P1Target } from '../helpers/P1_targets';

// Real user originals enter via the file input. No application-state or Konva injection.
const sr03 = P1_TARGETS.filter(target => target.family === 'SR03');
async function ready(page: Page) {
  await page.goto('/');
  await expect(page.getByRole('button', { name: '保存工程', exact: true })).toBeEnabled();
}
async function saved(page: Page) { await expect(page.getByTestId('browser-save-status')).toContainText('已保存', { timeout: 30000 }); }
async function projectKeys(page: Page): Promise<string[]> {
  return page.evaluate(() => new Promise<string[]>((resolve, reject) => {
    const request = indexedDB.open('shipyard-map-projects', 1);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result; const tx = db.transaction('projects', 'readonly');
      const keys = tx.objectStore('projects').getAllKeys();
      tx.oncomplete = () => { db.close(); resolve(keys.result.map(String).sort()); };
      tx.onabort = () => { db.close(); reject(tx.error); };
    };
  }));
}
async function importFile(page: Page, file: string, name: string) {
  const beforeKeys = await projectKeys(page);
  await page.getByTestId('json-file-input').setInputFiles(file);
  const conflict = page.getByRole('dialog', { name: '未保存编辑冲突', exact: true });
  await expect.poll(async () => await conflict.isVisible() || await page.getByLabel('地图名称', { exact: true }).inputValue() === name, { timeout: 30000 }).toBe(true);
  if (await conflict.isVisible()) await conflict.getByRole('button', { name: '放弃编辑并重载', exact: true }).click();
  await expect.poll(() => projectKeys(page), { timeout: 30000 }).not.toEqual(beforeKeys);
  await expect(page.getByLabel('地图名称', { exact: true })).toHaveValue(name, { timeout: 30000 });
}
async function importOriginal(page: Page, target: P1Target) {
  const original = await readP1Target(target);
  await importFile(page, target.absolutePath, original.map.metadata.name);
  await page.getByRole('button', { name: '适应地图', exact: true }).click();
  return original.map;
}
async function download(page: Page, info: TestInfo, name: string) {
  const event = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出 JSON', exact: true }).click();
  const path = info.outputPath(name); await (await event).saveAs(path);
  return { path, map: JSON.parse(await readFile(path, 'utf8')) as YardMap };
}
async function screen(page: Page, point: Vec3) {
  const box = await page.getByTestId('map-canvas').locator('canvas').first().boundingBox();
  if (!box) throw new Error('Canvas is not visible.');
  const camera = page.getByTestId('camera-state'); const scale = Number(await camera.getAttribute('data-scale'));
  return { x: box.x + Number(await camera.getAttribute('data-offset-x')) + point[0] * scale,
    y: box.y + Number(await camera.getAttribute('data-offset-y')) - point[1] * scale };
}
async function drag(page: Page, from: Vec3, to: Vec3, during?: () => Promise<void>) {
  const a = await screen(page, from); const b = await screen(page, to);
  await page.mouse.move(a.x, a.y); await page.mouse.down(); await page.mouse.move(b.x, b.y, { steps: 100 });
  if (during) await during();
  await page.mouse.up();
}
async function choose(page: Page, kind: string, id: string) {
  await page.getByTestId('object-search').fill(id);
  await page.getByTestId(kind === 'nodes' ? 'node-item-' + id : kind === 'roads' ? 'road-item-' + id : kind + '-item-' + id).click();
  await expect(page.getByLabel('稳定 ID', { exact: true })).toHaveValue(id);
}
async function layers(page: Page) {
  const summary = page.getByText('基础图层与标签', { exact: true });
  if (await summary.locator('..').getAttribute('open') === null) await summary.click();
}
async function transforms(page: Page) {
  const summary = page.getByText('数值平移与旋转', { exact: true });
  if (await summary.locator('..').getAttribute('open') === null) await summary.click();
}
type SlotsPayload = { slots: { id: string; boundary: Polygon; servicePointId?: string }[] };
const slots = (map: YardMap, kind: 'facilities' | 'zones', id: string) => (map[kind][id]!.extensions!['sr02.planning'] as SlotsPayload).slots;
function mapPolygon(polygon: Polygon, transform: (point: Vec3) => Vec3): Polygon {
  return { outer: polygon.outer.map(transform) as Polygon['outer'], holes: polygon.holes.map(ring => ring.map(transform) as Polygon['outer']) };
}
function expectedOwnerTransform(before: YardMap, kind: 'facilities' | 'zones', id: string, nodeIds: string[], transform: (point: Vec3) => Vec3) {
  const after = structuredClone(before); after.revision++;
  after[kind][id]!.boundary = mapPolygon(before[kind][id]!.boundary, transform);
  slots(after, kind, id).forEach(slot => { slot.boundary = mapPolygon(slot.boundary, transform); });
  for (const node of nodeIds) after.nodes[node]!.position = transform(before.nodes[node]!.position);
  for (const junction of Object.values(after.junctions)) {
    if (junction.boundary && junction.nodeIds.every(node => nodeIds.includes(node))) junction.boundary = mapPolygon(junction.boundary, transform);
  }
  return after;
}
function expectNumericTree(actual: unknown, expected: unknown, path = '') {
  if (typeof expected === 'number') {
    expect(typeof actual, path).toBe('number'); expect(actual as number, path).toBeCloseTo(expected, 8); return;
  }
  if (Array.isArray(expected)) {
    expect(Array.isArray(actual), path).toBe(true); expect(actual as unknown[], path).toHaveLength(expected.length);
    expected.forEach((value, i) => expectNumericTree((actual as unknown[])[i], value, `${path}/${i}`)); return;
  }
  if (expected && typeof expected === 'object') {
    expect(actual && typeof actual === 'object', path).toBe(true);
    expect(Object.keys(actual as object).sort(), path).toEqual(Object.keys(expected).sort());
    for (const [key, value] of Object.entries(expected)) expectNumericTree((actual as Record<string, unknown>)[key], value, `${path}/${key}`);
    return;
  }
  expect(actual, path).toEqual(expected);
}

for (const target of sr03) {
  test(`P1 A02 A04 ${target.id} complete original shows inventory and survives real save/refresh/export/import`, async ({ page, browser }, info) => {
    test.setTimeout(120000);
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await ready(page); const started = performance.now(); const original = await importOriginal(page, target);
    for (const [i, kind] of P1_COLLECTIONS.entries()) await expect(page.getByTestId('scene-count-' + kind)).toHaveText(String(target.counts[i]));
    await expect(page.getByTestId('scene-count-slots')).toHaveText(String(target.counts[12]));
    await expect(page.getByTestId('scene-count-siteBoundary')).toHaveText('1');
    await expect(page.getByTestId('issue-panel')).toContainText('0 错误');
    const importedMs = performance.now() - started;
    await page.screenshot({ path: info.outputPath(target.id + '-complete.png'), fullPage: true });
    const hash = await page.getByTestId('map-hash').textContent();
    await page.getByRole('button', { name: '保存工程', exact: true }).click(); await saved(page);
    await page.reload(); await expect(page.getByTestId('map-hash')).toHaveText(hash!, { timeout: 30000 });
    const exported = await download(page, info, target.id + '-roundtrip.map.json'); expect(exported.map).toEqual(original);
    await importFile(page, exported.path, original.metadata.name);
    expect((await download(page, info, target.id + '-reimport.map.json')).map).toEqual(original);
    expect(errors).toEqual([]); await readP1Target(target);
    await info.attach('actual-environment-and-import-time', { body: JSON.stringify({ target: target.id, sha256: target.sha256, bytes: Buffer.byteLength((await readP1Target(target)).text), counts: target.counts,
      browser: browser.version(), platform: platform(), release: release(), cpu: cpus()[0]?.model, importedMs,
      interpretation: 'Observed current complete-input import/render time, not a hardware-independent performance guarantee.' }, null, 2), contentType: 'application/json' });
  });
}

test('P1 A03 A06 real F_001 rigid contents drag and numeric rotation retain slots, anchors and declarations', async ({ page }, info) => {
  test.setTimeout(120000); await ready(page); const before = await importOriginal(page, sr03[0]!);
  await choose(page, 'facilities', 'F_001');
  await page.getByLabel('设施移动策略', { exact: true }).selectOption('withStaticContents');
  await page.getByLabel('网格吸附', { exact: true }).selectOption('1');
  const hash = await page.getByTestId('map-hash').textContent();
  await drag(page, [78, 180, 0], [88, 185, 0], async () => {
    await expect(page.getByTestId('map-hash')).toHaveText(hash!);
  });
  const moved = (await download(page, info, 'F001-moved.map.json')).map;
  const nodeIds = ['N_0012', 'N_0013', 'N_0014'];
  expect(moved).toEqual(expectedOwnerTransform(before, 'facilities', 'F_001', nodeIds, ([x,y,z]) => [x + 10,y + 5,z]));
  expect(moved.resources).toEqual(before.resources); expect(moved.movements).toEqual(before.movements);
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  expect((await download(page, info, 'F001-undo.map.json')).map).toEqual(before);
  await expect(page.getByRole('button', { name: '撤销', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '重做', exact: true }).click();
  expect((await download(page, info, 'F001-redo.map.json')).map).toEqual(moved);
  await choose(page, 'facilities', 'F_001'); await transforms(page);
  const angle = 0.05; const cx = 75.5; const cy = 137;
  await page.getByLabel('旋转角 (rad)', { exact: true }).fill(String(angle));
  await page.getByLabel('旋转中心 X (m)', { exact: true }).fill(String(cx));
  await page.getByLabel('旋转中心 Y (m)', { exact: true }).fill(String(cy));
  await page.getByRole('button', { name: '应用旋转', exact: true }).click();
  const rotated = (await download(page, info, 'F001-rotated.map.json')).map;
  const expected = expectedOwnerTransform(moved, 'facilities', 'F_001', nodeIds, ([x,y,z]) => [cx + (x-cx)*Math.cos(angle)-(y-cy)*Math.sin(angle), cy+(x-cx)*Math.sin(angle)+(y-cy)*Math.cos(angle), z]);
  expectNumericTree(rotated, expected);
  expect(rotated.resources).toEqual(before.resources); expect(rotated.movements).toEqual(before.movements);
  await saved(page); await page.reload();
  const exported = await download(page, info, 'F001-recovered.map.json'); expect(exported.map).toEqual(rotated);
  await importFile(page, exported.path, rotated.metadata.name);
  expect((await download(page, info, 'F001-reimported.map.json')).map).toEqual(rotated);
  await readP1Target(sr03[0]!);
});

test('P1 A03 A06 real Z_005 parking slots and service nodes move together with public anchors fixed', async ({ page }, info) => {
  await ready(page); const before = await importOriginal(page, sr03[0]!);
  await choose(page, 'zones', 'Z_005');
  await page.getByLabel('区域移动策略', { exact: true }).selectOption('withStaticContents');
  await page.getByLabel('网格吸附', { exact: true }).selectOption('1');
  await drag(page, [459, 94, 0], [449, 99, 0]);
  const moved = (await download(page, info, 'Z005-moved.map.json')).map;
  const nodeIds = ['N_0031', 'N_0032', 'N_0033', 'N_0035', 'N_0036', 'N_0037', 'N_0038', 'N_0039'];
  expect(moved).toEqual(expectedOwnerTransform(before, 'zones', 'Z_005', nodeIds, ([x,y,z]) => [x-10,y+5,z]));
  expect(moved.servicePoints).toEqual(before.servicePoints);
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  expect((await download(page, info, 'Z005-undo.map.json')).map).toEqual(before);
  await page.getByRole('button', { name: '重做', exact: true }).click();
  await saved(page); await page.reload();
  const exported = await download(page, info, 'Z005-recovered.map.json'); expect(exported.map).toEqual(moved);
  await importFile(page, exported.path, moved.metadata.name);
  expect((await download(page, info, 'Z005-reimported.map.json')).map).toEqual(moved);
});

test('P1 A05 layer configuration survives reload without map history and locked hidden nodes cannot move indirectly', async ({ page }, info) => {
  await ready(page); const before = await importOriginal(page, sr03[0]!);
  const hash = await page.getByTestId('map-hash').textContent();
  await layers(page);
  await page.getByTestId('layer-visible-nodes').uncheck(); await page.getByTestId('layer-locked-nodes').check();
  await page.getByTestId('show-labels').uncheck();
  await page.getByTestId('object-search').fill('F_001');
  await saved(page); await page.reload();
  await expect(page.getByTestId('layer-visible-nodes')).not.toBeChecked(); await expect(page.getByTestId('layer-locked-nodes')).toBeChecked();
  await expect(page.getByTestId('show-labels')).not.toBeChecked(); await expect(page.getByTestId('object-search')).toHaveValue('F_001');
  await expect(page.getByTestId('map-hash')).toHaveText(hash!); await expect(page.getByRole('button', { name: '撤销', exact: true })).toBeDisabled();
  await choose(page, 'facilities', 'F_001'); await page.getByLabel('设施移动策略', { exact: true }).selectOption('withStaticContents');
  await transforms(page);
  const delta = page.getByLabel('平移 X (m)', { exact: true });
  if (await delta.isEnabled()) {
    await delta.fill('10'); await page.getByRole('button', { name: '应用平移', exact: true }).click();
    await expect(page.getByTestId('issue-panel')).toContainText('锁定');
    await page.getByRole('button', { name: '重置变换输入', exact: true }).click();
  } else await expect(delta).toBeDisabled();
  expect((await download(page, info, 'locked-no-change.map.json')).map).toEqual(before);
  await expect(page.getByTestId('scene-count-nodes')).toHaveText(String(sr03[0]!.counts[0]));
  await expect(page.getByTestId('map-hash')).toHaveText(hash!);
});

for (const mutation of ['unknown_namespace', 'unknown_nested_slot_field'] as const) {
  test(`P1 A03 ${mutation} remains inspectable and globally protected with its full payload retained`, async ({ page }, info) => {
    const { map } = await readP1Target(sr03[0]!);
    map.metadata.name += ' · ' + mutation;
    if (mutation === 'unknown_namespace') {
      map.extensionNamespaces['test.unknown_global_behavior'] = { category: 'behavior', version: '1' };
      map.extensions['test.unknown_global_behavior'] = { dependsOnAllGeometry: true, mustKeep: ['原件反例', 1.23456789012345] };
    } else Object.assign(slots(map, 'facilities', 'F_001')[0]!, { futureMotionConstraint: { mode: 'uninterpreted', keep: '完整保留' } });
    await ready(page);
    await page.getByTestId('json-file-input').setInputFiles({ name: mutation + '.map.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(map)) });
    await expect(page.getByLabel('地图名称', { exact: true })).toHaveValue(map.metadata.name);
    await choose(page, 'facilities', 'F_001');
    await expect(page.getByLabel('名称', { exact: true })).toBeDisabled();
    if (mutation === 'unknown_nested_slot_field') {
      await expect(page.getByTestId('issue-panel')).toContainText('PLANNING_UNKNOWN_FIELD');
      await expect(page.getByTestId('issue-panel')).toContainText('/facilities/F_001/extensions/sr02.planning/slots/0/futureMotionConstraint');
    }
    await expect(page.getByRole('button', { name: '节点', exact: true })).toBeDisabled();
    expect((await download(page, info, mutation + '-preserved.map.json')).map).toEqual(map);
    await layers(page); await page.getByTestId('layer-visible-facilities').uncheck();
    await expect(page.getByLabel('地图名称', { exact: true })).toBeDisabled();
    expect((await download(page, info, mutation + '-hidden.map.json')).map).toEqual(map);
    await readP1Target(sr03[0]!);
  });
}


test('P1 A03 A06 approved name edit preserves every geometry and pending input cannot be silently discarded by a layer action', async ({ page }, info) => {
  await ready(page); const before = await importOriginal(page, sr03[0]!);
  await choose(page, 'facilities', 'F_001');
  await layers(page);
  const name = before.facilities.F_001!.name + ' · 已审查命名';
  await page.getByLabel('名称', { exact: true }).fill(name);
  await page.getByTestId('layer-visible-facilities').click();
  const guard = page.getByRole('dialog', { name: '未应用输入保护', exact: true });
  await expect(guard).toBeVisible();
  await guard.getByRole('button', { name: '取消，保留输入', exact: true }).click();
  await expect(page.getByLabel('名称', { exact: true })).toHaveValue(name);
  await expect(page.getByTestId('layer-visible-facilities')).toBeChecked();
  await page.getByRole('button', { name: '应用属性', exact: true }).click();
  const expected = structuredClone(before); expected.facilities.F_001!.name = name; expected.revision++;
  const changed = (await download(page, info, 'name-only.map.json')).map; expect(changed).toEqual(expected);
  await saved(page); await page.reload();
  expect((await download(page, info, 'name-only-recovered.map.json')).map).toEqual(expected);
  await readP1Target(sr03[0]!);
});


test('P1 A05 locked indirect resources and slots guard both history buttons and keyboard without consuming history', async ({ page }, info) => {
  test.setTimeout(90000); await ready(page); const original = await importOriginal(page, sr03[0]!);
  await choose(page, 'facilities', 'F_001');
  await page.getByLabel('设施移动策略', { exact: true }).selectOption('withStaticContents');
  await page.getByLabel('网格吸附', { exact: true }).selectOption('1');
  await drag(page, [78, 180, 0], [88, 185, 0]);
  const moved = (await download(page, info, 'history-moved.map.json')).map;
  expect(moved.revision).toBe(original.revision + 1);
  await layers(page); await page.getByTestId('layer-locked-resources').check();
  const undo = page.getByRole('button', { name: '撤销', exact: true });
  if (await undo.isEnabled()) await undo.click(); else await expect(undo).toBeDisabled();
  expect((await download(page, info, 'history-locked-undo-button.map.json')).map).toEqual(moved);
  await page.getByTestId('map-canvas').focus(); await page.keyboard.press('Control+z');
  expect((await download(page, info, 'history-locked-undo-keyboard.map.json')).map).toEqual(moved);
  await expect(page.getByRole('button', { name: '重做', exact: true })).toBeDisabled();
  await page.getByTestId('layer-locked-resources').uncheck(); await undo.click();
  expect((await download(page, info, 'history-unlocked-undo.map.json')).map).toEqual(original);
  await page.getByTestId('layer-locked-slots').check();
  const redo = page.getByRole('button', { name: '重做', exact: true });
  if (await redo.isEnabled()) await redo.click(); else await expect(redo).toBeDisabled();
  expect((await download(page, info, 'history-locked-redo-button.map.json')).map).toEqual(original);
  await page.getByTestId('map-canvas').focus(); await page.keyboard.press('Control+Shift+z');
  expect((await download(page, info, 'history-locked-redo-keyboard.map.json')).map).toEqual(original);
  await expect(undo).toBeDisabled();
  await page.getByTestId('layer-locked-slots').uncheck(); await redo.click();
  expect((await download(page, info, 'history-unlocked-redo.map.json')).map).toEqual(moved);
  await readP1Target(sr03[0]!);
});

test('P1 A06 searching the directory during a real polygon draft retains all earlier vertices', async ({ page }, info) => {
  await ready(page);
  const before = (await download(page, info, 'polygon-before.map.json')).map;
  const hash = await page.getByTestId('map-hash').textContent();
  await page.getByRole('button', { name: '多边形设施', exact: true }).click();
  for (const point of [[0,0,0], [60,0,0]] as Vec3[]) { const p = await screen(page, point); await page.mouse.click(p.x, p.y); }
  await expect(page.getByTestId('unapplied-inputs')).toBeVisible();
  await page.getByTestId('object-search').fill('仍在绘制');
  await expect(page.getByTestId('unapplied-inputs')).toBeVisible();
  await expect(page.getByTestId('map-hash')).toHaveText(hash!);
  for (const point of [[60,30,0], [0,30,0]] as Vec3[]) { const p = await screen(page, point); await page.mouse.click(p.x, p.y); }
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('facilities-count')).toHaveText('1');
  await expect(page.getByTestId('unapplied-inputs')).not.toBeVisible();
  const after = (await download(page, info, 'polygon-after-search.map.json')).map;
  expect(after.revision).toBe(before.revision + 1);
  expect(Object.values(after.facilities)[0]!.boundary).toEqual({outer:[[0,0,0],[60,0,0],[60,30,0],[0,30,0],[0,0,0]],holes:[]});
  expect(after.nodes).toEqual(before.nodes); expect(after.roads).toEqual(before.roads);
});
