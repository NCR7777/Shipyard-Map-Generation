import { expect, test, type Page } from '@playwright/test';

type Camera = { offsetX: number; offsetY: number; scale: number };
type Editor = { camera: Camera; drawing: Record<string, unknown> };
type Project = { draft: { mapJson: string }; checkpoint: { mapJson: string } | null };

async function saved(page: Page) { await expect(page.getByTestId('browser-save-status')).toHaveText('浏览器草稿已保存'); }
async function ready(page: Page) {
  await page.goto('/');
  await expect(page.getByRole('button', { name: '保存工程', exact: true })).toBeEnabled();
  await saved(page);
}
async function layers(page: Page) {
  const details = page.locator('details.layer-controls');
  if (!await details.evaluate(el => (el as HTMLDetailsElement).open)) await details.locator('summary').click();
}
async function camera(page: Page): Promise<Camera> {
  const output = page.getByTestId('camera-state');
  return { offsetX: Number(await output.getAttribute('data-offset-x')), offsetY: Number(await output.getAttribute('data-offset-y')), scale: Number(await output.getAttribute('data-scale')) };
}
// Native IDB fixtures are used only for legacy records; current edits/saves use the UI.
async function stored(page: Page, store: 'projects' | 'editorStates', replacement?: unknown): Promise<unknown> {
  return page.evaluate(({ store, replacement }) => new Promise((resolve, reject) => {
    const id = sessionStorage.getItem('shipyard.activeProjectId');
    if (!id) { reject(new Error('No restored project')); return; }
    const request = indexedDB.open('shipyard-map-projects', 1);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const transaction = db.transaction(store, replacement === undefined ? 'readonly' : 'readwrite');
      const result = replacement === undefined ? transaction.objectStore(store).get(id) : transaction.objectStore(store).put(replacement, id);
      transaction.oncomplete = () => { db.close(); resolve(result.result); };
      transaction.onabort = () => { db.close(); reject(transaction.error); };
    };
  }), { store, replacement });
}
async function editor(page: Page) { return await stored(page, 'editorStates') as Editor; }
async function mapJson(page: Page) { return (await stored(page, 'projects') as Project).draft.mapJson; }
async function save(page: Page) { await page.getByRole('button', { name: '保存工程', exact: true }).click(); await saved(page); }

test('DP1 S01 all four label modes persist without changing map JSON or camera', async ({ page }) => {
  await ready(page);
  const original = await mapJson(page); const originalCamera = await camera(page);
  for (const mode of ['off', 'focus', 'debug_all', 'auto']) {
    await layers(page); await page.getByTestId('label-mode').selectOption(mode); await save(page);
    expect((await editor(page)).drawing.labelMode).toBe(mode);
    expect((await editor(page)).drawing).not.toHaveProperty('showLabels');
    await page.reload(); await saved(page); await layers(page);
    await expect(page.getByTestId('label-mode')).toHaveValue(mode);
    expect(await camera(page)).toEqual(originalCamera); expect(await mapJson(page)).toBe(original);
  }
});

test('DP1 S02 real wheel inputs followed by Ctrl+S save the effective camera before the delayed native RAF', async ({ page }, info) => {
  await ready(page); const original = await mapJson(page); const before = await camera(page);
  const box = await page.getByTestId('map-canvas').locator('canvas').first().boundingBox();
  if (!box) throw new Error('Canvas is not visible.');
  // Fault injection delays the native scheduling boundary, not application state or commands.
  await page.evaluate(() => {
    const nativeRequest = window.requestAnimationFrame.bind(window);
    const nativeCancel = window.cancelAnimationFrame.bind(window);
    const nativeTimeout = window.setTimeout.bind(window);
    const delayedSettle = new Map<number, { handler: TimerHandler; args: unknown[] }>();
    const held = new Map<number, FrameRequestCallback>(); let id = 1_000_000;
    const probe = window as typeof window & { dp1WheelCount: number; dp1ReleaseFrames: () => void };
    probe.dp1WheelCount = 0;
    const count = () => { ++probe.dp1WheelCount; };
    document.querySelector('[data-testid="map-canvas"]')!.addEventListener('wheel', count, { capture: true });
    window.requestAnimationFrame = callback => { held.set(++id, callback); return id; };
    window.cancelAnimationFrame = value => { if (!held.delete(value)) nativeCancel(value); };
    window.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
      if (timeout !== 150) return nativeTimeout(handler, timeout, ...args);
      const timer = nativeTimeout(() => { delayedSettle.delete(timer); }, 60_000);
      delayedSettle.set(timer, { handler, args }); return timer;
    }) as typeof window.setTimeout;
    const nativeClearTimeout = window.clearTimeout.bind(window);
    window.clearTimeout = value => { if (typeof value === 'number') delayedSettle.delete(value); nativeClearTimeout(value); };
    probe.dp1ReleaseFrames = () => {
      window.requestAnimationFrame = nativeRequest; window.cancelAnimationFrame = nativeCancel;
      window.setTimeout = nativeTimeout; window.clearTimeout = nativeClearTimeout;
      document.querySelector('[data-testid="map-canvas"]')?.removeEventListener('wheel', count, { capture: true });
      for (const callback of held.values()) nativeRequest(callback); held.clear();
      for (const [timer, { handler, args }] of delayedSettle) { nativeClearTimeout(timer); nativeTimeout(handler, 0, ...args); }
      delayedSettle.clear();
    };
  });
  let expected = { ...before };
  try {
    for (const [index, input] of [
      { x: 220, y: 220, delta: -100 }, { x: 340, y: 280, delta: -100 }, { x: 260, y: 330, delta: 100 },
    ].entries()) {
      await page.mouse.move(box.x + input.x, box.y + input.y); await page.mouse.wheel(0, input.delta);
      await expect.poll(() => page.evaluate(() => (window as typeof window & { dp1WheelCount: number }).dp1WheelCount)).toBe(index + 1);
      const nextScale = expected.scale * (input.delta < 0 ? 1.15 : 1 / 1.15);
      const ratio = nextScale / expected.scale;
      expected = { scale: nextScale, offsetX: input.x - (input.x - expected.offsetX) * ratio, offsetY: input.y - (input.y - expected.offsetY) * ratio };
    }
    await page.keyboard.press('Control+s');
    await expect.poll(async () => (await editor(page)).camera.scale).toBeCloseTo(expected.scale, 10);
    const persisted = (await editor(page)).camera;
    expect(persisted.offsetX).toBeCloseTo(expected.offsetX, 8); expect(persisted.offsetY).toBeCloseTo(expected.offsetY, 8);
    expect(await mapJson(page)).toBe(original);
    await info.attach('pending-frame-effective-camera-save', { body: JSON.stringify({ before, expected, persisted, injection: 'native RAF and 150ms settle callback delayed; real wheel and Ctrl+S inputs' }), contentType: 'application/json' });
  } finally {
    await page.evaluate(() => (window as typeof window & { dp1ReleaseFrames: () => void }).dp1ReleaseFrames());
  }
  await saved(page); await page.reload(); await saved(page);
  const restored = await camera(page);
  expect(restored.scale).toBeCloseTo(expected.scale, 10); expect(restored.offsetX).toBeCloseTo(expected.offsetX, 8); expect(restored.offsetY).toBeCloseTo(expected.offsetY, 8);
  expect(await mapJson(page)).toBe(original);
});

test('DP1 S03 native legacy records migrate once with new-mode precedence and retain the camera', async ({ page }) => {
  await ready(page); const original = await mapJson(page);
  const legacyCamera = { offsetX: 110, offsetY: 420, scale: 3 };
  for (const fixture of [
    { drawing: undefined, mode: 'auto' },
    { drawing: { showLabels: false, snapGrid: 0, snapNodes: false }, mode: 'off' },
    { drawing: { showLabels: true }, mode: 'auto' },
    { drawing: { showLabels: false, labelMode: 'focus' }, mode: 'focus' },
  ]) {
    await stored(page, 'editorStates', { camera: legacyCamera, ...(fixture.drawing === undefined ? {} : { drawing: fixture.drawing }) });
    await page.reload(); await saved(page); await layers(page);
    await expect(page.getByTestId('label-mode')).toHaveValue(fixture.mode);
    expect(await camera(page)).toEqual(legacyCamera);
    // Explicit Save writes the normalized form; restore alone must not rewrite a source record.
    await save(page);
    const normalized = await editor(page);
    expect(normalized.drawing.labelMode).toBe(fixture.mode); expect(normalized.drawing).not.toHaveProperty('showLabels');
    expect(normalized.drawing.snapGrid).toBe(0); expect(normalized.drawing.snapNodes).toBe(false);
    expect(await mapJson(page)).toBe(original);
  }
});
