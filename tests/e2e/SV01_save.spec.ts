import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import type { YardMap } from '../../src/domain/model';
import { editorFixture } from '../helpers/M1_fixtures';
import { drawingControl, fileAction } from '../helpers/workbenchUi';
import { checkpoint, expectVisiblePosition, storedWorkspace } from '../helpers/RF01_workbench';

const originalFile = 'sv01-original.map.json';
const secondFile = 'sv01-second.map.json';
const copyFile = 'sv01-explicit-copy.map.json';
const wrongFile = 'sv01-other-map.map.json';
const frameFile = 'sv01-other-frame.map.json';
const nameA = 'SV01 synthetic 工程 A';
const nameB = 'SV01 synthetic 工程 B';

test.setTimeout(90000);
const loadedBundles = new WeakMap<Page, string[]>();

function mapWithName(name: string, x = 100): YardMap {
  const map = editorFixture(); map.metadata.name = name; map.nodes.nB!.position[0] = x;
  return map;
}

/** Only OS pickers are simulated: files, handles, streams and persisted handle clones are native. */
async function installPickers(page: Page, originalMap = mapWithName(nameA)) {
  const wrong = mapWithName('SV01 synthetic 其他地图'); wrong.mapId = 'sv01_different_map';
  const frame = mapWithName('SV01 synthetic 不同框架');
  frame.coordinateFrame.geographicAnchor = { crs: 'EPSG:32652', coordinateOrder: 'easting,northing,height', origin: [100, 200, 0], rotationRad: 0.1, method: 'synthetic_test' };
  await page.addInitScript(({ files, initialName, saveName }) => {
    const ready = navigator.storage.getDirectory().then(async directory => {
      for (const [name, text] of files) {
        try { await directory.getFileHandle(name); }
        catch (error) {
          if (!(error instanceof DOMException) || error.name !== 'NotFoundError') throw error;
          const handle = await directory.getFileHandle(name, { create: true });
          const stream = await handle.createWritable(); await stream.write(text); await stream.close();
        }
      }
      return directory;
    });
    const count = (key: string) => sessionStorage.setItem(key, String(Number(sessionStorage.getItem(key) ?? '0') + 1));
    Object.defineProperty(window, 'showOpenFilePicker', { configurable: true, value: async () => {
      count('sv01-open-count');
      if (sessionStorage.getItem('sv01-cancel-open')) {
        sessionStorage.removeItem('sv01-cancel-open'); throw new DOMException('Synthetic picker cancellation', 'AbortError');
      }
      return [await (await ready).getFileHandle(sessionStorage.getItem('sv01-open-name') ?? initialName)];
    } });
    Object.defineProperty(window, 'showSaveFilePicker', { configurable: true, value: async () => {
      count('sv01-save-count'); return (await ready).getFileHandle(saveName, { create: true });
    } });
  }, { files: [[originalFile, JSON.stringify(originalMap)], [secondFile, JSON.stringify(mapWithName(nameB, 200))],
    [wrongFile, JSON.stringify(wrong)], [frameFile, JSON.stringify(frame)]] as [string, string][], initialName: originalFile, saveName: copyFile });
}

async function fileText(page: Page, name = originalFile): Promise<string> {
  return page.evaluate(async filename => {
    const file = await (await navigator.storage.getDirectory()).getFileHandle(filename);
    return (await file.getFile()).text();
  }, name);
}
async function readMap(page: Page, name = originalFile): Promise<YardMap> { return JSON.parse(await fileText(page, name)) as YardMap; }
async function chooseFile(page: Page, name: string) { await page.evaluate(value => sessionStorage.setItem('sv01-open-name', value), name); }
async function pickerCounts(page: Page) {
  return page.evaluate(() => ({ open: Number(sessionStorage.getItem('sv01-open-count') ?? '0'), save: Number(sessionStorage.getItem('sv01-save-count') ?? '0') }));
}
async function saved(page: Page) {
  await expect(page.getByTestId('browser-save-status')).toHaveText('浏览器草稿已保存');
  await expect(page.getByRole('button', { name: '保存工程', exact: true })).toBeEnabled();
}
async function start(page: Page, linked = true) {
  await installPickers(page); await page.goto('/'); await saved(page);
  if (linked) {
    await fileAction(page, '导入 JSON');
    await expect(page.getByTestId('local-save-status')).toContainText(originalFile);
  } else {
    await page.getByTestId('json-file-input').setInputFiles({ name: originalFile, mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(mapWithName(nameA))) });
    await expect(page.getByTestId('local-save-status')).toHaveText('本地文件未关联');
  }
  await expect(page.getByTestId('road-count')).toHaveText('1'); await saved(page);
}
async function editX(page: Page, value: number) {
  await page.getByTestId('node-item-nB').click();
  await page.getByLabel('X (m)', { exact: true }).fill(String(value));
  await page.getByRole('button', { name: '应用属性', exact: true }).click();
  await page.getByTestId('road-item-rAB').click();
  await expect(page.getByTestId('road-length')).toHaveText(String(value));
}
async function saveOriginal(page: Page, x: number, name = originalFile) {
  await page.getByRole('button', { name: '保存工程', exact: true }).click();
  await expect(page.getByTestId('local-save-status')).toContainText('本地文件已确认：' + name);
  expect((await readMap(page, name)).nodes.nB!.position[0]).toBe(x); await saved(page);
}
async function recent(page: Page, name: string) {
  await fileAction(page, '最近项目');
  const modal = page.getByRole('dialog', { name: '最近项目', exact: true });
  await modal.getByRole('button').filter({ has: page.getByText(name, { exact: true }) }).click();
  await expect(modal).not.toBeVisible(); await saved(page);
}
async function selectOriginalForUnlinked(page: Page) {
  await fileAction(page, '关联原文件');
}
async function externalX(page: Page, value: number) {
  return page.evaluate(async ({ name, x }) => {
    const handle = await (await navigator.storage.getDirectory()).getFileHandle(name);
    const map = JSON.parse(await (await handle.getFile()).text()); const revision = map.revision as number;
    map.nodes.nB.position[0] = x;
    const stream = await handle.createWritable(); await stream.write(JSON.stringify(map)); await stream.close();
    return revision;
  }, { name: originalFile, x: value });
}

test.beforeEach(async ({ page }, info) => {
  const bundles: string[] = []; loadedBundles.set(page, bundles);
  page.on('response', response => { if (/\/assets\/[^/]+\.js$/.test(new URL(response.url()).pathname)) bundles.push(response.url()); });
  info.annotations.push({ type: 'evidence-boundary', description: 'Synthetic fixtures except the explicitly frozen Hanwha case; OS picker simulated; real OPFS handles/streams and IndexedDB. Native OS chooser and permission prompts are not tested.' });
});

test.afterEach(async ({ page }, info) => {
  await info.attach('loaded-production-bundles', { body: JSON.stringify([...new Set(loadedBundles.get(page) ?? [])]), contentType: 'application/json' });
});

test('SV01 ordinary open and Save keep writing the same file across refresh and closing the page', async ({ page, context }, info) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  let downloads = 0; page.on('download', () => downloads++);
  await start(page); const original = await readMap(page);
  await editX(page, 110); await saveOriginal(page, 110);
  const written = await readMap(page);
  expect(written.coordinateFrame).toEqual(original.coordinateFrame);
  expect(written.roads).toEqual(original.roads);
  await page.reload(); await saved(page);
  await expect(page.getByTestId('local-save-status')).toContainText(originalFile);
  await editX(page, 125); await page.keyboard.press('Control+s');
  await expect(page.getByTestId('local-save-status')).toContainText('本地文件已确认：' + originalFile);
  expect((await readMap(page)).nodes.nB!.position[0]).toBe(125); await saved(page);
  expect(await pickerCounts(page)).toEqual({ open: 1, save: 0 });
  await page.screenshot({ path: info.outputPath('save-original-after-refresh.png'), fullPage: true });
  await page.close();
  const reopened = await context.newPage(); await installPickers(reopened); await reopened.goto('/'); await saved(reopened);
  await expect(reopened.getByTestId('local-save-status')).toContainText(originalFile);
  await editX(reopened, 135); await saveOriginal(reopened, 135);
  expect(await pickerCounts(reopened)).toEqual({ open: 0, save: 0 });
  expect(downloads).toBe(0); expect(errors).toEqual([]);
});

test('SV01 same mapId in two projects restores the correct distinct file handle', async ({ page }) => {
  await start(page); await editX(page, 111); await saveOriginal(page, 111);
  await chooseFile(page, secondFile); await fileAction(page, '关联本地 JSON'); await saved(page);
  await expect(page.getByTestId('local-save-status')).toContainText(secondFile);
  expect((await readMap(page)).mapId).toBe((await readMap(page, secondFile)).mapId);
  await editX(page, 222); await saveOriginal(page, 222, secondFile);
  await recent(page, nameA); await expect(page.getByTestId('local-save-status')).toContainText(originalFile);
  await editX(page, 113); await saveOriginal(page, 113);
  expect((await readMap(page, secondFile)).nodes.nB!.position[0]).toBe(222);
  await recent(page, nameB); await page.reload(); await saved(page);
  await expect(page.getByTestId('local-save-status')).toContainText(secondFile);
  await editX(page, 223); await saveOriginal(page, 223, secondFile);
  expect((await readMap(page)).nodes.nB!.position[0]).toBe(113);
  expect(await pickerCounts(page)).toEqual({ open: 2, save: 0 });
});

test('SV01 existing imported copy can attach its original without reloading away edits; cancellation writes nothing', async ({ page }, info) => {
  await start(page, false); const original = await fileText(page);
  await editX(page, 155); const hash = await page.getByTestId('map-hash').textContent();
  await page.evaluate(() => sessionStorage.setItem('sv01-cancel-open', '1'));
  await selectOriginalForUnlinked(page);
  await expect(page.getByRole('dialog', { name: '关联原文件并写回', exact: true })).not.toBeVisible();
  expect(await fileText(page)).toBe(original);
  await selectOriginalForUnlinked(page);
  const confirm = page.getByRole('dialog', { name: '关联原文件并写回', exact: true });
  await expect(confirm).toBeVisible(); await expect(page.getByTestId('map-hash')).toHaveText(hash!);
  expect(await fileText(page)).toBe(original);
  await confirm.getByRole('button', { name: '取消', exact: true }).click();
  await expect(page.getByTestId('local-save-status')).toHaveText('本地文件未关联');
  expect(await fileText(page)).toBe(original); await expect(page.getByTestId('map-hash')).toHaveText(hash!);
  await selectOriginalForUnlinked(page); await expect(confirm).toBeVisible();
  await page.screenshot({ path: info.outputPath('attach-original-confirmation.png'), fullPage: true });
  await confirm.getByRole('button', { name: '确认关联并写回', exact: true }).click();
  await expect(page.getByTestId('local-save-status')).toContainText('本地文件已确认：' + originalFile);
  expect((await readMap(page)).nodes.nB!.position[0]).toBe(155);
  await expect(page.getByTestId('map-hash')).toHaveText(hash!);
  await expect(page.locator('.canvas-status')).toContainText('1 个撤销事务');
  await saved(page); await page.reload(); await saved(page);
  await editX(page, 165); await saveOriginal(page, 165);
  expect(await pickerCounts(page)).toEqual({ open: 3, save: 0 });
});

test('SV01 unchanged-revision external change survives refresh and blocks Save without overwriting either side', async ({ page }) => {
  await start(page); await editX(page, 110); await saveOriginal(page, 110);
  const written = await readMap(page); const currentHash = await page.getByTestId('map-hash').textContent();
  expect(await externalX(page, 120)).toBe(written.revision);
  const external = await fileText(page);
  await page.reload(); await saved(page);
  await expect(page.getByTestId('map-hash')).toHaveText(currentHash!);
  await page.getByRole('button', { name: '保存工程', exact: true }).click();
  const conflict = page.getByRole('dialog', { name: '外部文件内容已变化', exact: true });
  await expect(conflict).toBeVisible(); expect(await fileText(page)).toBe(external);
  await expect(page.getByTestId('map-hash')).toHaveText(currentHash!);
  await conflict.getByRole('button', { name: '取消', exact: true }).click();
  expect(await fileText(page)).toBe(external); expect(await pickerCounts(page)).toEqual({ open: 1, save: 0 });
});

test('SV01 different map IDs and coordinate frames cannot become original-file write targets', async ({ page }) => {
  await start(page, false); await editX(page, 155);
  const hash = await page.getByTestId('map-hash').textContent();
  for (const name of [wrongFile, frameFile]) {
    const original = await fileText(page, name);
    await chooseFile(page, name); await selectOriginalForUnlinked(page);
    await expect(page.locator('.project-note').filter({ hasText: '地图 ID 或坐标框架不匹配' })).toBeVisible();
    await expect(page.getByRole('dialog', { name: '关联原文件并写回', exact: true })).not.toBeVisible();
    await expect(page.getByTestId('local-save-status')).toHaveText('本地文件未关联');
    await expect(page.getByTestId('map-hash')).toHaveText(hash!); expect(await fileText(page, name)).toBe(original);
  }
  expect(await pickerCounts(page)).toEqual({ open: 2, save: 0 });
});

test('SV01 external changes while original-file confirmation is open require the existing conflict flow', async ({ page }) => {
  await start(page, false); await editX(page, 155); await selectOriginalForUnlinked(page);
  const confirm = page.getByRole('dialog', { name: '关联原文件并写回', exact: true });
  await expect(confirm).toBeVisible(); await externalX(page, 120); const external = await fileText(page);
  await confirm.getByRole('button', { name: '确认关联并写回', exact: true }).click();
  const conflict = page.getByRole('dialog', { name: '外部文件内容已变化', exact: true });
  await expect(conflict).toBeVisible(); expect(await fileText(page)).toBe(external);
  await conflict.getByRole('button', { name: '取消', exact: true }).click();
  await page.getByTestId('road-item-rAB').click(); await expect(page.getByTestId('road-length')).toHaveText('155');
  expect(await pickerCounts(page)).toEqual({ open: 1, save: 0 });
});


test('SV01 delayed native binding restore keeps Save disabled until the correct handle is ready', async ({ page }) => {
  await start(page); await editX(page, 110); await saveOriginal(page, 110);
  await page.addInitScript(() => {
    const property = Object.getOwnPropertyDescriptor(IDBTransaction.prototype, 'oncomplete');
    if (!property?.set) throw new Error('Native IDBTransaction oncomplete setter unavailable');
    Object.defineProperty(IDBTransaction.prototype, 'oncomplete', { ...property, set(listener: ((event: Event) => void) | null) {
      const transaction = this as IDBTransaction;
      const delayed = transaction.mode === 'readonly' && transaction.objectStoreNames.contains('localFileBindings');
      property.set!.call(transaction, delayed && listener ? function (event: Event) {
        window.setTimeout(() => listener.call(transaction, event), 1200);
      } : listener);
    } });
  });
  await page.reload();
  await expect(page.getByTestId('local-save-status')).toContainText('正在恢复原文件关联');
  await expect(page.getByRole('button', { name: '保存工程', exact: true })).toBeDisabled();
  await page.keyboard.press('Control+s');
  expect(await pickerCounts(page)).toEqual({ open: 1, save: 0 });
  await saved(page); await expect(page.getByTestId('local-save-status')).toContainText(originalFile);
  expect((await readMap(page)).nodes.nB!.position[0]).toBe(110);
  await editX(page, 115); await saveOriginal(page, 115);
  expect(await pickerCounts(page)).toEqual({ open: 1, save: 0 });
});


test('SV01 saving only committed geometry while attaching preserves unapplied property input', async ({ page }) => {
  await start(page, false); await editX(page, 155);
  const hash = await page.getByTestId('map-hash').textContent();
  await page.getByTestId('node-item-nB').click();
  const input = page.getByLabel('X (m)', { exact: true }); await input.fill('175');
  await page.getByRole('button', { name: '保存工程', exact: true }).click();
  await page.getByRole('dialog', { name: '有未应用输入', exact: true }).getByRole('button', { name: '仅保存已提交地图', exact: true }).click();
  await selectOriginalForUnlinked(page);
  await page.getByRole('dialog', { name: '关联原文件并写回', exact: true }).getByRole('button', { name: '确认关联并写回', exact: true }).click();
  await expect(page.getByTestId('local-save-status')).toContainText('本地文件已确认：' + originalFile);
  expect((await readMap(page)).nodes.nB!.position[0]).toBe(155);
  await expect(page.getByTestId('map-hash')).toHaveText(hash!); await expect(input).toHaveValue('175');
  await expect(page.getByTestId('unapplied-inputs')).toBeVisible();
  expect(await pickerCounts(page)).toEqual({ open: 1, save: 0 });
});


test('SV01 failed browser checkpoint after successful file write cannot bless a stale map on refresh', async ({ page }) => {
  await start(page); const hash = await page.getByTestId('map-hash').textContent();
  await page.evaluate(() => {
    const originalPut = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (value: unknown, key?: IDBValidKey) {
      if (this.name === 'projects') {
        sessionStorage.setItem('sv01-checkpoint-failures', String(Number(sessionStorage.getItem('sv01-checkpoint-failures') ?? '0') + 1));
        throw new DOMException('SV01 synthetic project checkpoint failure', 'QuotaExceededError');
      }
      return key === undefined ? originalPut.call(this, value) : originalPut.call(this, value, key);
    };
  });
  await editX(page, 110);
  await page.getByRole('button', { name: '保存工程', exact: true }).click();
  await expect.poll(async () => (await readMap(page)).nodes.nB!.position[0]).toBe(110);
  await expect(page.locator('.project-note').filter({ hasText: '浏览器' }).filter({ hasText: '基线' })).toBeVisible();
  expect(await page.evaluate(() => Number(sessionStorage.getItem('sv01-checkpoint-failures')))).toBeGreaterThan(0);
  await page.reload(); await saved(page); await expect(page.getByTestId('map-hash')).toHaveText(hash!);
  await page.getByRole('button', { name: '保存工程', exact: true }).click();
  const conflict = page.getByRole('dialog', { name: '外部文件内容已变化', exact: true });
  await expect(conflict).toBeVisible(); expect((await readMap(page)).nodes.nB!.position[0]).toBe(110);
  await conflict.getByRole('button', { name: '取消', exact: true }).click();
  expect(await pickerCounts(page)).toEqual({ open: 1, save: 0 });
});


test('SV01 real frozen Hanwha entrance writes the same temporary source and remains editable after refresh', async ({ page }, info) => {
  test.setTimeout(180000);
  const path = resolve(process.env.UX02_MQ01_ROOT ?? '../../projects/MQ01_Repair_20260913', 'hanwha/map.json');
  let bytes: Buffer; try { bytes = await readFile(path); } catch (cause) { throw new Error('blocked_input: required Hanwha map missing: ' + path, { cause }); }
  const digest = createHash('sha256').update(bytes).digest('hex');
  expect(digest, 'blocked_input: Hanwha frozen source SHA').toBe('026bf0c409b151aa005fe59d50e0aeda294eca83a5fbccf9b5927b9190cb4749');
  const original = JSON.parse(bytes.toString('utf8')) as YardMap;
  await installPickers(page, original); await page.goto('/'); await saved(page);
  await fileAction(page, '导入 JSON'); await saved(page);
  await (await drawingControl(page, '网格吸附')).selectOption('1'); await (await drawingControl(page, '节点吸附')).uncheck();
  await expect(page.getByTestId('local-save-status')).toContainText(originalFile);
  const access = 'AP_HW123', node = 'N_HW_7aa9ceb679';
  async function editEntrance(y: number) {
    await page.getByTestId('object-search').fill(access); await page.getByTestId('accessPoints-item-' + access).click();
    await page.getByRole('button', { name: '定位 ' + access, exact: true }).click();
    await page.getByRole('button', { name: '在画布重新定位', exact: true }).click();
    const point = await expectVisiblePosition(page, [1888, y, 0]); await page.mouse.click(point.x, point.y);
    await page.getByRole('button', { name: '保存工程', exact: true }).click();
    await expect(page.getByTestId('local-save-status')).toContainText('本地文件已确认：' + originalFile); await saved(page);
    const written = await readMap(page);
    expect(written.nodes[node]!.position).toEqual([1888, y, 0]);
    const expected = structuredClone(original); expected.revision = written.revision; expected.sources = written.sources; expected.nodes[node] = written.nodes[node]!;
    expect(written).toEqual(expected);
    for (const [id, source] of Object.entries(original.sources)) expect(written.sources[id]).toEqual(source);
    const expectedNode = structuredClone(original.nodes[node]!); expectedNode.position = [1888, y, 0]; expectedNode.provenance = written.nodes[node]!.provenance;
    expect(written.nodes[node]).toEqual(expectedNode); expect(written.nodes[node]!.provenance.fieldSources?.position).toBeTruthy();
    return written;
  }
  const first = await editEntrance(2175); expect(first.revision).toBe(original.revision + 1);
  await page.screenshot({ path: info.outputPath('hanwha-original-written.png'), fullPage: true });
  const firstHash = await page.getByTestId('map-hash').textContent(); await page.reload(); await saved(page);
  await expect(page.getByTestId('map-hash')).toHaveText(firstHash!); await expect(page.getByTestId('local-save-status')).toContainText(originalFile);
  const second = await editEntrance(2176); expect(second.revision).toBe(first.revision + 1);
  await page.screenshot({ path: info.outputPath('hanwha-refreshed-written-again.png'), fullPage: true });
  expect(second.coordinateFrame).toEqual(original.coordinateFrame); expect(second.resources).toEqual(original.resources);
  expect(await pickerCounts(page)).toEqual({ open: 1, save: 0 });
  expect(createHash('sha256').update(await readFile(path)).digest('hex')).toBe(digest);
  await info.attach('real-source-integrity', { body: JSON.stringify({ path, sha256Before: digest, sha256After: digest, originalRevision: original.revision, firstRevision: first.revision, secondRevision: second.revision }), contentType: 'application/json' });
});


test('SV01 failed binding removal during Schema upgrade preserves both the original frame and file link', async ({ page }) => {
  await start(page); const hash = await page.getByTestId('map-hash').textContent(); const original = await fileText(page);
  await page.evaluate(() => {
    const originalPut = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (value: unknown, key?: IDBValidKey) {
      if (this.name === 'localFileBindings' && value === null) {
        sessionStorage.setItem('sv01-unlink-failed', '1');
        throw new DOMException('SV01 synthetic unlink failure', 'QuotaExceededError');
      }
      return key === undefined ? originalPut.call(this, value) : originalPut.call(this, value, key);
    };
  });
  await page.getByRole('button', { name: '升级到 0.2.0', exact: true }).click();
  const modal = page.getByRole('dialog', { name: '显式升级地图契约', exact: true });
  await modal.getByRole('button', { name: '保留原图并升级', exact: true }).click();
  await expect.poll(() => page.evaluate(() => sessionStorage.getItem('sv01-unlink-failed'))).toBe('1');
  await expect(page.getByTestId('map-hash')).toHaveText(hash!);
  await expect(page.getByTestId('local-save-status')).toContainText(originalFile); expect(await fileText(page)).toBe(original);
  await modal.getByRole('button', { name: '取消', exact: true }).click();
  await page.reload(); await saved(page); await expect(page.getByTestId('map-hash')).toHaveText(hash!);
  await expect(page.getByTestId('local-save-status')).toContainText(originalFile);
  await editX(page, 115); await saveOriginal(page, 115);
  expect((await readMap(page)).schemaVersion).toBe('0.1.0'); expect(await pickerCounts(page)).toEqual({ open: 1, save: 0 });
});


test('SV02 legacy ask browser and file preferences cannot redirect default Save or Ctrl S', async ({ page }, info) => {
  let downloads = 0; page.on('download', () => downloads++);
  await start(page);
  for (const [index, preference] of ['ask', 'browser', 'file'].entries()) {
    await page.evaluate(value => new Promise<void>((resolve, reject) => {
      const open = indexedDB.open('shipyard-map-projects'); open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const db = open.result, tx = db.transaction('editorStates', 'readwrite');
        const store = tx.objectStore('editorStates'), id = sessionStorage.getItem('shipyard.activeProjectId')!;
        const request = store.get(id);
        request.onsuccess = () => { const editor = request.result; editor.workbench.saveTarget = value; store.put(editor, id); };
        tx.oncomplete = () => { db.close(); resolve(); }; tx.onabort = () => { db.close(); reject(tx.error); };
      };
    }), preference);
    await page.reload(); await saved(page);
    expect((await storedWorkspace(page)).editor?.workbench?.saveTarget).toBe(preference);
    await editX(page, 140 + index); await saveOriginal(page, 140 + index);
    await editX(page, 150 + index); await page.keyboard.press('Control+s');
    await expect(page.getByTestId('local-save-status')).toContainText('本地文件已确认：' + originalFile); await saved(page);
    expect((await readMap(page)).nodes.nB!.position[0]).toBe(150 + index);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByRole('dialog', { name: '选择保存目标', exact: true })).toHaveCount(0);
    await expect(page.getByRole('dialog', { name: '保存到哪个文件', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '保存到文件', exact: true, includeHidden: true })).toHaveCount(0);
    expect(await pickerCounts(page)).toEqual({ open: 1, save: 0 });
    expect((await storedWorkspace(page)).editor?.workbench?.saveTarget).toBe(preference);
  }
  expect(downloads).toBe(0);
  await page.screenshot({ path: info.outputPath('default-save-no-target-dialog.png'), fullPage: true });
});

test('SV02 unlinked Save keeps recovery without a picker download or false file-success claim', async ({ page }, info) => {
  let downloads = 0; page.on('download', () => downloads++);
  await start(page, false); const original = await fileText(page);
  await editX(page, 155); const hash = (await page.getByTestId('map-hash').textContent())!;
  for (const shortcut of [false, true]) {
    const before = (await storedWorkspace(page)).record!.storageVersion;
    if (shortcut) await page.keyboard.press('Control+s');
    else await page.getByRole('button', { name: '保存工程', exact: true }).click();
    const record = await checkpoint(page, hash, before);
    expect(JSON.parse(record.checkpoint!.mapJson).nodes.nB.position[0]).toBe(155);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.locator('.project-note').filter({ hasText: '未关联原文件' })).toContainText('未写入本地文件');
    await expect(page.getByTestId('local-save-status')).toHaveText('本地文件未关联');
    expect(await pickerCounts(page)).toEqual({ open: 0, save: 0 });
    expect(await fileText(page)).toBe(original); await expect(page.getByTestId('map-hash')).toHaveText(hash);
  }
  expect(downloads).toBe(0); await expect(page.locator('.canvas-status')).toContainText('1 个撤销事务');
  await page.screenshot({ path: info.outputPath('unlinked-save-explicit-status.png'), fullPage: true });
});

test('SV02 explicit Save As changes the linked target and subsequent default saves do not reopen a picker', async ({ page }, info) => {
  let downloads = 0; page.on('download', () => downloads++);
  await start(page); await editX(page, 110); await saveOriginal(page, 110);
  const original = await fileText(page);
  await editX(page, 120);
  await page.getByLabel('保存选项', { exact: true }).click();
  await page.getByRole('button', { name: '另存为', exact: true }).click();
  await expect(page.getByTestId('local-save-status')).toContainText('本地文件已确认：' + copyFile); await saved(page);
  expect((await readMap(page, copyFile)).nodes.nB!.position[0]).toBe(120);
  await editX(page, 130); await saveOriginal(page, 130, copyFile);
  await page.reload(); await saved(page); await editX(page, 140); await page.keyboard.press('Control+s');
  await expect(page.getByTestId('local-save-status')).toContainText('本地文件已确认：' + copyFile); await saved(page);
  expect((await readMap(page, copyFile)).nodes.nB!.position[0]).toBe(140);
  expect(await fileText(page)).toBe(original); expect(await pickerCounts(page)).toEqual({ open: 1, save: 1 });
  expect(downloads).toBe(0); await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.screenshot({ path: info.outputPath('explicit-save-as-subsequent-save.png'), fullPage: true });
});
