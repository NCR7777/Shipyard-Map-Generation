import { expect, test, type Page } from '@playwright/test';
import type { YardMap } from '../../src/domain/model';
import { editorFixture } from '../helpers/M1_fixtures';

const linkedFile = 'm11-linked.map.json';
const copyFile = 'm11-copy.map.json';

/** Only the picker is simulated. Every returned handle and stream below is native browser OPFS. */
async function installOPFSPickers(page: Page) {
  await page.addInitScript(({ initialJson, linkedName, copyName }) => {
    const root = navigator.storage.getDirectory();
    const ready = root.then(async directory => {
      try { return await directory.getFileHandle(linkedName); }
      catch (error) {
        if (!(error instanceof DOMException) || error.name !== 'NotFoundError') throw error;
        const handle = await directory.getFileHandle(linkedName, { create: true });
        const stream = await handle.createWritable();
        await stream.write(initialJson); await stream.close();
        return handle;
      }
    });
    Object.defineProperty(window, 'showOpenFilePicker', { configurable: true, value: async () => [await ready] });
    Object.defineProperty(window, 'showSaveFilePicker', {
      configurable: true, value: async () => (await root).getFileHandle(copyName, { create: true }),
    });
  }, { initialJson: JSON.stringify(editorFixture()), linkedName: linkedFile, copyName: copyFile });
}

async function readOPFS(page: Page, name = linkedFile): Promise<YardMap> {
  return page.evaluate(async filename => {
    const directory = await navigator.storage.getDirectory();
    const handle = await directory.getFileHandle(filename);
    return JSON.parse(await (await handle.getFile()).text());
  }, name) as Promise<YardMap>;
}

async function externalEdit(page: Page, x: number) {
  return page.evaluate(async ({ filename, nextX }) => {
    const directory = await navigator.storage.getDirectory();
    const handle = await directory.getFileHandle(filename);
    const map = JSON.parse(await (await handle.getFile()).text());
    const revision = map.revision as number;
    map.nodes.nB.position[0] = nextX;
    const stream = await handle.createWritable();
    await stream.write(JSON.stringify(map)); await stream.close();
    return revision;
  }, { filename: linkedFile, nextX: x });
}

async function persistedMaps(page: Page): Promise<YardMap[]> {
  const texts = await page.evaluate(() => new Promise<string[]>((resolve, reject) => {
    const request = indexedDB.open('shipyard-map-projects', 1);
    request.onerror = () => reject(new Error('Cannot inspect real project storage'));
    request.onsuccess = () => {
      const database = request.result;
      const transaction = database.transaction('projects', 'readonly');
      const rows = transaction.objectStore('projects').getAll();
      transaction.onabort = () => { database.close(); reject(new Error('Project inspection aborted')); };
      transaction.oncomplete = () => {
        const records = rows.result as { draft: { mapJson: string } | null; checkpoint: { mapJson: string } | null }[];
        resolve(records.flatMap(record => [record.draft?.mapJson, record.checkpoint?.mapJson].filter((value): value is string => !!value)));
        database.close();
      };
    };
  }));
  return texts.map(text => JSON.parse(text) as YardMap);
}

async function startLinked(page: Page) {
  await installOPFSPickers(page);
  await page.goto('/');
  await expect(page.getByTestId('browser-save-status')).toHaveText('浏览器草稿已保存');
  await page.getByRole('button', { name: '关联本地 JSON', exact: true }).click();
  await expect(page.getByTestId('road-count')).toHaveText('1');
  await expect(page.getByTestId('local-save-status')).toContainText(linkedFile);
  await expect(page.getByTestId('browser-save-status')).toHaveText('浏览器草稿已保存');
}

async function editEndpoint(page: Page, x: number) {
  await page.getByTestId('node-item-nB').click();
  await page.getByLabel('X (m)', { exact: true }).fill(String(x));
  await page.getByRole('button', { name: '应用属性', exact: true }).click();
  await page.getByTestId('road-item-rAB').click();
  await expect(page.getByTestId('road-length')).toHaveText(String(x));
}

test('simulated picker + real OPFS: UI writes, detects unchanged-revision external edits, backs up both sides and explicitly overwrites/reloads', async ({ page }, testInfo) => {
  testInfo.annotations.push({ type: 'evidence-boundary', description: 'Picker simulated; real browser OPFS file handles, streams and IndexedDB; native OS permissions are not tested.' });
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await startLinked(page);
  const initial = await readOPFS(page);
  expect(initial.nodes.nB!.position[0]).toBe(100);

  await editEndpoint(page, 110);
  await expect(page.getByTestId('local-save-status')).toContainText('有未写回变化');
  await page.getByRole('button', { name: '写回关联文件', exact: true }).click();
  await expect(page.getByTestId('local-save-status')).toContainText('本地文件已确认');
  const written = await readOPFS(page);
  expect(written.nodes.nB!.position[0]).toBe(110);
  expect(Object.keys(written.nodes)).toEqual(Object.keys(initial.nodes));
  expect(written.roads.rAB!.fromNodeId).toBe(initial.roads.rAB!.fromNodeId);
  expect(written.roads.rAB!.toNodeId).toBe(initial.roads.rAB!.toNodeId);

  // Pending property text must never be silently included or claimed as written.
  await page.getByTestId('node-item-nB').click();
  await page.getByLabel('X (m)', { exact: true }).fill('140');
  await expect(page.getByTestId('unapplied-inputs')).toBeVisible();
  await page.getByRole('button', { name: '写回关联文件', exact: true }).click();
  await expect(page.getByText('有未应用输入，请先应用属性；未写回文件。', { exact: true })).toBeVisible();
  expect((await readOPFS(page)).nodes.nB!.position[0]).toBe(110);
  await page.getByRole('button', { name: '应用属性', exact: true }).click();
  await page.getByTestId('road-item-rAB').click();
  await expect(page.getByTestId('road-length')).toHaveText('140');
  const currentHash = await page.getByTestId('map-hash').textContent();

  const unchangedRevision = await externalEdit(page, 120);
  expect(unchangedRevision).toBe(written.revision);
  expect((await readOPFS(page)).revision).toBe(written.revision);
  await page.getByRole('button', { name: '检查外部变化', exact: true }).click();
  const conflict = page.getByRole('dialog', { name: '外部文件内容已变化', exact: true });
  await expect(conflict).toBeVisible();
  await expect(page.getByTestId('map-hash')).toHaveText(currentHash ?? '');
  await conflict.getByRole('button', { name: '先保存双方恢复副本', exact: true }).click();
  await expect(conflict.getByRole('button', { name: '明确覆盖外部版本', exact: true })).toBeVisible();
  const backups = await persistedMaps(page);
  expect(backups.some(map => map.nodes.nB?.position[0] === 120)).toBe(true);
  expect(backups.some(map => map.nodes.nB?.position[0] === 140)).toBe(true);
  expect((await readOPFS(page)).nodes.nB!.position[0]).toBe(120);
  await conflict.getByRole('button', { name: '明确覆盖外部版本', exact: true }).click();
  await expect(conflict).not.toBeVisible();
  await expect(page.getByTestId('local-save-status')).toContainText('本地文件已确认');
  expect((await readOPFS(page)).nodes.nB!.position[0]).toBe(140);

  await externalEdit(page, 130);
  await page.getByRole('button', { name: '检查外部变化', exact: true }).click();
  await expect(conflict).toBeVisible();
  await conflict.getByRole('button', { name: '重新载入文件', exact: true }).click();
  await expect(conflict).not.toBeVisible();
  await page.getByTestId('road-item-rAB').click();
  await expect(page.getByTestId('road-length')).toHaveText('130');
  await expect(page.getByTestId('map-hash')).not.toHaveText(currentHash ?? '');
  await expect(page.getByTestId('local-save-status')).toContainText('本地文件已确认');
  await expect(page.getByTestId('browser-save-status')).toHaveText('浏览器草稿已保存');
  const afterReload = await persistedMaps(page);
  expect(afterReload.some(map => map.nodes.nB?.position[0] === 140)).toBe(true);
  expect(afterReload.some(map => map.nodes.nB?.position[0] === 130)).toBe(true);
  expect(errors).toEqual([]);
});

test('simulated picker + real OPFS: a new browser project does not inherit the old file and refresh requires reassociation', async ({ page }, testInfo) => {
  testInfo.annotations.push({ type: 'evidence-boundary', description: 'Real OPFS I/O with simulated pickers; no native OS file authorization claim.' });
  await startLinked(page);
  await editEndpoint(page, 125);
  await page.getByRole('button', { name: '写回关联文件', exact: true }).click();
  await expect(page.getByTestId('local-save-status')).toContainText('本地文件已确认');
  await expect(page.getByTestId('browser-save-status')).toHaveText('浏览器草稿已保存');
  const original = await readOPFS(page);

  await page.getByRole('button', { name: '新建地图', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '新建地图', exact: true });
  await dialog.getByLabel('新地图名称', { exact: true }).fill('独立的浏览器工程 B');
  await dialog.getByRole('button', { name: '创建地图', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.getByTestId('node-count')).toHaveText('0');
  await expect(page.getByTestId('local-save-status')).toHaveText('本地文件未关联');
  await expect(page.getByRole('button', { name: '写回关联文件', exact: true })).toBeDisabled();
  expect(await readOPFS(page)).toEqual(original);

  await page.getByRole('button', { name: '文件另存为', exact: true }).click();
  await expect(page.getByTestId('local-save-status')).toContainText(copyFile);
  const savedCopy = await readOPFS(page, copyFile);
  expect(savedCopy.metadata.name).toBe('独立的浏览器工程 B');
  expect(savedCopy.mapId).not.toBe(original.mapId);
  expect(savedCopy.nodes).toEqual({});
  expect(await readOPFS(page)).toEqual(original);
  await expect(page.getByTestId('browser-save-status')).toHaveText('浏览器草稿已保存');

  await page.reload();
  await expect(page.getByTestId('browser-save-status')).toHaveText('浏览器草稿已保存');
  await expect(page.getByLabel('地图名称', { exact: true })).toHaveValue('独立的浏览器工程 B');
  await expect(page.getByTestId('local-save-status')).toHaveText('本地文件未关联');
  await expect(page.getByRole('button', { name: '写回关联文件', exact: true })).toBeDisabled();
  expect(await readOPFS(page)).toEqual(original);
  expect(await readOPFS(page, copyFile)).toEqual(savedCopy);
});
