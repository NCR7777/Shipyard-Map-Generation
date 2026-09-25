import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { backgroundMap, quadrantPng } from '../helpers/P1B_backgroundMap';
/** The map name in the top bar (a dialog's header is a banner too, so the role alone is ambiguous while one is open). */
const docTitle = (page: Page) => page.locator('header.topbar .doc-title');

const example = fileURLToPath(new URL('../../examples/M2A1_synthetic_service_targets.map.json', import.meta.url));
/** The synthetic example plus a free building at 20–50 × 60–80 m that moves without dependencies. */
type MapJson = { mapId: string; metadata: { name: string }; facilities: Record<string, unknown> };
function mapJson(change: (map: MapJson) => void = () => {}): string {
  const map = JSON.parse(readFileSync(example, 'utf8')) as MapJson;
  map.facilities.fFree = {
    name: '空置厂房', kind: 'workshop', boundary: { outer: [[20, 60, 0], [50, 60, 0], [50, 80, 0], [20, 80, 0], [20, 60, 0]], holes: [] },
    accessPointIds: [], servicePointIds: [], heightM: { state: 'unknown' }, provenance: { category: 'synthetic' },
  };
  change(map);
  return JSON.stringify(map);
}
const canvas = (page: Page) => page.getByTestId('map-canvas');
async function ready(page: Page) { await expect(canvas(page)).toHaveAttribute('data-scale', /\d/); }
async function open(page: Page, errors: string[], text = mapJson(), name = 'projects.map.json') {
  page.on('pageerror', error => errors.push(error.message));
  if (page.url() === 'about:blank') await page.goto('/');
  await page.getByTestId('open-file-input').setInputFiles({ name, mimeType: 'application/json', buffer: Buffer.from(text) });
  await ready(page);
}
async function at(page: Page, x: number, y: number) {
  const box = (await canvas(page).boundingBox())!;
  const [s, ox, oy] = await Promise.all(['data-scale', 'data-offset-x', 'data-offset-y'].map(async name => Number(await canvas(page).getAttribute(name))));
  return { x: box.x + ox! + x * s!, y: box.y + oy! - y * s! };
}
async function click(page: Page, x: number, y: number) { const p = await at(page, x, y); await page.mouse.click(p.x, p.y); }
async function drag(page: Page, from: [number, number], to: [number, number]) {
  const a = await at(page, ...from), b = await at(page, ...to);
  await page.mouse.move(a.x, a.y); await page.mouse.down(); await page.mouse.move(b.x, b.y, { steps: 10 }); await page.mouse.up();
}
const status = (page: Page) => page.getByTestId('save-status');
const heading = (page: Page) => page.getByRole('region', { name: '属性' }).locator('.entity-heading');
const overview = (page: Page) => page.getByRole('region', { name: '属性' }).getByRole('heading', { name: '地图概览' });
const undoButton = (page: Page) => page.getByRole('toolbar', { name: '工具' }).getByRole('button', { name: '撤销' });
/** Records every IndexedDB write of the page (`store:op`) and fails puts to a store on demand (`__fail[store] = 'QuotaExceededError'`). */
type Probe = { __writes: string[]; __fail: Record<string, string>; __hold: boolean };
async function instrument(page: Page) {
  await page.addInitScript(() => {
    const probe = window as unknown as Probe; probe.__writes = []; probe.__fail = {};
    for (const name of ['put', 'add', 'delete', 'clear'] as const) {
      const original = IDBObjectStore.prototype[name] as (...args: unknown[]) => IDBRequest;
      (IDBObjectStore.prototype as unknown as Record<string, unknown>)[name] = function (this: IDBObjectStore, ...args: unknown[]) {
        probe.__writes.push(this.name + ':' + name);
        const failure = probe.__fail[this.name]; if (failure && name === 'put') throw new DOMException('simulated ' + failure, failure);
        return original.apply(this, args);
      };
    }
  });
}
const writes = (page: Page) => page.evaluate(() => (window as unknown as Probe).__writes.splice(0));
const failPuts = (page: Page, store: string, failure: string | null) => page.evaluate(([name, error]) => {
  const probe = window as unknown as Probe; if (error) probe.__fail[name] = error; else delete probe.__fail[name];
}, [store, failure] as const);
/** Keeps a read-write transaction on the projects store open (by always asking it something), so saves queue behind it. */
const holdProjects = (page: Page) => page.evaluate(() => new Promise<void>((resolve, reject) => {
  const probe = window as unknown as Probe; probe.__hold = true;
  const request = indexedDB.open('shipyard-map-studio'); request.onerror = () => reject(request.error);
  request.onsuccess = () => {
    const db = request.result, transaction = db.transaction('projects', 'readwrite'), store = transaction.objectStore('projects');
    const spin = () => { if (probe.__hold) store.count().onsuccess = spin; };
    spin(); transaction.oncomplete = () => db.close(); resolve();
  };
}));
const releaseProjects = (page: Page) => page.evaluate(() => { (window as unknown as Probe).__hold = false; });
const projectRows = (page: Page) => page.getByRole('dialog', { name: '浏览器工程' }).getByRole('list', { name: '浏览器工程列表' }).getByRole('button');
/** Makes stored drafts fail their hash check (all projects, or the one with this name). */
async function damage(page: Page, name?: string) {
  await page.evaluate(target => new Promise<void>((resolve, reject) => {
    const request = indexedDB.open('shipyard-map-studio');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result, store = db.transaction('projects', 'readwrite').objectStore('projects'), all = store.getAll();
      all.onsuccess = () => {
        for (const record of all.result as { name: string; draft: { contentHash: string } }[]) if (!target || record.name === target) { record.draft.contentHash = '0'.repeat(64); store.put(record); }
        store.transaction.oncomplete = () => { db.close(); resolve(); };
      };
    };
  }), name);
}

/** The building is at 20–50 m; after a 20 m move to the right it is at 40–70 m. */
async function movedRight(page: Page) {
  await click(page, 25, 70); await expect(overview(page)).toBeVisible();
  await click(page, 65, 70); await expect(heading(page)).toContainText('空置厂房');
}

test('edits are saved automatically and come back after a reload, with the camera and display settings', async ({ page }) => {
  const errors: string[] = []; await open(page, errors);
  await drag(page, [35, 70], [55, 70]);
  await expect(status(page)).toHaveText('已自动保存（草稿）');
  await page.getByRole('button', { name: '放大（=）' }).click();
  await page.getByRole('tab', { name: '图层' }).click();
  await page.getByLabel('显示普通节点').check();
  const scale = await canvas(page).getAttribute('data-scale');
  // The view is saved 600 ms after it settles, without a status of its own.
  await page.waitForTimeout(1500);
  await page.reload(); await ready(page);
  await expect(status(page)).toHaveText('已自动保存（草稿）');
  await expect(canvas(page)).toHaveAttribute('data-scale', scale!);
  // The panel tab is not part of the project; the setting is.
  await page.getByRole('tab', { name: '图层' }).click();
  await expect(page.getByLabel('显示普通节点')).toBeChecked();
  // Undo history is not stored.
  await expect(undoButton(page)).toHaveAttribute('aria-disabled', 'true');
  await page.getByRole('tab', { name: '对象' }).click();
  await movedRight(page);
  expect(errors).toEqual([]);
});

test('Ctrl+S keeps a checkpoint, also from inside a field', async ({ page }) => {
  const errors: string[] = []; await open(page, errors);
  await click(page, 35, 70);
  const name = page.getByRole('region', { name: '属性' }).getByLabel('名称', { exact: true });
  await name.fill('已改名厂房');
  await page.keyboard.press('Control+s');
  await expect(heading(page)).toContainText('已改名厂房');
  await expect(status(page)).toHaveText('已保存');
  await expect(page.getByRole('status')).toContainText('已保存到浏览器工程');
  await canvas(page).focus(); await page.keyboard.press('ArrowUp');
  await expect(status(page)).toHaveText('已自动保存（草稿）');
  expect(errors).toEqual([]);
});

test('each opened map is its own project; switching writes the current one first and keeps both', async ({ page }) => {
  const errors: string[] = []; await open(page, errors);
  await drag(page, [35, 70], [55, 70]);
  // Switch at once, before the automatic save: the edit must still be stored.
  await open(page, errors, mapJson(map => { map.mapId = 'map_second'; map.metadata.name = '第二张图'; }), 'second.map.json');
  await expect(docTitle(page)).toContainText('第二张图');
  await page.keyboard.press('Control+Shift+O');
  const dialog = page.getByRole('dialog', { name: '浏览器工程' }), rows = dialog.getByRole('list', { name: '浏览器工程列表' }).getByRole('button');
  await expect(rows).toHaveCount(2);
  await expect(rows.first()).toContainText('第二张图');
  await expect(rows.first()).toContainText('当前');
  await rows.nth(1).click();
  await expect(dialog).toHaveCount(0);
  await expect(docTitle(page)).not.toContainText('第二张图');
  await ready(page);
  await movedRight(page);
  expect(errors).toEqual([]);
});

test('a new map is an empty 0.3.0 project that survives a reload', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await page.getByRole('button', { name: '新建地图…' }).click();
  const dialog = page.getByRole('dialog', { name: '新建地图' });
  await dialog.getByLabel('地图名称').fill('测试布局');
  await dialog.getByRole('button', { name: '创建地图' }).click();
  await expect(docTitle(page)).toContainText('测试布局');
  await expect(page.getByRole('contentinfo')).toContainText('0.3.0');
  await ready(page);
  await page.keyboard.press('n');
  await click(page, 0, 0); await click(page, 20, 0);
  await expect(status(page)).toHaveText('已自动保存（草稿）');
  await page.reload();
  await expect(docTitle(page)).toContainText('测试布局');
  await expect(page.getByRole('list', { name: '对象目录' }).locator('.object-group').filter({ hasText: /^节点/ })).toContainText('2');
  expect(errors).toEqual([]);
});

test('two tabs: after the other tab saves, this one stops saving, can keep a copy or load the stored version, and asks before leaving', async ({ page }) => {
  const errors: string[] = []; await open(page, errors);
  await expect(status(page)).toHaveText('已自动保存（草稿）');
  const other = await page.context().newPage(); other.on('pageerror', error => errors.push(error.message));
  await other.goto('/'); await ready(other);
  // The other tab moves the building and saves.
  await drag(other, [35, 70], [55, 70]);
  await expect(status(other)).toHaveText('已自动保存（草稿）');
  // Back in the first tab: the check on focus finds the newer version.
  await page.bringToFront(); await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.getByRole('alert').filter({ hasText: '另一个标签页或窗口已保存此工程' })).toBeVisible();
  await expect(status(page)).toHaveText('冲突：另一标签页已保存此工程');
  // Edits here are kept in the page but no longer saved.
  await canvas(page).focus(); await click(page, 35, 70); await page.keyboard.press('Shift+ArrowUp');
  await page.waitForTimeout(1000);
  await expect(status(page)).toHaveText('冲突：另一标签页已保存此工程');
  await page.getByRole('button', { name: '另存为恢复副本' }).click();
  await expect(page.getByRole('status')).toContainText('（恢复副本）');
  await page.getByRole('button', { name: '载入浏览器中的版本…' }).click();
  await page.getByRole('dialog', { name: '载入浏览器中的版本' }).getByRole('button', { name: '放弃本页修改并载入' }).click();
  await expect(status(page)).toHaveText('已自动保存（草稿）');
  await ready(page); await movedRight(page);
  await page.keyboard.press('Control+Shift+O');
  await expect(page.getByRole('dialog', { name: '浏览器工程' }).getByRole('list', { name: '浏览器工程列表' })).toContainText('（恢复副本）');
  await page.keyboard.press('Escape');
  // Now this tab saves again; the other tab's next save is refused (compare-and-set), without any focus check.
  await canvas(page).focus(); await click(page, 65, 70); await page.keyboard.press('Shift+ArrowDown');
  await expect(status(page)).toHaveText('已自动保存（草稿）');
  await other.bringToFront(); await canvas(other).focus(); await click(other, 65, 70); await other.keyboard.press('Shift+ArrowUp');
  await expect(status(other)).toHaveText('冲突：另一标签页已保存此工程');
  // Leaving asks only while edits are not stored: here, the conflict stopped saving.
  const asked = other.waitForEvent('dialog');
  await other.close({ runBeforeUnload: true });
  expect((await asked).type()).toBe('beforeunload');
  expect(errors).toEqual([]);
});

test('leaving after the edits are stored does not ask', async ({ page }) => {
  const errors: string[] = []; await open(page, errors);
  await drag(page, [35, 70], [55, 70]);
  await expect(status(page)).toHaveText('已自动保存（草稿）');
  // close() does not wait for the page to go: wait for it, accepting any prompt so the page does close.
  let asked = false; page.on('dialog', dialog => { asked = true; void dialog.accept(); });
  const closed = page.waitForEvent('close');
  await page.close({ runBeforeUnload: true });
  await closed;
  expect(asked).toBe(false);
  expect(errors).toEqual([]);
});

test('a project that cannot be recovered is left untouched; the page offers retry or memory only', async ({ page }) => {
  const errors: string[] = []; await open(page, errors);
  await expect(status(page)).toHaveText('已自动保存（草稿）');
  // Damage the stored snapshot: its hash no longer matches its map.
  await page.evaluate(() => new Promise<void>((resolve, reject) => {
    const request = indexedDB.open('shipyard-map-studio');
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result, store = db.transaction('projects', 'readwrite').objectStore('projects'), all = store.getAll();
      all.onsuccess = () => {
        for (const record of all.result as { draft: { contentHash: string } }[]) { record.draft.contentHash = '0'.repeat(64); store.put(record); }
        store.transaction.oncomplete = () => { db.close(); resolve(); };
      };
    };
  }));
  await page.reload();
  const dialog = page.getByRole('dialog', { name: '恢复浏览器工程' });
  await expect(dialog).toContainText('没有可用地图快照');
  await dialog.getByRole('button', { name: '重试恢复' }).click();
  await expect(page.getByRole('dialog', { name: '恢复浏览器工程' })).toBeVisible();
  await page.getByRole('dialog', { name: '恢复浏览器工程' }).getByRole('button', { name: '仅在本页继续' }).click();
  await expect(page.getByRole('heading', { name: '打开一张船厂地图' })).toBeVisible();
  // A map opened now lives in this page only; saving says so.
  await open(page, errors);
  await expect(status(page)).toHaveText('只在本页内存中（未存入浏览器）');
  await page.keyboard.press('Control+s');
  await expect(page.getByRole('alert')).toContainText('只在本页内存中');
  expect(errors).toEqual([]);
});

test('background images are stored with the project and come back after a reload', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await page.getByTestId('open-file-input').setInputFiles([
    { name: 'bg.map.json', mimeType: 'application/json', buffer: Buffer.from(backgroundMap()) },
    { name: 'any-name.png', mimeType: 'image/png', buffer: quadrantPng() },
  ]);
  await page.getByRole('tab', { name: '图层' }).click();
  const layer = page.getByRole('group', { name: '底图 四色测试底图' });
  await expect(layer.locator('.badge')).toHaveText('就绪');
  await expect(status(page)).toHaveText('已自动保存（草稿）');
  await page.reload();
  await page.getByRole('tab', { name: '图层' }).click();
  await expect(page.getByRole('group', { name: '底图 四色测试底图' }).locator('.badge')).toHaveText('就绪');
  expect(errors).toEqual([]);
});

// Review of P4a: an edit made while the current map is written, before another map replaces it, used to be lost silently.
// Now edits are refused from the start of the switch (with a notice), and everything made before it is stored.
test('while another map is opening, edits are refused and everything made before is stored', async ({ page }) => {
  const errors: string[] = []; await open(page, errors);
  await expect(status(page)).toHaveText('已自动保存（草稿）');
  await click(page, 35, 70); await page.keyboard.press('Shift+ArrowUp');
  // The write of that edit waits behind a held transaction; meanwhile the second map is opened and one more edit made.
  await holdProjects(page);
  await page.getByTestId('open-file-input').setInputFiles({ name: 'second.map.json', mimeType: 'application/json', buffer: Buffer.from(mapJson(map => { map.mapId = 'map_second'; map.metadata.name = '第二张图'; })) });
  await expect(status(page)).toHaveText('保存中…');
  await page.keyboard.press('Shift+ArrowUp');
  await expect(page.getByRole('alert')).toContainText('正在打开另一张地图');
  await page.getByRole('toolbar', { name: '工具' }).getByRole('button', { name: '撤销' }).click();
  await expect(page.getByRole('alert')).toContainText('稍候再撤销');
  await releaseProjects(page);
  await expect(docTitle(page)).toContainText('第二张图');
  await page.keyboard.press('Control+Shift+O');
  await projectRows(page).nth(1).click();
  await expect(docTitle(page)).not.toContainText('第二张图');
  await ready(page);
  // Exactly the move made before the switch: the outline spans 61–81 m (the refused one would give 62–82 m).
  await click(page, 35, 70); await expect(heading(page)).toContainText('空置厂房');
  const raw = page.getByRole('region', { name: '属性' }).locator('.raw-json pre');
  await expect(raw).toContainText(/\b81\b/);
  await expect(raw).not.toContainText(/\b82\b/);
  expect(errors).toEqual([]);
});

test('after a reload nothing is written until something changes', async ({ page }) => {
  await instrument(page);
  const errors: string[] = []; await open(page, errors);
  await drag(page, [35, 70], [55, 70]);
  await expect(status(page)).toHaveText('已自动保存（草稿）');
  await page.waitForTimeout(1500);
  await page.reload(); await ready(page);
  await expect(status(page)).toHaveText('已自动保存（草稿）');
  await page.waitForTimeout(2000);
  expect(await writes(page)).toEqual([]);
  expect(errors).toEqual([]);
});

test('a storage failure stops automatic saving and refuses to open another map; Ctrl+S resumes once storage works', async ({ page }) => {
  await instrument(page);
  const errors: string[] = []; await open(page, errors);
  await expect(status(page)).toHaveText('已自动保存（草稿）');
  await failPuts(page, 'projects', 'QuotaExceededError');
  await click(page, 35, 70); await page.keyboard.press('Shift+ArrowUp');
  await expect(status(page)).toContainText('保存失败：浏览器存储空间不足');
  await writes(page);
  for (let i = 0; i < 3; i++) await page.keyboard.press('Shift+ArrowUp');
  await page.waitForTimeout(1500);
  expect((await writes(page)).filter(write => write.startsWith('projects:'))).toEqual([]);
  await page.getByTestId('open-file-input').setInputFiles({ name: 'second.map.json', mimeType: 'application/json', buffer: Buffer.from(mapJson(map => { map.mapId = 'map_second'; map.metadata.name = '第二张图'; })) });
  await expect(page.getByRole('alert')).toContainText('没有打开新地图');
  await expect(docTitle(page)).not.toContainText('第二张图');
  await failPuts(page, 'projects', null);
  await canvas(page).focus(); await page.keyboard.press('Control+s');
  await expect(status(page)).toHaveText('已保存');
  await page.keyboard.press('Shift+ArrowDown');
  await expect(status(page)).toHaveText('已自动保存（草稿）');
  expect(errors).toEqual([]);
});

test('choosing the current project in the list keeps its undo history', async ({ page }) => {
  const errors: string[] = []; await open(page, errors);
  await click(page, 35, 70); await page.keyboard.press('Shift+ArrowUp');
  await expect(status(page)).toHaveText('已自动保存（草稿）');
  await page.keyboard.press('Control+Shift+O');
  await projectRows(page).first().click();
  await expect(page.getByRole('dialog', { name: '浏览器工程' })).toHaveCount(0);
  await expect(undoButton(page)).toHaveAttribute('aria-disabled', 'false');
  expect(errors).toEqual([]);
});

test('one damaged project does not lock the others out', async ({ page }) => {
  const errors: string[] = []; await open(page, errors, mapJson(map => { map.metadata.name = '第一张图'; }), 'first.map.json');
  await expect(status(page)).toHaveText('已自动保存（草稿）');
  await open(page, errors, mapJson(map => { map.mapId = 'map_second'; map.metadata.name = '第二张图'; }), 'second.map.json');
  await expect(status(page)).toHaveText('已自动保存（草稿）');
  await damage(page, '第二张图');
  await page.reload();
  const dialog = page.getByRole('dialog', { name: '恢复浏览器工程' });
  await expect(dialog).toContainText('没有可用地图快照');
  await dialog.getByRole('list', { name: '浏览器工程列表' }).getByRole('button', { name: /第一张图/ }).click();
  await expect(docTitle(page)).toContainText('第一张图');
  await expect(status(page)).toHaveText('已自动保存（草稿）');
  // A new tab opens the chosen project too, not the damaged one.
  const other = await page.context().newPage(); other.on('pageerror', error => errors.push(error.message));
  await other.goto('/');
  await expect(docTitle(other)).toContainText('第一张图');
  expect(errors).toEqual([]);
});

test('in memory only, opening another map asks before dropping edits that were not exported', async ({ page }) => {
  const errors: string[] = []; await open(page, errors);
  await expect(status(page)).toHaveText('已自动保存（草稿）');
  await damage(page);
  await page.reload();
  await page.getByRole('dialog', { name: '恢复浏览器工程' }).getByRole('button', { name: '仅在本页继续' }).click();
  await open(page, errors, mapJson(map => { map.metadata.name = '内存图 A'; }), 'a.map.json');
  await click(page, 35, 70); await page.keyboard.press('Shift+ArrowUp');
  // A display setting of this map must not carry over to the next one.
  await page.getByRole('tab', { name: '图层' }).click();
  await page.getByRole('button', { name: '锁定道路' }).click();
  const second = { name: 'b.map.json', mimeType: 'application/json', buffer: Buffer.from(mapJson(map => { map.mapId = 'map_b'; map.metadata.name = '内存图 B'; })) };
  await page.getByTestId('open-file-input').setInputFiles(second);
  await page.getByRole('dialog', { name: '未导出的修改' }).getByRole('button', { name: '取消' }).click();
  await expect(docTitle(page)).toContainText('内存图 A');
  await page.getByTestId('open-file-input').setInputFiles(second);
  const download = page.waitForEvent('download');
  await page.getByRole('dialog', { name: '未导出的修改' }).getByRole('button', { name: '先导出副本再打开' }).click();
  expect((await download).suggestedFilename()).toMatch(/\.map\.json$/);
  await expect(docTitle(page)).toContainText('内存图 B');
  await expect(page.getByRole('button', { name: '锁定道路' })).toBeVisible();
  expect(errors).toEqual([]);
});

test('upgrading a map keeps its original as a recovery copy first', async ({ page }) => {
  const errors: string[] = []; await open(page, errors);
  await page.keyboard.press('r');
  await page.getByRole('dialog', { name: '升级地图格式' }).getByRole('button', { name: '升级并继续' }).click();
  await expect(page.getByRole('status')).toContainText('升级前的原图已另存为');
  await expect(undoButton(page)).toHaveAttribute('title', /撤销：升级到格式 0\.3\.0/);
  await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
  await page.keyboard.press('Control+Shift+O');
  await expect(page.getByRole('dialog', { name: '浏览器工程' }).getByRole('list', { name: '浏览器工程列表' })).toContainText('（恢复副本）');
  expect(errors).toEqual([]);
});

// Re-review of P4a: opening a damaged project from the list recorded its failure on the open project and stopped its saving.
test('a damaged project that fails to open does not stop saving the open one', async ({ page }) => {
  const errors: string[] = []; await open(page, errors, mapJson(map => { map.metadata.name = '坏工程'; }), 'bad.map.json');
  await expect(status(page)).toHaveText('已自动保存（草稿）');
  await open(page, errors, mapJson(map => { map.mapId = 'map_good'; map.metadata.name = '好工程'; }), 'good.map.json');
  await expect(status(page)).toHaveText('已自动保存（草稿）');
  await damage(page, '坏工程');
  await page.keyboard.press('Control+Shift+O');
  await projectRows(page).filter({ hasText: '坏工程' }).click();
  await expect(page.getByRole('alert')).toContainText('无法打开浏览器工程');
  // The status is right at once, with the list still open.
  await expect(status(page)).toHaveText('已自动保存（草稿）');
  await page.keyboard.press('Escape');
  await expect(docTitle(page)).toContainText('好工程');
  await expect(status(page)).toHaveText('已自动保存（草稿）');
  await click(page, 35, 70); await page.keyboard.press('Shift+ArrowUp');
  await expect(status(page)).toHaveText('已自动保存（草稿）');
  expect(errors).toEqual([]);
});
