import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { test, expect, type Page, type TestInfo } from '@playwright/test';
import type { YardMap } from '../../src/domain/model';
import { editorFixture, readonlyFixture } from '../helpers/M1_fixtures';

const projectRoot = fileURLToPath(new URL('../../', import.meta.url));

async function screenPoint(page: Page, x: number, y: number) {
  const bounds = await page.getByTestId('map-canvas').locator('canvas').first().boundingBox();
  expect(bounds).not.toBeNull();
  const camera = page.getByTestId('camera-state');
  const offsetX = Number(await camera.getAttribute('data-offset-x'));
  const offsetY = Number(await camera.getAttribute('data-offset-y'));
  const scale = Number(await camera.getAttribute('data-scale'));
  return { x: bounds!.x + offsetX + x * scale, y: bounds!.y + offsetY - y * scale };
}

async function clickWorld(page: Page, x: number, y: number) {
  const point = await screenPoint(page, x, y);
  await page.mouse.click(point.x, point.y);
}

async function downloadMap(page: Page, testInfo: TestInfo, filename: string) {
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出 JSON', exact: true }).click();
  const download = await pending;
  const file = testInfo.outputPath(filename);
  await download.saveAs(file);
  return { file, map: JSON.parse(await readFile(file, 'utf8')) as YardMap };
}

async function importText(page: Page, map: YardMap | object, filename = 'import.map.json') {
  await page.getByTestId('json-file-input').setInputFiles({ name: filename, mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(map)) });
}

async function replaceFixture(page: Page, map = editorFixture()) {
  await importText(page, map);
  const conflict = page.getByRole('dialog', { name: '未保存编辑冲突' });
  await expect.poll(async () => (await conflict.isVisible()) || (await page.getByTestId('node-item-nA').isVisible())).toBe(true);
  if (await conflict.isVisible()) await conflict.getByRole('button', { name: '放弃编辑并重载', exact: true }).click();
  await expect(page.getByTestId('road-count')).toHaveText('1');
}

async function drawRoadWithMouse(page: Page) {
  await page.getByRole('button', { name: '节点', exact: true }).click();
  await clickWorld(page, 0, 0);
  await expect(page.getByTestId('node-count')).toHaveText('1');
  const a = await page.getByLabel('稳定 ID', { exact: true }).inputValue();
  await clickWorld(page, 80, 0);
  await expect(page.getByTestId('node-count')).toHaveText('2');
  const b = await page.getByLabel('稳定 ID', { exact: true }).inputValue();
  await page.getByRole('button', { name: '道路折线', exact: true }).click();
  await clickWorld(page, 0, 0);
  await clickWorld(page, 40, 20);
  await clickWorld(page, 80, 0);
  await expect(page.getByTestId('road-count')).toHaveText('1');
  const road = await page.getByLabel('稳定 ID', { exact: true }).inputValue();
  await expect(page.getByLabel('折点 1 X (m)', { exact: true })).toHaveValue('40');
  await page.getByRole('button', { name: '删除折点 1', exact: true }).click();
  await page.getByRole('button', { name: '应用属性', exact: true }).click();
  await page.getByTestId(`node-item-${b}`).click();
  await page.getByLabel('X (m)', { exact: true }).fill('100');
  await page.getByRole('button', { name: '应用属性', exact: true }).click();
  await page.getByTestId(`road-item-${road}`).click();
  await expect(page.getByTestId('road-length')).toHaveText('100');
  return { a, b, road };
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '船厂空间布局编辑器', exact: true })).toBeVisible();
  await expect(page.getByTestId('map-canvas')).toBeVisible();
});

test('draws a true polyline, edits to 100m, exports, externally edits to 120m, validates and reloads with stable IDs', async ({ page }, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.getByRole('button', { name: '新建地图', exact: true }).click();
  const newDialog = page.getByRole('dialog', { name: '新建地图', exact: true });
  const newName = newDialog.getByLabel('新地图名称', { exact: true });
  await newName.fill('');
  await newName.pressSequentially('M1 synthetic validation');
  await expect(newName).toHaveValue('M1 synthetic validation');
  await expect(newName).toBeFocused();
  await newDialog.getByRole('button', { name: '创建地图', exact: true }).click();
  await expect(newDialog).not.toBeVisible();
  await expect(page.getByTestId('node-count')).toHaveText('0');
  // M1.1 replaces the download baseline with durable browser storage (S09 tests independence).
  await expect(page.getByTestId('browser-save-status')).toContainText('浏览器草稿');
  const ids = await drawRoadWithMouse(page);
  const before = await downloadMap(page, testInfo, 'before.map.json');
  expect(before.map.roads[ids.road]!.fromNodeId).toBe(ids.a);
  expect(before.map.roads[ids.road]!.toNodeId).toBe(ids.b);
  expect(before.map.nodes[ids.b]!.position).toEqual([100, 0, 0]);
  expect(before.map.roads[ids.road]!.shapePoints).toEqual([]);
  const oldHash = await page.getByTestId('map-hash').textContent();
  await page.getByRole('button', { name: '平移', exact: true }).click();
  const panStart = await screenPoint(page, 45, 20);
  await page.mouse.move(panStart.x, panStart.y);
  await page.mouse.down();
  await page.mouse.move(panStart.x + 35, panStart.y + 25, { steps: 8 });
  await page.mouse.up();
  await page.mouse.wheel(0, -160);
  const viewOnly = await downloadMap(page, testInfo, 'after-view-only.map.json');
  expect(viewOnly.map).toEqual(before.map);
  await expect(page.getByTestId('map-hash')).toHaveText(oldHash ?? '');
  const edited = structuredClone(before.map);
  edited.nodes[ids.b]!.position = [120, 0, 0];
  const editedFile = testInfo.outputPath('external-120.map.json');
  await writeFile(editedFile, JSON.stringify(edited, null, 2), 'utf8');
  const cli = spawnSync(process.execPath, ['--import', 'tsx', 'scripts/map-validate.ts', editedFile], {
    cwd: projectRoot, encoding: 'utf8', timeout: 20_000, windowsHide: true,
  });
  expect(cli.status, cli.stderr).toBe(0);
  const report = JSON.parse(cli.stdout) as { ok: boolean; mapContentHash: string };
  expect(report.ok).toBe(true);
  await page.getByTestId('json-file-input').setInputFiles(editedFile);
  await expect(page.getByRole('dialog', { name: '未保存编辑冲突' })).not.toBeVisible();
  await page.getByTestId(`road-item-${ids.road}`).click();
  await expect(page.getByTestId('road-length')).toHaveText('120');
  await expect(page.getByTestId('map-hash')).not.toHaveText(oldHash ?? '');
  await expect(page.getByTestId('map-hash')).toContainText(report.mapContentHash);
  await page.getByRole('button', { name: '选择', exact: true }).click();
  await clickWorld(page, 120, 0);
  await expect(page.getByLabel('稳定 ID', { exact: true })).toHaveValue(ids.b);
  await expect(page.getByLabel('X (m)', { exact: true })).toHaveValue('120');
  const after = await downloadMap(page, testInfo, 'after.map.json');
  expect(after.map.revision).toBe(before.map.revision);
  expect(Object.keys(after.map.nodes)).toEqual(Object.keys(before.map.nodes));
  expect(Object.keys(after.map.roads)).toEqual(Object.keys(before.map.roads));
  expect(after.map.roads).toEqual(before.map.roads);
  await page.screenshot({ path: testInfo.outputPath('M1_external_120m.png'), fullPage: true });
  await mkdir(new URL('../../.cache/', import.meta.url), { recursive: true });
  await page.screenshot({ path: fileURLToPath(new URL('../../.cache/M1_editor.png', import.meta.url)), fullPage: true });
  expect(errors).toEqual([]);
});

test('commits a real 100-step drag as one undo operation and rejects a zero-length drag without ghost coordinates', async ({ page }, testInfo) => {
  await replaceFixture(page);
  await page.getByRole('button', { name: '选择', exact: true }).click();
  await page.getByTestId('node-item-nB').click();
  const start = await screenPoint(page, 100, 0);
  const end = await screenPoint(page, 120, 10);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(end.x, end.y, { steps: 100 });
  await page.mouse.up();
  await expect(page.getByLabel('X (m)', { exact: true })).toHaveValue('120');
  await expect(page.getByLabel('Y (m)', { exact: true })).toHaveValue('10');
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect(page.getByLabel('X (m)', { exact: true })).toHaveValue('100');
  await expect(page.getByLabel('Y (m)', { exact: true })).toHaveValue('0');
  await expect(page.getByRole('button', { name: '撤销', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '重做', exact: true }).click();
  await expect(page.getByLabel('X (m)', { exact: true })).toHaveValue('120');
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  const before = await downloadMap(page, testInfo, 'before-failed-drag.map.json');
  const invalidStart = await screenPoint(page, 100, 0);
  const invalidEnd = await screenPoint(page, 0, 0);
  await page.mouse.move(invalidStart.x, invalidStart.y);
  await page.mouse.down();
  await page.mouse.move(invalidEnd.x, invalidEnd.y, { steps: 20 });
  await page.mouse.up();
  await expect(page.getByTestId('issue-panel')).toContainText('ZERO_LENGTH_ROAD');
  await expect(page.getByRole('button', { name: '撤销', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: '重做', exact: true })).toBeEnabled();
  await page.getByTestId('road-item-rAB').click();
  await clickWorld(page, 100, 0);
  await expect(page.getByLabel('稳定 ID', { exact: true })).toHaveValue('nB');
  await expect(page.getByLabel('X (m)', { exact: true })).toHaveValue('100');
  const after = await downloadMap(page, testInfo, 'after-failed-drag.map.json');
  expect(after.map).toEqual(before.map);
});

test('preserves dirty edits and undo across invalid imports and cancel, then exports the current version before explicit reload', async ({ page }, testInfo) => {
  await replaceFixture(page);
  await page.getByTestId('node-item-nA').click();
  await page.getByLabel('名称', { exact: true }).fill('保留这份本地编辑');
  await page.getByRole('button', { name: '应用属性', exact: true }).click();
  const dirtyHash = await page.getByTestId('map-hash').textContent();
  const invalid = editorFixture();
  invalid.roads.rAB!.toNodeId = 'missingNode';
  await importText(page, invalid, 'bad.map.json');
  await expect(page.getByTestId('issue-panel')).toContainText('DANGLING_REFERENCE');
  await expect(page.getByRole('dialog', { name: '未保存编辑冲突' })).not.toBeVisible();
  await expect(page.getByTestId('map-hash')).toHaveText(dirtyHash ?? '');
  await expect(page.getByRole('button', { name: '撤销', exact: true })).toBeEnabled();
  const external = editorFixture();
  external.nodes.nB!.position = [120, 0, 0];
  await importText(page, external);
  const dialog = page.getByRole('dialog', { name: '未保存编辑冲突' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: '取消', exact: true })).toBeFocused();
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await expect(page.getByTestId('map-hash')).toHaveText(dirtyHash ?? '');
  await expect(page.getByLabel('名称', { exact: true })).toHaveValue('保留这份本地编辑');
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect(page.getByLabel('名称', { exact: true })).toHaveValue('A');
  await page.getByRole('button', { name: '重做', exact: true }).click();
  await importText(page, external);
  await expect(dialog).toBeVisible();
  const pending = page.waitForEvent('download');
  await dialog.getByRole('button', { name: '先导出当前版本', exact: true }).click();
  const download = await pending;
  const currentFile = testInfo.outputPath('conflict-current.map.json');
  await download.saveAs(currentFile);
  const saved = JSON.parse(await readFile(currentFile, 'utf8')) as YardMap;
  expect(saved.nodes.nA!.name).toBe('保留这份本地编辑');
  expect(saved.nodes.nB!.position).toEqual([100, 0, 0]);
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: '放弃编辑并重载', exact: true }).click();
  await page.getByTestId('road-item-rAB').click();
  await expect(page.getByTestId('road-length')).toHaveText('120');
  await expect(page.getByRole('button', { name: '撤销', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: '重做', exact: true })).toBeDisabled();
});

test('copies a selected road through the UI with fresh endpoint IDs and stable redo', async ({ page }, testInfo) => {
  await replaceFixture(page);
  await page.getByTestId('road-item-rAB').click();
  await page.getByRole('button', { name: '复制', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '复制选中对象', exact: true });
  await expect(dialog).toBeVisible();
  await dialog.getByLabel('X 偏移 (m)', { exact: true }).fill('0');
  await dialog.getByLabel('Y 偏移 (m)', { exact: true }).fill('30');
  await dialog.getByLabel('Z 偏移 (m)', { exact: true }).fill('0');
  await dialog.getByRole('button', { name: '确认复制', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByTestId('node-count')).toHaveText('4');
  await expect(page.getByTestId('road-count')).toHaveText('2');
  const copied = await downloadMap(page, testInfo, 'copied.map.json');
  const roadId = Object.keys(copied.map.roads).find((id) => id !== 'rAB');
  expect(roadId).toBeDefined();
  const road = copied.map.roads[roadId!]!;
  expect(road.fromNodeId).not.toBe('nA');
  expect(road.toNodeId).not.toBe('nB');
  expect(copied.map.nodes[road.fromNodeId]!.position).toEqual([0, 30, 0]);
  expect(copied.map.nodes[road.toNodeId]!.position).toEqual([100, 30, 0]);
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect(page.getByTestId('node-count')).toHaveText('2');
  await expect(page.getByTestId('road-count')).toHaveText('1');
  await expect(page.getByRole('button', { name: '撤销', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '重做', exact: true }).click();
  const redone = await downloadMap(page, testInfo, 'copy-redone.map.json');
  expect(redone.map).toEqual(copied.map);
});

test('imports unsupported facilities read-only, preserves their JSON on export and rejects future versions', async ({ page }, testInfo) => {
  const advanced = readonlyFixture();
  await replaceFixture(page, advanced);
  await expect(page.getByTestId('readonly-notice')).toBeVisible();
  await expect(page.getByRole('button', { name: '节点', exact: true })).toBeDisabled();
  await page.getByTestId('node-item-nB').click();
  await expect(page.getByRole('button', { name: '应用属性', exact: true })).toBeDisabled();
  const exported = await downloadMap(page, testInfo, 'advanced-preserved.map.json');
  expect(exported.map).toEqual(advanced);
  const oldHash = await page.getByTestId('map-hash').textContent();
  await importText(page, { ...editorFixture(), schemaVersion: '99.0.0' }, 'future.map.json');
  await expect(page.getByTestId('issue-panel')).toContainText('UNSUPPORTED_SCHEMA_VERSION');
  await expect(page.getByTestId('map-hash')).toHaveText(oldHash ?? '');
  await expect(page.getByTestId('readonly-notice')).toBeVisible();
});

test('keeps text-field undo and deletion separate from map commands', async ({ page }) => {
  await replaceFixture(page);
  await page.getByTestId('node-item-nA').click();
  await page.getByLabel('名称', { exact: true }).fill('已提交名称');
  await page.getByRole('button', { name: '应用属性', exact: true }).click();
  const hash = await page.getByTestId('map-hash').textContent();
  const name = page.getByLabel('名称', { exact: true });
  await name.focus();
  await name.press('End');
  await name.pressSequentially('text');
  await name.press('Control+z');
  await expect(page.getByTestId('map-hash')).toHaveText(hash ?? '');
  await name.press('Control+a');
  await name.press('Delete');
  await expect(page.getByTestId('node-count')).toHaveText('2');
  await expect(page.getByTestId('map-hash')).toHaveText(hash ?? '');
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect(page.getByLabel('名称', { exact: true })).toHaveValue('A');
});
