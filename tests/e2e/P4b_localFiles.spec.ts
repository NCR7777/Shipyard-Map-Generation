import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
/** The map name in the top bar (a dialog's header is a banner too, so the role alone is ambiguous while one is open). */
const docTitle = (page: Page) => page.locator('header.topbar .doc-title');

const example = fileURLToPath(new URL('../../examples/M2A1_synthetic_service_targets.map.json', import.meta.url));
type MapJson = { mapId: string; schemaVersion: string; metadata: { name: string }; facilities: Record<string, { boundary: { outer: number[][] } } & Record<string, unknown>> };
const originalName = (JSON.parse(readFileSync(example, 'utf8')) as MapJson).metadata.name;
function mapJson(change: (map: MapJson) => void = () => {}): string {
  const map = JSON.parse(readFileSync(example, 'utf8')) as MapJson;
  map.facilities.fFree = {
    name: '空置厂房', kind: 'workshop', boundary: { outer: [[20, 60, 0], [50, 60, 0], [50, 80, 0], [20, 80, 0], [20, 60, 0]], holes: [] },
    accessPointIds: [], servicePointIds: [], heightM: { state: 'unknown' }, provenance: { category: 'synthetic' },
  } as never;
  change(map);
  return JSON.stringify(map, null, 2);
}
type Probe = { __pick?: string; __saveAs?: string; __writes: string[]; __fail: Record<string, string>;
  __deny?: boolean; __permissionDelay?: number; __permissionRequests: number; __granted: string[] };
/**
 * The native pickers cannot be driven headless: these return files of the origin's private file system, wrapped to follow
 * the rules of picked files — opening grants reading only; the first write asks for write access (which may wait or be
 * denied); a file chosen in the save picker may be written. Every IndexedDB write is recorded (store:op), and puts to a
 * store fail on demand.
 */
async function setup(page: Page, errors: string[]) {
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    const probe = window as unknown as Probe & Record<string, unknown>;
    probe.__writes = []; probe.__fail = {}; probe.__permissionRequests = 0; probe.__granted = [];
    const wrap = (handle: FileSystemFileHandle) => ({
      name: handle.name, kind: 'file', inner: handle,
      getFile: () => handle.getFile(), createWritable: () => handle.createWritable(),
      isSameEntry: (other: { inner?: FileSystemFileHandle }) => handle.isSameEntry(other.inner ?? (other as unknown as FileSystemFileHandle)),
      queryPermission: async ({ mode }: { mode: string }) => mode === 'read' || probe.__granted.includes(handle.name) ? 'granted' : 'prompt',
      requestPermission: async ({ mode }: { mode: string }) => {
        if (mode === 'read' || probe.__granted.includes(handle.name)) return 'granted';
        probe.__permissionRequests++;
        if (probe.__permissionDelay) await new Promise(resolve => setTimeout(resolve, probe.__permissionDelay));
        if (probe.__deny) return 'denied';
        probe.__granted.push(handle.name); return 'granted';
      },
    });
    const file = async (name: string) => (await navigator.storage.getDirectory()).getFileHandle(name, { create: true });
    probe.showOpenFilePicker = async () => { if (!probe.__pick) throw new DOMException('cancelled', 'AbortError'); return [wrap(await file(probe.__pick))]; };
    probe.showSaveFilePicker = async (options: { suggestedName: string }) => {
      const name = probe.__saveAs ?? options.suggestedName; probe.__granted.push(name); return wrap(await file(name));
    };
    for (const name of ['put', 'add'] as const) {
      const original = IDBObjectStore.prototype[name] as (...args: unknown[]) => IDBRequest;
      (IDBObjectStore.prototype as unknown as Record<string, unknown>)[name] = function (this: IDBObjectStore, ...args: unknown[]) {
        probe.__writes.push(this.name + ':' + name);
        const failure = probe.__fail[this.name]; if (failure && name === 'put') throw new DOMException('simulated ' + failure, failure);
        return original.apply(this, args);
      };
    }
  });
  await page.goto('/');
}
const putFile = (page: Page, name: string, text: string) => page.evaluate(async ([file, content]) => {
  const handle = await (await navigator.storage.getDirectory()).getFileHandle(file!, { create: true });
  const writable = await handle.createWritable(); await writable.write(content!); await writable.close();
}, [name, text]);
const readFile = (page: Page, name: string) => page.evaluate(async file => (await (await (await navigator.storage.getDirectory()).getFileHandle(file)).getFile()).text(), name);
const probe = (page: Page, patch: Partial<Probe>) => page.evaluate(values => { Object.assign(window as unknown as Probe, values); }, patch);
const failPuts = (page: Page, store: string, failure: string | null) => page.evaluate(([name, error]) => {
  const fail = (window as unknown as Probe).__fail; if (error) fail[name] = error; else delete fail[name];
}, [store, failure] as const);
async function command(page: Page, label: string) {
  await page.keyboard.press('Control+k');
  await page.getByLabel('搜索命令或对象').fill(label);
  await page.keyboard.press('Enter');
}
const canvas = (page: Page) => page.getByTestId('map-canvas');
async function ready(page: Page) { await expect(canvas(page)).toHaveAttribute('data-scale', /\d/); }
async function at(page: Page, x: number, y: number) {
  const box = (await canvas(page).boundingBox())!;
  const [s, ox, oy] = await Promise.all(['data-scale', 'data-offset-x', 'data-offset-y'].map(async name => Number(await canvas(page).getAttribute(name))));
  return { x: box.x + ox! + x * s!, y: box.y + oy! - y * s! };
}
async function nudgeBuilding(page: Page, key = 'Shift+ArrowUp') { const p = await at(page, 35, 70); await page.mouse.click(p.x, p.y); await page.keyboard.press(key); }
const fileStatus = (page: Page) => page.getByTestId('file-status');
const saveStatus = (page: Page) => page.getByTestId('save-status');
const topOf = (text: string) => (JSON.parse(text) as MapJson).facilities.fFree!.boundary.outer[2]![1];
const projectList = (page: Page) => page.getByRole('dialog', { name: '浏览器工程' }).getByRole('list', { name: '浏览器工程列表' });
async function openLinked(page: Page, name = 'yard.map.json', text = mapJson()) {
  await putFile(page, name, text); await probe(page, { __pick: name });
  await command(page, '打开并关联本地 JSON');
  await ready(page);
  await expect(fileStatus(page)).toHaveText(`已写回 ${name}`);
}
async function openPlain(page: Page, text: string, name: string) {
  await page.getByTestId('open-file-input').setInputFiles({ name, mimeType: 'application/json', buffer: Buffer.from(text) });
  await ready(page); await expect(saveStatus(page)).toHaveText('已自动保存（草稿）');
}

test('a linked file: the first Save asks for write access and writes it back; handles are never stored in IndexedDB', async ({ page }) => {
  const errors: string[] = []; await setup(page, errors);
  await openLinked(page);
  await nudgeBuilding(page);
  await expect(fileStatus(page)).toHaveText('有修改未写回 yard.map.json');
  await page.keyboard.press('Control+s');
  await expect(page.getByRole('status')).toContainText('已保存并写回 yard.map.json');
  await expect(fileStatus(page)).toHaveText('已写回 yard.map.json');
  expect(topOf(await readFile(page, 'yard.map.json'))).toBe(81);
  await nudgeBuilding(page); await page.keyboard.press('Control+s');
  await expect(fileStatus(page)).toHaveText('已写回 yard.map.json');
  expect(await page.evaluate(() => (window as unknown as Probe).__permissionRequests)).toBe(1);
  // In an off-the-record context (this one), Chrome crashes reading a stored file handle back: none is ever stored.
  const writes = await page.evaluate(() => (window as unknown as Probe).__writes);
  expect(writes.filter(write => write.startsWith('localFileBindings'))).toEqual([]);
  expect(writes.some(write => write.startsWith('projects'))).toBe(true);
  expect(errors).toEqual([]);
});

test('write access refused: the file is not written and says so', async ({ page }) => {
  const errors: string[] = []; await setup(page, errors);
  await openLinked(page);
  await probe(page, { __deny: true });
  await nudgeBuilding(page); await page.keyboard.press('Control+s');
  await expect(page.getByRole('alert')).toContainText('没有写回原文件');
  await expect(fileStatus(page)).toHaveText('有修改未写回 yard.map.json');
  expect(topOf(await readFile(page, 'yard.map.json'))).toBe(80);
  expect(errors).toEqual([]);
});

test('no file is written when the browser checkpoint fails', async ({ page }) => {
  const errors: string[] = []; await setup(page, errors);
  await openLinked(page);
  await failPuts(page, 'projects', 'QuotaExceededError');
  await nudgeBuilding(page); await page.keyboard.press('Control+s');
  await expect(page.getByRole('alert')).toContainText('保存失败');
  expect(topOf(await readFile(page, 'yard.map.json'))).toBe(80);
  expect(errors).toEqual([]);
});

// Review of P4b: a write waiting for permission, then a switch to another project, let that project's Save write this file.
test('while a file write waits, switching projects is refused; another project never writes this file', async ({ page }) => {
  const errors: string[] = []; await setup(page, errors);
  await openPlain(page, mapJson(map => { map.mapId = 'map_b'; map.metadata.name = 'B 图'; }), 'b.map.json');
  await openLinked(page, 'a.map.json', mapJson(map => { map.metadata.name = 'A 图'; }));
  await probe(page, { __permissionDelay: 6000 });
  await nudgeBuilding(page); await page.keyboard.press('Control+s');
  await expect(fileStatus(page)).toHaveText('正在读写 a.map.json…');
  await page.keyboard.press('Control+Shift+O');
  await projectList(page).getByRole('button', { name: /B 图/ }).click();
  await expect(page.getByRole('alert')).toContainText('正在读写本地文件');
  await page.keyboard.press('Escape');
  // Opening another map is refused as well, and so is an upgrade (the late write would record the dropped link).
  await page.getByTestId('open-file-input').setInputFiles({ name: 'c.map.json', mimeType: 'application/json', buffer: Buffer.from(mapJson(map => { map.mapId = 'map_c'; map.metadata.name = 'C 图'; })) });
  await expect(page.getByRole('alert')).toContainText('正在读写本地文件');
  await canvas(page).focus(); await page.keyboard.press('r');
  await page.getByRole('dialog', { name: '升级地图格式' }).getByRole('button', { name: '升级并继续' }).click();
  await expect(page.getByRole('alert')).toContainText('稍候再升级');
  await page.keyboard.press('Escape');
  await expect(fileStatus(page)).toHaveText('已写回 a.map.json');
  expect(topOf(await readFile(page, 'a.map.json'))).toBe(81);
  await expect(docTitle(page)).toContainText('A 图');
  // One prompt: the write waits for the answer given at the key press instead of asking again.
  expect(await page.evaluate(() => (window as unknown as Probe).__permissionRequests)).toBe(1);
  // Now B: no link, and its Save leaves A's file alone.
  await page.keyboard.press('Control+Shift+O');
  await projectList(page).getByRole('button', { name: /B 图/ }).click();
  await expect(docTitle(page)).toContainText('B 图');
  await expect(fileStatus(page)).toHaveCount(0);
  await ready(page); await nudgeBuilding(page); await nudgeBuilding(page); await page.keyboard.press('Control+s');
  await expect(saveStatus(page)).toHaveText('已保存');
  const a = JSON.parse(await readFile(page, 'a.map.json')) as MapJson;
  expect([a.metadata.name, topOf(JSON.stringify(a))]).toEqual(['A 图', 81]);
  expect(errors).toEqual([]);
});

test('a file changed elsewhere is not overwritten: keep both versions first; a newer change needs keeping again', async ({ page }) => {
  const errors: string[] = []; await setup(page, errors);
  await openLinked(page);
  await putFile(page, 'yard.map.json', mapJson(map => { map.metadata.name = '别处改过'; }));
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  const dialog = page.getByRole('dialog', { name: '外部文件已变化' });
  await expect(dialog).toContainText('yard.map.json');
  await expect(fileStatus(page)).toHaveText('外部文件已变化：yard.map.json');
  await dialog.getByRole('button', { name: '先保存双方恢复副本' }).click();
  await expect(dialog.getByRole('button', { name: '用当前地图覆盖外部文件' })).toBeVisible();
  // Changed once more meanwhile: that version was not kept, so overwriting is refused and keeping is asked for again.
  await putFile(page, 'yard.map.json', mapJson(map => { map.metadata.name = '又改过'; }));
  await dialog.getByRole('button', { name: '用当前地图覆盖外部文件' }).click();
  await expect(dialog.getByRole('button', { name: '先保存双方恢复副本' })).toBeVisible();
  expect((JSON.parse(await readFile(page, 'yard.map.json')) as MapJson).metadata.name).toBe('又改过');
  await dialog.getByRole('button', { name: '先保存双方恢复副本' }).click();
  await dialog.getByRole('button', { name: '用当前地图覆盖外部文件' }).click();
  await expect(dialog).toHaveCount(0);
  expect((JSON.parse(await readFile(page, 'yard.map.json')) as MapJson).metadata.name).toBe(originalName);
  await page.keyboard.press('Control+Shift+O');
  await expect(projectList(page)).toContainText('别处改过（恢复副本）');
  await expect(projectList(page)).toContainText('又改过（恢复副本）');
  await expect(projectList(page)).toContainText(`${originalName}（恢复副本）`);
  expect(errors).toEqual([]);
});

test('Save finds the change too; the file version can be loaded instead (this map kept as a copy first)', async ({ page }) => {
  const errors: string[] = []; await setup(page, errors);
  await openLinked(page);
  await nudgeBuilding(page);
  await putFile(page, 'yard.map.json', mapJson(map => { map.metadata.name = '文件版本'; map.facilities.fFree!.boundary.outer = [[20, 60, 0], [50, 60, 0], [50, 90, 0], [20, 90, 0], [20, 60, 0]]; }));
  await page.keyboard.press('Control+s');
  const dialog = page.getByRole('dialog', { name: '外部文件已变化' });
  await dialog.getByRole('button', { name: '载入文件中的版本' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('status')).toContainText('已载入 yard.map.json 中的版本');
  await expect(fileStatus(page)).toHaveText('已写回 yard.map.json');
  await expect(saveStatus(page)).toHaveText('已自动保存（草稿）');
  await expect(docTitle(page)).toContainText('文件版本');
  const p = await at(page, 35, 88); await page.mouse.click(p.x, p.y);
  await expect(page.getByRole('region', { name: '属性' }).locator('.entity-heading')).toContainText('空置厂房');
  await page.keyboard.press('Control+Shift+O');
  await expect(projectList(page)).toContainText(`${originalName}（恢复副本）`);
  expect(errors).toEqual([]);
});

test('after a reload the file is picked once more; the same file links again, another map is refused', async ({ page }) => {
  const errors: string[] = []; await setup(page, errors);
  await openLinked(page);
  await nudgeBuilding(page); await page.keyboard.press('Control+s');
  await expect(fileStatus(page)).toHaveText('已写回 yard.map.json');
  await page.reload(); await ready(page);
  await expect(fileStatus(page)).toHaveText('原文件 yard.map.json：重新选择后才能写回');
  await nudgeBuilding(page);
  await page.keyboard.press('Control+s');
  await expect(page.getByRole('status')).toContainText('需要重新选择一次才能写回');
  expect(topOf(await readFile(page, 'yard.map.json'))).toBe(81);
  await putFile(page, 'other.map.json', mapJson(map => { map.mapId = 'map_other'; }));
  await probe(page, { __pick: 'other.map.json' }); await command(page, '关联原文件');
  await expect(page.getByRole('alert')).toContainText('不是这张地图');
  await probe(page, { __pick: 'yard.map.json' }); await command(page, '关联原文件');
  await expect(page.getByRole('status')).toContainText('已关联 yard.map.json。');
  await expect(fileStatus(page)).toHaveText('有修改未写回 yard.map.json');
  expect(topOf(await readFile(page, 'yard.map.json'))).toBe(81);
  await page.keyboard.press('Control+s');
  await expect(fileStatus(page)).toHaveText('已写回 yard.map.json');
  expect(topOf(await readFile(page, 'yard.map.json'))).toBe(82);
  expect(errors).toEqual([]);
});

test('linking a file with another version of the map asks first and keeps the file version', async ({ page }) => {
  const errors: string[] = []; await setup(page, errors);
  await openPlain(page, mapJson(), 'plain.map.json');
  await putFile(page, 'older.map.json', mapJson(map => { map.metadata.name = '旧版本'; }));
  await probe(page, { __pick: 'older.map.json' });
  await command(page, '关联原文件');
  const dialog = page.getByRole('dialog', { name: '关联内容不同的文件' });
  await dialog.getByRole('button', { name: '取消' }).click();
  await expect(fileStatus(page)).toHaveCount(0);
  await command(page, '关联原文件');
  await page.getByRole('dialog', { name: '关联内容不同的文件' }).getByRole('button', { name: '另存文件版本并关联' }).click();
  await expect(fileStatus(page)).toHaveText('有修改未写回 older.map.json');
  await page.keyboard.press('Control+Shift+O');
  await expect(projectList(page)).toContainText('旧版本（恢复副本）');
  expect(errors).toEqual([]);
});

test('opening a linked file when the current project cannot be written leaves both links as they were', async ({ page }) => {
  const errors: string[] = []; await setup(page, errors);
  await openLinked(page, 'a.map.json');
  await failPuts(page, 'projects', 'QuotaExceededError');
  await nudgeBuilding(page);
  await expect(saveStatus(page)).toContainText('保存失败');
  await putFile(page, 'b.map.json', mapJson(map => { map.mapId = 'map_b'; }));
  await probe(page, { __pick: 'b.map.json' }); await command(page, '打开并关联本地 JSON');
  await expect(page.getByRole('alert')).toContainText('没有打开新地图');
  await failPuts(page, 'projects', null);
  await canvas(page).focus(); await page.keyboard.press('Control+s');
  await expect(fileStatus(page)).toHaveText('已写回 a.map.json');
  expect(topOf(await readFile(page, 'a.map.json'))).toBe(81);
  expect((JSON.parse(await readFile(page, 'b.map.json')) as MapJson).mapId).toBe('map_b');
  expect(errors).toEqual([]);
});

test('save as writes a new file and moves the link there', async ({ page }) => {
  const errors: string[] = []; await setup(page, errors);
  await openPlain(page, mapJson(), 'plain.map.json');
  await expect(fileStatus(page)).toHaveCount(0);
  await nudgeBuilding(page);
  await probe(page, { __saveAs: 'copy.map.json' });
  await page.keyboard.press('Control+Shift+S');
  await expect(page.getByRole('status')).toContainText('已另存为 copy.map.json');
  await expect(fileStatus(page)).toHaveText('已写回 copy.map.json');
  expect(topOf(await readFile(page, 'copy.map.json'))).toBe(81);
  await nudgeBuilding(page); await page.keyboard.press('Control+s');
  await expect(fileStatus(page)).toHaveText('已写回 copy.map.json');
  expect(topOf(await readFile(page, 'copy.map.json'))).toBe(82);
  expect(errors).toEqual([]);
});

test('upgrading the map stops writing to its file, which keeps its format, also after a reload', async ({ page }) => {
  const errors: string[] = []; await setup(page, errors);
  await openLinked(page);
  await page.keyboard.press('r');
  await page.getByRole('dialog', { name: '升级地图格式' }).getByRole('button', { name: '升级并继续' }).click();
  await expect(page.getByRole('status')).toContainText('已解除与原文件 yard.map.json 的关联');
  await expect(fileStatus(page)).toHaveCount(0);
  await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
  await canvas(page).focus(); await page.keyboard.press('Control+s');
  await expect(saveStatus(page)).toHaveText('已保存');
  await page.reload(); await ready(page);
  await expect(fileStatus(page)).toHaveCount(0);
  expect((JSON.parse(await readFile(page, 'yard.map.json')) as MapJson).schemaVersion).toBe('0.2.0');
  expect(errors).toEqual([]);
});
