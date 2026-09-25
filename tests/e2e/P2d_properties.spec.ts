import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const example = fileURLToPath(new URL('../../examples/M2A1_synthetic_service_targets.map.json', import.meta.url));
/** The synthetic example plus a free building at 20–50 × 60–80 m. */
type MapJson = { facilities: Record<string, unknown>; roads: Record<string, Record<string, unknown>>; sources: Record<string, unknown>; metadata: Record<string, unknown>; extensionNamespaces: Record<string, unknown>; extensions: Record<string, unknown> };
function mapJson(change: (map: MapJson) => void = () => {}): string {
  const map = JSON.parse(readFileSync(example, 'utf8')) as MapJson;
  map.facilities.fFree = {
    name: '空置厂房', kind: 'workshop', boundary: { outer: [[20, 60, 0], [50, 60, 0], [50, 80, 0], [20, 80, 0], [20, 60, 0]], holes: [] },
    accessPointIds: [], servicePointIds: [], heightM: { state: 'unknown' }, provenance: { category: 'synthetic' },
  };
  change(map);
  return JSON.stringify(map);
}
async function open(page: Page, errors: string[], text = mapJson()) {
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await page.getByTestId('open-file-input').setInputFiles({ name: 'props.map.json', mimeType: 'application/json', buffer: Buffer.from(text) });
  await expect(page.getByTestId('map-canvas')).toHaveAttribute('data-scale', /\d/);
}
async function at(page: Page, x: number, y: number) {
  const canvas = page.getByTestId('map-canvas'), box = (await canvas.boundingBox())!;
  const [s, ox, oy] = await Promise.all(['data-scale', 'data-offset-x', 'data-offset-y'].map(async name => Number(await canvas.getAttribute(name))));
  return { x: box.x + ox! + x * s!, y: box.y + oy! - y * s! };
}
async function click(page: Page, x: number, y: number, keys: string[] = []) {
  const p = await at(page, x, y);
  for (const key of keys) await page.keyboard.down(key);
  await page.mouse.click(p.x, p.y);
  for (const key of keys) await page.keyboard.up(key);
}
const inspector = (page: Page) => page.getByRole('region', { name: '属性' });
const heading = (page: Page) => inspector(page).locator('.entity-heading');
const undoButton = (page: Page) => page.getByRole('toolbar', { name: '工具' }).getByRole('button', { name: '撤销' });
const raw = (page: Page) => inspector(page).locator('.raw-json pre');
/** The main road runs along y = 0 from x = 0 to 100; at x = 80 nothing else is there. */
const selectMainRoad = async (page: Page) => { await click(page, 80, 0); await expect(heading(page)).toContainText('100m'); };

test('road fields commit on Enter, one undo step each; units convert once; sources are recorded', async ({ page }) => {
  const errors: string[] = []; await open(page, errors);
  await selectMainRoad(page);
  const name = inspector(page).getByLabel('名称', { exact: true });
  await name.fill('主路 A'); await name.press('Enter');
  await expect(heading(page)).toContainText('主路 A');
  await expect(undoButton(page)).toHaveAttribute('title', /撤销：修改名称/);
  // Unknown width: choosing「已声明」opens the number, nothing is committed yet.
  await inspector(page).getByLabel('宽度状态').selectOption('known');
  await expect(undoButton(page)).toHaveAttribute('title', /撤销：修改名称/);
  const width = inspector(page).getByLabel('宽度', { exact: true });
  await width.fill('14'); await width.press('Enter');
  await expect(undoButton(page)).toHaveAttribute('title', /撤销：修改宽度/);
  await expect(inspector(page).getByLabel('宽度依据')).toContainText('道路参数设计假设');
  await expect(raw(page)).toContainText('"value": 14');
  // An invalid number stays for correction on Enter; Escape restores; nothing is committed.
  await width.fill('0'); await width.press('Enter');
  await expect(inspector(page).getByRole('alert')).toContainText('大于 0');
  await expect(width).toHaveAttribute('aria-invalid', 'true');
  await width.press('Escape');
  await expect(width).toHaveValue('14');
  // Leaving the field with an invalid number reports it and restores the value.
  await width.fill('-3'); await width.press('Tab');
  await expect(page.getByRole('alert').filter({ hasText: '已恢复原值' })).toBeVisible();
  await expect(width).toHaveValue('14');
  await expect(undoButton(page)).toHaveAttribute('title', /撤销：修改宽度/);
  // Mass typed in t is stored in kg; switching the display unit changes nothing in the map.
  await inspector(page).getByLabel('承载状态').selectOption('known');
  const mass = inspector(page).getByLabel('承载', { exact: true });
  await mass.fill('100.5'); await mass.press('Enter');
  await expect(raw(page)).toContainText('"value": 100500');
  await inspector(page).getByLabel('承载单位').selectOption('kg');
  await expect(mass).toHaveValue('100500');
  await expect(undoButton(page)).toHaveAttribute('title', /撤销：修改承载/);
  await inspector(page).getByLabel('限速状态').selectOption('known');
  const speed = inspector(page).getByLabel('限速', { exact: true });
  await speed.fill('36'); await speed.press('Enter');
  await expect(raw(page)).toContainText('"value": 10');
  // Clearing a known number makes it unknown on purpose.
  await width.fill(''); await width.press('Enter');
  await expect(inspector(page).getByLabel('宽度状态')).toHaveValue('unknown');
  await inspector(page).getByLabel('方向', { exact: true }).selectOption('forward');
  await expect(undoButton(page)).toHaveAttribute('title', /撤销：修改道路方向/);
  // Each field was its own step: undo the direction, the width, the speed, the mass, the width, the name.
  // (Shortcuts do not act inside fields and lists: the canvas takes the keys.)
  await page.getByTestId('map-canvas').focus();
  for (let i = 0; i < 6; i++) await page.keyboard.press('Control+z');
  await expect(undoButton(page)).toHaveAttribute('aria-disabled', 'true');
  await expect(heading(page)).toContainText('100m');
  expect(errors).toEqual([]);
});

test('Enter while an input method is composing neither commits nor cancels', async ({ page }) => {
  const errors: string[] = []; await open(page, errors);
  await selectMainRoad(page);
  const name = inspector(page).getByLabel('名称', { exact: true });
  await name.fill('主路');
  await name.dispatchEvent('keydown', { key: 'Enter', isComposing: true });
  await name.dispatchEvent('keydown', { key: 'Escape', isComposing: true });
  await expect(name).toHaveValue('主路');
  await expect(undoButton(page)).toHaveAttribute('aria-disabled', 'true');
  await name.press('Enter');
  await expect(undoButton(page)).toHaveAttribute('title', /撤销：修改名称/);
  // The physical fields too.
  await inspector(page).getByLabel('宽度状态').selectOption('known');
  const width = inspector(page).getByLabel('宽度', { exact: true });
  await width.fill('9');
  await width.dispatchEvent('keydown', { key: 'Enter', isComposing: true });
  await expect(undoButton(page)).toHaveAttribute('title', /撤销：修改名称/);
  await width.press('Enter');
  await expect(undoButton(page)).toHaveAttribute('title', /撤销：修改宽度/);
  expect(errors).toEqual([]);
});

test('Escape restores a field; after undo a committed field shows the map again and leaving it commits nothing', async ({ page }) => {
  const errors: string[] = []; await open(page, errors);
  await selectMainRoad(page);
  const name = inspector(page).getByLabel('名称', { exact: true });
  await name.fill('临时'); await name.press('Escape');
  await expect(name).toHaveValue('100m 合成主路');
  await expect(undoButton(page)).toHaveAttribute('aria-disabled', 'true');
  await name.fill('主路 B'); await name.press('Enter');
  await expect(undoButton(page)).toHaveAttribute('title', /撤销：修改名称/);
  // The toolbar button takes the focus from the field (nothing left to commit there), then undoes.
  await undoButton(page).click();
  await expect(name).toHaveValue('100m 合成主路');
  await name.focus(); await name.press('Tab');
  await expect(undoButton(page)).toHaveAttribute('aria-disabled', 'true');
  await expect(heading(page)).toContainText('100m 合成主路');
  expect(errors).toEqual([]);
});

test('the note on an unknown value survives opening「已声明」and going back, and can be edited', async ({ page }) => {
  const errors: string[] = []; await open(page, errors, mapJson(map => { map.roads.rMain!.widthM = { state: 'unknown', reason: '影像中路缘不可辨' }; }));
  await selectMainRoad(page);
  const note = inspector(page).getByLabel('宽度说明');
  await expect(note).toHaveValue('影像中路缘不可辨');
  await inspector(page).getByLabel('宽度状态').selectOption('known');
  await inspector(page).getByLabel('宽度状态').selectOption('unknown');
  await expect(undoButton(page)).toHaveAttribute('aria-disabled', 'true');
  await expect(note).toHaveValue('影像中路缘不可辨');
  // An edited note is trimmed (an untouched one never is).
  await note.fill('  被吊车遮挡  '); await note.press('Enter');
  await expect(undoButton(page)).toHaveAttribute('title', /撤销：修改宽度/);
  await expect(raw(page)).toContainText('"reason": "被吊车遮挡"');
  expect(errors).toEqual([]);
});

test('text typed but not committed is dropped when another map opens, never written into it', async ({ page }) => {
  const errors: string[] = []; await open(page, errors);
  const mapName = inspector(page).getByLabel('地图名称');
  await mapName.fill('旧地图的新名字');
  await page.getByTestId('open-file-input').setInputFiles({ name: 'other.map.json', mimeType: 'application/json',
    buffer: Buffer.from(mapJson(map => { map.metadata.name = '另一张地图'; })) });
  await expect(inspector(page).getByLabel('地图名称')).toHaveValue('另一张地图');
  await page.getByTestId('map-canvas').focus();
  await expect(inspector(page).getByLabel('地图名称')).toHaveValue('另一张地图');
  await expect(undoButton(page)).toHaveAttribute('aria-disabled', 'true');
  expect(errors).toEqual([]);
});

test('continuous segments are selected together and edited in one step', async ({ page }) => {
  const errors: string[] = []; await open(page, errors);
  await selectMainRoad(page);
  await inspector(page).getByRole('button', { name: '选中连续的 2 段' }).click();
  await expect(inspector(page).getByRole('heading', { name: '已选 2 个对象' })).toBeVisible();
  const width = inspector(page).getByLabel('批量宽度');
  await expect(width).toHaveAttribute('placeholder', '未知');
  await width.fill('10'); await width.press('Enter');
  await expect(undoButton(page)).toHaveAttribute('title', /撤销：批量修改道路宽度/);
  await expect(width).toHaveValue('10');
  await inspector(page).getByLabel('批量方向').selectOption('both');
  await expect(undoButton(page)).toHaveAttribute('title', /撤销：批量修改道路宽度/);
  // The second road got the width too; one undo takes it from both.
  await click(page, 90, 15); await expect(inspector(page).getByLabel('宽度', { exact: true })).toHaveValue('10');
  await page.keyboard.press('Control+z');
  await expect(inspector(page).getByLabel('宽度状态')).toHaveValue('unknown');
  await expect(undoButton(page)).toHaveAttribute('aria-disabled', 'true');
  // Different widths leave the box empty; the button still makes them all unknown, in one step.
  await inspector(page).getByLabel('宽度状态').selectOption('known');
  const single = inspector(page).getByLabel('宽度', { exact: true }); await single.fill('7'); await single.press('Enter');
  await click(page, 80, 0, ['Shift']);
  await expect(inspector(page).getByLabel('批量宽度')).toHaveAttribute('placeholder', '各不相同');
  await inspector(page).getByRole('button', { name: '把已声明的宽度改为未知（1 条）' }).click();
  await expect(undoButton(page)).toHaveAttribute('title', /撤销：批量把已声明的道路宽度改为未知/);
  await expect(inspector(page).getByRole('button', { name: /把已声明的宽度改为未知/ })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('making declared widths unknown leaves unknown and not-applicable widths and their notes alone', async ({ page }) => {
  const errors: string[] = []; await open(page, errors, mapJson(map => {
    map.sources.sSurvey = { name: '现场测量', category: 'surveyed', description: '' };
    map.roads.rMain!.widthM = { state: 'unknown', reason: '影像中路缘不可辨' };
    map.roads.rZoneConnection!.widthM = { state: 'known', value: 7, sourceRef: 'sSurvey' };
    map.roads.rApproach!.widthM = { state: 'not_applicable', reason: '内部通道' };
  }));
  const pick = async (id: string, shift: boolean) => {
    await page.getByLabel('搜索对象').fill(id);
    await page.getByRole('list', { name: '对象目录' }).locator('.object-row .object-main').first().click(shift ? { modifiers: ['Shift'] } : {});
  };
  await pick('rMain', false); await pick('rZoneConnection', true); await pick('rApproach', true);
  await expect(inspector(page).getByRole('heading', { name: '已选 3 个对象' })).toBeVisible();
  await inspector(page).getByRole('button', { name: '把已声明的宽度改为未知（1 条）' }).click();
  await expect(undoButton(page)).toHaveAttribute('title', /撤销：批量把已声明的道路宽度改为未知/);
  await pick('rZoneConnection', false); await expect(inspector(page).getByLabel('宽度状态')).toHaveValue('unknown');
  await pick('rMain', false); await expect(inspector(page).getByLabel('宽度说明')).toHaveValue('影像中路缘不可辨');
  await pick('rApproach', false);
  await expect(inspector(page).getByLabel('宽度状态')).toHaveValue('not_applicable');
  await expect(inspector(page).getByLabel('宽度说明')).toHaveValue('内部通道');
  expect(errors).toEqual([]);
});

test('nodes, buildings, zones and the map name', async ({ page }) => {
  const errors: string[] = []; await open(page, errors);
  // The map name cannot be emptied.
  const mapName = inspector(page).getByLabel('地图名称');
  await mapName.fill(' '); await mapName.press('Enter');
  await expect(inspector(page).getByRole('alert')).toContainText('不能为空');
  await mapName.fill('韩华描图 1'); await mapName.press('Enter');
  await expect(undoButton(page)).toHaveAttribute('title', /撤销：重命名地图/);
  // A node from the directory: move it by typing X.
  await page.getByLabel('搜索对象').fill('nRoadEast');
  await page.getByRole('list', { name: '对象目录' }).locator('.object-row .object-main').first().click();
  const x = inspector(page).getByLabel('X 坐标');
  await expect(x).toHaveValue('100');
  await x.fill('abc'); await x.press('Enter');
  await expect(inspector(page).getByRole('alert')).toContainText('有限数');
  await x.fill('104.5'); await x.press('Enter');
  await expect(undoButton(page)).toHaveAttribute('title', /撤销：修改节点坐标/);
  await expect(raw(page)).toContainText('104.5');
  // Committed, the field shows the map again at once (still focused): three decimals, the full value stored.
  await x.fill('104.56789'); await x.press('Enter');
  await expect(x).toHaveValue('104.568');
  await expect(raw(page)).toContainText('104.56789');
  // Also when the shown value does not change: 104.5680001 is shown as 104.568 too.
  await x.fill('104.5680001'); await x.press('Enter');
  await expect(raw(page)).toContainText('104.5680001');
  await expect(x).toHaveValue('104.568');
  // Building: kind (0.2 map: no「建筑」), height with a design assumption. (Locating the node moved the view: pick from the directory.)
  const pick = async (id: string) => { await page.getByLabel('搜索对象').fill(id); await page.getByRole('list', { name: '对象目录' }).locator('.object-row .object-main').first().click(); };
  await pick('fFree'); await expect(heading(page)).toContainText('空置厂房');
  const kinds = inspector(page).getByLabel('建筑兼容类型');
  await expect(kinds.locator('option')).toHaveText(['厂房', '其他']);
  await kinds.selectOption('other');
  await expect(undoButton(page)).toHaveAttribute('title', /撤销：修改建筑类型/);
  await inspector(page).getByLabel('高度状态').selectOption('known');
  const height = inspector(page).getByLabel('高度', { exact: true });
  await height.fill('12'); await height.press('Enter');
  await expect(inspector(page).getByLabel('高度依据')).toContainText('建筑参数设计假设');
  // Zone passability.
  await pick('zWaiting');
  await inspector(page).getByLabel('通行声明').selectOption('forbidden');
  await expect(undoButton(page)).toHaveAttribute('title', /撤销：修改通行声明/);
  expect(errors).toEqual([]);
});

test('read-only maps and locked layers show values without inputs', async ({ page }) => {
  const errors: string[] = []; await open(page, errors);
  await page.getByRole('tab', { name: '图层' }).click();
  await page.getByRole('button', { name: '锁定道路' }).click();
  await selectMainRoad(page);
  await expect(inspector(page).getByRole('textbox')).toHaveCount(0);
  await expect(inspector(page).locator('.field').filter({ hasText: /^宽度/ })).toContainText('未知');
  await page.getByRole('button', { name: '解锁道路' }).click();
  await expect(inspector(page).getByLabel('名称', { exact: true })).toBeVisible();
  await page.getByTestId('open-file-input').setInputFiles({ name: 'ro.map.json', mimeType: 'application/json', buffer: Buffer.from(mapJson(map => {
    map.extensionNamespaces['test.future_behavior'] = { version: '1', category: 'behavior' };
    map.extensions['test.future_behavior'] = { controller: 'unsupported' };
  })) });
  await expect(inspector(page).getByRole('textbox')).toHaveCount(0);
  await selectMainRoad(page);
  await expect(inspector(page).getByRole('textbox')).toHaveCount(0);
  await expect(inspector(page).getByRole('combobox')).toHaveCount(0);
  expect(errors).toEqual([]);
});
