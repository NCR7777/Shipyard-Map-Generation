import { expect, test, type Page } from '@playwright/test';
import { fileURLToPath } from 'node:url';

const example = fileURLToPath(new URL('../../examples/M2A1_synthetic_service_targets.map.json', import.meta.url));

async function open(page: Page, errors: string[]) {
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await page.getByTestId('open-file-input').setInputFiles(example);
  await expect(page.getByTestId('map-canvas')).toHaveAttribute('data-scale', /\d/);
}
async function at(page: Page, x: number, y: number) {
  const canvas = page.getByTestId('map-canvas'), box = (await canvas.boundingBox())!;
  const [s, ox, oy] = await Promise.all(['data-scale', 'data-offset-x', 'data-offset-y'].map(async name => Number(await canvas.getAttribute(name))));
  return { x: box.x + ox! + x * s!, y: box.y + oy! - y * s! };
}
async function click(page: Page, x: number, y: number) { const p = await at(page, x, y); await page.mouse.click(p.x, p.y); }
const group = (page: Page, name: string) => page.getByRole('list', { name: '对象目录' }).locator('.object-group').filter({ hasText: new RegExp('^' + name) }).first();
const undoButton = (page: Page) => page.getByRole('toolbar', { name: '工具' }).getByRole('button', { name: '撤销' });
const step = (page: Page) => page.getByRole('region', { name: '绘图选项' }).locator('.tool-step');
/** The example is a 0.2.0 map: the first road, curve or area tool asks to upgrade it. */
async function upgrade(page: Page, key: string) {
  await page.keyboard.press(key);
  const dialog = page.getByRole('dialog', { name: '升级地图格式' });
  await expect(dialog).toContainText('0.2.0');
  await dialog.getByRole('button', { name: '升级并继续' }).click();
  await expect(dialog).toHaveCount(0);
}

test('a 0.2 map is upgraded first; a drawn road is one undo step and ends up selected', async ({ page }) => {
  const errors: string[] = []; await open(page, errors);
  await expect(group(page, '道路')).toContainText('3');
  await upgrade(page, 'r');
  await expect(page.getByRole('button', { name: /^道路/ }).first()).toHaveAttribute('aria-pressed', 'true');
  await expect(undoButton(page)).toHaveAttribute('title', /撤销：升级到格式 0\.3\.0/);
  // Free ground right of the workshop and above the waiting zone, clear of the options panel.
  await click(page, 65, 58); await expect(step(page)).toContainText('继续点击折点');
  await click(page, 85, 58); await click(page, 85, 70);
  await page.keyboard.press('Enter');
  await expect(group(page, '道路')).toContainText('4');
  await expect(page.getByRole('region', { name: '属性' }).locator('.entity-heading')).toContainText('道路');
  await expect(undoButton(page)).toHaveAttribute('title', /撤销：绘制道路/);
  await page.keyboard.press('Control+z');
  await expect(group(page, '道路')).toContainText('3');
  await expect(undoButton(page)).toHaveAttribute('title', /撤销：升级到格式 0\.3\.0/);
  expect(errors).toEqual([]);
});

test('clicking a node ends the road there; clicking a road interior splits it and connects', async ({ page }) => {
  const errors: string[] = []; await open(page, errors);
  await upgrade(page, 'r');
  const nodes = async () => Number((await group(page, '节点').locator('.count').textContent()) ?? 0);
  const before = await nodes();
  // From free ground to the east end of the main road: one new node only, the road ends on the existing one.
  // (Its 12 m band keeps clear of the workshop, which ends at x = 60.)
  await click(page, 75, 15); await click(page, 100, 0);
  await expect(group(page, '道路')).toContainText('4');
  expect(await nodes()).toBe(before + 1);
  // From free ground onto the middle of the main road: the road is split there, so two more roads and two more nodes.
  await click(page, 85, -15); await click(page, 85, 0);
  await expect(group(page, '道路')).toContainText('6');
  expect(await nodes()).toBe(before + 3);
  expect(errors).toEqual([]);
});

test('R and C continue one road with a curve; Alt draws without connecting', async ({ page }) => {
  const errors: string[] = []; await open(page, errors);
  await upgrade(page, 'r');
  const nodes = async () => Number((await group(page, '节点').locator('.count').textContent()) ?? 0), before = await nodes();
  await click(page, 75, 15);
  await page.keyboard.press('c'); await expect(step(page)).toContainText('曲线终点');
  await click(page, 95, 15); await expect(step(page)).toContainText('经过的位置');
  await click(page, 85, 22);
  await page.keyboard.press('Enter');
  await expect(group(page, '道路')).toContainText('4');
  const inspector = page.getByRole('region', { name: '属性' });
  await inspector.getByText('原始 JSON').click();
  await expect(inspector.locator('pre')).toContainText('"cubic"');
  // Alt on the east node: the road starts beside it, unconnected, so it gets both of its own end nodes.
  await page.keyboard.press('r');
  const east = await at(page, 100, 0), south = await at(page, 100, -15);
  await page.keyboard.down('Alt'); await page.mouse.click(east.x, east.y); await page.keyboard.up('Alt');
  await page.mouse.click(south.x, south.y); await page.keyboard.press('Enter');
  await expect(group(page, '道路')).toContainText('5');
  expect(await nodes()).toBe(before + 2 + 2);
  expect(errors).toEqual([]);
});

test('areas: a dragged rectangle, a three-point oblique rectangle, a polygon closed on its first vertex', async ({ page }) => {
  const errors: string[] = []; await open(page, errors);
  await expect(group(page, '建筑')).toContainText('1');
  await upgrade(page, 'b');
  const a = await at(page, 65, 55), b = await at(page, 95, 70);
  await page.mouse.move(a.x, a.y); await page.mouse.down(); await page.mouse.move(b.x, b.y, { steps: 8 }); await page.mouse.up();
  await expect(group(page, '建筑')).toContainText('2');
  await page.getByRole('radio', { name: '三点斜矩形' }).click();
  // Below the main road and above the scale bar in the lower left corner.
  await click(page, 5, -8); await expect(step(page)).toContainText('基边终点');
  await click(page, 25, -11); await expect(step(page)).toContainText('确定宽度');
  await click(page, 15, -16);
  await expect(group(page, '建筑')).toContainText('3');
  await expect(group(page, '区域')).toContainText('1');
  await page.keyboard.press('a');
  await click(page, 40, -8); await click(page, 60, -8); await click(page, 60, -16);
  await expect(step(page)).toContainText('点回起点');
  await click(page, 40, -8);
  await expect(group(page, '区域')).toContainText('2');
  expect(errors).toEqual([]);
});

test('Backspace takes back points; Escape drops the draft, then leaves the tool; undo drops a stale draft', async ({ page }) => {
  const errors: string[] = []; await open(page, errors);
  await upgrade(page, 'r');
  await click(page, 65, 58); await click(page, 85, 58);
  await page.keyboard.press('Backspace'); await expect(step(page)).toContainText('继续点击折点');
  await page.keyboard.press('Backspace'); await expect(step(page)).toContainText('点击起点');
  await click(page, 65, 58);
  await page.keyboard.press('Escape'); await expect(step(page)).toContainText('点击起点');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('region', { name: '绘图选项' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^选择/ })).toHaveAttribute('aria-pressed', 'true');
  // A draft started before an undo does not fit the map any more.
  await page.keyboard.press('r'); await click(page, 65, 58);
  await page.keyboard.press('Control+z');
  await expect(page.getByRole('status')).toContainText('草稿已取消');
  expect(errors).toEqual([]);
});

async function doubleClick(page: Page, x: number, y: number) { const p = await at(page, x, y); await page.mouse.dblclick(p.x, p.y); }

test('a double-click finishes without an extra point, node or draft', async ({ page }) => {
  const errors: string[] = []; await open(page, errors);
  const count = async (name: string) => Number((await group(page, name).locator('.count').textContent()) ?? 0);
  const nodes = await count('节点');
  await page.keyboard.press('n'); await doubleClick(page, 65, 58);
  await expect.poll(() => count('节点')).toBe(nodes + 1);
  await upgrade(page, 'r');
  await click(page, 65, 58); await click(page, 85, 58); await doubleClick(page, 85, 70);
  await expect(group(page, '道路')).toContainText('4');
  await expect(step(page)).toContainText('点击起点');
  // Ending on a node with a double-click: the first click connects and commits, the second must not start a new road.
  await click(page, 75, 15); await doubleClick(page, 100, 0);
  await expect(group(page, '道路')).toContainText('5');
  await expect(step(page)).toContainText('点击起点');
  expect(errors).toEqual([]);
});

test('opening another map resets the tool and drops the draft; Delete while drawing only takes back a point', async ({ page }) => {
  const errors: string[] = []; await open(page, errors);
  await upgrade(page, 'r');
  // The road just drawn is selected; Delete while drawing the next one must not offer to delete it.
  await click(page, 65, 58); await click(page, 85, 58); await page.keyboard.press('Enter');
  await expect(group(page, '道路')).toContainText('4');
  await click(page, 65, 50); await click(page, 85, 50);
  await page.keyboard.press('Delete');
  await expect(page.getByRole('dialog', { name: '删除选中对象' })).toHaveCount(0);
  await page.keyboard.press('Backspace'); await expect(step(page)).toContainText('点击起点');
  await click(page, 65, 50); await click(page, 85, 50);
  await page.getByTestId('open-file-input').setInputFiles(example);
  await expect(page.getByRole('region', { name: '绘图选项' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^选择/ })).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Enter');
  await expect(group(page, '道路')).toContainText('3');
  await expect(undoButton(page)).toHaveAttribute('aria-disabled', 'true');
  expect(errors).toEqual([]);
});

test('the node tool adds nodes; measuring never changes the map', async ({ page }) => {
  const errors: string[] = []; await open(page, errors);
  const count = async () => Number((await group(page, '节点').locator('.count').textContent()) ?? 0), before = await count();
  await page.keyboard.press('n');
  await click(page, 65, 58);
  await expect.poll(count).toBe(before + 1);
  await page.keyboard.press('Control+z');
  await expect.poll(count).toBe(before);
  await page.keyboard.press('m');
  await click(page, 0, -10); await click(page, 30, -20);
  await expect(step(page)).toContainText('继续点击');
  await page.keyboard.press('Enter');
  await expect(step(page)).toContainText('点击起点');
  await expect(undoButton(page)).toHaveAttribute('aria-disabled', 'true');
  expect(errors).toEqual([]);
});
