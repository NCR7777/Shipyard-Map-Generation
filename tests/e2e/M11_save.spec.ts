import { test, expect, type Page, type BrowserContext } from '@playwright/test';

// These tests use the real browser IndexedDB adapter and real pointer/keyboard edits.
// S03/S04/S05 deliberately inject timing/storage faults at native API boundaries;
// they do not assert that the machine actually ran out of disk space.
async function ready(page: Page) {
  await page.goto('/');
  await expect(page.getByRole('button', { name: '保存工程', exact: true })).toBeEnabled();
  await expect(page.getByTestId('map-canvas')).toBeVisible();
}
async function saved(page: Page) {
  await expect(page.getByTestId('browser-save-status')).toContainText('已保存');
}
async function clickWorld(page: Page, x: number, y: number) {
  const canvas = await page.getByTestId('map-canvas').locator('canvas').first().boundingBox();
  expect(canvas).not.toBeNull();
  const camera = page.getByTestId('camera-state');
  const ox = Number(await camera.getAttribute('data-offset-x'));
  const oy = Number(await camera.getAttribute('data-offset-y'));
  const scale = Number(await camera.getAttribute('data-scale'));
  await page.mouse.click(canvas!.x + ox + x * scale, canvas!.y + oy - y * scale);
}
async function addNode(page: Page, x = 20, y = 30) {
  await page.getByRole('button', { name: '节点', exact: true }).click();
  await clickWorld(page, x, y);
  return page.getByLabel('稳定 ID', { exact: true }).inputValue();
}
async function renameMap(page: Page, name: string) {
  await page.getByLabel('地图名称', { exact: true }).fill(name);
  await page.getByRole('button', { name: '应用地图名称', exact: true }).click();
}
async function selectNode(page: Page, id: string) {
  await page.getByTestId('node-item-' + id).click();
}
async function editX(page: Page, value: string) {
  await page.getByLabel('X (m)', { exact: true }).fill(value);
  await page.getByRole('button', { name: '应用属性', exact: true }).click();
}
async function recent(page: Page, name: string) {
  await page.getByRole('button', { name: '最近项目', exact: true }).click();
  const modal = page.getByRole('dialog', { name: '最近项目', exact: true });
  await modal.getByRole('button').filter({ has: page.getByText(name, { exact: true }) }).click();
  await expect(modal).not.toBeVisible();
}
async function secondPage(context: BrowserContext) {
  const page = await context.newPage();
  await ready(page);
  return page;
}

test('S01 real auto-draft survives refresh and closing/reopening a page without a download', async ({ page, context }) => {
  let downloads = 0;
  page.on('download', () => { downloads++; });
  await ready(page);
  const id = await addNode(page);
  await renameMap(page, 'S01 自动保存恢复');
  const hash = await page.getByTestId('map-hash').textContent();
  await saved(page);
  await page.reload();
  await expect(page.getByTestId('node-count')).toHaveText('1');
  await expect(page.getByTestId('map-hash')).toHaveText(hash!);
  await selectNode(page, id);
  await expect(page.getByLabel('X (m)', { exact: true })).toHaveValue('20');
  await expect(page.getByLabel('Y (m)', { exact: true })).toHaveValue('30');
  await page.close();
  const reopened = await secondPage(context);
  await expect(reopened.getByTestId('map-hash')).toHaveText(hash!);
  await expect(reopened.getByTestId('node-count')).toHaveText('1');
  expect(downloads).toBe(0);
});

test('S02 two named browser projects retain independent IDs, maps and subsequent edits', async ({ page, context }) => {
  await ready(page);
  const firstId = await addNode(page, 10, 10);
  await renameMap(page, 'S02 工程甲');
  await saved(page);
  const firstHash = await page.getByTestId('map-hash').textContent();
  await page.getByRole('button', { name: '新建地图', exact: true }).click();
  const modal = page.getByRole('dialog', { name: '新建地图', exact: true });
  await modal.getByLabel('新地图名称', { exact: true }).fill('S02 工程乙');
  await modal.getByRole('button', { name: '创建地图', exact: true }).click();
  await expect(page.getByTestId('node-count')).toHaveText('0');
  const secondId = await addNode(page, 40, 30);
  expect(secondId).not.toBe(firstId);
  await saved(page);
  await recent(page, 'S02 工程甲');
  await expect(page.getByTestId('map-hash')).toHaveText(firstHash!);
  await selectNode(page, firstId);
  await editX(page, '25');
  await saved(page);
  const changedFirstHash = await page.getByTestId('map-hash').textContent();
  await recent(page, 'S02 工程乙');
  await selectNode(page, secondId);
  await expect(page.getByLabel('X (m)', { exact: true })).toHaveValue('40');
  await expect(page.getByTestId('node-count')).toHaveText('1');
  await recent(page, 'S02 工程甲');
  await expect(page.getByTestId('map-hash')).toHaveText(changedFirstHash!);
  const other = await secondPage(context);
  await recent(other, 'S02 工程乙');
  await selectNode(other, secondId);
  await page.reload();
  await expect(page.getByTestId('map-hash')).toHaveText(changedFirstHash!);
  await selectNode(page, firstId);
  await expect(page.getByLabel('X (m)', { exact: true })).toHaveValue('25');
  await expect(other.getByLabel('X (m)', { exact: true })).toHaveValue('40');
  await expect(page.getByTestId('local-save-status')).toContainText('未关联');
});

test('S03 delayed database restore never starts an empty-map write', async ({ page }) => {
  await ready(page);
  await addNode(page);
  await saved(page);
  const hash = await page.getByTestId('map-hash').textContent();
  await page.addInitScript(() => {
    const state = { writes: 0, restoreReleased: false };
    Object.assign(window, { m11RecoveryTest: state });
    const transaction = IDBDatabase.prototype.transaction;
    IDBDatabase.prototype.transaction = function (...args: Parameters<IDBDatabase['transaction']>) {
      if (args[1] === 'readwrite') state.writes++;
      return transaction.apply(this, args);
    };
    const success = Object.getOwnPropertyDescriptor(IDBRequest.prototype, 'onsuccess')!;
    Object.defineProperty(IDBRequest.prototype, 'onsuccess', {
      ...success,
      set(callback: ((event: Event) => void) | null) {
        if (!(this instanceof IDBOpenDBRequest) || !callback) { success.set!.call(this, callback); return; }
        success.set!.call(this, (event: Event) => { setTimeout(() => { state.restoreReleased = true; callback.call(this, event); }, 1500); });
      },
    });
  });
  await page.reload();
  await expect.poll(() => page.evaluate(() => (window as unknown as { m11RecoveryTest: { restoreReleased: boolean } }).m11RecoveryTest.restoreReleased)).toBe(false);
  await expect(page.getByRole('button', { name: '保存工程', exact: true })).toBeDisabled();
  expect(await page.evaluate(() => (window as unknown as { m11RecoveryTest: { writes: number } }).m11RecoveryTest.writes)).toBe(0);
  await expect(page.getByTestId('map-hash')).toHaveText(hash!);
  await expect(page.getByTestId('node-count')).toHaveText('1');
  await saved(page);
});

test('S04 an earlier real IDB commit acknowledgement cannot mark a newer edit saved (completion-delay fault injection)', async ({ page }) => {
  await ready(page);
  const id = await addNode(page);
  await saved(page);
  await page.evaluate(() => {
    const state = { pending: [] as (() => void)[], enabled: true };
    Object.assign(window, { m11CommitTest: state });
    const complete = Object.getOwnPropertyDescriptor(IDBTransaction.prototype, 'oncomplete')!;
    Object.defineProperty(IDBTransaction.prototype, 'oncomplete', {
      ...complete,
      set(callback: ((event: Event) => void) | null) {
        if (this.mode !== 'readwrite' || !this.objectStoreNames.contains('projects') || !callback) { complete.set!.call(this, callback); return; }
        complete.set!.call(this, (event: Event) => { if (state.enabled) state.pending.push(() => callback.call(this, event)); else callback.call(this, event); });
      },
    });
  });
  await selectNode(page, id);
  await editX(page, '40');
  await expect.poll(() => page.evaluate(() => (window as unknown as { m11CommitTest: { pending: unknown[] } }).m11CommitTest.pending.length)).toBeGreaterThan(0);
  await editX(page, '60');
  await page.evaluate(() => { (window as unknown as { m11CommitTest: { pending: (() => void)[] } }).m11CommitTest.pending.shift()!(); });
  await expect(page.getByTestId('browser-save-status')).not.toContainText('已保存');
  await expect(page.getByLabel('X (m)', { exact: true })).toHaveValue('60');
  await page.evaluate(() => { const s = (window as unknown as { m11CommitTest: { enabled: boolean; pending: (() => void)[] } }).m11CommitTest; s.enabled = false; s.pending.splice(0).forEach(callback => callback()); });
  await page.getByRole('button', { name: '保存工程', exact: true }).click();
  await saved(page);
  await page.reload();
  await selectNode(page, id);
  await expect(page.getByLabel('X (m)', { exact: true })).toHaveValue('60');
});

test('S05 simulated quota failure keeps the preceding durable map and does not report saved', async ({ page }) => {
  await ready(page);
  const id = await addNode(page);
  await saved(page);
  const durableHash = await page.getByTestId('map-hash').textContent();
  await page.evaluate(() => {
    IDBObjectStore.prototype.put = function () { throw new DOMException('S05 simulated quota exhaustion', 'QuotaExceededError'); };
  });
  await selectNode(page, id);
  await editX(page, '99');
  await page.getByRole('button', { name: '保存工程', exact: true }).click();
  await expect(page.getByTestId('browser-save-status')).toContainText('失败');
  await expect(page.getByTestId('browser-save-status')).not.toContainText('已保存');
  await expect(page.getByLabel('X (m)', { exact: true })).toHaveValue('99');
  page.on('dialog', dialog => dialog.accept());
  await page.reload();
  await expect(page.getByTestId('map-hash')).toHaveText(durableHash!);
  await selectNode(page, id);
  await expect(page.getByLabel('X (m)', { exact: true })).toHaveValue('20');
});

test('S06 two real pages detect a stale storage version and preserve the losing edits as a recovery copy', async ({ page, context }) => {
  await ready(page);
  const id = await addNode(page);
  await renameMap(page, 'S06 并发工程');
  await saved(page);
  const other = await secondPage(context);
  await selectNode(page, id);
  await selectNode(other, id);
  await editX(page, '80');
  await saved(page);
  await editX(other, '120');
  await other.getByRole('button', { name: '保存工程', exact: true }).click();
  await expect(other.getByTestId('browser-save-status')).toContainText('冲突');
  await expect(other.getByLabel('X (m)', { exact: true })).toHaveValue('120');
  await other.getByRole('button', { name: '保留当前恢复副本', exact: true }).click();
  await saved(other);
  await recent(page, 'S06 并发工程');
  await selectNode(page, id);
  await expect(page.getByLabel('X (m)', { exact: true })).toHaveValue('80');
  await other.reload();
  await selectNode(other, id);
  await expect(other.getByLabel('X (m)', { exact: true })).toHaveValue('120');
});

test('S08 S10 save shortcut inside an unapplied field is explicit and leaves native text undo/delete intact', async ({ page }) => {
  await ready(page);
  const id = await addNode(page);
  await saved(page);
  await selectNode(page, id);
  const hash = await page.getByTestId('map-hash').textContent();
  const name = page.getByLabel('名称', { exact: true });
  const oldName = await name.inputValue();
  await name.focus();
  await name.press('End');
  await name.pressSequentially(' pending');
  await expect(page.getByTestId('unapplied-inputs')).toBeVisible();
  await name.press('Control+s');
  const modal = page.getByRole('dialog', { name: '有未应用输入', exact: true });
  await expect(modal).toBeVisible();
  await expect(modal.getByRole('button', { name: '返回应用属性', exact: true })).toBeFocused();
  await page.keyboard.press('Control+z');
  await page.keyboard.press('Delete');
  await expect(page.getByTestId('map-hash')).toHaveText(hash!);
  await expect(page.getByTestId('node-count')).toHaveText('1');
  await expect(name).toHaveValue(oldName + ' pending');
  await modal.getByRole('button', { name: '仅保存已提交地图', exact: true }).click();
  await saved(page);
  await expect(name).toHaveValue(oldName + ' pending');
  await expect(page.getByTestId('unapplied-inputs')).toBeVisible();
  await expect(page.getByTestId('map-hash')).toHaveText(hash!);
  await name.focus();
  await name.press('Control+z');
  await expect(page.getByTestId('map-hash')).toHaveText(hash!);
  await name.press('Control+a');
  await name.press('Delete');
  await expect(page.getByTestId('node-count')).toHaveText('1');
  await expect(page.getByTestId('map-hash')).toHaveText(hash!);
});

test('S09 exporting is a download notification and cannot acknowledge browser or local-file saves', async ({ page }) => {
  await ready(page);
  const id = await addNode(page);
  await saved(page);
  await page.evaluate(() => {
    IDBObjectStore.prototype.put = function () { throw new DOMException('S09 controlled storage failure', 'QuotaExceededError'); };
  });
  await selectNode(page, id);
  await editX(page, '42');
  await page.getByRole('button', { name: '保存工程', exact: true }).click();
  await expect(page.getByTestId('browser-save-status')).toContainText('失败');
  const before = await page.getByTestId('browser-save-status').textContent();
  const localBefore = await page.getByTestId('local-save-status').textContent();
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出 JSON', exact: true }).click();
  await pending;
  await expect(page.getByTestId('browser-save-status')).toHaveText(before!);
  await expect(page.getByTestId('local-save-status')).toHaveText(localBefore!);
  await expect(page.getByTestId('export-status')).toContainText('已发起 JSON 下载');
});

test('S04 navigation checkpoint delay blocks undo/delete until the old project has been safely retained', async ({ page }) => {
  await ready(page);
  const id = await addNode(page);
  await renameMap(page, 'S04 导航原工程');
  await selectNode(page, id);
  await editX(page, '40');
  await saved(page);
  const hash = await page.getByTestId('map-hash').textContent();
  await page.evaluate(() => {
    const state = { pending: [] as (() => void)[], enabled: true };
    Object.assign(window, { m11NavigationTest: state });
    const complete = Object.getOwnPropertyDescriptor(IDBTransaction.prototype, 'oncomplete')!;
    Object.defineProperty(IDBTransaction.prototype, 'oncomplete', {
      ...complete,
      set(callback: ((event: Event) => void) | null) {
        if (this.mode !== 'readwrite' || !this.objectStoreNames.contains('projects') || !callback) { complete.set!.call(this, callback); return; }
        complete.set!.call(this, (event: Event) => { if (state.enabled) state.pending.push(() => callback.call(this, event)); else callback.call(this, event); });
      },
    });
  });
  await page.getByRole('button', { name: '新建地图', exact: true }).click();
  const modal = page.getByRole('dialog', { name: '新建地图', exact: true });
  await modal.getByLabel('新地图名称', { exact: true }).fill('S04 导航新工程');
  await modal.getByRole('button', { name: '创建地图', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as { m11NavigationTest: { pending: unknown[] } }).m11NavigationTest.pending.length)).toBeGreaterThan(0);
  await expect(page.getByRole('button', { name: '撤销', exact: true })).toBeDisabled();
  await expect(page.getByRole('button', { name: '删除', exact: true })).toBeDisabled();
  await page.keyboard.press('Control+z');
  await page.keyboard.press('Delete');
  await expect(page.getByTestId('map-hash')).toHaveText(hash!);
  await page.evaluate(() => { const s = (window as unknown as { m11NavigationTest: { enabled: boolean; pending: (() => void)[] } }).m11NavigationTest; s.enabled = false; s.pending.splice(0).forEach(callback => callback()); });
  await expect(page.getByTestId('node-count')).toHaveText('0');
  await saved(page);
  await recent(page, 'S04 导航原工程');
  await selectNode(page, id);
  await expect(page.getByLabel('X (m)', { exact: true })).toHaveValue('40');
  await expect(page.getByTestId('map-hash')).toHaveText(hash!);
});
