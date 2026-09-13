import { readFile } from 'node:fs/promises';
import { expect, type Page, type TestInfo } from '@playwright/test';
import type { YardMap, Vec3 } from '../../src/domain/model';
import type { EditorState, StoredProject } from '../../src/editor/projectController';

export async function readyWorkbench(page: Page) {
  await page.goto('/');
  await expect(page.getByRole('button', { name: '保存工程', exact: true })).toBeEnabled({ timeout: 30000 });
  await expect(page.getByTestId('map-canvas')).toBeVisible();
}

export async function browserSaved(page: Page) {
  await expect(page.getByTestId('browser-save-status')).toContainText('已保存', { timeout: 30000 });
}

export async function fileAction(page: Page, name: string) {
  const menu = page.locator('details.workbench-menu').filter({ has: page.locator('summary').filter({ hasText: /^文件$/ }) });
  const action = menu.getByRole('button', { name, exact: true });
  const opened = !(await action.isVisible());
  if (opened) await menu.locator('summary').click();
  await action.click();
  if (await menu.getAttribute('open') !== null && !(await page.getByRole('dialog').count())) await menu.locator('summary').click();
}

export async function importMapUI(page: Page, map: YardMap, bytes: Buffer = Buffer.from(JSON.stringify(map))) {
  const chooser = page.waitForEvent('filechooser');
  await fileAction(page, '导入 JSON');
  await (await chooser).setFiles({ name: map.mapId + '.json', mimeType: 'application/json', buffer: bytes });
  const conflict = page.getByRole('dialog', { name: '未保存编辑冲突', exact: true });
  await expect.poll(async () => await conflict.isVisible() || (await storedWorkspace(page))?.record?.draft?.contentHash === await page.getByTestId('map-hash').textContent()
    && (await storedWorkspace(page))?.record?.draft?.mapJson.includes(map.mapId), { timeout: 30000 }).toBeTruthy();
  if (await conflict.isVisible()) await conflict.getByRole('button', { name: '放弃编辑并重载', exact: true }).click();
  await expect(page.locator('.workbench-project-name')).toHaveText(map.metadata.name, { timeout: 30000 });
  await browserSaved(page);
}

export async function selectResult(page: Page, kind: 'node' | 'facilities' | 'servicePoints', id: string) {
  if (!(await page.getByTestId('object-search').isVisible())) await page.getByRole('button', { name: '切换对象面板', exact: true }).click();
  await page.getByTestId('object-search').fill(id);
  await page.getByTestId(kind + '-item-' + id).click();
  await expect(page.getByLabel('稳定 ID', { exact: true })).toHaveValue(id);
}

export async function exportMapUI(page: Page, info: TestInfo, name: string) {
  const download = page.waitForEvent('download');
  await fileAction(page, '导出 JSON');
  const path = info.outputPath(name + '.json');
  await (await download).saveAs(path);
  return { path, map: JSON.parse(await readFile(path, 'utf8')) as YardMap };
}

export async function storedWorkspace(page: Page, projectId?: string): Promise<{ record: StoredProject | undefined; editor: EditorState | undefined }> {
  return page.evaluate((requestedProjectId: string | undefined) => new Promise<{ record: StoredProject | undefined; editor: EditorState | undefined }>((resolve, reject) => {
    const open = indexedDB.open('shipyard-map-projects');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction(['projects', 'editorStates'], 'readonly');
      const id = requestedProjectId ?? sessionStorage.getItem('shipyard.activeProjectId')!;
      const record = tx.objectStore('projects').get(id);
      const editor = tx.objectStore('editorStates').get(id);
      tx.oncomplete = () => { db.close(); resolve({ record: record.result, editor: editor.result }); };
      tx.onabort = () => { db.close(); reject(tx.error); };
    };
  }), projectId);
}

export async function checkpoint(page: Page, expectedHash: string, afterVersion = 0) {
  await expect.poll(async () => {
    const { record } = await storedWorkspace(page);
    return !!record && record.storageVersion > afterVersion && record.checkpoint?.contentHash === expectedHash;
  }, { timeout: 30000 }).toBe(true);
  return (await storedWorkspace(page)).record!;
}

export async function canvasBox(page: Page) {
  const box = await page.getByTestId('map-canvas').locator('canvas').first().boundingBox();
  if (!box) throw new Error('Map canvas has no visible bounds');
  return box;
}

export async function expectVisiblePosition(page: Page, position: Vec3) {
  const canvas = await canvasBox(page);
  const camera = page.getByTestId('camera-state');
  const scale = Number(await camera.getAttribute('data-scale'));
  const x = canvas.x + Number(await camera.getAttribute('data-offset-x')) + position[0] * scale;
  const y = canvas.y + Number(await camera.getAttribute('data-offset-y')) - position[1] * scale;
  expect(x).toBeGreaterThan(canvas.x + 8); expect(x).toBeLessThan(canvas.x + canvas.width - 8);
  expect(y).toBeGreaterThan(canvas.y + 8); expect(y).toBeLessThan(canvas.y + canvas.height - 8);
  expect(await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.tagName, { x, y })).toBe('CANVAS');
  return { x, y, scale };
}

export async function selectBrowserTarget(page: Page) {
  const target = page.getByRole('dialog', { name: '选择保存目标', exact: true });
  if (await target.isVisible()) await target.getByRole('button', { name: '仅保存浏览器恢复', exact: true }).click();
}

export async function installRF01Picker(page: Page, filename: string) {
  await page.addInitScript(name => {
    Object.defineProperty(window, 'showSaveFilePicker', { configurable: true, value: async () =>
      (await navigator.storage.getDirectory()).getFileHandle(name, { create: true }) });
  }, filename);
}

export async function opfsMap(page: Page, filename: string): Promise<YardMap> {
  return page.evaluate(async name => {
    const handle = await (await navigator.storage.getDirectory()).getFileHandle(name);
    return JSON.parse(await (await handle.getFile()).text()) as YardMap;
  }, filename);
}
