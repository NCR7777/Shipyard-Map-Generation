import { readFile } from 'node:fs/promises';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import type { Polygon, Vec3, YardMap } from '../../src/domain/model';
import { associatedFixture, rectangle } from '../helpers/M2A_fixtures';

async function ready(page: Page) {
  await page.goto('/');
  await expect(page.getByRole('button', { name: '保存工程', exact: true })).toBeEnabled();
}
async function saved(page: Page) { await expect(page.getByTestId('browser-save-status')).toContainText('已保存'); }
async function screen(page: Page, x: number, y: number) {
  const box = await page.getByTestId('map-canvas').locator('canvas').first().boundingBox();
  if (!box) throw new Error('Canvas is not visible.');
  const camera = page.getByTestId('camera-state');
  const scale = Number(await camera.getAttribute('data-scale'));
  return { x: box.x + Number(await camera.getAttribute('data-offset-x')) + x * scale, y: box.y + Number(await camera.getAttribute('data-offset-y')) - y * scale };
}
async function clickWorld(page: Page, x: number, y: number) {
  const p = await screen(page, x, y); await page.mouse.click(p.x, p.y);
}
async function startDrag(page: Page, from: Vec3, to: Vec3, steps = 20) {
  const a = await screen(page, from[0], from[1]); const b = await screen(page, to[0], to[1]);
  await page.mouse.move(a.x, a.y); await page.mouse.down(); await page.mouse.move(b.x, b.y, { steps });
}
async function drag(page: Page, from: Vec3, to: Vec3, steps = 20) {
  await startDrag(page, from, to, steps); await page.mouse.up();
}
async function download(page: Page, info: TestInfo, filename: string): Promise<YardMap> {
  const pending = page.waitForEvent('download'); await page.getByRole('button', { name: '导出 JSON', exact: true }).click();
  const path = info.outputPath(filename); await (await pending).saveAs(path);
  return JSON.parse(await readFile(path, 'utf8')) as YardMap;
}
async function importMap(page: Page, map: YardMap) {
  await page.getByTestId('json-file-input').setInputFiles({ name: 'synthetic-rectangle-input.map.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(map)) });
  const conflict = page.getByRole('dialog', { name: '未保存编辑冲突', exact: true });
  await expect(page.getByRole('button', { name: '导入 JSON', exact: true })).toBeEnabled();
  if (await conflict.isVisible()) await conflict.getByRole('button', { name: '放弃编辑并重载', exact: true }).click();
  await expect(page.getByLabel('地图名称', { exact: true })).toHaveValue(map.metadata.name);
  await page.getByTestId('facilities-item-fA').click();
}
async function localSize(page: Page, width: number, height: number) {
  for (const [id, value] of [['rectangle-width', width], ['rectangle-height', height]] as const) {
    await expect.poll(async () => Number(await page.getByTestId(id).textContent())).toBeCloseTo(value, 8);
  }
}
async function numericSize(page: Page, width: number, height: number) {
  await page.getByLabel('矩形宽 (m)', { exact: true }).fill(String(width));
  await page.getByLabel('矩形高 (m)', { exact: true }).fill(String(height));
  await page.getByRole('button', { name: '应用属性', exact: true }).click();
}
async function storedProjects(page: Page): Promise<string> {
  return page.evaluate(() => new Promise<string>((resolve, reject) => {
    const opened = indexedDB.open('shipyard-map-projects', 1);
    opened.onerror = () => reject(opened.error);
    opened.onsuccess = () => {
      const db = opened.result; const transaction = db.transaction('projects', 'readonly');
      const request = transaction.objectStore('projects').getAll();
      transaction.oncomplete = () => { db.close(); resolve(JSON.stringify(request.result)); };
      transaction.onabort = () => { db.close(); reject(transaction.error); };
    };
  }));
}
async function labelInk(page: Page): Promise<{ width: number; height: number; count: number }> {
  // DP1 places text inside the current polygon. Check fixed CSS glyph size, not the old corner anchor.
  return page.getByTestId('map-canvas').evaluate(element => {
    const points: number[][] = [];
    // Third canvas is the non-listening overlay; handles occupy their own later canvas.
    for (const canvas of Array.from(element.querySelectorAll('canvas')).slice(2, 3)) {
      const dpr = canvas.width / canvas.getBoundingClientRect().width;
      const pixels = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data;
      for (let i = 0; i < pixels.length; i += 4) if (pixels[i] === 154 && pixels[i + 1] === 76 && pixels[i + 2] === 13 && pixels[i + 3] === 255) points.push([(i / 4 % canvas.width) / dpr, Math.floor(i / 4 / canvas.width) / dpr]);
    }
    return { width: Math.max(...points.map(p => p[0]!)) - Math.min(...points.map(p => p[0]!)), height: Math.max(...points.map(p => p[1]!)) - Math.min(...points.map(p => p[1]!)), count: points.length };
  });
}
function expectRectangle(polygon: Polygon, width: number, height: number) {
  expect(polygon.holes).toEqual([]);
  expect(polygon.outer).toHaveLength(5);
  expect(polygon.outer[4]).toEqual(polygon.outer[0]);
  const edges = polygon.outer.slice(0, 4).map((p, i) => {
    const q = polygon.outer[i + 1]!; return [q[0] - p[0], q[1] - p[1]];
  });
  edges.forEach((edge, i) => {
    expect(Math.hypot(edge[0]!, edge[1]!)).toBeCloseTo(i % 2 ? height : width, 8);
    const next = edges[(i + 1) % 4]!;
    expect(edge[0]! * next[0]! + edge[1]! * next[1]!).toBeCloseTo(0, 7);
  });
}
function versionedFixture(version: YardMap['schemaVersion']): YardMap {
  const base = associatedFixture();
  return { ...base, schemaVersion: version, metadata: { ...base.metadata, name: 'synthetic rectangle ' + version } } as YardMap;
}
const preview = (page: Page) => page.getByTestId('boundary-edit-preview');
const guard = (page: Page) => page.getByRole('dialog', { name: '未应用输入保护', exact: true });

// No map is injected through application internals. Creation, import, editing and saving use real UI.
for (const kind of ['facilities', 'zones'] as const) {
  test('R01 R05 R08 real ' + kind + ' 60x30 to 80x45 keeps its diagonal fixed and commits 100 pointer frames once', async ({ page }, info) => {
    await ready(page);
    await page.getByRole('button', { name: kind === 'facilities' ? '矩形设施' : '矩形区域', exact: true }).click();
    await clickWorld(page, 0, 0); await clickWorld(page, 60, 30);
    const id = await page.getByLabel('稳定 ID', { exact: true }).inputValue();
    await localSize(page, 60, 30);
    await expect(page.getByTestId('boundary-handles')).toHaveAttribute('data-count', '4');
    await expect(page.getByTestId('boundary-handles')).toHaveAttribute('data-mode', 'rectangle');
    await saved(page);
    const before = await download(page, info, 'before.map.json');
    const storedBefore = await storedProjects(page);
    const hash = await page.getByTestId('map-hash').textContent();
    await startDrag(page, [60, 30, 0], [80, 45, 0], 100);
    await expect(preview(page)).toBeVisible();
    await expect.poll(async () => Number(await preview(page).getAttribute('data-width-m'))).toBeCloseTo(80, 8);
    await expect.poll(async () => Number(await preview(page).getAttribute('data-height-m'))).toBeCloseTo(45, 8);
    await expect(page.getByTestId('map-hash')).toHaveText(hash!);
    await page.waitForTimeout(750); // Longer than the real 600ms auto-draft debounce.
    expect(await storedProjects(page)).toBe(storedBefore);
    await page.mouse.up();
    await localSize(page, 80, 45);
    const resized = await download(page, info, 'resized.map.json');
    expect(resized[kind][id]!.boundary.outer).toEqual(rectangle(0, 0, 80, 45).outer);
    expectRectangle(resized[kind][id]!.boundary, 80, 45);
    expect(resized.revision).toBe(before.revision + 1);
    expect(resized.nodes).toEqual(before.nodes);
    expect(Object.keys(resized[kind][id]!)).toEqual(Object.keys(before[kind][id]!));
    expect(resized[kind][id]).toEqual({ ...before[kind][id]!, boundary: rectangle(0, 0, 80, 45) });
    await page.getByRole('button', { name: '撤销', exact: true }).click();
    expect(await download(page, info, 'undone.map.json')).toEqual(before);
    await page.getByRole('button', { name: '重做', exact: true }).click();
    expect(await download(page, info, 'redone.map.json')).toEqual(resized);
    await saved(page); await page.reload(); await page.getByTestId(kind + '-item-' + id).click();
    await localSize(page, 80, 45);
    expect(await download(page, info, 'recovered.map.json')).toEqual(resized);
  });
}

test('R02 R08 a 30-degree rectangle uses local dimensions and numeric editing produces the same authoritative corners', async ({ page }, info) => {
  await ready(page);
  await page.getByRole('button', { name: '矩形设施', exact: true }).click();
  await clickWorld(page, 0, 0); await clickWorld(page, 60, 30);
  const id = await page.getByLabel('稳定 ID', { exact: true }).inputValue();
  await page.getByRole('button', { name: '旋转', exact: true }).click();
  const modal = page.getByRole('dialog', { name: '旋转选中对象', exact: true });
  await modal.getByLabel('旋转角度 (rad)', { exact: true }).fill(String(Math.PI / 6));
  for (const axis of ['X', 'Y', 'Z']) await modal.getByLabel('中心 ' + axis + ' (m)', { exact: true }).fill('0');
  await modal.getByRole('button', { name: '确认旋转', exact: true }).click();
  await expect(modal).not.toBeVisible();
  await localSize(page, 60, 30);
  await expect(page.getByLabel('外环 顶点 2 X (m)', { exact: true })).not.toBeVisible();
  const original = await download(page, info, 'rotated-original.map.json');
  const labelBefore = await labelInk(page);
  expect(labelBefore.count).toBeGreaterThan(0);
  expect(labelBefore.height).toBeLessThanOrEqual(12);
  const c = Math.cos(Math.PI / 6); const s = Math.sin(Math.PI / 6);
  const moved: Vec3 = [80 * c - 45 * s, 80 * s + 45 * c, 0];
  const nativeInput = page.evaluate(() => new Promise<{ type: string; x: number; y: number }[]>(resolve => {
    const events: { type: string; x: number; y: number }[] = [];
    const types = ['pointerdown', 'mousedown', 'pointermove', 'mousemove', 'pointerup', 'mouseup'];
    const record = (event: Event) => {
      const pointer = event as MouseEvent;
      events.push({ type: event.type, x: pointer.clientX, y: pointer.clientY });
      if (event.type === 'mouseup') {
        types.forEach(type => window.removeEventListener(type, record, true)); resolve(events);
      }
    };
    types.forEach(type => window.addEventListener(type, record, true));
  }));
  const dragCamera = {
    offsetX: await page.getByTestId('camera-state').getAttribute('data-offset-x'),
    offsetY: await page.getByTestId('camera-state').getAttribute('data-offset-y'),
    scale: await page.getByTestId('camera-state').getAttribute('data-scale'),
  };
  await drag(page, original.facilities[id]!.boundary.outer[2], moved);
  const events = await nativeInput;
  await info.attach('native-drag-coordinates.json', { body: JSON.stringify({ events, camera: dragCamera, originalCorner: original.facilities[id]!.boundary.outer[2], requestedCorner: moved }, null, 2), contentType: 'application/json' });
  const down = events.find(event => event.type === 'pointerdown')!;
  const up = events.find(event => event.type === 'pointerup')!;
  const scale = Number(dragCamera.scale); const oldCorner = original.facilities[id]!.boundary.outer[2];
  // Chrome exposes float32 PointerEvent coordinates. Assert the actual physical pointer displacement
  // to 1e-8, rather than assuming it delivered infinitely precise trigonometric screen coordinates.
  const actualCorner: Vec3 = [oldCorner[0] + (up.x - down.x) / scale, oldCorner[1] - (up.y - down.y) / scale, oldCorner[2]];
  const actualWidth = actualCorner[0] * c + actualCorner[1] * s;
  const actualHeight = -actualCorner[0] * s + actualCorner[1] * c;
  await localSize(page, actualWidth, actualHeight);
  const mouse = await download(page, info, 'rotated-mouse.map.json');
  const labelAfter = await labelInk(page);
  expect(labelAfter.count).toBeGreaterThan(0);
  expect(labelAfter.height).toBeLessThanOrEqual(12);
  expect(Math.abs(labelAfter.width - labelBefore.width)).toBeLessThanOrEqual(2);
  expectRectangle(mouse.facilities[id]!.boundary, actualWidth, actualHeight);
  const expected = [[0, 0, 0], [actualWidth * c, actualWidth * s, 0], actualCorner, [-actualHeight * s, actualHeight * c, 0], [0, 0, 0]];
  mouse.facilities[id]!.boundary.outer.forEach((p, i) => p.forEach((v, j) => expect(v).toBeCloseTo(expected[i]![j]!, 8)));
  expect(mouse.facilities[id]!.boundary.outer[0]).toEqual(original.facilities[id]!.boundary.outer[0]);
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await page.getByLabel('固定对角', { exact: true }).selectOption('0');
  await numericSize(page, actualWidth, actualHeight);
  const numeric = await download(page, info, 'rotated-numeric.map.json');
  expectRectangle(numeric.facilities[id]!.boundary, actualWidth, actualHeight);
  numeric.facilities[id]!.boundary.outer.forEach((p, i) => p.forEach((v, j) => expect(v).toBeCloseTo(mouse.facilities[id]!.boundary.outer[i]![j]!, 8)));
  expect(numeric.nodes).toEqual(original.nodes);
  await numericSize(page, 80, 45); await localSize(page, 80, 45);
  const exact = await download(page, info, 'rotated-exact-numeric.map.json');
  expectRectangle(exact.facilities[id]!.boundary, 80, 45);
  expect(exact.facilities[id]!.boundary.outer[0]).toEqual(original.facilities[id]!.boundary.outer[0]);
  await page.screenshot({ path: info.outputPath('rectangle-rotated-80x45.png'), fullPage: true });

});

test('R03 the same world resize is independent of view zoom and pan', async ({ page }, info) => {
  await ready(page); const original = associatedFixture(); await importMap(page, original);
  await drag(page, [60, 30, 0], [80, 45, 0]);
  const first = await download(page, info, 'normal-view.map.json');
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  expect(await download(page, info, 'before-view.map.json')).toEqual(original);
  const cameraBefore = await page.getByTestId('camera-state').textContent();
  const p = await screen(page, 70, 40);
  await page.mouse.move(p.x, p.y); await page.mouse.down({ button: 'middle' });
  await page.mouse.move(p.x + 70, p.y + 35, { steps: 10 }); await page.mouse.up({ button: 'middle' });
  await page.mouse.wheel(0, -200);
  await expect(page.getByTestId('camera-state')).not.toHaveText(cameraBefore!);
  expect(await download(page, info, 'view-only.map.json')).toEqual(original);
  await drag(page, [60, 30, 0], [80, 45, 0]);
  const second = await download(page, info, 'changed-view.map.json');
  expect(second).toEqual(first);
});

test('R04 irregular outer and hole vertices remain authoritative; invalid pointer edits roll back map and history', async ({ page }, info) => {
  await ready(page); const original = associatedFixture();
  original.facilities.fA!.boundary = {
    outer: [[0, 0, 0], [60, 0, 0], [50, 30, 0], [0, 30, 0], [0, 0, 0]],
    holes: [[[10, 10, 0], [10, 15, 0], [20, 15, 0], [20, 10, 0], [10, 10, 0]]],
  };
  await importMap(page, original);
  await expect(page.getByLabel('矩形宽 (m)', { exact: true })).not.toBeVisible();
  await expect(page.getByTestId('boundary-handles')).toHaveAttribute('data-count', '8');
  await expect(page.getByTestId('boundary-handles')).toHaveAttribute('data-mode', 'polygon');
  expect(await download(page, info, 'irregular-import.map.json')).toEqual(original);
  await drag(page, [50, 30, 0], [55, 35, 0]);
  const edited = await download(page, info, 'irregular-edited.map.json');
  expect(edited.facilities.fA!.boundary.outer).toEqual([[0, 0, 0], [60, 0, 0], [55, 35, 0], [0, 30, 0], [0, 0, 0]]);
  expect(edited.facilities.fA!.boundary.holes).toEqual(original.facilities.fA!.boundary.holes);
  await drag(page, [10, 10, 0], [9, 9, 0]);
  const holeEdited = await download(page, info, 'hole-valid-edit.map.json');
  expect(holeEdited.facilities.fA!.boundary.outer).toEqual(edited.facilities.fA!.boundary.outer);
  expect(holeEdited.facilities.fA!.boundary.holes).toEqual([[[9, 9, 0], [10, 15, 0], [20, 15, 0], [20, 10, 0], [9, 9, 0]]]);
  const hash = await page.getByTestId('map-hash').textContent();
  await drag(page, [60, 0, 0], [-10, 20, 0]);
  await expect(page.getByTestId('issue-panel')).toContainText('POLYGON');
  await expect(page.getByTestId('map-hash')).toHaveText(hash!);
  expect(await download(page, info, 'self-intersection-rejected.map.json')).toEqual(holeEdited);
  await drag(page, [9, 9, 0], [70, 10, 0]);
  await expect(page.getByTestId('map-hash')).toHaveText(hash!);
  expect(await download(page, info, 'hole-outside-rejected.map.json')).toEqual(holeEdited);
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  expect(await download(page, info, 'valid-hole-undo.map.json')).toEqual(edited);
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect(page.getByRole('button', { name: '撤销', exact: true })).toBeDisabled();
  expect(await download(page, info, 'one-valid-vertex-undo.map.json')).toEqual(original);
});

test('R04 a zero-area polygon drag is rejected without adding an undo step', async ({ page }, info) => {
  await ready(page); const original = associatedFixture();
  original.facilities.fA!.boundary = { outer: [[0, 0, 0], [60, 0, 0], [0, 30, 0], [0, 0, 0]], holes: [] };
  await importMap(page, original);
  await drag(page, [0, 30, 0], [30, 0, 0]);
  await expect(page.getByTestId('issue-panel')).toContainText('POLYGON_ZERO_AREA');
  await expect(page.getByRole('button', { name: '撤销', exact: true })).toBeDisabled();
  expect(await download(page, info, 'zero-area-rejected.map.json')).toEqual(original);
});

test('R05 Escape cancels preview and a map revision change prevents a stale boundary commit', async ({ page }, info) => {
  await ready(page); const original = associatedFixture(); await importMap(page, original);
  await startDrag(page, [60, 30, 0], [80, 45, 0]);
  await expect(preview(page)).toBeVisible();
  await page.keyboard.press('Escape'); await page.mouse.up();
  await expect(preview(page)).not.toBeVisible();
  await expect(page.getByRole('button', { name: '撤销', exact: true })).toBeDisabled();
  expect(await download(page, info, 'escape-canceled.map.json')).toEqual(original);
  await page.getByTestId('facilities-item-fA').click();
  await page.getByLabel('名称', { exact: true }).fill('rename before boundary drag');
  await page.getByRole('button', { name: '应用属性', exact: true }).click();
  await startDrag(page, [60, 30, 0], [80, 45, 0]);
  await expect(preview(page)).toBeVisible();
  await page.keyboard.press('Control+z');
  await page.mouse.up();
  await expect(preview(page)).not.toBeVisible();
  expect(await download(page, info, 'stale-drag-canceled.map.json')).toEqual(original);
});

for (const version of ['0.1.0', '0.2.0'] as const) {
  test('R06 R07 ' + version + ' resize retains IDs, references, nonrectangular data and the original schema through saving and reimport', async ({ page }, info) => {
    await ready(page); const original = versionedFixture(version);
    original.zones.zA!.boundary = { outer: [[10, 50, 0], [30, 50, 0], [25, 70, 0], [10, 70, 0], [10, 50, 0]], holes: [] };
    await importMap(page, original);
    expect(await download(page, info, 'legacy-original.map.json')).toEqual(original);
    await page.getByLabel('设施移动策略', { exact: true }).selectOption('withAssociatedNodes');
    await drag(page, [60, 30, 0], [80, 45, 0]);
    const resized = await download(page, info, 'legacy-resized.map.json');
    expect(resized.schemaVersion).toBe(version); expect(resized.mapId).toBe(original.mapId);
    expect(resized.facilities.fA).toEqual({ ...original.facilities.fA!, boundary: rectangle(0, 0, 80, 45) });
    expect(resized.nodes).toEqual(original.nodes); expect(resized.roads).toEqual(original.roads);
    expect(resized.accessPoints).toEqual(original.accessPoints); expect(resized.servicePoints).toEqual(original.servicePoints);
    expect(resized.zones).toEqual(original.zones);
    await saved(page); await page.reload(); await page.getByTestId('facilities-item-fA').click();
    await localSize(page, 80, 45);
    expect(await download(page, info, 'legacy-restored.map.json')).toEqual(resized);
    await importMap(page, resized); await localSize(page, 80, 45);
    expect(await download(page, info, 'legacy-reimported.map.json')).toEqual(resized);
    await page.getByTestId('zones-item-zA').click();
    await expect(page.getByLabel('矩形宽 (m)', { exact: true })).not.toBeVisible();
    expect(await download(page, info, 'irregular-zone-preserved.map.json')).toEqual(resized);
  });
}

test('R07 multi-selection keeps whole-object moves while readonly and unapplied numeric input cannot be bypassed by handles', async ({ page }, info) => {
  await ready(page); const original = associatedFixture(); await importMap(page, original);
  await page.getByTestId('zones-item-zA').click({ modifiers: ['Shift'] });
  await expect(page.getByTestId('boundary-handles')).toHaveAttribute('data-count', '0');
  await expect(page.getByLabel('矩形宽 (m)', { exact: true })).not.toBeVisible();
  await drag(page, [30, 15, 0], [35, 20, 0]);
  const moved = await download(page, info, 'multi-moved.map.json');
  expect(moved.facilities.fA!.boundary.outer[0]).toEqual([5, 5, 0]);
  expect(moved.zones.zA!.boundary.outer[0]).toEqual([15, 55, 0]);
  expectRectangle(moved.facilities.fA!.boundary, 60, 30);
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  expect(await download(page, info, 'multi-undone.map.json')).toEqual(original);
  await page.getByTestId('facilities-item-fA').click();
  await page.getByLabel('矩形宽 (m)', { exact: true }).fill('90');
  const hash = await page.getByTestId('map-hash').textContent();
  await drag(page, [60, 30, 0], [80, 45, 0]);
  await expect(page.getByTestId('map-hash')).toHaveText(hash!);
  await expect(page.getByLabel('矩形宽 (m)', { exact: true })).toHaveValue('90');
  await expect(guard(page)).toBeVisible();
  await guard(page).getByRole('button', { name: '取消，保留输入', exact: true }).click();
  await expect(page.getByTestId('map-hash')).toHaveText(hash!);
  await page.getByTestId('zones-item-zA').click();
  await expect(guard(page)).toBeVisible();
  await guard(page).getByRole('button', { name: '取消，保留输入', exact: true }).click();
  await expect(page.getByLabel('矩形宽 (m)', { exact: true })).toHaveValue('90');
  await page.getByTestId('zones-item-zA').click();
  await guard(page).getByRole('button', { name: '丢弃未应用输入并继续', exact: true }).click();
  expect(await download(page, info, 'guard-preserved.map.json')).toEqual(original);
  const protectedMap = associatedFixture();
  protectedMap.extensionNamespaces['test.readonly'] = { category: 'behavior', version: '1' };
  protectedMap.extensions['test.readonly'] = { futureRule: 'retain without implementing' };
  await importMap(page, protectedMap);
  await expect(page.getByTestId('readonly-notice')).toBeVisible();
  await expect(page.getByLabel('矩形宽 (m)', { exact: true })).toBeDisabled();
  await expect(page.getByTestId('boundary-handles')).toHaveAttribute('data-count', '0');
  await drag(page, [60, 30, 0], [80, 45, 0]);
  await expect(preview(page)).not.toBeVisible();
  expect(await download(page, info, 'readonly-preserved.map.json')).toEqual(protectedMap);
});

test('R01 R03 R08 crossing the fixed corner clamps positive metric sizes; invalid numeric dimensions do not commit', async ({ page }, info) => {
  await ready(page); const original = associatedFixture(); await importMap(page, original);
  await page.getByLabel('矩形宽 (m)', { exact: true }).fill('60.0');
  await expect(page.getByTestId('unapplied-inputs')).toBeVisible();
  await page.getByRole('button', { name: '应用属性', exact: true }).click();
  await expect(page.getByTestId('unapplied-inputs')).not.toBeVisible();
  expect(await download(page, info, 'numeric-equivalent-noop.map.json')).toEqual(original);
  await expect(page.getByRole('button', { name: '撤销', exact: true })).toBeDisabled();
  const originalHash = await page.getByTestId('map-hash').textContent();
  await numericSize(page, 0, 30);
  await expect(page.getByTestId('map-hash')).toHaveText(originalHash!);
  await expect(page.getByRole('button', { name: '撤销', exact: true })).toBeDisabled();
  await page.getByLabel('矩形宽 (m)', { exact: true }).fill('60');
  await drag(page, [60, 30, 0], [-10, -10, 0]);
  await localSize(page, 0.01, 0.01);
  const clamped = await download(page, info, 'clamped.map.json');
  expectRectangle(clamped.facilities.fA!.boundary, 0.01, 0.01);
  expect(clamped.facilities.fA!.boundary.outer[0]).toEqual([0, 0, 0]);
  expect(clamped.nodes).toEqual(original.nodes);
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  const p = await screen(page, 50, 20); await page.mouse.move(p.x, p.y); await page.mouse.wheel(0, -200);
  await drag(page, [60, 30, 0], [-10, -10, 0]);
  expect(await download(page, info, 'clamped-other-camera.map.json')).toEqual(clamped);
});
