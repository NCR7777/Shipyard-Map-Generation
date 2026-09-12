import { readFile } from 'node:fs/promises';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import type { YardMap } from '../../src/domain/model';
import type { StoredProject } from '../../src/editor/projectController';
import { GA01_TARGETS, GA01Boundary, GA01Command, readGA01Target, assertGA01Change, assertGA01Equal } from '../helpers/GA01_targets';

const phase = process.env.GA01_PHASE ?? 'A';
async function saved(page: Page) { await expect(page.getByTestId('browser-save-status')).toContainText('已保存', { timeout: 30000 }); }
async function exportMap(page: Page, info: TestInfo, name: string) {
  const event = page.waitForEvent('download'); await page.getByRole('button', { name: '导出 JSON', exact: true }).click();
  const path = info.outputPath(name + '.map.json'); await (await event).saveAs(path);
  return { path, map: JSON.parse(await readFile(path, 'utf8')) as YardMap };
}
async function imported(page: Page, name: string) {
  const conflict = page.getByRole('dialog', { name: '未保存编辑冲突', exact: true });
  await expect.poll(async () => await conflict.isVisible() || await page.getByLabel('地图名称', { exact: true }).inputValue() === name, { timeout: 30000 }).toBe(true);
  if (await conflict.isVisible()) await conflict.getByRole('button', { name: '放弃编辑并重载', exact: true }).click();
  await expect(page.getByLabel('地图名称', { exact: true })).toHaveValue(name); await saved(page);
}
for (const target of GA01_TARGETS) test('GA01 ' + phase + ' ' + target.id + ' actual geometry, history, autosave, refresh and JSON roundtrip', async ({ page, browser }, info) => {
  test.setTimeout(150000);
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const original = await readGA01Target(target); const bytes = await readFile(target.absolutePath);
  await page.goto('/'); await expect(page.getByRole('button', { name: '保存工程', exact: true })).toBeEnabled();
  await page.getByTestId('json-file-input').setInputFiles({ name: target.id + '.map.json', mimeType: 'application/json', buffer: bytes });
  await imported(page, original.metadata.name);
  assertGA01Equal((await exportMap(page, info, 'original')).map, original);
  await page.getByRole('button', { name: '适应地图', exact: true }).click();
  const entityId = phase === 'B' ? target.nodeId : target.facilityId;
  await page.getByTestId('object-search').fill(entityId);
  await page.getByTestId((phase === 'B' ? 'node-item-' : 'facilities-item-') + entityId).click();
  await expect(page.getByLabel('稳定 ID', { exact: true })).toHaveValue(entityId);
  const startHash = await page.getByTestId('map-hash').textContent();
  if (phase === 'B') {
    const command = GA01Command(original, target, 'B');
    if (command.type !== 'updateNode') throw new Error('unexpected B command');
    await page.getByLabel('X (m)', { exact: true }).fill(String(command.patch.position![0]));
  } else {
    const mode = page.getByLabel('边界编辑模式', { exact: true });
    if (await mode.isVisible()) await mode.selectOption('polygon');
    const boundary = GA01Boundary(original, target);
    for (const [index, point] of boundary.outer.slice(0, -1).entries()) for (const [axis, coordinate] of [['X', point[0]], ['Y', point[1]]] as const)
      await page.getByLabel('外环 顶点 ' + (index + 1) + ' ' + axis + ' (m)', { exact: true }).fill(String(coordinate));
  }
  await page.getByRole('button', { name: '应用属性', exact: true }).click();
  await expect(page.getByTestId('map-hash')).not.toHaveText(startHash!, { timeout: 30000 });
  await saved(page); // Auto-save must complete before any explicit save.
  const changed = await exportMap(page, info, 'edited'); assertGA01Change(original, changed.map, target, phase);
  if (phase !== 'B') expect(changed.map.facilities[target.facilityId]!.boundary).toEqual(GA01Boundary(original, target));
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  assertGA01Equal((await exportMap(page, info, 'undo')).map, original);
  await page.getByRole('button', { name: '重做', exact: true }).click();
  assertGA01Equal((await exportMap(page, info, 'redo')).map, changed.map);
  const ctrlSReceipt = await confirmedSave(page, changed.map, () => page.keyboard.press('Control+s'));
  const buttonSaveReceipt = await confirmedSave(page, changed.map, () => page.getByRole('button', { name: '保存工程', exact: true }).click());
  await page.reload(); await expect(page.getByLabel('地图名称', { exact: true })).toHaveValue(original.metadata.name, { timeout: 30000 }); await saved(page);
  assertGA01Equal((await exportMap(page, info, 'refreshed')).map, changed.map);
  const previousProjects = await projectKeys(page);
  await page.getByTestId('json-file-input').setInputFiles(changed.path);
  await expect.poll(() => projectKeys(page), { timeout: 30000 }).not.toEqual(previousProjects);
  await imported(page, original.metadata.name);
  assertGA01Equal((await exportMap(page, info, 'reimported')).map, changed.map);
  await page.screenshot({ path: info.outputPath('GA01-' + target.id + '-final.png'), fullPage: true });
  expect(errors).toEqual([]); expect(await readGA01Target(target)).toEqual(original);
  await info.attach('GA01-receipt.json', { body: JSON.stringify({ phase, id: target.id, originalSHA256: target.sha256, entityId, realGeometryChanged: true, framePreserved: true, unmodifiedFieldsExact: true, sourceAttribution: true, undoRedo: true, automaticSave: true, ctrlS: ctrlSReceipt, explicitSave: buttonSaveReceipt, refresh: true, reimport: true, originalUnchanged: true, numericEquality: 'exact ===; existing JSON -0 to 0 only, no rounding or tolerance', browser: browser.version() }, null, 2), contentType: 'application/json' });
});

if (phase === 'A') test('GA01 A large Hanwha V02 map commits 100 native corner previews once', async ({ page }, info) => {
  test.setTimeout(150000);
  const target = GA01_TARGETS.find(item => item.id === 'hanwha_v02')!;
  const original = await readGA01Target(target);
  await page.goto('/'); await expect(page.getByRole('button', { name: '保存工程', exact: true })).toBeEnabled();
  await page.getByTestId('json-file-input').setInputFiles({ name: target.id + '.map.json', mimeType: 'application/json', buffer: await readFile(target.absolutePath) });
  await imported(page, original.metadata.name);
  await page.getByTestId('object-search').fill(target.facilityId);
  await page.getByTestId('facilities-item-' + target.facilityId).click();
  await page.getByRole('button', { name: '定位 ' + target.facilityId, exact: true }).click();
  await page.getByLabel('网格吸附', { exact: true }).selectOption('0');
  await page.getByLabel('节点吸附', { exact: true }).uncheck();
  const canvas = await page.getByTestId('map-canvas').locator('canvas').first().boundingBox();
  if (!canvas) throw new Error('canvas unavailable');
  const camera = page.getByTestId('camera-state');
  const scale = Number(await camera.getAttribute('data-scale'));
  const ox = Number(await camera.getAttribute('data-offset-x')), oy = Number(await camera.getAttribute('data-offset-y'));
  const polygon = original.facilities[target.facilityId]!.boundary;
  const fixed = polygon.outer[0], corner = polygon.outer[2]!;
  const end = [fixed[0] + (corner[0] - fixed[0]) * 0.95, fixed[1] + (corner[1] - fixed[1]) * 0.95];
  const startHash = await page.getByTestId('map-hash').textContent();
  await page.mouse.move(canvas.x + ox + corner[0] * scale, canvas.y + oy - corner[1] * scale);
  await page.mouse.down();
  await page.mouse.move(canvas.x + ox + end[0]! * scale, canvas.y + oy - end[1]! * scale, { steps: 100 });
  await expect(page.getByTestId('map-hash')).toHaveText(startHash!);
  await expect(page.locator('.canvas-status')).toContainText('0 个撤销事务');
  await page.mouse.up();
  await expect(page.getByTestId('map-hash')).not.toHaveText(startHash!);
  await expect(page.locator('.canvas-status')).toContainText('1 个撤销事务');
  const moved = (await exportMap(page, info, '100-preview-one-transaction')).map;
  assertGA01Change(original, moved, target);
  expect(moved.facilities[target.facilityId]!.boundary.outer[0]).toEqual(fixed);
  const labels = Number(await page.getByTestId('display-state').getAttribute('data-labels'));
  expect(labels).toBeLessThanOrEqual(200);
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  assertGA01Equal((await exportMap(page, info, 'drag-undo')).map, original);
  await page.getByRole('button', { name: '重做', exact: true }).click(); await saved(page);
  assertGA01Equal((await exportMap(page, info, 'drag-redo')).map, moved);
  await page.screenshot({ path: info.outputPath('large-native-drag.png'), fullPage: true });
  await info.attach('native-drag-receipt.json', { body: JSON.stringify({ id: target.id, requestedPointerSteps: 100, camera: { scale, ox, oy }, labels, oneTransaction: true, framePreserved: true, actualBoundary: moved.facilities[target.facilityId]!.boundary }, null, 2), contentType: 'application/json' });
  await readGA01Target(target);
});

async function projectKeys(page: Page): Promise<string[]> {
  return page.evaluate(() => new Promise<string[]>((resolve, reject) => {
    const request = indexedDB.open('shipyard-map-projects', 1);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result; const transaction = db.transaction('projects', 'readonly');
      const keys = transaction.objectStore('projects').getAllKeys();
      transaction.oncomplete = () => { db.close(); resolve(keys.result.map(String).sort()); };
      transaction.onabort = () => { db.close(); reject(transaction.error); };
    };
  }));
}
async function activeProject(page: Page): Promise<StoredProject | undefined> {
  return page.evaluate(() => new Promise<StoredProject | undefined>((resolve, reject) => {
    const request = indexedDB.open('shipyard-map-projects', 1);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result; const transaction = db.transaction('projects', 'readonly');
      const row = transaction.objectStore('projects').get(sessionStorage.getItem('shipyard.activeProjectId')!);
      transaction.oncomplete = () => { db.close(); resolve(row.result as StoredProject | undefined); };
      transaction.onabort = () => { db.close(); reject(transaction.error); };
    };
  }));
}
async function confirmedSave(page: Page, expected: YardMap, action: () => Promise<void>) {
  await saved(page); const before = await activeProject(page);
  const hash = await page.getByTestId('map-hash').textContent();
  await action();
  await expect.poll(async () => {
    const row = await activeProject(page);
    return !!row && row.projectId === before?.projectId && row.storageVersion > before.storageVersion && row.checkpoint?.contentHash === hash;
  }, { timeout: 60000, intervals: [50, 100] }).toBe(true);
  const after = await activeProject(page);
  if (!after?.checkpoint) throw new Error('missing committed checkpoint');
  assertGA01Equal(JSON.parse(after.checkpoint.mapJson), expected, 'committed checkpoint must match edited JSON');
  return { projectId: after.projectId, versionBefore: before!.storageVersion, versionAfter: after.storageVersion, checkpointHash: after.checkpoint.contentHash, checkpointExact: true };
}
