import { readFile, writeFile } from 'node:fs/promises';
import { expect, test, type Page } from '@playwright/test';
import { GA01_TARGETS, GA01Command, readGA01Target, assertGA01Change, assertGA01Equal } from '../helpers/GA01_targets';
import { editorFixture } from '../helpers/M1_fixtures';
import { spatialFixture } from '../helpers/M2A_fixtures';
import { browserSaved, canvasBox, checkpoint, expectVisiblePosition, exportMapUI, fileAction, importMapUI,
  installRF01Picker, opfsMap, readyWorkbench, selectBrowserTarget, selectResult, storedWorkspace } from '../helpers/RF01_workbench';

const target = GA01_TARGETS.find(item => item.id === 'cimc_v02')!;
test.setTimeout(150000);
test.use({ actionTimeout: 15000 });
const loadedBundles = new WeakMap<Page, string[]>();
test.beforeEach(async ({ page }) => {
  const responses: string[] = []; loadedBundles.set(page, responses);
  page.on('response', response => {
    if (response.status() >= 200 && response.status() < 400 && /\/assets\/[^/]+\.js$/.test(new URL(response.url()).pathname)) responses.push(response.url());
  });
});
test.afterEach(async ({ page }, info) => {
  const urls = [...new Set(loadedBundles.get(page) ?? [])];
  await writeFile(info.outputPath('loaded-bundles.json'), JSON.stringify(urls, null, 2));
  await info.attach('loaded-bundles', { body: JSON.stringify(urls), contentType: 'application/json' });
  const expected = process.env.RF01_EXPECTED_BUNDLE;
  if (expected) expect(urls.some(url => new URL(url).pathname === '/assets/' + expected)).toBe(true);
});

for (const viewport of [{ width: 1920, height: 1080 }, { width: 1366, height: 768 }, { width: 1093, height: 614 }]) {
  test('RF01 real CIMC V02 complete workflow ' + viewport.width + 'x' + viewport.height, async ({ page, browser }, info) => {
    await page.setViewportSize(viewport);
    const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    const original = await readGA01Target(target);
    await readyWorkbench(page);
    await importMapUI(page, original, await readFile(target.absolutePath));
    const openedBox = await canvasBox(page);
    expect(openedBox.width).toBeGreaterThanOrEqual(700);
    expect(openedBox.height).toBeGreaterThanOrEqual(viewport.width === 1093 ? 430 : 500);
    await page.screenshot({ path: info.outputPath('01-real-map-open.png'), fullPage: true });
    await selectResult(page, 'node', target.nodeId);
    expect(await canvasBox(page)).toEqual(openedBox);
    const located = await expectVisiblePosition(page, original.nodes[target.nodeId]!.position);
    const originalHash = (await page.getByTestId('map-hash').textContent())!;
    const command = GA01Command(original, target, 'B');
    if (command.type !== 'updateNode') throw new Error('Expected approved GA01 node edit');
    const requestedX = command.patch.position![0];
    const x = page.getByLabel('X (m)', { exact: true });
    await browserSaved(page);
    const before = (await storedWorkspace(page)).record!;

    await x.fill(String(requestedX));
    await page.getByRole('button', { name: '保存工程', exact: true }).click();
    const chooseTarget = page.getByRole('dialog', { name: '选择保存目标', exact: true });
    await expect(chooseTarget).not.toBeVisible();
    const firstPending = page.getByRole('dialog', { name: '有未应用输入', exact: true });
    await expect(firstPending.getByRole('button', { name: '取消，保留输入', exact: true })).toBeFocused();
    await firstPending.getByRole('button', { name: '取消，保留输入', exact: true }).click();
    expect((await storedWorkspace(page)).record).toEqual(before);
    await expect(page.getByTestId('map-hash')).toHaveText(originalHash);
    await expect(x).toHaveValue(String(requestedX));

    await x.press('Control+s'); await selectBrowserTarget(page);
    const pending = page.getByRole('dialog', { name: '有未应用输入', exact: true });
    await expect(pending).toBeVisible(); await expect(page.getByRole('dialog')).toHaveCount(1);
    expect(await canvasBox(page)).toEqual(openedBox);
    await expect(pending.getByRole('button', { name: '取消，保留输入', exact: true })).toBeFocused();
    await page.screenshot({ path: info.outputPath('02-save-unapplied.png'), fullPage: true });
    await pending.getByRole('button', { name: '取消，保留输入', exact: true }).click();
    await expect(x).toBeFocused(); await expect(x).toHaveValue(String(requestedX));
    await expect(page.getByTestId('map-hash')).toHaveText(originalHash);

    await page.getByRole('button', { name: '保存工程', exact: true }).click();
    await expect(chooseTarget).not.toBeVisible();
    await pending.getByRole('button', { name: '仅保存已提交地图', exact: true }).click();
    const committedOnly = await checkpoint(page, originalHash, before.storageVersion);
    assertGA01Equal(JSON.parse(committedOnly.checkpoint!.mapJson), original);
    await expect(x).toHaveValue(String(requestedX));
    await expect(page.getByTestId('unapplied-inputs')).toBeVisible();

    // Two edits while already dirty exercise the stable registration's latest input callback.
    await x.fill(String(requestedX + 0.01)); await x.fill(String(requestedX)); await x.press('Control+s');
    await pending.getByRole('button', { name: '应用后保存', exact: true }).click();
    await expect(page.getByTestId('map-hash')).not.toHaveText(originalHash);
    const editedHash = (await page.getByTestId('map-hash').textContent())!;
    const saved = await checkpoint(page, editedHash, committedOnly.storageVersion);
    const edited = await exportMapUI(page, info, 'edited');
    assertGA01Change(original, edited.map, target, 'B');
    assertGA01Equal(JSON.parse(saved.checkpoint!.mapJson), edited.map);
    await expect(page.locator('.canvas-status')).toContainText('1 个撤销事务');
    await expect(page.getByTestId('unapplied-inputs')).not.toBeVisible();

    await page.getByRole('button', { name: '撤销', exact: true }).click();
    assertGA01Equal((await exportMapUI(page, info, 'undo')).map, original);
    await page.getByRole('button', { name: '重做', exact: true }).click();
    assertGA01Equal((await exportMapUI(page, info, 'redo')).map, edited.map);
    await page.getByRole('button', { name: '保存工程', exact: true }).click();
    await checkpoint(page, editedHash);
    await browserSaved(page);
    page.on('dialog', dialog => dialog.accept());
    await page.reload();
    await expect(page.getByTestId('map-hash')).toHaveText(editedHash, { timeout: 30000 });
    await browserSaved(page);
    expect((await storedWorkspace(page)).editor?.workbench?.saveTarget).toBe('ask');
    assertGA01Equal((await exportMapUI(page, info, 'refreshed')).map, edited.map);
    const previousProject = (await storedWorkspace(page)).record!.projectId;
    await importMapUI(page, edited.map, await readFile(edited.path));
    await expect.poll(async () => (await storedWorkspace(page)).record?.projectId).not.toBe(previousProject);
    assertGA01Equal((await exportMapUI(page, info, 'roundtrip')).map, edited.map);
    await selectResult(page, 'node', target.nodeId);
    const finalPosition = await expectVisiblePosition(page, edited.map.nodes[target.nodeId]!.position);
    expect(await canvasBox(page)).toEqual(openedBox);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: info.outputPath('03-real-map-restored-roundtrip.png'), fullPage: true });
    assertGA01Equal(await readGA01Target(target), original); expect(errors).toEqual([]);
    const receipt = { target: target.id, frozenSHA256: target.sha256, viewport, browser: browser.version(), canvas: openedBox,
      located, finalPosition, originalHash, editedHash, originalRevision: original.revision, editedRevision: edited.map.revision,
      singleGeometryTransaction: true, coordinateFramePreserved: true, stableIdsAndReferencesPreserved: true,
      saveCancel: true, committedOnlyCheckpoint: committedOnly.checkpoint!.contentHash, appliedCheckpoint: saved.checkpoint!.contentHash,
      legacySavePreferencePreserved: true, refreshed: true, jsonRoundtrip: true, originalUnchanged: true };
    await writeFile(info.outputPath('RF01-receipt.json'), JSON.stringify(receipt, null, 2));
    await info.attach('RF01-receipt', { body: JSON.stringify(receipt), contentType: 'application/json' });
  });
}

test('RF01 mixed spatial drafts reject without clearing inputs or creating history', async ({ page }, info) => {
  const original = spatialFixture();
  await readyWorkbench(page); await importMapUI(page, original); await selectResult(page, 'facilities', 'fA');
  const box = await canvasBox(page); const hash = (await page.getByTestId('map-hash').textContent())!;
  await page.getByLabel('矩形宽 (m)', { exact: true }).fill('59');
  await page.getByText('数值平移与旋转', { exact: true }).click();
  await page.getByLabel('平移 X (m)', { exact: true }).fill('1');
  await page.getByRole('button', { name: '保存工程', exact: true }).click(); await selectBrowserTarget(page);
  await page.getByRole('dialog', { name: '有未应用输入' }).getByRole('button', { name: '应用后保存', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.getByRole('alert')).toContainText('每次只提交一个完整事务');
  await expect(page.getByLabel('矩形宽 (m)', { exact: true })).toHaveValue('59');
  await expect(page.getByLabel('平移 X (m)', { exact: true })).toHaveValue('1');
  await expect(page.getByTestId('map-hash')).toHaveText(hash);
  await expect(page.locator('.canvas-status')).toContainText('0 个撤销事务');
  expect(await canvasBox(page)).toEqual(box);
  assertGA01Equal((await exportMapUI(page, info, 'mixed-rejected')).map, original);
  await page.screenshot({ path: info.outputPath('mixed-draft-rejected.png'), fullPage: true });
  await page.getByRole('button', { name: '重置变换输入', exact: true }).click();
  await page.getByRole('button', { name: '保存工程', exact: true }).click();
  await page.getByRole('dialog', { name: '有未应用输入' }).getByRole('button', { name: '应用后保存', exact: true }).click();
  await expect(page.getByTestId('map-hash')).not.toHaveText(hash);
  const changed = (await exportMapUI(page, info, 'width-applied')).map;
  expect(changed.revision).toBe(original.revision + 1); expect(changed.coordinateFrame).toEqual(original.coordinateFrame);
  expect(changed.facilities.fA!.boundary.outer).not.toEqual(original.facilities.fA!.boundary.outer);
});

test('RF01 modal priority, native text undo/delete, IME and discarded cross-project draft', async ({ page }, info) => {
  const original = editorFixture();
  await readyWorkbench(page); await importMapUI(page, original); await selectResult(page, 'node', 'nB');
  const hash = (await page.getByTestId('map-hash').textContent())!;
  const name = page.getByLabel('名称', { exact: true });
  await name.fill('文本编辑草稿'); await name.press('Control+z'); await name.press('Delete');
  await expect(page.getByTestId('map-hash')).toHaveText(hash);
  await name.fill(original.nodes.nB!.name);
  await name.dispatchEvent('compositionstart');
  await name.dispatchEvent('keydown', { key: 'Delete', isComposing: true, bubbles: true });
  await name.dispatchEvent('keydown', { key: 's', ctrlKey: true, isComposing: true, bubbles: true });
  await name.dispatchEvent('compositionend', { data: '' });
  await expect(page.getByRole('dialog')).toHaveCount(0); await expect(page.getByTestId('map-hash')).toHaveText(hash);
  await page.getByRole('button', { name: '复制', exact: true }).click();
  const copy = page.getByRole('dialog', { name: '复制选中对象', exact: true });
  await expect(copy).toBeVisible();
  const cancel = copy.getByRole('button', { name: '取消', exact: true });
  await expect(cancel).toBeFocused();
  await page.keyboard.press('Control+s'); await expect(page.getByRole('dialog')).toHaveCount(1);
  await expect(copy).toBeVisible();
  await copy.getByRole('button', { name: '确认复制', exact: true }).focus(); await page.keyboard.press('Tab');
  await expect(copy.getByLabel('X 偏移 (m)', { exact: true })).toBeFocused();
  await page.keyboard.press('Escape'); await expect(copy).not.toBeVisible();
  await expect(page.getByRole('button', { name: '复制', exact: true })).toBeFocused();
  await expect(page.getByTestId('map-hash')).toHaveText(hash);
  await page.getByLabel('X (m)', { exact: true }).fill('123');
  const replacement = editorFixture(); replacement.mapId = 'rf01_other_project'; replacement.metadata.name = 'RF01 synthetic 新工程';
  replacement.nodes.nB!.position[0] = 200;
  await importMapUI(page, replacement);
  await selectResult(page, 'node', 'nB'); await expect(page.getByLabel('X (m)', { exact: true })).toHaveValue('200');
  await expect(page.getByTestId('unapplied-inputs')).not.toBeVisible();
  await page.getByRole('button', { name: '保存工程', exact: true }).click(); await selectBrowserTarget(page);
  await checkpoint(page, (await page.getByTestId('map-hash').textContent())!);
  assertGA01Equal((await exportMapUI(page, info, 'new-project-no-old-draft')).map, replacement);
  await page.screenshot({ path: info.outputPath('new-project-draft-isolation.png'), fullPage: true });
});

for (const failure of ['file', 'browser'] as const) test('RF01 independent save receipts with simulated ' + failure + ' failure and native OPFS', async ({ page }, info) => {
  info.annotations.push({ type: 'evidence-boundary', description: 'Picker and one failure are simulated; OPFS streams and IndexedDB are native. OS file permission dialogs are not tested.' });
  const filename = 'rf01-' + failure + '.json';
  await installRF01Picker(page, filename); await readyWorkbench(page); await importMapUI(page, editorFixture());
  await fileAction(page, '文件另存为');
  await expect(page.getByTestId('local-save-status')).toContainText('已确认');
  await browserSaved(page);
  const durable = (await storedWorkspace(page)).record!; const oldFile = await opfsMap(page, filename);
  await selectResult(page, 'node', 'nB');
  await page.getByLabel('X (m)', { exact: true }).fill('120');
  if (failure === 'file') await page.evaluate(() => {
    FileSystemFileHandle.prototype.createWritable = async function () { throw new DOMException('RF01 simulated file permission rejection', 'NotAllowedError'); };
  });
  else await page.evaluate(() => {
    IDBObjectStore.prototype.put = function () { throw new DOMException('RF01 simulated browser quota exhaustion', 'QuotaExceededError'); };
  });
  await page.getByRole('button', { name: '保存工程', exact: true }).click();
  await page.getByRole('dialog', { name: '有未应用输入' }).getByRole('button', { name: '应用后保存', exact: true }).click();
  const changedHash = (await page.getByTestId('map-hash').textContent())!;
  if (failure === 'file') {
    const saved = await checkpoint(page, changedHash, durable.storageVersion);
    expect(JSON.parse(saved.checkpoint!.mapJson).nodes.nB.position[0]).toBe(120);
    assertGA01Equal(await opfsMap(page, filename), oldFile);
    await expect(page.getByTestId('local-save-status')).toContainText('未写回变化');
    await expect(page.getByTestId('browser-save-status')).toContainText('已保存');
  } else {
    await expect.poll(async () => (await opfsMap(page, filename)).nodes.nB!.position[0]).toBe(120);
    await expect(page.getByTestId('local-save-status')).toContainText('已确认');
    await expect(page.getByTestId('browser-save-status')).toContainText('失败');
    expect((await storedWorkspace(page)).record).toEqual(durable);
  }
  await page.screenshot({ path: info.outputPath('partial-save-' + failure + '.png'), fullPage: true });
});

test('RF01 map-name draft uses apply-and-save and preserves rejected blank input', async ({ page }, info) => {
  const original = editorFixture();
  await readyWorkbench(page); await importMapUI(page, original); await selectResult(page, 'node', 'nB');
  const hash = (await page.getByTestId('map-hash').textContent())!;
  // A selected but clean entity must not replace the active map-name draft registration.
  const name = page.getByLabel('地图名称', { exact: true });
  await name.fill('   '); await name.press('Control+s'); await selectBrowserTarget(page);
  const pending = page.getByRole('dialog', { name: '有未应用输入', exact: true });
  await pending.getByRole('button', { name: '应用后保存', exact: true }).click();
  await expect(page.getByTestId('map-hash')).toHaveText(hash);
  await expect(name).toHaveValue('   ');
  await expect(page.locator('.canvas-status')).toContainText('0 个撤销事务');
  // Return to the unchanged form if validation deliberately keeps the save dialog open.
  if (await pending.isVisible()) await pending.getByRole('button', { name: '取消，保留输入', exact: true }).click();
  const renamed = 'RF01 synthetic 地图名称草稿';
  await name.fill(renamed + '旧值'); await name.fill(renamed); await name.press('Control+s');
  await pending.getByRole('button', { name: '应用后保存', exact: true }).click();
  await expect(page.locator('.workbench-project-name')).toHaveText(renamed);
  const changedHash = (await page.getByTestId('map-hash').textContent())!;
  const saved = await checkpoint(page, changedHash);
  const exported = (await exportMapUI(page, info, 'renamed-map')).map;
  assertGA01Equal(exported, { ...original, revision: original.revision + 1, metadata: { ...original.metadata, name: renamed } });
  assertGA01Equal(JSON.parse(saved.checkpoint!.mapJson), exported);
  await expect(page.getByTestId('unapplied-inputs')).not.toBeVisible();
  await page.screenshot({ path: info.outputPath('map-name-applied-and-saved.png'), fullPage: true });
});

test('RF01 recovery-copy cancel retains draft and explicit discard creates a separate unchanged map', async ({ page }, info) => {
  const original = editorFixture();
  await readyWorkbench(page); await importMapUI(page, original); await selectResult(page, 'node', 'nB');
  const originalHash = (await page.getByTestId('map-hash').textContent())!;
  await page.getByRole('button', { name: '保存工程', exact: true }).click(); await selectBrowserTarget(page);
  const source = await checkpoint(page, originalHash);
  const sourceId = source.projectId;
  const x = page.getByLabel('X (m)', { exact: true });
  await x.fill('140');
  await fileAction(page, '浏览器另存为');
  const guard = page.getByRole('dialog', { name: '未应用输入保护', exact: true });
  await expect(guard).toContainText('另存浏览器恢复副本');
  await expect(page.getByRole('dialog')).toHaveCount(1);
  await guard.getByRole('button', { name: '取消，保留输入', exact: true }).click();
  await expect(x).toHaveValue('140'); await expect(page.getByTestId('map-hash')).toHaveText(originalHash);
  expect((await storedWorkspace(page)).record).toEqual(source);
  await fileAction(page, '浏览器另存为');
  await guard.getByRole('button', { name: '丢弃未应用输入并继续', exact: true }).click();
  await expect.poll(async () => (await storedWorkspace(page)).record?.projectId, { timeout: 30000 }).not.toBe(sourceId);
  await browserSaved(page);
  const copy = (await storedWorkspace(page)).record!;
  expect(copy.projectId).not.toBe(sourceId); expect(copy.name).toContain('恢复副本');
  assertGA01Equal(JSON.parse(copy.checkpoint!.mapJson), original);
  expect((await storedWorkspace(page, sourceId)).record).toEqual(source);
  await selectResult(page, 'node', 'nB'); await expect(x).toHaveValue('100');
  await expect(page.getByTestId('unapplied-inputs')).not.toBeVisible();
  assertGA01Equal((await exportMapUI(page, info, 'recovery-copy')).map, original);
  await page.screenshot({ path: info.outputPath('recovery-copy-after-discard.png'), fullPage: true });
});
