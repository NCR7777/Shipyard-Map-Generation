import { readFile } from 'node:fs/promises';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { readonlyFixture } from '../helpers/M1_fixtures';
import { TE01Synthetic } from '../helpers/TE01_fixtures';
import type { YardMap } from '../../src/domain/model';
import type { StoredProject } from '../../src/editor/projectController';
import { TE01_TARGETS, TE01_HANWHA, readTE01Target, assertTE01Equal, assertTE01HanwhaDeletion } from '../helpers/TE01_targets';

async function exported(page: Page, info: TestInfo, name: string) {
  const event = page.waitForEvent('download'); await page.getByRole('button', { name: '导出 JSON', exact: true }).click();
  const path = info.outputPath(name + '.map.json'); await (await event).saveAs(path);
  return { path, map: JSON.parse(await readFile(path, 'utf8')) as YardMap };
}
async function imported(page: Page, map: YardMap, bytes?: Buffer) {
  await page.goto('/'); await expect(page.getByRole('button', { name: '保存工程', exact: true })).toBeEnabled();
  await page.getByTestId('json-file-input').setInputFiles({ name: 'TE01-input.map.json', mimeType: 'application/json', buffer: bytes ?? Buffer.from(JSON.stringify(map)) });
  await expect(page.getByLabel('地图名称', { exact: true })).toHaveValue(map.metadata.name, { timeout: 30000 });
  await expect(page.getByTestId('browser-save-status')).toContainText('已保存', { timeout: 30000 });
}
async function project(page: Page): Promise<StoredProject> {
  return page.evaluate(() => new Promise<StoredProject>((resolve, reject) => {
    const request = indexedDB.open('shipyard-map-projects', 1); request.onerror = () => reject(request.error);
    request.onsuccess = () => { const db = request.result, tx = db.transaction('projects', 'readonly');
      const row = tx.objectStore('projects').get(sessionStorage.getItem('shipyard.activeProjectId')!);
      tx.oncomplete = () => { db.close(); resolve(row.result as StoredProject); };
      tx.onabort = () => { db.close(); reject(tx.error); };
    };
  }));
}
async function savedRoundtrip(page: Page, info: TestInfo, expected: YardMap, file: string) {
  await expect(page.getByTestId('browser-save-status')).toContainText('已保存', { timeout: 30000 });
  const automatic = await project(page); assertTE01Equal(JSON.parse(automatic.draft!.mapJson), expected, 'actual autosave draft exact');
  const receipts = [];
  for (const action of ['ctrlS', 'button']) {
    const before = await project(page), hash = await page.getByTestId('map-hash').textContent();
    if (action === 'ctrlS') await page.keyboard.press('Control+s'); else await page.getByRole('button', { name: '保存工程', exact: true }).click();
    await expect.poll(async () => { const after = await project(page); return after.projectId === before.projectId && after.storageVersion > before.storageVersion && after.checkpoint?.contentHash === hash; }, { timeout: 60000 }).toBe(true);
    const after = await project(page); assertTE01Equal(JSON.parse(after.checkpoint!.mapJson), expected);
    receipts.push({ action, before: before.storageVersion, after: after.storageVersion, checkpointHash: after.checkpoint!.contentHash });
  }
  await page.reload(); await expect(page.getByLabel('地图名称', { exact: true })).toHaveValue(expected.metadata.name);
  assertTE01Equal((await exported(page, info, 'refreshed')).map, expected);
  const oldId = (await project(page)).projectId;
  await page.getByTestId('json-file-input').setInputFiles(file);
  await expect.poll(async () => { const row = await project(page); return !!row && row.projectId !== oldId; }, { timeout: 30000 }).toBe(true);
  assertTE01Equal((await exported(page, info, 'reimported')).map, expected);
  return receipts;
}
async function history(page: Page, info: TestInfo, before: YardMap, after: YardMap, name: string) {
  await page.getByRole('button', { name: '撤销', exact: true }).click(); assertTE01Equal((await exported(page, info, name + '-undo')).map, before);
  await page.getByRole('button', { name: '重做', exact: true }).click(); assertTE01Equal((await exported(page, info, name + '-redo')).map, after);
}

test('TE01 real Hanwha explicit road deletion removes eight turns, cancel and locks preserve history, full saved roundtrip', async ({ page }, info) => {
  test.setTimeout(240000);
  const target = TE01_TARGETS.find(item => item.id === TE01_HANWHA.id)!, original = await readTE01Target(target);
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await imported(page, original, await readFile(target.absolutePath));
  await page.getByTestId('object-search').fill(TE01_HANWHA.roadId);
  await page.getByTestId('road-item-' + TE01_HANWHA.roadId).click();
  const hash = await page.getByTestId('map-hash').textContent();
  await page.getByRole('button', { name: '删除', exact: true }).click();
  const modal = page.getByRole('dialog', { name: '删除空间对象', exact: true });
  await expect(modal.getByTestId('delete-impact')).toContainText('TOPOLOGY_DELETE_DEPENDENCIES');
  await modal.getByRole('button', { name: '取消', exact: true }).click();
  await expect(page.getByTestId('map-hash')).toHaveText(hash!); await expect(page.locator('.canvas-status')).toContainText('0 个撤销事务');
  assertTE01Equal((await exported(page, info, 'cancelled')).map, original);
  await page.getByText('基础图层与标签', { exact: true }).click();
  await page.getByTestId('layer-locked-movements').check();
  await page.getByRole('button', { name: '删除', exact: true }).click();
  await modal.getByLabel('允许删除关联道路和转向', { exact: true }).check();
  const lockedConfirm = modal.getByRole('button', { name: '确认删除', exact: true });
  if (await lockedConfirm.isEnabled()) await lockedConfirm.click(); else await expect(lockedConfirm).toBeDisabled();
  await expect(page.getByTestId('map-hash')).toHaveText(hash!); await expect(page.locator('.canvas-status')).toContainText('0 个撤销事务');
  if (await modal.isVisible()) await modal.getByRole('button', { name: '取消', exact: true }).click();
  await page.getByTestId('layer-locked-movements').uncheck();
  await page.getByRole('button', { name: '删除', exact: true }).click();
  await modal.getByLabel('允许删除关联道路和转向', { exact: true }).check();
  for (const id of TE01_HANWHA.movementIds) await expect(modal.getByTestId('delete-impact')).toContainText(id);
  await modal.getByRole('button', { name: '确认删除', exact: true }).click(); await expect(modal).not.toBeVisible();
  await expect(page.locator('.canvas-status')).toContainText('1 个撤销事务');
  const after = await exported(page, info, 'deleted'); assertTE01HanwhaDeletion(original, after.map);
  await history(page, info, original, after.map, 'delete');
  const saves = await savedRoundtrip(page, info, after.map, after.path);
  await readTE01Target(target); expect(errors).toEqual([]);
  const finalHash = await page.getByTestId('map-hash').textContent();
  await page.getByRole('button', { name: '适应地图', exact: true }).click();
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await expect(page.getByTestId('map-hash')).toHaveText(finalHash!);
  await page.screenshot({ path: info.outputPath('TE01-Hanwha-deletion.png'), fullPage: true });
  await info.attach('TE01-receipt.json', { body: JSON.stringify({ mapId: original.mapId, sha256: target.sha256, roadId: TE01_HANWHA.roadId, deletedTurnIds: TE01_HANWHA.movementIds, sharedResourcesPreserved: TE01_HANWHA.resourceIds, exactOtherFields: true, cancel: true, lockedMovements: true, oneTransaction: true, undoRedo: true, saves, refreshedReimported: true }), contentType: 'application/json' });
});

async function selectNode(page: Page, id: string, additive = false) {
  await page.getByTestId('object-search').fill(id);
  await page.getByTestId('node-item-' + id).click({ modifiers: additive ? ['Shift'] : [] });
}
async function worldPoint(page: Page, point: readonly number[]) {
  const rect = await page.getByTestId('map-canvas').locator('canvas').first().boundingBox(); if (!rect) throw new Error('canvas missing');
  const camera = page.getByTestId('camera-state'), scale = Number(await camera.getAttribute('data-scale'));
  return { x: rect.x + Number(await camera.getAttribute('data-offset-x')) + point[0]! * scale, y: rect.y + Number(await camera.getAttribute('data-offset-y')) - point[1]! * scale };
}
async function dragWorld(page: Page, from: readonly number[], to: readonly number[], release = true) {
  const a = await worldPoint(page, from), b = await worldPoint(page, to);
  await page.mouse.move(a.x, a.y); await page.mouse.down(); await page.mouse.move(b.x, b.y, { steps: 8 });
  if (release) await page.mouse.up();
}

test('TE01 synthetic split, degree-two suppression and explicit node merge are separate reversible UI transactions', async ({ page }, info) => {
  test.setTimeout(120000); const original = TE01Synthetic(); await imported(page, original);
  await page.getByTestId('object-search').fill('rAB'); await page.getByTestId('road-item-rAB').click();
  await page.getByRole('button', { name: '拆分道路', exact: true }).click();
  const splitModal = page.getByRole('dialog', { name: '拆分道路', exact: true });
  await splitModal.getByLabel('距起点距离 (m)', { exact: true }).fill('50');
  await splitModal.getByRole('button', { name: '确认拆分', exact: true }).click(); await expect(splitModal).not.toBeVisible();
  const split = await exported(page, info, 'split'); const middle = Object.keys(split.map.nodes).find(id => !original.nodes[id])!;
  expect(middle).toBeTruthy(); expect(split.map.roads.rAB).toBeUndefined(); expect(Object.keys(split.map.roads)).toHaveLength(3);
  assertTE01Equal(split.map.nodes[middle]!.position, [50, 0, 0]); assertTE01Equal(split.map.roads.rCD, original.roads.rCD);
  await history(page, info, original, split.map, 'split');
  await selectNode(page, middle); await page.getByRole('button', { name: '保持道路连通删除节点', exact: true }).click();
  const suppressModal = page.getByRole('dialog', { name: '保持道路连通删除节点', exact: true });
  const retained = Object.keys(split.map.roads).find(id => split.map.roads[id]!.fromNodeId === 'nA')!;
  await suppressModal.getByLabel('保留道路', { exact: true }).selectOption(retained);
  await suppressModal.getByRole('button', { name: '确认拓扑编辑', exact: true }).click(); await expect(suppressModal).not.toBeVisible();
  const suppressed = await exported(page, info, 'suppressed'); expect(suppressed.map.nodes[middle]).toBeUndefined(); expect(Object.keys(suppressed.map.roads)).toHaveLength(2);
  expect(suppressed.map.roads[retained]!.fromNodeId).toBe('nA'); expect(suppressed.map.roads[retained]!.toNodeId).toBe('nB');
  await history(page, info, split.map, suppressed.map, 'suppress');
  await selectNode(page, 'nC'); await selectNode(page, 'nA', true);
  await page.getByRole('button', { name: '合并节点', exact: true }).click();
  const mergeModal = page.getByRole('dialog', { name: '合并节点', exact: true });
  await mergeModal.getByLabel('保留节点', { exact: true }).selectOption('nA');
  await mergeModal.getByRole('button', { name: '确认拓扑编辑', exact: true }).click(); await expect(mergeModal).not.toBeVisible();
  const merged = await exported(page, info, 'merged'); expect(merged.map.nodes.nC).toBeUndefined();
  expect(merged.map.roads.rCD!.fromNodeId).toBe('nA'); assertTE01Equal(merged.map.nodes.nA!.position, original.nodes.nA!.position);
  await history(page, info, suppressed.map, merged.map, 'merge'); await expect(page.locator('.canvas-status')).toContainText('3 个撤销事务');
  const saves = await savedRoundtrip(page, info, merged.map, merged.path);
  await info.attach('TE01-synthetic-receipt.json', { body: JSON.stringify({ kind: 'synthetic', split: true, suppress: true, merge: true, eachOneUndoRedo: true, saves }), contentType: 'application/json' });
});

test('TE01 topology snapping requires opt-in and confirmation; ordinary overlap and cancel create no graph links', async ({ page }, info) => {
  test.setTimeout(120000); const original = TE01Synthetic(); await imported(page, original);
  await page.getByRole('button', { name: '适应地图', exact: true }).click();
  await page.getByLabel('网格吸附', { exact: true }).selectOption('0'); await page.getByLabel('节点吸附', { exact: true }).uncheck();
  const topology = page.getByLabel('拓扑吸附', { exact: true }); await expect(topology).not.toBeChecked();
  await selectNode(page, 'nC'); await dragWorld(page, [50, 25, 0], [50, 0, 0]);
  const overlap = await exported(page, info, 'overlap-only'); expect(overlap.map.roads.rAB).toBeDefined(); expect(Object.keys(overlap.map.roads)).toHaveLength(2); expect(Object.keys(overlap.map.junctions)).toHaveLength(0);
  await page.getByRole('button', { name: '撤销', exact: true }).click(); assertTE01Equal((await exported(page, info, 'overlap-undone')).map, original);
  await topology.check(); await selectNode(page, 'nC');
  await page.getByText('基础图层与标签', { exact: true }).click();
  await page.getByTestId('layer-visible-roads').uncheck();
  await dragWorld(page, [50, 25, 0], [50, 0, 0], false); await expect(page.getByTestId('topology-candidate')).not.toBeVisible(); await page.mouse.up();
  const hiddenTarget = (await exported(page, info, 'hidden-target-no-link')).map;
  expect(Object.keys(hiddenTarget.roads)).toEqual(Object.keys(original.roads)); expect(Object.keys(hiddenTarget.junctions)).toHaveLength(0);
  await page.getByRole('button', { name: '撤销', exact: true }).click(); assertTE01Equal((await exported(page, info, 'hidden-target-undo')).map, original);
  await page.getByTestId('layer-visible-roads').check(); await page.getByTestId('layer-locked-roads').check();
  await dragWorld(page, [50, 25, 0], [50, 0, 0], false); await expect(page.getByTestId('topology-candidate')).not.toBeVisible(); await page.mouse.up();
  assertTE01Equal((await exported(page, info, 'locked-road-refused')).map, original);
  await page.getByTestId('layer-locked-roads').uncheck();

  await dragWorld(page, [50, 25, 0], [50, 0, 0], false); await expect(page.getByTestId('topology-candidate')).toBeVisible(); await page.mouse.up();
  const modal = page.getByRole('dialog', { name: '确认连接道路', exact: true }); await expect(modal).toBeVisible();
  await expect(modal.getByLabel('允许新增方向兼容转向', { exact: true })).not.toBeChecked();
  await modal.getByRole('button', { name: '取消', exact: true }).click(); assertTE01Equal((await exported(page, info, 'connect-cancelled')).map, original);
  await expect(page.locator('.canvas-status')).toContainText('0 个撤销事务');
  await dragWorld(page, [50, 25, 0], [50, 0, 0]); await expect(modal).toBeVisible();
  await modal.getByLabel('允许新增方向兼容转向', { exact: true }).check();
  await modal.getByRole('button', { name: '确认拓扑编辑', exact: true }).click(); await expect(modal).not.toBeVisible();
  const connected = await exported(page, info, 'connected'); expect(connected.map.roads.rAB).toBeUndefined();
  assertTE01Equal(connected.map.nodes.nC!.position, [50, 0, 0]); expect(Object.keys(connected.map.roads)).toHaveLength(3);
  expect(Object.keys(connected.map.junctions)).toHaveLength(1); expect(Object.keys(connected.map.movements)).toHaveLength(6);
  for (const movement of Object.values(connected.map.movements)) expect(movement.allowed).toBe(true);
  // Independent directed arc-chain check: branch D -> C followed by main C -> B.
  const onward = Object.entries(connected.map.roads).find(([, road]) => road.fromNodeId === 'nC' && road.toNodeId === 'nB')!;
  expect(connected.map.roads.rCD!.toNodeId).toBe('nD'); expect(connected.map.roads.rCD!.fromNodeId).toBe('nC');
  expect(['both', 'backward']).toContain(connected.map.roads.rCD!.direction); expect(['both', 'forward']).toContain(onward[1].direction);
  const branchTurn = Object.values(connected.map.movements).find(turn => turn.incomingArc.roadId === 'rCD' && turn.incomingArc.direction === 'backward' && turn.outgoingArc.roadId === onward[0] && turn.outgoingArc.direction === 'forward');
  expect(branchTurn?.allowed).toBe(true); expect(connected.map.junctions[branchTurn!.junctionId]!.nodeIds).toContain('nC');

  await expect(page.locator('.canvas-status')).toContainText('1 个撤销事务'); await history(page, info, original, connected.map, 'connect');
  const saves = await savedRoundtrip(page, info, connected.map, connected.path);
  await info.attach('TE01-connect-receipt.json', { body: JSON.stringify({ kind: 'synthetic', optIn: true, overlapNoTopology: true, cancelExact: true, approvedTurns: 6, oneUndoRedo: true, saves }), contentType: 'application/json' });
});


test('TE01 unknown behavior stays read-only in the actual UI and exports its unchanged frame and declarations', async ({ page }, info) => {
  const original = readonlyFixture(); await imported(page, original);
  await page.getByTestId('object-search').fill('rAB'); await page.getByTestId('road-item-rAB').click();
  await expect(page.getByRole('button', { name: '拆分道路', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: '删除', exact: true })).toBeDisabled();
  await expect(page.locator('.canvas-status')).toContainText('0 个撤销事务');
  assertTE01Equal((await exported(page, info, 'unknown-readonly')).map, original);
});
