import { readFile } from 'node:fs/promises';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import type { YardMap } from '../../src/domain/model';

// Independent contract values, not imported from the implementation under test.
type Drawing = {
  snapGrid: 0 | 1 | 5 | 10; snapNodes: boolean; facilityKind: string; zoneKind: string;
  facilityMovePolicy: 'boundaryOnly' | 'withAssociatedNodes';
  zoneMovePolicy: 'boundaryOnly' | 'withAssociatedNodes';
  showRoadBands: boolean; showRoadCenterlines: boolean; showOrdinaryNodes: boolean;
};
type Camera = { offsetX: number; offsetY: number; scale: number };
type Editor = { camera: Camera; drawing: Drawing };
type Stored = { draft: { mapJson: string }; checkpoint: { mapJson: string } | null };
const defaults: Drawing = {
  snapGrid: 0, snapNodes: false, facilityKind: 'workshop', zoneKind: 'work',
  facilityMovePolicy: 'boundaryOnly', zoneMovePolicy: 'boundaryOnly',
  showRoadBands: true, showRoadCenterlines: true, showOrdinaryNodes: true,
};
const custom: Drawing = {
  snapGrid: 5, snapNodes: true, facilityKind: 'dock', zoneKind: 'buffer',
  facilityMovePolicy: 'withAssociatedNodes', zoneMovePolicy: 'withAssociatedNodes',
  showRoadBands: true, showRoadCenterlines: true, showOrdinaryNodes: true,
};
const labels = {
  snapGrid: '网格吸附', snapNodes: '节点吸附', facilityKind: '新建设施类型', zoneKind: '新建区域类型',
  facilityMovePolicy: '设施移动策略', zoneMovePolicy: '区域移动策略',
  showRoadBands: '显示道路带', showRoadCenterlines: '显示中心线', showOrdinaryNodes: '显示普通节点',
} as const;

async function ready(page: Page) {
  await page.goto('/');
  await expect(page.getByRole('button', { name: '保存工程', exact: true })).toBeEnabled();
  await expect(page.getByTestId('map-canvas')).toBeVisible();
}
async function saved(page: Page) {
  await expect(page.getByTestId('browser-save-status')).toHaveText('浏览器草稿已保存');
}
async function activeId(page: Page) {
  const id = await page.evaluate(() => sessionStorage.getItem('shipyard.activeProjectId'));
  if (!id) throw new Error('No active browser project ID.');
  return id;
}
async function readStored(page: Page, store: 'projects' | 'editorStates', id: string): Promise<unknown> {
  return page.evaluate(({ store, id }) => new Promise<unknown>((resolve, reject) => {
    const request = indexedDB.open('shipyard-map-projects', 1);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result; const transaction = db.transaction(store, 'readonly');
      const value = transaction.objectStore(store).get(id);
      transaction.oncomplete = () => { db.close(); resolve(value.result); };
      transaction.onabort = () => { db.close(); reject(transaction.error); };
    };
  }), { store, id });
}
async function editor(page: Page, id = '') {
  return await readStored(page, 'editorStates', id || await activeId(page)) as Editor;
}
async function project(page: Page, id = '') {
  return await readStored(page, 'projects', id || await activeId(page)) as Stored;
}
// Only editor-state compatibility/corruption fixtures use direct IDB writes.
// All map creation/editing, navigation and persistence are exercised through real UI.
async function replaceEditorRecord(page: Page, value: unknown) {
  const id = await activeId(page);
  await page.evaluate(({ id, value }) => new Promise<void>((resolve, reject) => {
    const request = indexedDB.open('shipyard-map-projects', 1);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result; const transaction = db.transaction('editorStates', 'readwrite');
      transaction.objectStore('editorStates').put(value, id);
      transaction.oncomplete = () => { db.close(); resolve(); };
      transaction.onabort = () => { db.close(); reject(transaction.error); };
    };
  }), { id, value });
}
async function configure(page: Page, drawing: Drawing) {
  for (const key of ['snapGrid', 'facilityKind', 'zoneKind', 'facilityMovePolicy', 'zoneMovePolicy'] as const) {
    await page.getByLabel(labels[key], { exact: true }).selectOption(String(drawing[key]));
  }
  for (const key of ['snapNodes', 'showRoadBands', 'showRoadCenterlines', 'showOrdinaryNodes'] as const)
    await page.getByLabel(labels[key], { exact: true }).setChecked(drawing[key]);
}
async function expectDrawing(page: Page, drawing: Drawing) {
  for (const key of ['snapGrid', 'facilityKind', 'zoneKind', 'facilityMovePolicy', 'zoneMovePolicy'] as const) {
    await expect(page.getByLabel(labels[key], { exact: true })).toHaveValue(String(drawing[key]));
  }
  for (const key of ['snapNodes', 'showRoadBands', 'showRoadCenterlines', 'showOrdinaryNodes'] as const)
    await expect(page.getByLabel(labels[key], { exact: true })).toBeChecked({ checked: drawing[key] });
}
async function savedDrawing(page: Page, drawing: Drawing) {
  await expect.poll(async () => (await editor(page))?.drawing).toEqual(drawing);
  await saved(page);
}
async function camera(page: Page): Promise<Camera> {
  const output = page.getByTestId('camera-state');
  return {
    offsetX: Number(await output.getAttribute('data-offset-x')),
    offsetY: Number(await output.getAttribute('data-offset-y')),
    scale: Number(await output.getAttribute('data-scale')),
  };
}
async function clickWorld(page: Page, x: number, y: number) {
  const box = await page.getByTestId('map-canvas').locator('canvas').first().boundingBox();
  if (!box) throw new Error('Canvas is not visible.');
  const view = await camera(page);
  await page.mouse.click(box.x + view.offsetX + x * view.scale, box.y + view.offsetY - y * view.scale);
}
async function addNode(page: Page, x = 23, y = 27) {
  await page.getByRole('button', { name: '节点', exact: true }).click();
  await clickWorld(page, x, y);
  return page.getByLabel('稳定 ID', { exact: true }).inputValue();
}
async function download(page: Page, info: TestInfo, filename: string): Promise<YardMap> {
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出 JSON', exact: true }).click();
  const path = info.outputPath(filename); await (await pending).saveAs(path);
  return JSON.parse(await readFile(path, 'utf8')) as YardMap;
}
async function rename(page: Page, name: string) {
  await page.getByLabel('地图名称', { exact: true }).fill(name);
  await page.getByRole('button', { name: '应用地图名称', exact: true }).click();
}
async function create(page: Page, name: string) {
  await page.getByRole('button', { name: '新建地图', exact: true }).click();
  const modal = page.getByRole('dialog', { name: '新建地图', exact: true });
  await modal.getByLabel('新地图名称', { exact: true }).fill(name);
  await modal.getByRole('button', { name: '创建地图', exact: true }).click();
  await expect(page.getByLabel('地图名称', { exact: true })).toHaveValue(name);
  await expect(modal).not.toBeVisible();
}
async function beginOpen(page: Page, id: string) {
  await page.getByRole('button', { name: '最近项目', exact: true }).click();
  await page.getByTestId('project-item-' + id).click();
}
async function open(page: Page, id: string) {
  await beginOpen(page, id);
  await expect(page.getByRole('dialog', { name: '最近项目', exact: true })).not.toBeVisible();
  await expect.poll(() => activeId(page)).toBe(id);
}
async function undoCount(page: Page) {
  const text = await page.locator('.canvas-status').textContent();
  const match = text?.match(/(\d+) 个撤销事务/);
  if (!match) throw new Error('Undo count is unavailable.');
  return Number(match[1]);
}

test('D01 all six drawing choices survive real IDB save and refresh and drive 5m/node snapping', async ({ page }, info) => {
  await ready(page);
  const nodeId = await addNode(page);
  await saved(page);
  await configure(page, custom);
  await savedDrawing(page, custom);
  const hash = await page.getByTestId('map-hash').textContent();
  await page.reload();
  await saved(page);
  await expectDrawing(page, custom);
  await expect(page.getByTestId('map-hash')).toHaveText(hash!);
  await expect(page.getByTestId('node-item-' + nodeId)).toBeVisible();
  await addNode(page, 12, 18);
  await expect(page.getByLabel('X (m)', { exact: true })).toHaveValue('10');
  await expect(page.getByLabel('Y (m)', { exact: true })).toHaveValue('20');
  // A rectangle click near the original off-grid node must use its coordinate, before the 5m grid.
  await page.getByRole('button', { name: '矩形设施', exact: true }).click();
  await clickWorld(page, 24, 28); await clickWorld(page, 70, 60);
  const facilityId = await page.getByLabel('稳定 ID', { exact: true }).inputValue();
  await page.getByRole('button', { name: '矩形区域', exact: true }).click();
  await clickWorld(page, 90, 10); await clickWorld(page, 120, 35);
  const zoneId = await page.getByLabel('稳定 ID', { exact: true }).inputValue();
  const map = await download(page, info, 'drawing-snapping.map.json');
  expect(map.facilities[facilityId]!.kind).toBe('dock');
  expect(map.facilities[facilityId]!.boundary.outer[0]).toEqual([23, 27, 0]);
  expect(map.zones[zoneId]!.kind).toBe('buffer');
  expect(map.nodes[nodeId]!.position).toEqual([23, 27, 0]);
});

test('D02 config-only auto-save leaves map JSON, hash, revision and undo/redo history unchanged', async ({ page }, info) => {
  await ready(page); await addNode(page, 20, 20);
  const secondId = await addNode(page, 40, 40);
  const twoNodes = await download(page, info, 'two-nodes.map.json');
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await saved(page);
  const before = await download(page, info, 'config-before.map.json');
  const hash = await page.getByTestId('map-hash').textContent();
  const history = await undoCount(page);
  const storedBefore = await project(page);
  await expect(page.getByRole('button', { name: '重做', exact: true })).toBeEnabled();
  await configure(page, custom); await savedDrawing(page, custom);
  expect(await project(page)).toEqual(storedBefore);
  expect(await download(page, info, 'config-after.map.json')).toEqual(before);
  await expect(page.getByTestId('map-hash')).toHaveText(hash!);
  expect(await undoCount(page)).toBe(history);
  await expect(page.getByRole('button', { name: '重做', exact: true })).toBeEnabled();
  await page.getByRole('button', { name: '重做', exact: true }).click();
  expect(await download(page, info, 'redo-still-valid.map.json')).toEqual(twoNodes);
  await expect(page.getByTestId('node-item-' + secondId)).toBeVisible();
  await expectDrawing(page, custom);
});

test('D03 camera and drawing writes retain each other and restoring drawing defaults changes no map or camera', async ({ page }, info) => {
  await ready(page); await addNode(page); await configure(page, custom); await savedDrawing(page, custom);
  const before = await download(page, info, 'reset-before.map.json');
  const history = await undoCount(page); const oldCamera = await camera(page);
  const box = await page.getByTestId('map-canvas').locator('canvas').first().boundingBox();
  if (!box) throw new Error('Canvas is not visible.');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, -100);
  await expect.poll(() => camera(page)).not.toEqual(oldCamera);
  const changed: Drawing = { ...custom, snapGrid: 10, zoneKind: 'waiting' };
  await configure(page, changed);
  const movedCamera = await camera(page);
  await expect.poll(() => editor(page)).toEqual({ camera: movedCamera, drawing: changed });
  await saved(page); await page.reload(); await saved(page);
  expect(await camera(page)).toEqual(movedCamera); await expectDrawing(page, changed);
  const recoveredHistory = await undoCount(page);
  await page.getByRole('button', { name: '恢复绘图默认配置', exact: true }).click();
  await expectDrawing(page, defaults); await savedDrawing(page, defaults);
  expect(await camera(page)).toEqual(movedCamera);
  expect(await download(page, info, 'reset-after.map.json')).toEqual(before);
  expect(await undoCount(page)).toBe(recoveredHistory);
  expect(history).toBeGreaterThan(0); // Existing history belonged to the pre-refresh session.
  await page.reload(); await saved(page);
  expect(await camera(page)).toEqual(movedCamera); await expectDrawing(page, defaults);
});

test('D04 rapid A/B navigation isolates drawing snapshots during a simulated native IDB completion delay', async ({ page }) => {
  await ready(page); await addNode(page, 10, 10); await rename(page, 'Drawing 工程A');
  await configure(page, custom); await savedDrawing(page, custom);
  const idA = await activeId(page); const hashA = await page.getByTestId('map-hash').textContent();
  await create(page, 'Drawing 工程B'); await expectDrawing(page, defaults);
  await addNode(page, 50, 50);
  const configB: Drawing = { ...defaults, snapGrid: 1, facilityKind: 'yard', zoneKind: 'drivable' };
  await configure(page, configB); await savedDrawing(page, configB);
  const idB = await activeId(page); const hashB = await page.getByTestId('map-hash').textContent();
  await open(page, idA); await expectDrawing(page, custom);
  // Real IDB commits still occur. Only editorStates.oncomplete receipts are held by this fault.
  await page.evaluate(() => {
    const state = { enabled: true, pending: [] as (() => void)[] };
    Object.assign(window, { drawingReceiptFault: state });
    const complete = Object.getOwnPropertyDescriptor(IDBTransaction.prototype, 'oncomplete')!;
    Object.defineProperty(IDBTransaction.prototype, 'oncomplete', {
      ...complete,
      set(callback: ((event: Event) => void) | null) {
        if (this.mode !== 'readwrite' || !this.objectStoreNames.contains('editorStates') || !callback) {
          complete.set!.call(this, callback); return;
        }
        complete.set!.call(this, (event: Event) => {
          if (state.enabled) state.pending.push(() => callback.call(this, event)); else callback.call(this, event);
        });
      },
    });
  });
  const newerA: Drawing = { ...custom, snapGrid: 10 };
  await configure(page, newerA);
  await expect.poll(() => page.evaluate(() => (window as unknown as { drawingReceiptFault: { pending: unknown[] } }).drawingReceiptFault.pending.length)).toBeGreaterThan(0);
  await expect(page.getByTestId('browser-save-status')).not.toHaveText('浏览器草稿已保存');
  await beginOpen(page, idB);
  for (const label of Object.values(labels)) await expect(page.getByLabel(label, { exact: true })).toBeDisabled();
  await expect(page.getByTestId('map-hash')).toHaveText(hashA!);
  await page.evaluate(() => {
    const state = (window as unknown as { drawingReceiptFault: { enabled: boolean; pending: (() => void)[] } }).drawingReceiptFault;
    state.enabled = false; state.pending.splice(0).forEach(callback => callback());
  });
  await expect.poll(() => activeId(page)).toBe(idB);
  await expect(page.getByRole('dialog', { name: '最近项目', exact: true })).not.toBeVisible();
  await expectDrawing(page, configB); await expect(page.getByTestId('map-hash')).toHaveText(hashB!);
  // Leave before the 600ms debounce: navigation must retain the latest B choices, with B's target ID.
  const newerB: Drawing = { ...configB, snapNodes: true, zoneMovePolicy: 'withAssociatedNodes' };
  await configure(page, newerB); await open(page, idA);
  await expectDrawing(page, newerA); await expect(page.getByTestId('map-hash')).toHaveText(hashA!);
  await open(page, idB); await expectDrawing(page, newerB);
  await open(page, idA); await expectDrawing(page, newerA);
  expect((await editor(page, idA)).drawing).toEqual(newerA);
  expect((await editor(page, idB)).drawing).toEqual(newerB);
  expect(JSON.parse((await project(page, idA)).draft.mapJson).nodes).not.toEqual(JSON.parse((await project(page, idB)).draft.mapJson).nodes);
  await page.reload(); await saved(page); await expectDrawing(page, newerA);
});

test('D05 real legacy camera-only and partial records normalize missing fields while preserving explicit false and zero', async ({ page }, info) => {
  await ready(page); await addNode(page); await saved(page);
  const map = await download(page, info, 'legacy-original.map.json');
  const legacyCamera: Camera = { offsetX: 110, offsetY: 420, scale: 3 };
  const cases = [
    { record: { camera: legacyCamera }, expected: defaults },
    { record: { camera: legacyCamera, drawing: { snapGrid: 0, snapNodes: false, facilityKind: 'quay' } }, expected: { ...defaults, facilityKind: 'quay' } },
    { record: { camera: legacyCamera, drawing: { zoneMovePolicy: 'withAssociatedNodes' } }, expected: { ...defaults, zoneMovePolicy: 'withAssociatedNodes' as const } },
    { record: { camera: legacyCamera, drawing: { showRoadBands: false, showRoadCenterlines: false, showOrdinaryNodes: false } }, expected: { ...defaults, showRoadBands: false, showRoadCenterlines: false, showOrdinaryNodes: false } },
  ];
  for (const [index, fixture] of cases.entries()) {
    await replaceEditorRecord(page, fixture.record);
    await page.reload(); await saved(page);
    await expectDrawing(page, fixture.expected); expect(await camera(page)).toEqual(legacyCamera);
    expect(await download(page, info, 'legacy-' + index + '.map.json')).toEqual(map);
    await expect(page.getByText(/地图已恢复，但视窗或绘图配置未恢复/)).not.toBeVisible();
  }
});

test('D06 invalid values, null and unknown drawing fields warn without losing the valid map', async ({ page }, info) => {
  await ready(page); await addNode(page); await saved(page);
  const before = await download(page, info, 'corruption-before.map.json');
  const hash = await page.getByTestId('map-hash').textContent();
  const view = await camera(page);
  for (const [index, drawing] of [null, { snapGrid: 2 }, { ...custom, futureFlag: true }].entries()) {
    await replaceEditorRecord(page, { camera: view, drawing });
    await page.reload();
    await expect(page.getByRole('button', { name: '保存工程', exact: true })).toBeEnabled();
    await expect(page.getByText(/地图已恢复，但视窗或绘图配置未恢复/)).toBeVisible();
    await expectDrawing(page, defaults);
    await expect(page.getByTestId('map-hash')).toHaveText(hash!);
    await expect(page.getByTestId('node-count')).toHaveText('1');
    expect(await download(page, info, 'corruption-' + index + '.map.json')).toEqual(before);
    expect(JSON.parse((await project(page)).draft.mapJson)).toEqual(before);
  }
});

test('D07 a simulated editorStates quota failure reports unsaved config while preserving the durable map and current editable JSON', async ({ page }, info) => {
  await ready(page); const id = await addNode(page, 20, 30); await saved(page);
  const before = await download(page, info, 'quota-before.map.json');
  const durable = await project(page);
  // Scope the synthetic fault to auxiliary editor state; the real projects store is untouched.
  await page.evaluate(() => {
    const put = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function (...args: Parameters<IDBObjectStore['put']>) {
      if (this.name === 'editorStates') throw new DOMException('D07 simulated drawing quota exhaustion', 'QuotaExceededError');
      return put.apply(this, args);
    };
  });
  await page.getByLabel('网格吸附', { exact: true }).selectOption('5');
  await expect(page.getByTestId('browser-save-status')).toContainText('绘图配置保存失败');
  await expect(page.getByTestId('browser-save-status')).not.toHaveText('浏览器草稿已保存');
  expect(await project(page)).toEqual(durable);
  await page.getByTestId('node-item-' + id).click();
  await page.getByLabel('X (m)', { exact: true }).fill('40');
  await page.getByRole('button', { name: '应用属性', exact: true }).click();
  await page.getByRole('button', { name: '保存工程', exact: true }).click();
  await expect(page.getByTestId('browser-save-status')).toContainText('绘图配置保存失败');
  await expect(page.getByLabel('X (m)', { exact: true })).toHaveValue('40');
  const current = await download(page, info, 'quota-current-ram.map.json');
  expect(current.nodes[id]!.position).toEqual([40, 30, 0]);
  expect(current.revision).toBe(before.revision + 1);
  expect(JSON.parse((await project(page)).draft.mapJson)).toEqual(before);
  expect((await editor(page)).drawing).toEqual(defaults);
  page.on('dialog', dialog => dialog.accept());
  await page.reload(); await saved(page);
  expect(await download(page, info, 'quota-recovered.map.json')).toEqual(before);
  await expectDrawing(page, defaults);
});

test('D08 refresh resets selection/tool/free-polygon mode and discards incomplete drawing without persisting temporary state', async ({ page }, info) => {
  await ready(page); await configure(page, custom);
  await page.getByRole('button', { name: '矩形设施', exact: true }).click();
  await clickWorld(page, 0, 0); await clickWorld(page, 60, 30);
  const id = await page.getByLabel('稳定 ID', { exact: true }).inputValue();
  await savedDrawing(page, custom);
  const before = await download(page, info, 'temporary-before.map.json');
  await page.getByLabel('边界编辑模式', { exact: true }).selectOption('polygon');
  await page.getByRole('button', { name: '多边形区域', exact: true }).click();
  await clickWorld(page, 90, 10);
  await expect(page.getByTestId('unapplied-inputs')).toBeVisible();
  await page.waitForTimeout(750); // Cross the real debounce; incomplete geometry must not be a durable map edit.
  expect(Object.keys(await editor(page)).sort()).toEqual(['camera', 'drawing']);
  expect((await editor(page)).drawing).toEqual(custom);
  expect(JSON.parse((await project(page)).draft.mapJson)).toEqual(before);
  page.on('dialog', dialog => dialog.accept());
  await page.reload(); await saved(page);
  await expect(page.getByRole('button', { name: '选择', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.getByTestId('unapplied-inputs')).not.toBeVisible();
  await expect(page.locator('.canvas-status')).toContainText('0 个选中');
  await expectDrawing(page, custom);
  await page.getByTestId('facilities-item-' + id).click();
  await expect(page.getByLabel('边界编辑模式', { exact: true })).toHaveValue('auto');
  await expect(page.getByTestId('boundary-handles')).toHaveAttribute('data-mode', 'rectangle');
  expect(await download(page, info, 'temporary-recovered.map.json')).toEqual(before);
});


test('D09 Save and Ctrl+S persist the current six choices with automatic debounce deliberately paused', async ({ page }, info) => {
  await ready(page); await addNode(page); await savedDrawing(page, defaults);
  const before = await download(page, info, 'manual-before.map.json');
  const hash = await page.getByTestId('map-hash').textContent(); const history = await undoCount(page);
  // Synthetic timing fault: only the app's 600ms auto-save timers are replaced by inert timers.
  // UI, native keyboard handling and actual IndexedDB transactions remain live.
  await page.evaluate(() => {
    const original = window.setTimeout;
    const state = { pausedTimers: 0 };
    Object.assign(window, { drawingAutoSavePause: state });
    Object.defineProperty(window, 'setTimeout', {
      configurable: true, writable: true,
      value: (handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
        if (timeout === 600) { state.pausedTimers++; return Reflect.apply(original, window, [() => {}, 3_600_000]); }
        return Reflect.apply(original, window, [handler, timeout, ...args]);
      },
    });
  });
  await configure(page, custom);
  await expect.poll(() => page.evaluate(() => (window as unknown as { drawingAutoSavePause: { pausedTimers: number } }).drawingAutoSavePause.pausedTimers)).toBeGreaterThan(0);
  await page.waitForTimeout(750); // Prove the automatic path is paused, rather than racing its normal deadline.
  expect((await editor(page)).drawing).toEqual(defaults);
  await expect(page.getByTestId('browser-save-status')).toContainText('绘图配置未保存');
  await page.getByRole('button', { name: '保存工程', exact: true }).click();
  await savedDrawing(page, custom);
  const next: Drawing = { ...defaults, snapGrid: 10, facilityKind: 'assembly', zoneKind: 'waiting', zoneMovePolicy: 'withAssociatedNodes' };
  await configure(page, next); await page.waitForTimeout(750);
  expect((await editor(page)).drawing).toEqual(custom);
  await page.getByLabel('网格吸附', { exact: true }).focus();
  await page.keyboard.press('Control+s'); await savedDrawing(page, next);
  await expect(page.getByTestId('map-hash')).toHaveText(hash!);
  expect(await download(page, info, 'manual-after.map.json')).toEqual(before);
  expect(await undoCount(page)).toBe(history);
  await page.reload(); await saved(page); await expectDrawing(page, next);
});

test('D10 a simulated editor-state read delay keeps defaults from overwriting the saved drawing configuration', async ({ page }) => {
  await ready(page); await addNode(page); await configure(page, custom); await savedDrawing(page, custom);
  const hash = await page.getByTestId('map-hash').textContent();
  const durable = await editor(page);
  await page.addInitScript(() => {
    const state = { enabled: true, writes: 0, pending: [] as (() => void)[] };
    Object.assign(window, { drawingRestoreFault: state });
    const transaction = IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction = function (...args: Parameters<IDBDatabase['transaction']>) {
      if (args[1] === 'readwrite') state.writes++;
      return transaction.apply(this, args);
    };
    const complete = Object.getOwnPropertyDescriptor(IDBTransaction.prototype, 'oncomplete')!;
    Object.defineProperty(IDBTransaction.prototype, 'oncomplete', {
      ...complete,
      set(callback: ((event: Event) => void) | null) {
        if (this.mode !== 'readonly' || !this.objectStoreNames.contains('editorStates') || !callback) {
          complete.set!.call(this, callback); return;
        }
        complete.set!.call(this, (event: Event) => {
          if (state.enabled) state.pending.push(() => callback.call(this, event)); else callback.call(this, event);
        });
      },
    });
  });
  await page.reload();
  await expect.poll(() => page.evaluate(() => (window as unknown as { drawingRestoreFault: { pending: unknown[] } }).drawingRestoreFault.pending.length)).toBeGreaterThan(0);
  await expect(page.getByRole('button', { name: '保存工程', exact: true })).toBeDisabled();
  for (const label of Object.values(labels)) await expect(page.getByLabel(label, { exact: true })).toBeDisabled();
  await page.keyboard.press('Control+s');
  await page.waitForTimeout(750);
  expect(await page.evaluate(() => (window as unknown as { drawingRestoreFault: { writes: number } }).drawingRestoreFault.writes)).toBe(0);
  await page.evaluate(() => {
    const state = (window as unknown as { drawingRestoreFault: { enabled: boolean; pending: (() => void)[] } }).drawingRestoreFault;
    state.enabled = false; state.pending.splice(0).forEach(callback => callback());
  });
  await saved(page); await expectDrawing(page, custom);
  await expect(page.getByTestId('map-hash')).toHaveText(hash!);
  await expect(page.getByTestId('node-count')).toHaveText('1');
  expect(await editor(page)).toEqual(durable);
});
