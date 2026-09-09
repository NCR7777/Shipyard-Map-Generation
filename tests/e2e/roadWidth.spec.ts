import { readFile } from 'node:fs/promises';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import type { PhysicalValue, YardMap } from '../../src/domain/model';
import { editorFixture, testNode } from '../helpers/M1_fixtures';
import { associatedFixture } from '../helpers/M2A_fixtures';

const labels = { bands: '显示道路带', centers: '显示中心线', nodes: '显示普通节点' } as const;
function roadFixture(width: PhysicalValue = { state: 'known', value: 12, sourceRef: 'srcWidth' }): YardMap {
  const map = editorFixture();
  map.metadata.name = 'synthetic metric road-width acceptance';
  map.nodes.nA!.position = [0, 30, 0]; map.nodes.nB!.position = [100, 30, 0];
  map.nodes.nB!.kind = 'junction';
  map.roads.rAB!.widthM = width;
  map.sources.srcWidth = { name: 'synthetic width fixture', category: 'synthetic', description: 'Test geometry, not field measurement.' };
  return map;
}
async function ready(page: Page) {
  await page.goto('/');
  await expect(page.getByRole('button', { name: '保存工程', exact: true })).toBeEnabled();
}
async function saved(page: Page) { await expect(page.getByTestId('browser-save-status')).toHaveText('浏览器草稿已保存'); }
async function importMap(page: Page, map: YardMap) {
  await saved(page);
  await page.getByTestId('json-file-input').setInputFiles({ name: 'synthetic-road-width.map.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(map)) });
  await expect(page.getByLabel('地图名称', { exact: true })).toHaveValue(map.metadata.name);
  await expect(page.getByTestId('node-count')).toHaveText(String(Object.keys(map.nodes).length));
  await expect(page.getByTestId('readonly-notice')).not.toBeVisible();
  await saved(page);
}
async function download(page: Page, info: TestInfo, filename: string): Promise<YardMap> {
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出 JSON', exact: true }).click();
  const path = info.outputPath(filename); await (await pending).saveAs(path);
  return JSON.parse(await readFile(path, 'utf8')) as YardMap;
}
async function camera(page: Page) {
  const el = page.getByTestId('camera-state');
  return { offsetX: Number(await el.getAttribute('data-offset-x')), offsetY: Number(await el.getAttribute('data-offset-y')), scale: Number(await el.getAttribute('data-scale')) };
}
async function screen(page: Page, x: number, y: number) {
  const box = await page.getByTestId('map-canvas').locator('canvas').first().boundingBox();
  if (!box) throw new Error('Canvas unavailable.');
  const view = await camera(page);
  return { x: box.x + view.offsetX + x * view.scale, y: box.y + view.offsetY - y * view.scale };
}
async function clickWorld(page: Page, x: number, y: number) {
  const p = await screen(page, x, y); await page.mouse.click(p.x, p.y);
}
async function display(page: Page, values: { bands?: boolean; centers?: boolean; nodes?: boolean }) {
  for (const key of Object.keys(values) as (keyof typeof labels)[]) await page.getByLabel(labels[key], { exact: true }).setChecked(values[key]!);
}
async function activeId(page: Page) {
  const id = await page.evaluate(() => sessionStorage.getItem('shipyard.activeProjectId'));
  if (!id) throw new Error('No active project.');
  return id;
}
async function record(page: Page, store: 'projects' | 'editorStates', id = '') {
  return page.evaluate(({ store, id }) => new Promise<unknown>((resolve, reject) => {
    const opened = indexedDB.open('shipyard-map-projects', 1);
    opened.onerror = () => reject(opened.error);
    opened.onsuccess = () => {
      const db = opened.result; const tx = db.transaction(store, 'readonly'); const request = tx.objectStore(store).get(id);
      tx.oncomplete = () => { db.close(); resolve(request.result); };
      tx.onabort = () => { db.close(); reject(tx.error); };
    };
  }), { store, id: id || await activeId(page) });
}
async function presetScale(page: Page, scale: number) {
  await saved(page);
  // Valid persisted-camera fixture, through the real IDB store. No application method or render metadata injection.
  await page.evaluate(({ id, scale }) => new Promise<void>((resolve, reject) => {
    const opened = indexedDB.open('shipyard-map-projects', 1);
    opened.onerror = () => reject(opened.error);
    opened.onsuccess = () => {
      const db = opened.result; const tx = db.transaction('editorStates', 'readwrite'); const store = tx.objectStore('editorStates');
      const request = store.get(id);
      request.onsuccess = () => store.put({ ...request.result, camera: { offsetX: 80, offsetY: 460, scale } }, id);
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onabort = () => { db.close(); reject(tx.error); };
    };
  }), { id: await activeId(page), scale });
  await page.reload(); await saved(page);
  await expect(page.getByTestId('camera-state')).toHaveAttribute('data-scale', String(scale));
}
async function pixels(page: Page, point: readonly number[], halfWidth = 1, halfHeight = 160) {
  const view = await camera(page);
  return page.getByTestId('map-canvas').evaluate((element, args) => {
    const canvases = [...element.querySelectorAll('canvas')];
    const box = canvases[0]!.getBoundingClientRect();
    const scratch = document.createElement('canvas');
    scratch.width = Math.floor(box.width); scratch.height = Math.floor(box.height);
    const context = scratch.getContext('2d')!;
    context.fillStyle = '#ffffff'; context.fillRect(0, 0, scratch.width, scratch.height);
    // Composite actual rendered canvas pixels, without looking at Konva nodes or self-reported stroke sizes.
    for (const canvas of canvases) context.drawImage(canvas, 0, 0, scratch.width, scratch.height);
    const cx = Math.floor(args.view.offsetX + args.point[0]! * args.view.scale);
    const cy = Math.floor(args.view.offsetY - args.point[1]! * args.view.scale);
    const left = Math.max(0, cx - args.halfWidth); const top = Math.max(0, cy - args.halfHeight);
    const width = Math.min(scratch.width - left, args.halfWidth * 2 + 1);
    const height = Math.min(scratch.height - top, args.halfHeight * 2 + 1);
    if (width <= 0 || height <= 0) throw new Error('Pixel sampling point is outside the canvas.');
    const data = context.getImageData(left, top, width, height).data;
    let band = 0; let first = height; let last = -1; let orange = 0; let nodeInk = 0; let centerInk = 0;
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i]!; const g = data[i + 1]!; const b = data[i + 2]!;
      if ((r === 183 && g === 208 && b === 219) || (r === 239 && g === 187 && b === 130)) {
        band++; const row = Math.floor(i / 4 / width); first = Math.min(first, row); last = Math.max(last, row);
      }
      if (r > g + 20 && g > b + 20 && r > 100) orange++;
      if ((r === 33 && g === 107 && b === 136) || (r === 154 && g === 76 && b === 13)) nodeInk++;
      if ((r === 33 && g === 107 && b === 136) || (r === 173 && g === 95 && b === 23)) centerInk++;
    }
    return { band, span: last < 0 ? 0 : last - first + 1, top: last < 0 ? null : top + first, bottom: last < 0 ? null : top + last, orange, nodeInk, centerInk, canvasHeight: scratch.height };
  }, { view, point: [...point], halfWidth, halfHeight });
}
async function openRecent(page: Page, id: string) {
  await page.getByRole('button', { name: '最近项目', exact: true }).click();
  await page.getByTestId('project-item-' + id).click();
  await expect(page.getByRole('dialog', { name: '最近项目', exact: true })).not.toBeVisible();
  await expect.poll(() => activeId(page)).toBe(id); await saved(page);
}

test('W01 actual canvas cross-sections measure 12m as 48px and 96px; selection never changes band width', async ({ page }, info) => {
  await ready(page); const map = roadFixture(); await importMap(page, map);
  await display(page, { centers: false, nodes: false }); await saved(page);
  await expect(page.getByTestId('camera-state')).toHaveAttribute('data-scale', '4');
  await expect.poll(async () => (await pixels(page, [37, 30])).span).toBe(48);
  const normal4 = await pixels(page, [37, 30]);
  await clickWorld(page, 37, 35.5);
  await expect(page.getByLabel('稳定 ID', { exact: true })).toHaveValue('rAB');
  await expect.poll(async () => (await pixels(page, [37, 30])).span).toBe(48);
  const selected4 = await pixels(page, [37, 30]);
  await page.screenshot({ path: info.outputPath('road-width-4px-per-m.png') });
  await presetScale(page, 8);
  await expect.poll(async () => (await pixels(page, [37, 30])).span).toBe(96);
  const normal8 = await pixels(page, [37, 30]);
  await clickWorld(page, 37, 35.5);
  await expect(page.getByLabel('稳定 ID', { exact: true })).toHaveValue('rAB');
  await expect.poll(async () => (await pixels(page, [37, 30])).span).toBe(96);
  const selected8 = await pixels(page, [37, 30]);
  await page.screenshot({ path: info.outputPath('road-width-8px-per-m.png') });
  await info.attach('actual-pixel-cross-sections.json', { body: JSON.stringify({ normal4, selected4, normal8, selected8 }, null, 2), contentType: 'application/json' });
  expect(await download(page, info, 'metric-unchanged.map.json')).toEqual(map);
});

test('W02 narrow roads retain a minimum hit area and wide edges are selectable without taking over nodes or associated points', async ({ page }, info) => {
  await ready(page); await importMap(page, roadFixture({ state: 'known', value: 1, sourceRef: 'srcWidth' }));
  await clickWorld(page, 40, 31.25); // Five screen pixels from a 4px-wide band's centre.
  await expect(page.getByLabel('稳定 ID', { exact: true })).toHaveValue('rAB');
  const map = associatedFixture();
  map.roads.rAB!.widthM = { state: 'known', value: 30, sourceRef: 'srcWidth' };
  map.sources.srcWidth = { name: 'synthetic priority width', category: 'synthetic', description: 'Independent interaction fixture, not field measurement.' };
  map.nodes.nO = testNode('ordinary point over road', 50, 0);
  await importMap(page, map);
  await clickWorld(page, 80, 14);
  await expect(page.getByLabel('稳定 ID', { exact: true })).toHaveValue('rAB');
  await clickWorld(page, 50, 0);
  await expect(page.getByLabel('稳定 ID', { exact: true })).toHaveValue('nO');
  await clickWorld(page, 0, 0);
  await expect(page.getByLabel('稳定 ID', { exact: true })).toHaveValue('aA');
  await clickWorld(page, 15, 10);
  await expect(page.getByLabel('稳定 ID', { exact: true })).toHaveValue('sA');
  expect(await download(page, info, 'priority-no-topology-change.map.json')).toEqual(map);
});

test('W03 width editing records a design source, undoes atomically and reimports an external width change with stable IDs', async ({ page }, info) => {
  await ready(page); const original = roadFixture({ state: 'unknown' }); await importMap(page, original);
  await page.getByTestId('road-item-rAB').click();
  await expect(page.getByLabel('道路宽度 (m) 状态', { exact: true })).toBeVisible();
  await page.getByLabel('道路宽度 (m) 状态', { exact: true }).selectOption('known');
  await page.getByLabel('道路宽度 (m) 数值', { exact: true }).fill('12');
  await page.getByRole('button', { name: '应用属性', exact: true }).click();
  const edited = await download(page, info, 'width-12.map.json');
  const width = edited.roads.rAB!.widthM;
  expect(width.state).toBe('known'); if (width.state !== 'known') throw new Error('Width was not committed.');
  expect(width.value).toBe(12); expect(width.sourceRef).toBeDefined();
  expect(edited.sources[width.sourceRef!]!.category).toBe('design_assumption');
  expect(edited.roads.rAB!.provenance.fieldSources?.widthM).toBe(width.sourceRef);
  await expect.poll(async () => (await pixels(page, [37, 30])).span).toBe(48);
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  expect(await download(page, info, 'width-undone.map.json')).toEqual(original);
  await page.getByRole('button', { name: '重做', exact: true }).click();
  expect(await download(page, info, 'width-redone.map.json')).toEqual(edited);
  await saved(page); await page.reload(); await saved(page);
  const oldHash = await page.getByTestId('map-hash').textContent();
  const external = structuredClone(edited);
  external.roads.rAB!.widthM = { ...width, value: 20 };
  await importMap(page, external);
  await expect(page.getByTestId('map-hash')).not.toHaveText(oldHash!);
  await expect.poll(async () => (await pixels(page, [37, 30])).span).toBe(80);
  expect(external.revision).toBe(edited.revision);
  expect(await download(page, info, 'external-20-roundtrip.map.json')).toEqual(external);
  expect(external.nodes).toEqual(edited.nodes);
  expect(external.roads.rAB!.fromNodeId).toBe(edited.roads.rAB!.fromNodeId);
  expect(external.roads.rAB!.toNodeId).toBe(edited.roads.rAB!.toNodeId);
});

test('W04 display choices persist per project without map/revision/hash/history changes; hiding ordinary nodes keeps junctions and explicit editing available', async ({ page }, info) => {
  await ready(page); const map = roadFixture(); await importMap(page, map);
  const idA = await activeId(page); const hash = await page.getByTestId('map-hash').textContent();
  const history = await page.locator('.canvas-status').textContent(); const stored = await record(page, 'projects');
  await display(page, { centers: false });
  await expect.poll(async () => (await pixels(page, [0, 30], 9, 9)).nodeInk).toBeGreaterThan(0);
  await display(page, { nodes: false });
  await expect.poll(async () => (await pixels(page, [0, 30], 9, 9)).nodeInk).toBe(0);
  await expect.poll(async () => (await pixels(page, [100, 30], 9, 9)).nodeInk).toBeGreaterThan(0);
  await page.getByTestId('node-item-nA').click();
  await expect.poll(async () => (await pixels(page, [0, 30], 9, 9)).nodeInk).toBeGreaterThan(0);
  await page.getByTestId('road-item-rAB').click(); await display(page, { bands: false });
  await expect.poll(async () => (await pixels(page, [37, 30], 5, 45)).band).toBe(0);
  await expect.poll(async () => (await pixels(page, [37, 30], 5, 45)).centerInk).toBe(0);
  await saved(page);
  expect(await record(page, 'projects')).toEqual(stored);
  await expect(page.getByTestId('map-hash')).toHaveText(hash!);
  expect((await page.locator('.canvas-status').textContent())?.match(/\d+ 个撤销事务/)?.[0]).toBe(history?.match(/\d+ 个撤销事务/)?.[0]);
  expect(await download(page, info, 'display-only.map.json')).toEqual(map);
  await page.reload(); await saved(page);
  for (const label of Object.values(labels)) await expect(page.getByLabel(label, { exact: true })).not.toBeChecked();
  await page.getByRole('button', { name: '新建地图', exact: true }).click();
  const modal = page.getByRole('dialog', { name: '新建地图', exact: true });
  await modal.getByLabel('新地图名称', { exact: true }).fill('W04 display project B');
  await modal.getByRole('button', { name: '创建地图', exact: true }).click(); await saved(page);
  const idB = await activeId(page);
  for (const label of Object.values(labels)) await expect(page.getByLabel(label, { exact: true })).toBeChecked();
  await display(page, { centers: false }); await saved(page);
  await openRecent(page, idA);
  for (const label of Object.values(labels)) await expect(page.getByLabel(label, { exact: true })).not.toBeChecked();
  await expect(page.getByTestId('map-hash')).toHaveText(hash!);
  await openRecent(page, idB);
  await expect(page.getByLabel(labels.bands, { exact: true })).toBeChecked();
  await expect(page.getByLabel(labels.centers, { exact: true })).not.toBeChecked();
  await expect(page.getByLabel(labels.nodes, { exact: true })).toBeChecked();
});

test('W05 unknown, unrestricted and not_applicable widths use auxiliary lines without invented physical bands', async ({ page }, info) => {
  await ready(page);
  const map = roadFixture({ state: 'unknown' }); map.nodes = {}; map.roads = {};
  for (const [index, state] of (['unknown', 'unrestricted', 'not_applicable'] as const).entries()) {
    const y = 20 + index * 30; const template = roadFixture({ state }).roads.rAB!;
    map.nodes['a' + index] = testNode('start ' + state, 0, y);
    map.nodes['b' + index] = testNode('end ' + state, 100, y);
    map.roads['r' + index] = { ...template, name: state, fromNodeId: 'a' + index, toNodeId: 'b' + index };
  }
  await importMap(page, map); await display(page, { centers: false, nodes: false });
  for (let i = 0; i < 3; i++) {
    await expect.poll(async () => (await pixels(page, [50, 20 + i * 30], 70, 7)).band).toBe(0);
    await expect.poll(async () => (await pixels(page, [50, 20 + i * 30], 70, 7)).orange).toBeGreaterThan(0);
  }
  await display(page, { bands: false });
  for (let i = 0; i < 3; i++) await expect.poll(async () => (await pixels(page, [50, 20 + i * 30], 70, 7)).orange).toBe(0);
  expect(await download(page, info, 'unknown-states-retained.map.json')).toEqual(map);
});

test('W06 crossing wide bands never create shared nodes, turning movements or implicit connectivity', async ({ page }, info) => {
  await ready(page); const map = roadFixture({ state: 'known', value: 20, sourceRef: 'srcWidth' });
  map.nodes.nC = testNode('C', 50, 0); map.nodes.nD = testNode('D', 50, 80);
  map.roads.rCD = { ...map.roads.rAB!, name: 'crossing CD', fromNodeId: 'nC', toNodeId: 'nD' };
  await importMap(page, map); await display(page, { centers: false });
  await expect.poll(async () => (await pixels(page, [50, 30], 5, 5)).band).toBeGreaterThan(0);
  await clickWorld(page, 50, 30);
  expect(['rAB', 'rCD']).toContain(await page.getByLabel('稳定 ID', { exact: true }).inputValue());
  await expect(page.getByTestId('node-count')).toHaveText('4');
  await expect(page.getByTestId('road-count')).toHaveText('2');
  const exported = await download(page, info, 'overlapping-bands.map.json');
  expect(exported).toEqual(map);
  expect(Object.values(exported.nodes).some(node => node.position[0] === 50 && node.position[1] === 30)).toBe(false);
  expect(Object.keys(exported.junctions)).toHaveLength(0);
  expect(Object.keys(exported.movements)).toHaveLength(0);
});

test('W07 uncommitted polyline and node-drag previews move the band without mutating the saved map; each commit is undoable', async ({ page }, info) => {
  await ready(page); const map = roadFixture(); map.roads.rAB!.shapePoints = [[50, 30, 0]];
  await importMap(page, map); await display(page, { centers: false }); await saved(page);
  await page.getByTestId('road-item-rAB').click();
  const hash = await page.getByTestId('map-hash').textContent(); const stored = await record(page, 'projects');
  await page.getByLabel('折点 1 Y (m)', { exact: true }).fill('60');
  await expect(page.getByTestId('unapplied-inputs')).toBeVisible();
  await expect.poll(async () => (await pixels(page, [50, 58], 2, 2)).band).toBeGreaterThan(0);
  await expect.poll(async () => (await pixels(page, [50, 30], 2, 2)).band).toBe(0);
  await expect(page.getByTestId('map-hash')).toHaveText(hash!);
  await page.waitForTimeout(750);
  expect(await record(page, 'projects')).toEqual(stored);
  expect(await download(page, info, 'polyline-preview-uncommitted.map.json')).toEqual(map);
  await page.getByRole('button', { name: '应用属性', exact: true }).click();
  const shaped = await download(page, info, 'polyline-committed.map.json');
  expect(shaped.roads.rAB!.shapePoints).toEqual([[50, 60, 0]]); expect(shaped.revision).toBe(map.revision + 1);
  await page.getByRole('button', { name: '撤销', exact: true }).click(); await saved(page);
  expect(await download(page, info, 'polyline-undone.map.json')).toEqual(map);
  await page.getByTestId('node-item-nB').click();
  const a = await screen(page, 100, 30); const b = await screen(page, 100, 50);
  await page.mouse.move(a.x, a.y); await page.mouse.down(); await page.mouse.move(b.x, b.y, { steps: 100 });
  await expect.poll(async () => (await pixels(page, [75, 40], 2, 2)).band).toBeGreaterThan(0);
  await expect.poll(async () => (await pixels(page, [75, 30], 2, 2)).band).toBe(0);
  await expect(page.getByTestId('map-hash')).toHaveText(hash!);
  await page.mouse.up();
  const moved = await download(page, info, 'node-band-moved.map.json');
  expect(moved.nodes.nB!.position).toEqual([100, 50, 0]);
  expect(moved.roads).toEqual(map.roads); expect(moved.revision).toBe(map.revision + 1);
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  expect(await download(page, info, 'node-band-undone.map.json')).toEqual(map);
});

test('W08 road creation temporarily exposes hidden endpoints and keeps its draft trajectory visible with both road layers off', async ({ page }, info) => {
  await ready(page); const map = roadFixture(); await importMap(page, map);
  await display(page, { bands: false, centers: false, nodes: false });
  const hash = await page.getByTestId('map-hash').textContent();
  await page.getByRole('button', { name: '道路折线', exact: true }).click();
  await expect.poll(async () => (await pixels(page, [0, 30], 9, 9)).nodeInk).toBeGreaterThan(0);
  await clickWorld(page, 0, 30); await clickWorld(page, 50, 80);
  const p = await screen(page, 75, 65); await page.mouse.move(p.x, p.y);
  await expect.poll(async () => (await pixels(page, [62, 73], 18, 18)).orange).toBeGreaterThan(0);
  await expect(page.getByTestId('road-count')).toHaveText('1'); await expect(page.getByTestId('map-hash')).toHaveText(hash!);
  await clickWorld(page, 100, 30);
  await expect(page.getByTestId('road-count')).toHaveText('2');
  const created = await download(page, info, 'draft-road-committed.map.json');
  const road = Object.entries(created.roads).find(([id]) => id !== 'rAB')![1];
  expect(road.fromNodeId).toBe('nA'); expect(road.toNodeId).toBe('nB');
  expect(road.shapePoints).toEqual([[50, 80, 0]]); expect(road.widthM).toEqual({ state: 'unknown' });
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  expect(await download(page, info, 'draft-road-undone.map.json')).toEqual(map);
});

test('W09 fit includes an exceptionally wide declared band without clipping it or imposing a misleading minimum scale', async ({ page }, info) => {
  await ready(page); const map = roadFixture({ state: 'known', value: 100000, sourceRef: 'srcWidth' }); await importMap(page, map);
  await display(page, { centers: false, nodes: false });
  await page.getByRole('button', { name: '适应地图', exact: true }).click();
  const view = await camera(page); expect(view.scale).toBeGreaterThan(0); expect(view.scale).toBeLessThan(0.02);
  const actual = await pixels(page, [50, 30], 0, 3000);
  expect(actual.span).toBeGreaterThan(100);
  expect(Math.abs(actual.span - 100000 * view.scale)).toBeLessThanOrEqual(2);
  expect(actual.top).toBeGreaterThanOrEqual(48);
  expect(actual.bottom).toBeLessThanOrEqual(actual.canvasHeight - 48);
  await page.screenshot({ path: info.outputPath('huge-width-fit.png') });
  expect(await download(page, info, 'huge-width-unchanged.map.json')).toEqual(map);
});

test('W10 a wide-band edge is not an existing access/service node and dedicated picks keep the clicked coordinate without splitting roads', async ({ page }, info) => {
  await ready(page); const map = associatedFixture();
  map.roads.rAB!.widthM = { state: 'known', value: 30, sourceRef: 'srcWidth' };
  map.sources.srcWidth = { name: 'synthetic point-pick width', category: 'synthetic', description: 'Independent interaction fixture, not field measurement.' };
  await importMap(page, map);
  await expect.poll(async () => (await pixels(page, [80, 14], 1, 1)).band).toBeGreaterThan(0);
  const hash = await page.getByTestId('map-hash').textContent();
  for (const kind of ['accessPoints', 'servicePoints'] as const) {
    await page.getByTestId('facilities-item-fA').click();
    const title = kind === 'accessPoints' ? '添加入口' : '添加服务点';
    const create = kind === 'accessPoints' ? '创建入口' : '创建服务点';
    await page.getByRole('button', { name: title, exact: true }).click();
    const modal = page.getByRole('dialog', { name: title, exact: true });
    await modal.getByLabel('名称', { exact: true }).fill('synthetic band-edge ' + kind);
    await modal.getByLabel('定位方式', { exact: true }).selectOption('existing');
    await modal.getByRole('button', { name: '在画布选择已有节点', exact: true }).click();
    await clickWorld(page, 80, 14);
    await expect(page.getByRole('complementary', { name: '服务点画布定位' })).toBeVisible();
    await expect(page.locator('.point-pick-instruction')).toContainText('请选择已有节点或入口/服务点标记');
    await expect(page.getByTestId('map-hash')).toHaveText(hash!);
    await expect(page.getByTestId('node-count')).toHaveText('3');
    await page.getByRole('button', { name: '返回创建表单', exact: true }).click();
    await expect(modal.getByLabel('关联节点', { exact: true })).toHaveValue('');
    await modal.getByRole('button', { name: create, exact: true }).click();
    await expect(modal).toContainText('POINT_NODE_REQUIRED');
    await modal.getByLabel('定位方式', { exact: true }).selectOption('new');
    await modal.getByRole('button', { name: '在画布放置专用节点', exact: true }).click();
    await clickWorld(page, 80, 14);
    await expect(modal.getByLabel('X (m)', { exact: true })).toHaveValue('80');
    await expect(modal.getByLabel('Y (m)', { exact: true })).toHaveValue('14');
    await expect(page.getByTestId('map-hash')).toHaveText(hash!);
    await modal.getByRole('button', { name: create, exact: true }).click();
    await expect(modal).not.toBeVisible();
    const id = await page.getByLabel('稳定 ID', { exact: true }).inputValue();
    const created = await download(page, info, 'edge-' + kind + '.map.json');
    const nodeId = created[kind][id]!.nodeId;
    expect(created.nodes[nodeId]!.position).toEqual([80, 14, 0]);
    expect(Object.hasOwn(map.nodes, nodeId)).toBe(false);
    expect(Object.keys(created.nodes)).toHaveLength(4);
    for (const [existingId, node] of Object.entries(map.nodes)) expect(created.nodes[existingId]).toEqual(node);
    expect(created.roads).toEqual(map.roads);
    expect(created.junctions).toEqual(map.junctions); expect(created.movements).toEqual(map.movements);
    expect(Object.values(created.roads).some(road => road.fromNodeId === nodeId || road.toNodeId === nodeId)).toBe(false);
    expect(created.revision).toBe(map.revision + 1);
    await page.getByRole('button', { name: '撤销', exact: true }).click();
    expect(await download(page, info, 'edge-' + kind + '-undone.map.json')).toEqual(map);
    await expect(page.getByTestId('map-hash')).toHaveText(hash!);
  }
});