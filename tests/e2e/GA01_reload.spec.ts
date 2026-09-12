import { expect, test, type Page } from '@playwright/test';
import { editorFixture } from '../helpers/M1_fixtures';

const map = editorFixture();
map.coordinateFrame.geographicAnchor = { crs: 'EPSG:32652', coordinateOrder: 'easting,northing,height', origin: [400000, 3900000, 12], rotationRad: 0.3, method: 'GA01 test only' };
const changed = structuredClone(map); changed.coordinateFrame.geographicAnchor!.origin[0] += 10;
const filename = 'GA01_frame.map.json';
async function ready(page: Page) {
  await page.goto('/'); await expect(page.getByTestId('browser-save-status')).toHaveText('浏览器草稿已保存');
}
async function importMap(page: Page) {
  await page.locator('input[type=file]').setInputFiles({ name: filename, mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(map)) });
  await expect(page.getByTestId('fixed-coordinate-frame')).toBeVisible();
  await expect(page.getByTestId('browser-save-status')).toHaveText('浏览器草稿已保存');
}

test('GA01 browser reload: frame replacement requires confirmation; cancellation preserves map/history and later acceptance uses the reviewed snapshot', async ({ page }) => {
  await ready(page); await importMap(page);
  const beforeHash = await page.getByTestId('map-hash').textContent();
  const projectId = await page.evaluate(() => sessionStorage.getItem('shipyard.activeProjectId'));
  await page.evaluate(async ({ id, text, hash }) => {
    await new Promise<void>((resolve, reject) => {
      const open = indexedDB.open('shipyard-map-projects', 1);
      open.onsuccess = () => {
        const db = open.result; const tx = db.transaction('projects', 'readwrite'); const store = tx.objectStore('projects');
        const read = store.get(id!);
        read.onsuccess = () => { const row = read.result; row.storageVersion++; row.draft = { mapJson: text, contentHash: hash, savedAt: Date.now() }; store.put(row); };
        tx.oncomplete = () => { db.close(); resolve(); }; tx.onabort = () => reject(tx.error);
      }; open.onerror = () => reject(open.error);
    });
    window.dispatchEvent(new Event('focus'));
  }, { id: projectId, text: JSON.stringify(changed), hash: await page.evaluate(async value => { const path = '/src/domain/serialization.ts'; return (await import(path)).contentHash(value) as string; }, changed) });
  await expect(page.getByTestId('browser-save-status')).toContainText('冲突');
  await page.getByRole('button', { name: '重新载入浏览器版本', exact: true }).click();
  await page.getByRole('button', { name: '明确放弃并重新载入', exact: true }).click();
  const confirmation = page.getByRole('dialog', { name: '确认替换坐标框架' });
  await expect(confirmation).toBeVisible(); await confirmation.getByRole('button', { name: '取消', exact: true }).click();
  await expect(page.getByTestId('map-hash')).toHaveText(beforeHash!);
  expect(await page.evaluate(() => sessionStorage.getItem('shipyard.activeProjectId'))).toBe(projectId);
  await page.getByRole('button', { name: '重新载入浏览器版本', exact: true }).click();
  await page.getByRole('button', { name: '明确放弃并重新载入', exact: true }).click();
  await confirmation.getByRole('button', { name: '取消', exact: true }).focus();
  await page.keyboard.press('Tab');
  await expect(confirmation.getByRole('button', { name: '明确接受候选坐标框架' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('map-hash')).not.toHaveText(beforeHash!);
  await expect(page.getByTestId('browser-save-status')).toHaveText('浏览器草稿已保存');
  await page.reload(); await expect(page.getByTestId('fixed-coordinate-frame')).toBeVisible();
});

test('GA01 linked-file reload: cancel keeps file baseline, explicit acceptance creates a new project with the captured frame', async ({ page }, testInfo) => {
  testInfo.annotations.push({ type: 'evidence-boundary', description: 'Simulated picker; real OPFS handle, streams, IndexedDB and UI.' });
  await page.addInitScript(({ text, filename }) => {
    const ready = navigator.storage.getDirectory().then(async root => {
      const file = await root.getFileHandle(filename, { create: true }); const stream = await file.createWritable(); await stream.write(text); await stream.close(); return file;
    });
    Object.defineProperty(window, 'showOpenFilePicker', { configurable: true, value: async () => [await ready] });
  }, { text: JSON.stringify(map), filename });
  await ready(page); await page.getByRole('button', { name: '关联本地 JSON', exact: true }).click();
  await expect(page.getByTestId('fixed-coordinate-frame')).toBeVisible();
  await expect(page.getByTestId('browser-save-status')).toHaveText('浏览器草稿已保存');
  const beforeHash = await page.getByTestId('map-hash').textContent();
  const projectId = await page.evaluate(() => sessionStorage.getItem('shipyard.activeProjectId'));
  await page.evaluate(async ({ text, filename }) => {
    const file = await (await navigator.storage.getDirectory()).getFileHandle(filename);
    const stream = await file.createWritable(); await stream.write(text); await stream.close();
  }, { text: JSON.stringify(changed), filename });
  await page.getByRole('button', { name: '重新载入文件', exact: true }).click();
  const confirmation = page.getByRole('dialog', { name: '确认替换坐标框架' });
  await expect(confirmation).toBeVisible(); await confirmation.getByRole('button', { name: '取消', exact: true }).click();
  await expect(page.getByTestId('map-hash')).toHaveText(beforeHash!);
  expect(await page.evaluate(() => sessionStorage.getItem('shipyard.activeProjectId'))).toBe(projectId);
  await expect(page.getByTestId('local-save-status')).toContainText('冲突');
  await expect(page.getByRole('button', { name: '重新载入文件', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '重新载入文件', exact: true }).click();
  await confirmation.getByRole('button', { name: '明确接受候选坐标框架' }).click();
  await expect(page.getByTestId('map-hash')).not.toHaveText(beforeHash!);
  await expect(page.getByTestId('local-save-status')).toContainText('本地文件已确认');
  expect(await page.evaluate(() => sessionStorage.getItem('shipyard.activeProjectId'))).not.toBe(projectId);
});


test('GA01 selecting the active recent project preserves committed geometry and undo history', async ({ page }) => {
  await ready(page); await importMap(page);
  const projectId = await page.evaluate(() => sessionStorage.getItem('shipyard.activeProjectId'));
  await page.getByTestId('node-item-nB').click();
  await page.getByLabel('X (m)', { exact: true }).fill('110');
  await page.getByRole('button', { name: '应用属性', exact: true }).click();
  const editedHash = await page.getByTestId('map-hash').textContent();
  await page.getByRole('button', { name: '最近项目', exact: true }).click();
  await page.getByTestId('project-item-' + projectId).click();
  await expect(page.getByTestId('map-hash')).toHaveText(editedHash!);
  await expect(page.getByRole('button', { name: '撤销', exact: true })).toBeEnabled();
  await expect(page.getByTestId('field-sources')).toContainText('position');
  await expect(page.getByTestId('field-sources')).toContainText('design_assumption');
});
