import { readFile } from 'node:fs/promises';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import type { YardMap } from '../../src/domain/model';
import { editorFixture } from '../helpers/M1_fixtures';
import { testFacility, rectangle } from '../helpers/M2A_fixtures';

type Camera = { offsetX: number; offsetY: number; scale: number };
type Wheel = { x: number; y: number; deltaY: number };
function fixture(): YardMap {
  const map = editorFixture();
  map.metadata.name = 'DP1 synthetic input-order and display regression';
  map.nodes.nA!.position = [35, 50, 0]; map.nodes.nA!.kind = 'junction';
  map.nodes.nB!.position = [150, 50, 0]; map.nodes.nB!.kind = 'junction';
  map.facilities.fA = testFacility('完整名称保持不变的 synthetic 厂房', rectangle(50, 80, 50, 30));
  return map;
}
async function ready(page: Page) {
  await page.goto('/');
  await expect(page.getByRole('button', { name: '保存工程', exact: true })).toBeEnabled();
  await expect(page.getByTestId('browser-save-status')).toContainText('已保存');
  const map = fixture();
  await page.getByTestId('json-file-input').setInputFiles({ name: 'DP1_synthetic.map.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(map)) });
  const conflict = page.getByRole('dialog', { name: '未保存编辑冲突', exact: true });
  await expect.poll(async () => await conflict.isVisible() || await page.getByLabel('地图名称', { exact: true }).inputValue() === map.metadata.name).toBe(true);
  if (await conflict.isVisible()) await conflict.getByRole('button', { name: '放弃编辑并重载', exact: true }).click();
  await expect(page.getByLabel('地图名称', { exact: true })).toHaveValue(map.metadata.name);
  await expect(page.getByTestId('browser-save-status')).toContainText('已保存');
  return map;
}
async function camera(page: Page): Promise<Camera> {
  return page.getByTestId('camera-state').evaluate(element => ({ offsetX: Number(element.getAttribute('data-offset-x')), offsetY: Number(element.getAttribute('data-offset-y')), scale: Number(element.getAttribute('data-scale')) }));
}
async function screen(page: Page, point: readonly number[]) {
  const bounds = await page.getByTestId('map-canvas').locator('canvas').first().boundingBox();
  if (!bounds) throw new Error('Canvas is unavailable.');
  const current = await camera(page);
  return { x: bounds.x + current.offsetX + point[0]! * current.scale, y: bounds.y + current.offsetY - point[1]! * current.scale };
}
function expectedCamera(start: Camera, events: Wheel[]): Camera {
  return events.reduce((current, event) => {
    const scale = Math.min(100, Math.max(Number.MIN_VALUE, current.scale * (event.deltaY < 0 ? 1.15 : 1 / 1.15)));
    const ratio = scale / current.scale;
    return { scale, offsetX: event.x - (event.x - current.offsetX) * ratio, offsetY: event.y - (event.y - current.offsetY) * ratio };
  }, start);
}
async function expectCamera(page: Page, expected: Camera) {
  await expect.poll(async () => {
    const actual = await camera(page);
    return Math.max(Math.abs(actual.offsetX - expected.offsetX), Math.abs(actual.offsetY - expected.offsetY), Math.abs(actual.scale - expected.scale));
  }).toBeLessThan(1e-8);
}
async function burst(page: Page, events: Wheel[], immediateClick?: { x: number; y: number }) {
  // One DOM event task intentionally prevents RAF between inputs. This is not app-state injection
  // or a physical-frame claim; separate cases below exercise native Playwright mouse input.
  await page.getByTestId('map-canvas').evaluate((element, input) => {
    const canvas = element.querySelector('canvas')!;
    const bounds = canvas.getBoundingClientRect();
    for (const wheel of input.events) canvas.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, clientX: bounds.x + wheel.x, clientY: bounds.y + wheel.y, deltaY: wheel.deltaY }));
    if (input.immediateClick) {
      const init = { bubbles: true, cancelable: true, clientX: bounds.x + input.immediateClick.x, clientY: bounds.y + input.immediateClick.y, button: 0 };
      canvas.dispatchEvent(new PointerEvent('pointerdown', { ...init, buttons: 1, pointerType: 'mouse', isPrimary: true, pointerId: 17 }));
      canvas.dispatchEvent(new MouseEvent('mousedown', { ...init, buttons: 1 }));
      canvas.dispatchEvent(new PointerEvent('pointerup', { ...init, buttons: 0, pointerType: 'mouse', isPrimary: true, pointerId: 17 }));
      canvas.dispatchEvent(new MouseEvent('mouseup', { ...init, buttons: 0 }));
    }
  }, { events, immediateClick });
}
async function downloaded(page: Page, info: TestInfo, name: string): Promise<YardMap> {
  const event = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出 JSON', exact: true }).click();
  const path = info.outputPath(name); await (await event).saveAs(path);
  return JSON.parse(await readFile(path, 'utf8')) as YardMap;
}
async function layers(page: Page) {
  const summary = page.getByText('基础图层与标签', { exact: true });
  if (await summary.locator('..').getAttribute('open') === null) await summary.click();
}

test('DP07 same-task wheel increments and different anchors agree with sequential camera arithmetic', async ({ page }) => {
  await ready(page);
  const before = await camera(page), events = [
    { x: 100, y: 100, deltaY: -1 }, { x: 180, y: 150, deltaY: -1 },
    { x: 260, y: 230, deltaY: 1 }, { x: 150, y: 180, deltaY: -1 }, { x: 210, y: 110, deltaY: 1 },
  ];
  await burst(page, events); await expectCamera(page, expectedCamera(before, events));
  await expect(page.getByTestId('display-state')).toHaveAttribute('data-navigating', 'false');
});

test('DP08 wheel followed immediately by pointer down/up hits the newly projected node', async ({ page }) => {
  const map = await ready(page), before = await camera(page);
  const events = [{ x: 50, y: 60, deltaY: -1 }, { x: 70, y: 90, deltaY: -1 }, { x: 100, y: 110, deltaY: -1 }];
  const after = expectedCamera(before, events), target = map.nodes.nA!.position;
  await burst(page, events, { x: after.offsetX + target[0] * after.scale, y: after.offsetY - target[1] * after.scale });
  await expect(page.getByLabel('稳定 ID', { exact: true })).toHaveValue('nA');
  await expectCamera(page, after);
  await expect(page.getByRole('button', { name: '撤销', exact: true })).toBeDisabled();
});

test('DP08 DP10 native down-before-drag freezes wheel and commits one node movement', async ({ page }, info) => {
  const map = await ready(page), point = await screen(page, map.nodes.nA!.position), beforeCamera = await camera(page);
  await page.mouse.move(point.x, point.y); await page.mouse.down();
  // Drag threshold has not been crossed: this is the ready-drag race, not only active drag.
  await page.mouse.wheel(0, -300);
  await expectCamera(page, beforeCamera);
  await page.mouse.move(point.x + 40, point.y - 20, { steps: 12 }); await page.mouse.up();
  const changed = await downloaded(page, info, 'DP1-one-node-drag.map.json');
  expect(changed.revision).toBe(map.revision + 1);
  expect(changed.nodes.nA!.position[0]).toBeCloseTo(map.nodes.nA!.position[0] + 40 / beforeCamera.scale, 6);
  expect(changed.nodes.nA!.position[1]).toBeCloseTo(map.nodes.nA!.position[1] + 20 / beforeCamera.scale, 6);
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  expect(await downloaded(page, info, 'DP1-drag-undone.map.json')).toEqual(map);
  await expect(page.getByRole('button', { name: '撤销', exact: true })).toBeDisabled();
});

test('DP09 native pan stops at release and Escape invalidates pending navigation', async ({ page }, info) => {
  const map = await ready(page), bounds = await page.getByTestId('map-canvas').locator('canvas').first().boundingBox();
  if (!bounds) throw new Error('Canvas is unavailable.');
  await page.mouse.move(bounds.x + 200, bounds.y + 200); await page.mouse.down({ button: 'middle' });
  await page.mouse.move(bounds.x + 250, bounds.y + 225, { steps: 10 }); await page.mouse.up({ button: 'middle' });
  const stopped = await camera(page);
  await page.mouse.move(bounds.x + 300, bounds.y + 280, { steps: 10 });
  await expectCamera(page, stopped);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('display-state')).toHaveAttribute('data-navigating', 'false');
  expect(await downloaded(page, info, 'DP1-pan-map-unchanged.map.json')).toEqual(map);
});

test('DP12 DP17 DP18 label modes, layer hiding and locking preserve the map and meaningful selection', async ({ page }, info) => {
  const map = await ready(page), beforeHash = await page.getByTestId('map-hash').textContent();
  await layers(page);
  for (const mode of ['focus', 'off', 'debug_all', 'auto']) {
    await page.getByLabel('标签模式', { exact: true }).selectOption(mode);
    if (mode === 'off') await expect(page.getByTestId('display-state')).toHaveAttribute('data-labels', '0');
    await expect(page.getByTestId('map-hash')).toHaveText(beforeHash!);
  }
  await page.getByTestId('layer-visible-facilities').uncheck();
  await page.getByTestId('object-search').fill('fA');
  await expect(page.getByTestId('facilities-item-fA')).toContainText('隐藏');
  await page.getByRole('button', { name: '定位 fA', exact: true }).click();
  await expect(page.getByTestId('layer-visible-facilities')).not.toBeChecked();
  await page.getByTestId('layer-visible-facilities').check();
  await page.getByTestId('layer-locked-facilities').check();
  await page.getByTestId('facilities-item-fA').click();
  const from = await screen(page, [75, 95]);
  await page.mouse.move(from.x, from.y); await page.mouse.down();
  await page.mouse.move(from.x + 35, from.y + 25, { steps: 12 }); await page.mouse.up();
  await expect(page.getByTestId('map-hash')).toHaveText(beforeHash!);
  await expect(page.getByRole('button', { name: '撤销', exact: true })).toBeDisabled();
  expect(await downloaded(page, info, 'DP1-display-and-lock-unchanged.map.json')).toEqual(map);
});


test('DP08 immediate drawing after accumulated zoom uses effective metric coordinates', async ({ page }, info) => {
  const original = await ready(page);
  await page.getByRole('button', { name: '节点', exact: true }).click();
  const before = await camera(page), events = [{ x: 300, y: 230, deltaY: -1 }, { x: 220, y: 180, deltaY: 1 }, { x: 260, y: 200, deltaY: -1 }];
  const after = expectedCamera(before, events), click = { x: 380, y: 270 };
  await burst(page, events, click);
  const changed = await downloaded(page, info, 'DP1-immediate-drawing.map.json');
  const added = Object.keys(changed.nodes).filter(id => !original.nodes[id]);
  expect(added).toHaveLength(1);
  const value = changed.nodes[added[0]!]!.position;
  expect(value[0]).toBeCloseTo((click.x - after.offsetX) / after.scale, 8);
  expect(value[1]).toBeCloseTo((after.offsetY - click.y) / after.scale, 8);
  expect(changed.revision).toBe(original.revision + 1);
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  expect(await downloaded(page, info, 'DP1-immediate-drawing-undone.map.json')).toEqual(original);
});

test('DP16 label mode leaves unapplied numeric edits and polygon drafts intact', async ({ page }) => {
  await ready(page);
  await page.getByTestId('node-item-nA').click();
  await page.getByLabel('X (m)', { exact: true }).fill('52.75');
  await layers(page); await page.getByTestId('label-mode').selectOption('focus');
  await expect(page.getByRole('dialog', { name: '未应用输入保护', exact: true })).not.toBeVisible();
  await expect(page.getByLabel('X (m)', { exact: true })).toHaveValue('52.75');
  await page.getByRole('button', { name: '应用属性', exact: true }).click();
  await page.getByRole('button', { name: '多边形设施', exact: true }).click();
  const point = await screen(page, [25, 25]); await page.mouse.click(point.x, point.y);
  await expect(page.getByText('1 个顶点 · Enter 完成', { exact: true })).toBeVisible();
  await page.getByTestId('label-mode').selectOption('off');
  await expect(page.getByText('1 个顶点 · Enter 完成', { exact: true })).toBeVisible();
  await expect(page.getByRole('dialog', { name: '未应用输入保护', exact: true })).not.toBeVisible();
});


test('DP07 middle pan and wheel compose without restoring the stale drag-start camera', async ({ page }) => {
  await ready(page);
  const start = await camera(page), bounds = await page.getByTestId('map-canvas').locator('canvas').first().boundingBox();
  if (!bounds) throw new Error('Canvas is unavailable.');
  await page.mouse.move(bounds.x + 200, bounds.y + 200); await page.mouse.down({ button: 'middle' });
  await page.mouse.move(bounds.x + 210, bounds.y + 210);
  const shifted = { ...start, offsetX: start.offsetX + 10, offsetY: start.offsetY + 10 };
  await expectCamera(page, shifted);
  await page.mouse.wheel(0, -120);
  const zoomed = expectedCamera(shifted, [{ x: 210, y: 210, deltaY: -120 }]);
  await expectCamera(page, zoomed);
  await page.mouse.move(bounds.x + 220, bounds.y + 220);
  const shiftedAgain = { ...zoomed, offsetX: zoomed.offsetX + 10, offsetY: zoomed.offsetY + 10 };
  await expectCamera(page, shiftedAgain);
  await page.mouse.wheel(0, 120);
  await expectCamera(page, expectedCamera(shiftedAgain, [{ x: 220, y: 220, deltaY: 120 }]));
  await page.mouse.up({ button: 'middle' });
});


test('DP08 DP10 accumulated wheel then same-task rectangle handle drag uses the fresh camera once', async ({ page }, info) => {
  const original = await ready(page);
  await page.getByTestId('facilities-item-fA').click();
  await expect(page.getByTestId('boundary-handles')).toHaveAttribute('data-count', '4');
  const before = await camera(page), events = [{ x: 180, y: 180, deltaY: -1 }, { x: 220, y: 160, deltaY: -1 }];
  const after = expectedCamera(before, events), corner = original.facilities.fA!.boundary.outer[0];
  const start = { x: after.offsetX + corner[0] * after.scale, y: after.offsetY - corner[1] * after.scale };
  const displacement = { x: -30, y: 20 };
  // DOM events in one JS task exercise capture -> hit refresh -> handle drag without a settling RAF.
  // The pointer event coordinates are returned as delivered, including browser numeric precision.
  const actual = await page.getByTestId('map-canvas').evaluate((element, input) => {
    const canvas = element.querySelector('canvas')!, bounds = canvas.getBoundingClientRect();
    for (const wheel of input.events) canvas.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true,
      clientX: bounds.x + wheel.x, clientY: bounds.y + wheel.y, deltaY: wheel.deltaY }));
    const init = { bubbles: true, cancelable: true, button: 0, pointerType: 'mouse', isPrimary: true, pointerId: 29 };
    const down = new PointerEvent('pointerdown', { ...init, buttons: 1, clientX: bounds.x + input.start.x, clientY: bounds.y + input.start.y });
    const move = new PointerEvent('pointermove', { ...init, buttons: 1, clientX: down.clientX + input.displacement.x, clientY: down.clientY + input.displacement.y });
    canvas.dispatchEvent(down);
    canvas.dispatchEvent(new MouseEvent('mousedown', { ...init, buttons: 1, clientX: down.clientX, clientY: down.clientY }));
    canvas.dispatchEvent(move);
    canvas.dispatchEvent(new MouseEvent('mousemove', { ...init, buttons: 1, clientX: move.clientX, clientY: move.clientY }));
    canvas.dispatchEvent(new PointerEvent('pointerup', { ...init, buttons: 0, clientX: move.clientX, clientY: move.clientY }));
    canvas.dispatchEvent(new MouseEvent('mouseup', { ...init, buttons: 0, clientX: move.clientX, clientY: move.clientY }));
    return { dx: (move.clientX - down.clientX) * canvas.clientWidth / bounds.width,
      dy: (move.clientY - down.clientY) * canvas.clientHeight / bounds.height };
  }, { events, start, displacement });
  await expectCamera(page, after);
  const changed = await downloaded(page, info, 'DP1-immediate-handle.map.json');
  const boundary = changed.facilities.fA!.boundary;
  expect(changed.revision).toBe(original.revision + 1);
  expect(boundary.outer[0][0]).toBeCloseTo(corner[0] + actual.dx / after.scale, 8);
  expect(boundary.outer[0][1]).toBeCloseTo(corner[1] - actual.dy / after.scale, 8);
  expect(boundary.outer[2]).toEqual(original.facilities.fA!.boundary.outer[2]);
  expect(boundary.outer[1][0]).toBe(boundary.outer[2][0]);
  expect(boundary.outer[1][1]).toBe(boundary.outer[0][1]);
  expect(boundary.outer[3][0]).toBe(boundary.outer[0][0]);
  expect(boundary.outer[3][1]).toBe(boundary.outer[2][1]);
  expect(changed.nodes).toEqual(original.nodes); expect(changed.roads).toEqual(original.roads);
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  expect(await downloaded(page, info, 'DP1-immediate-handle-undone.map.json')).toEqual(original);
  await expect(page.getByRole('button', { name: '撤销', exact: true })).toBeDisabled();
});

test('DP09 blur cancels a held middle-button pan before another move and keeps the map unchanged', async ({ page }, info) => {
  const original = await ready(page), bounds = await page.getByTestId('map-canvas').locator('canvas').first().boundingBox();
  if (!bounds) throw new Error('Canvas is unavailable.');
  await page.mouse.move(bounds.x + 200, bounds.y + 220);
  await page.mouse.down({ button: 'middle' });
  await page.mouse.move(bounds.x + 230, bounds.y + 245, { steps: 6 });
  // Synchronously deliver the lifecycle event, without mouseup masking a missing blur cleanup.
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await expect(page.getByTestId('display-state')).toHaveAttribute('data-navigating', 'false');
  const stopped = await camera(page);
  await page.mouse.move(bounds.x + 280, bounds.y + 285, { steps: 8 });
  await expectCamera(page, stopped);
  await page.mouse.up({ button: 'middle' });
  await expectCamera(page, stopped);
  await expect(page.getByRole('button', { name: '撤销', exact: true })).toBeDisabled();
  expect(await downloaded(page, info, 'DP1-blur-cancel-map-unchanged.map.json')).toEqual(original);
});
