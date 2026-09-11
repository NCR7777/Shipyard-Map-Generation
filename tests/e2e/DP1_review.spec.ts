import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import type { Polygon, Vec3, YardMap } from '../../src/domain/model';
import { P1_TARGETS, readP1Target, resolveP1DataRoot, originalSlotCount } from '../helpers/P1_targets';
import { geometryBounds } from '../../src/geometry/roads';
import { spatialFixture } from '../helpers/M2A_fixtures';

async function ready(page: Page) {
  await page.goto('/');
  await expect(page.getByRole('button', { name: '保存工程', exact: true })).toBeEnabled();
  await expect(page.getByTestId('browser-save-status')).toContainText('已保存');
}
async function imported(page: Page, map: YardMap) {
  const conflict = page.getByRole('dialog', { name: '未保存编辑冲突', exact: true });
  await expect.poll(async () => await conflict.isVisible() || await page.getByLabel('地图名称', { exact: true }).inputValue() === map.metadata.name, { timeout: 30000 }).toBe(true);
  if (await conflict.isVisible()) await conflict.getByRole('button', { name: '放弃编辑并重载', exact: true }).click();
  await expect(page.getByLabel('地图名称', { exact: true })).toHaveValue(map.metadata.name);
  await expect(page.getByTestId('browser-save-status')).toContainText('已保存');
}
async function screen(page: Page, point: Vec3) {
  const box = await page.getByTestId('map-canvas').locator('canvas').first().boundingBox();
  if (!box) throw new Error('Canvas is not visible.');
  const state = page.getByTestId('camera-state');
  const scale = Number(await state.getAttribute('data-scale'));
  return { x: box.x + Number(await state.getAttribute('data-offset-x')) + point[0] * scale,
    y: box.y + Number(await state.getAttribute('data-offset-y')) - point[1] * scale, scale };
}
async function download(page: Page, info: TestInfo, name: string): Promise<YardMap> {
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出 JSON', exact: true }).click();
  const path = info.outputPath(name); await (await pending).saveAs(path);
  return JSON.parse(await readFile(path, 'utf8')) as YardMap;
}
async function selectedOutlinePixels(page: Page) {
  // Actual canvas pixels, not Konva/application internals. The resource selection stroke is #d57921.
  return page.getByTestId('map-canvas').evaluate(element => {
    let count = 0;
    for (const canvas of element.querySelectorAll('canvas')) {
      const bytes = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data;
      for (let i = 0; i < bytes.length; i += 4) if (bytes[i] === 213 && bytes[i + 1] === 121 && bytes[i + 2] === 33 && bytes[i + 3] === 255) count++;
    }
    return count;
  });
}

test('DP review resource selection replaces a previous facility focus and direct resource locate paints its references', async ({ page }, info) => {
  test.setTimeout(90000);
  await page.addInitScript(() => {
    const originalAdd = window.addEventListener.bind(window), originalRemove = window.removeEventListener.bind(window);
    const events: unknown[] = [], wrappers = new Map<EventListener, EventListener>();
    (window as typeof window & { dp1KeyTrace: unknown[] }).dp1KeyTrace = events;
    // Track the real subscription lifetime without changing listener ordering or propagation.
    window.addEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) => {
      if (type !== 'keydown' || typeof listener !== 'function') return originalAdd(type, listener, options);
      let wrapper = wrappers.get(listener);
      if (!wrapper) { wrapper = event => { events.push({ op: 'invoke', name: listener.name, key: (event as KeyboardEvent).key, at: performance.now() }); listener.call(window, event); }; wrappers.set(listener, wrapper); }
      events.push({ op: 'add', name: listener.name, at: performance.now() }); return originalAdd(type, wrapper, options);
    }) as typeof window.addEventListener;
    window.removeEventListener = ((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | EventListenerOptions) => {
      if (type !== 'keydown' || typeof listener !== 'function') return originalRemove(type, listener, options);
      events.push({ op: 'remove', name: listener.name, at: performance.now() }); return originalRemove(type, wrappers.get(listener) ?? listener, options);
    }) as typeof window.removeEventListener;
  });
  const target = P1_TARGETS.find(item => item.id === 'SR03_A')!;
  const { map } = await readP1Target(target); // Missing/changed original remains blocked_input.
  expect(map.resources.RES_STORE_001!.appliesTo).toContainEqual({ entityType: 'facilities', entityId: 'F_001' });
  await ready(page); await page.getByTestId('json-file-input').setInputFiles(target.absolutePath); await imported(page, map);
  const hash = await page.getByTestId('map-hash').textContent();
  await page.getByTestId('object-search').fill('F_001');
  await page.getByRole('button', { name: '定位 F_001', exact: true }).click();
  await page.getByTestId('object-search').fill('RES_STORE_001');
  await page.getByTestId('inspect-item-resources-RES_STORE_001').click();
  await expect(page.getByTestId('object-inspector').locator('code')).toHaveText('RES_STORE_001');
  await expect.poll(() => selectedOutlinePixels(page)).toBeGreaterThan(10);
  await expect(page.getByTestId('focus-details').locator('code')).toHaveText('RES_STORE_001');
  await page.getByTestId('map-canvas').focus(); await page.keyboard.press('Escape');
  const keyTracePath = info.outputPath('escape-listener-order.json');
  await writeFile(keyTracePath, JSON.stringify(await page.evaluate(() => (window as typeof window & { dp1KeyTrace: unknown[] }).dp1KeyTrace), null, 2));
  await info.attach('escape-listener-order.json', { path: keyTracePath, contentType: 'application/json' });
  await expect(page.getByTestId('object-inspector')).toHaveCount(0);
  await expect.poll(() => selectedOutlinePixels(page)).toBe(0);
  await page.getByRole('button', { name: '定位 RES_STORE_001', exact: true }).click();
  await expect.poll(() => selectedOutlinePixels(page)).toBeGreaterThan(10);
  await expect(page.getByTestId('object-inspector')).toHaveCount(0); // Locate never silently adds an inspection selection.
  await expect(page.getByTestId('map-hash')).toHaveText(hash!);
  await expect(page.getByRole('button', { name: '撤销', exact: true })).toBeDisabled();
  expect(await download(page, info, 'DP1-review-resource-unchanged.map.json')).toEqual(map);
  await readP1Target(target);
});

test('DP review focus card avoids a real rectangle handle and native corner drag remains one transaction', async ({ page }, info) => {
  const map = spatialFixture(); // Existing, explicitly synthetic interaction fixture; not a substitute for SR03/SHI.
  await ready(page);
  await page.getByTestId('json-file-input').setInputFiles({ name: 'DP1_review_synthetic_handles.map.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(map)) });
  await imported(page, map); await page.getByTestId('facilities-item-fA').click();
  await expect(page.getByTestId('boundary-handles')).toHaveAttribute('data-count', '4');
  const canvas = await page.getByTestId('map-canvas').locator('canvas').first().boundingBox();
  if (!canvas) throw new Error('Canvas is not visible.');
  const before = await screen(page, [60, 30, 0]);
  const target = { x: canvas.x + canvas.width - 120, y: canvas.y + 80 };
  const start = { x: canvas.x + 100, y: canvas.y + canvas.height - 40 };
  await page.mouse.move(start.x, start.y); await page.mouse.down({ button: 'middle' });
  await page.mouse.move(start.x + target.x - before.x, start.y + target.y - before.y, { steps: 15 });
  await page.mouse.up({ button: 'middle' });
  await expect(page.getByTestId('display-state')).toHaveAttribute('data-navigating', 'false');
  const corner = await screen(page, [60, 30, 0]);
  expect(corner.x).toBeCloseTo(target.x, 0); expect(corner.y).toBeCloseTo(target.y, 0);
  const card = page.getByTestId('focus-details'); await expect(card).toBeVisible();
  const cardBox = await card.boundingBox(); if (!cardBox) throw new Error('Focus card is not visible.');
  for (const point of map.facilities.fA!.boundary.outer.slice(0, -1)) {
    const handle = await screen(page, point);
    expect(cardBox.x < handle.x + 14 && cardBox.x + cardBox.width > handle.x - 14
      && cardBox.y < handle.y + 14 && cardBox.y + cardBox.height > handle.y - 14).toBe(false);
  }
  const handlePixels = await page.getByTestId('map-canvas').evaluate((element, point) => {
    let count = 0;
    for (const canvas of element.querySelectorAll('canvas')) {
      const box = canvas.getBoundingClientRect(), dpr = canvas.width / box.width;
      const data = canvas.getContext('2d')!.getImageData(Math.floor((point.x - box.x - 8) * dpr), Math.floor((point.y - box.y - 8) * dpr), Math.ceil(16 * dpr), Math.ceil(16 * dpr)).data;
      for (let i = 0; i < data.length; i += 4) if (data[i] === 154 && data[i + 1] === 76 && data[i + 2] === 13 && data[i + 3] === 255) count++;
    }
    return count;
  }, corner);
  expect(handlePixels).toBeGreaterThan(4);
  await page.mouse.move(corner.x, corner.y); await page.mouse.down();
  await page.mouse.move(corner.x + 20, corner.y - 10, { steps: 12 }); await page.mouse.up();
  const changed = await download(page, info, 'DP1-review-corner-edited.map.json');
  expect(changed.revision).toBe(map.revision + 1);
  expect(changed.facilities.fA!.boundary.outer[0]).toEqual(map.facilities.fA!.boundary.outer[0]);
  expect(changed.facilities.fA!.boundary.outer[2][0]).toBeCloseTo(60 + 20 / corner.scale, 8);
  expect(changed.facilities.fA!.boundary.outer[2][1]).toBeCloseTo(30 + 10 / corner.scale, 8);
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  expect(await download(page, info, 'DP1-review-corner-undone.map.json')).toEqual(map);
  await expect(page.getByRole('button', { name: '撤销', exact: true })).toBeDisabled();
});


test('DP A04 synthetic long stable ID remains the complete selectable copy source and retains its declared provenance', async ({ page }, info) => {
  const map = spatialFixture();
  const id = 'FACILITY_SYNTHETIC_FULL_STABLE_IDENTIFIER_0123456789';
  const name = 'synthetic 完整名称：显示可以简写，但业务设施身份与来源必须保留';
  const sourceId = 'SRC_DP1_SYNTHETIC_FULL_PROVENANCE';
  map.facilities[id] = { ...map.facilities.fA!, name, provenance: { category: 'synthetic', sourceRefs: [sourceId] } };
  delete map.facilities.fA; // The existing spatialFixture facility has no references; this is a named synthetic input only.
  map.sources[sourceId] = { name: 'DP1 synthetic 来源完整信息', category: 'synthetic', description: '仅用于验证展示与复制源；不是真实船厂测绘。' };
  expect(id.length).toBeGreaterThan(20);
  await ready(page);
  await page.getByTestId('json-file-input').setInputFiles({ name: 'DP1_A04_synthetic_full_identity.map.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(map)) });
  await imported(page, map);
  const hash = await page.getByTestId('map-hash').textContent();
  await page.getByTestId('facilities-item-' + id).click();
  const card = page.getByTestId('focus-details');
  await expect(card).toHaveCount(1);
  await expect(card.locator('strong')).toHaveText(name);
  await expect(card.locator('code')).toHaveText(id);
  await expect(card.locator('span')).toHaveText('synthetic · ' + sourceId);
  await expect(page.getByLabel('名称', { exact: true })).toHaveValue(name);
  await expect(page.locator('.spatial-property .provenance-note')).toContainText('来源声明：synthetic');
  const field = page.getByLabel('稳定 ID', { exact: true });
  await expect(field).toHaveValue(id); await expect(field).toHaveAttribute('readonly', '');
  await field.click(); await page.keyboard.press('Control+a');
  // Inspect the native text selection that a copy operation consumes; do not change the system clipboard.
  const copySource = await field.evaluate(element => {
    const input = element as HTMLInputElement;
    return { value: input.value, start: input.selectionStart, end: input.selectionEnd,
      selected: input.value.slice(input.selectionStart ?? 0, input.selectionEnd ?? 0) };
  });
  expect(copySource).toEqual({ value: id, start: 0, end: id.length, selected: id });
  await expect(page.getByTestId('map-hash')).toHaveText(hash!);
  await expect(page.getByRole('button', { name: '撤销', exact: true })).toBeDisabled();
  expect(await download(page, info, 'DP1-A04-full-identity-unchanged.map.json')).toEqual(map);
});

test('DP A05 frozen SHI v03 multi-select keeps one focus card and a bounded label set without changing the full map', async ({ page }, info) => {
  test.setTimeout(120000);
  const relative = 'projects/SHI_Geoje_Research_Map_v03/map.json';
  const path = resolve(resolveP1DataRoot(), relative);
  const expectedSha = 'df1d7c6ec5148ef237e9a5ffa8e2b064e984a397e3799bf44f8f2c3117eaaa5a';
  let bytes: Buffer;
  try { bytes = await readFile(path); }
  catch (cause) { throw new Error(`blocked_input: required original ${relative} cannot be read at ${path}; SHIPYARD_TEST_DATA_ROOT must contain projects/`, { cause }); }
  const actualSha = createHash('sha256').update(bytes).digest('hex');
  if (actualSha !== expectedSha) throw new Error(`blocked_input: ${relative} SHA256 ${actualSha} differs from frozen ${expectedSha}; do not substitute another map`);
  expect(bytes.length).toBe(4569645);
  const map = JSON.parse(bytes.toString('utf8')) as YardMap;
  expect(Object.keys(map.facilities)).toHaveLength(113); expect(originalSlotCount(map)).toBe(1108);
  const ids = Object.keys(map.facilities).sort().slice(0, 12);
  await ready(page); await page.getByTestId('json-file-input').setInputFiles(path); await imported(page, map);
  await page.getByRole('button', { name: '适应地图', exact: true }).click();
  const hash = await page.getByTestId('map-hash').textContent();
  const observations: { selected: number; cards: number; labels: number; budget: number }[] = [];
  for (const [index, id] of ids.entries()) {
    const row = page.getByTestId('facilities-item-' + id);
    await row.click({ modifiers: index ? ['Shift'] : [] });
    await expect(row).toHaveClass(/selected/);
    await expect(page.locator('.canvas-status')).toContainText(`${index + 1} 个选中 · 0 个撤销事务`);
    const box = await page.getByTestId('map-canvas').locator('canvas').first().boundingBox();
    if (!box) throw new Error('Canvas is not visible.');
    const budget = Math.max(1, Math.min(200, Math.round(box.width * box.height / 800000 * 80)));
    await expect.poll(() => page.getByTestId('focus-details').count()).toBeLessThanOrEqual(1);
    const labels = Number(await page.getByTestId('display-state').getAttribute('data-labels'));
    expect(labels).toBeGreaterThan(0); expect(labels).toBeLessThanOrEqual(budget);
    await expect(page.getByTestId('map-hash')).toHaveText(hash!);
    observations.push({ selected: index + 1, cards: await page.getByTestId('focus-details').count(), labels, budget });
  }
  for (const id of ids) await expect(page.getByTestId('facilities-item-' + id)).toHaveClass(/selected/);
  await expect(page.getByText('已选择 12 个对象', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: '撤销', exact: true })).toBeDisabled();
  expect(await download(page, info, 'DP1-A05-SHI-v03-multiselect-unchanged.map.json')).toEqual(map);
  expect(createHash('sha256').update(await readFile(path)).digest('hex')).toBe(expectedSha);
  const evidencePath = info.outputPath('DP1-A05-frozen-SHI-multiselect.json');
  await writeFile(evidencePath, JSON.stringify({ input: relative, sha256: expectedSha, ids, observations }, null, 2));
  await info.attach('DP1-A05-frozen-SHI-multiselect', { path: evidencePath, contentType: 'application/json' });
});

test('DP A12 frozen SR03 A LOD slot has no ghost hit and remains selectable after directory locate', async ({ page }, info) => {
  test.setTimeout(90000);
  const target = P1_TARGETS.find(item => item.id === 'SR03_A')!;
  const { map } = await readP1Target(target);
  const declared = (map.facilities.F_001!.extensions?.['sr02.planning'] as { slots: { id: string; boundary: Polygon }[] }).slots.find(slot => slot.id === 'SLOT_001_001')!;
  expect(declared).toBeDefined();
  const slot = { id: 'facilities:F_001:' + declared.id };
  const bounds = geometryBounds(declared.boundary.outer)!;
  const center: Vec3 = [(bounds.min[0] + bounds.max[0]) / 2, (bounds.min[1] + bounds.max[1]) / 2, bounds.min[2]];
  expect(center).toEqual([61, 214, 0]);
  const shortM = Math.min(bounds.max[0] - bounds.min[0], bounds.max[1] - bounds.min[1]);
  expect(shortM).toBe(10);
  await ready(page); await page.getByTestId('json-file-input').setInputFiles(target.absolutePath); await imported(page, map);
  const hash = await page.getByTestId('map-hash').textContent();
  await page.getByRole('button', { name: '定位 F_001', exact: true }).click();
  await page.getByTestId('map-canvas').focus(); await page.keyboard.press('Escape');
  // Actual wheel navigation retains the same slot center on screen and changes no layers or map data.
  for (let i = 0; i < 24; i++) {
    const point = await screen(page, center);
    if (point.scale >= 0.7 && point.scale < 0.95) break;
    const delta = point.scale >= 0.95 ? 120 : -120;
    await page.mouse.move(point.x, point.y); await page.mouse.wheel(0, delta);
    await expect.poll(async () => Number(await page.getByTestId('camera-state').getAttribute('data-scale')))
      .toBeCloseTo(point.scale * (delta > 0 ? 1 / 1.15 : 1.15), 8);
  }
  await expect(page.getByTestId('display-state')).toHaveAttribute('data-navigating', 'false');
  const low = await screen(page, center);
  expect(low.scale).toBeGreaterThanOrEqual(0.7); expect(low.scale).toBeLessThan(0.95);
  expect(shortM * low.scale).toBeLessThan(10);
  expect(Number(await page.getByTestId('display-state').getAttribute('data-lod'))).toBeGreaterThan(0);
  await page.mouse.click(low.x, low.y);
  await expect(page.getByLabel('稳定 ID', { exact: true })).toHaveValue('F_001');
  await expect(page.getByTestId('object-inspector')).toHaveCount(0); // A mounted transparent slot hit would select its inspector instead.
  await page.getByTestId('object-search').fill(slot.id);
  await expect(page.getByTestId('inspect-item-slots-' + slot.id)).toBeVisible();
  await page.getByRole('button', { name: '定位 ' + slot.id, exact: true }).click();
  await expect(page.getByTestId('focus-details').locator('code')).toHaveText(slot.id);
  const located = await screen(page, center);
  expect(shortM * located.scale).toBeGreaterThan(10);
  await expect.poll(() => selectedOutlinePixels(page)).toBeGreaterThan(10);
  await page.mouse.click(located.x, located.y);
  await expect(page.getByTestId('object-inspector').locator('code')).toHaveText(slot.id);
  await expect(page.getByTestId('map-hash')).toHaveText(hash!);
  await expect(page.getByRole('button', { name: '撤销', exact: true })).toBeDisabled();
  expect(await download(page, info, 'DP1-A12-SR03-A-LOD-slot-unchanged.map.json')).toEqual(map);
  await readP1Target(target);
  const evidencePath = info.outputPath('DP1-A12-frozen-slot-lod-pick.json');
  await writeFile(evidencePath, JSON.stringify({ input: target.path, sha256: target.sha256, slot: slot.id, center, shortM, low, located }, null, 2));
  await info.attach('DP1-A12-frozen-slot-lod-pick', { path: evidencePath, contentType: 'application/json' });
});
