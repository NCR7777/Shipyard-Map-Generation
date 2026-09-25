import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const example = fileURLToPath(new URL('../../examples/M2A1_synthetic_service_targets.map.json', import.meta.url));
const invalid = fileURLToPath(new URL('../../examples/M1_invalid.map.json', import.meta.url));
const map = JSON.parse(readFileSync(example, 'utf8')) as { metadata: { name: string }; facilities: Record<string, { name: string }>; zones: Record<string, { name: string }>; accessPoints: Record<string, { name: string }>; roads: Record<string, { name: string }> };
const facilityName = map.facilities.fWorkshop!.name, zoneName = map.zones.zWaiting!.name, accessName = map.accessPoints.aWorkshop!.name;
const internalRoadName = map.roads.rApproach!.name;

async function open(page: Page, errors: string[]) {
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await page.getByTestId('open-file-input').setInputFiles(example);
  await expect(page.locator('.doc-title')).toHaveText(map.metadata.name);
  await expect(page.getByTestId('map-canvas')).toHaveAttribute('data-scale', /\d/);
}
/** Page coordinates of a world point, from the settled camera the canvas publishes. */
async function at(page: Page, x: number, y: number) {
  const canvas = page.getByTestId('map-canvas'), box = (await canvas.boundingBox())!;
  const [s, ox, oy] = await Promise.all(['data-scale', 'data-offset-x', 'data-offset-y'].map(async name => Number(await canvas.getAttribute(name))));
  return { x: box.x + ox! + x * s!, y: box.y + oy! - y * s! };
}
async function clickWorld(page: Page, x: number, y: number, modifiers: ('Shift' | 'Alt')[] = []) {
  const p = await at(page, x, y);
  for (const key of modifiers) await page.keyboard.down(key);
  await page.mouse.click(p.x, p.y);
  for (const key of modifiers) await page.keyboard.up(key);
}
const startsWith = (text: string) => new RegExp('^' + text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
async function dragWorld(page: Page, from: [number, number], to: [number, number]) {
  const a = await at(page, ...from), b = await at(page, ...to);
  await page.mouse.move(a.x, a.y); await page.mouse.down(); await page.mouse.move(b.x, b.y, { steps: 6 }); await page.mouse.up();
}
const inspector = (page: Page) => page.getByRole('region', { name: '属性' });

test('opens a map, lists objects by type and reports check results by severity', async ({ page }) => {
  const errors: string[] = []; await open(page, errors);
  const directory = page.getByRole('list', { name: '对象目录' });
  await expect(directory.getByRole('button', { name: /建筑\s*1/ })).toBeVisible();
  await expect(directory.getByRole('button', { name: /区域\s*1/ })).toBeVisible();
  await expect(page.getByRole('toolbar', { name: '工具' }).getByText(/错误|提示/)).toBeVisible();
  await expect(inspector(page).getByRole('heading', { name: '地图概览' })).toBeVisible();
  expect(errors).toEqual([]);
});

test('the object list opens with every group folded, and folds again when another map opens', async ({ page }) => {
  const errors: string[] = []; await open(page, errors);
  const directory = page.getByRole('list', { name: '对象目录' }), groups = directory.locator('.object-group');
  await expect(groups.first()).toBeVisible();
  // Every group is shown by its heading and count only.
  expect(await groups.evaluateAll(buttons => buttons.map(button => button.getAttribute('aria-expanded')))).not.toContain('true');
  await expect(directory.locator('.object-row')).toHaveCount(0);
  // Opening one group lists its objects; searching opens the matching groups without changing the folding.
  await groups.filter({ hasText: /^建筑/ }).click();
  await expect(directory.locator('.object-row')).toHaveCount(1);
  await page.getByLabel('搜索对象').fill('zWaiting');
  await expect(directory.locator('.object-row')).toHaveCount(1);
  // While searching a group can be folded for that search; the user's own folding is untouched.
  await page.getByLabel('搜索对象').fill('zWaiting');
  await groups.filter({ hasText: /^区域/ }).click();
  await expect(directory.locator('.object-row')).toHaveCount(0);
  await page.getByLabel('搜索对象').fill('');
  await expect(directory.locator('.object-row')).toHaveCount(1);
  // The folding survives switching tabs and folding the panel away.
  await page.getByRole('tab', { name: '图层' }).click();
  await page.getByRole('tab', { name: '对象' }).click();
  await expect(directory.locator('.object-row')).toHaveCount(1);
  await page.getByRole('button', { name: '收起项目内容栏' }).click();
  await page.getByRole('button', { name: '展开项目内容栏' }).click();
  await expect(directory.locator('.object-row')).toHaveCount(1);
  // An object selected on the canvas is shown in the directory: its group opens.
  await clickWorld(page, 80, 40);
  await expect(directory.locator('.object-row.selected')).toHaveCount(1);
  await expect(directory.locator('.object-row.selected')).toContainText(zoneName);
  // Another map (another name): everything folded again.
  const other = JSON.parse(readFileSync(example, 'utf8')) as { mapId: string; metadata: { name: string } };
  other.mapId = 'map_other'; other.metadata.name = '另一张图';
  await page.getByTestId('open-file-input').setInputFiles({ name: 'other.map.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(other)) });
  await expect(page.locator('.doc-title')).toHaveText('另一张图');
  await expect(directory.locator('.object-row')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('click selects, Shift toggles, empty space clears', async ({ page }) => {
  const errors: string[] = []; await open(page, errors);
  await clickWorld(page, 30, 22);
  await expect(inspector(page).locator('.entity-heading')).toContainText(facilityName);
  await clickWorld(page, 80, 45, ['Shift']);
  await expect(inspector(page).getByRole('heading', { name: '已选 2 个对象' })).toBeVisible();
  await clickWorld(page, 80, 45, ['Shift']);
  await expect(inspector(page).locator('.entity-heading')).toContainText(facilityName);
  await clickWorld(page, 65, 15);
  await expect(inspector(page).getByRole('heading', { name: '地图概览' })).toBeVisible();
  expect(errors).toEqual([]);
});

test('box selection: left-to-right contains, right-to-left crosses', async ({ page }) => {
  const errors: string[] = []; await open(page, errors);
  // The facility is only partly inside this left-to-right box, so containment selects nothing.
  await dragWorld(page, [-5, 35], [62, 25]);
  await expect(inspector(page).getByRole('heading', { name: '地图概览' })).toBeVisible();
  await dragWorld(page, [-5, 40], [65, -5]);
  const summary = inspector(page);
  await expect(summary.getByRole('heading', { name: /已选 \d+ 个对象/ })).toBeVisible();
  await expect(summary.getByRole('button', { name: new RegExp(facilityName) })).toBeVisible();
  await expect(summary.getByRole('button', { name: new RegExp(zoneName) })).toHaveCount(0);
  await dragWorld(page, [95, 48], [85, 44]);
  await expect(inspector(page).locator('.entity-heading')).toContainText(zoneName);
  expect(errors).toEqual([]);
});

test('directory search selects and frames; palette runs commands by name', async ({ page }) => {
  const errors: string[] = []; await open(page, errors);
  const canvas = page.getByTestId('map-canvas'), fitScale = await canvas.getAttribute('data-scale');
  // Zoom in on the facility so the zone is off-centre before locating it.
  const facility = await at(page, 10, 10); await page.mouse.move(facility.x, facility.y); await page.mouse.wheel(0, -400);
  await expect(canvas).not.toHaveAttribute('data-scale', fitScale!);
  await page.getByLabel('搜索对象').fill('zWaiting');
  const directory = page.getByRole('list', { name: '对象目录' });
  await expect(directory.locator('.object-row')).toHaveCount(1);
  await directory.getByRole('button', { name: startsWith(zoneName) }).click();
  await expect(inspector(page).locator('.entity-heading')).toContainText(zoneName);
  const box = (await canvas.boundingBox())!;
  await expect.poll(async () => { const centre = await at(page, 80, 40); return Math.hypot(centre.x - box.x - box.width / 2, centre.y - box.y - box.height / 2); }).toBeLessThan(2);
  await page.getByLabel('搜索对象').blur();
  await page.keyboard.press('Control+k');
  const palette = page.getByRole('dialog', { name: '命令与对象搜索' });
  await palette.getByLabel('搜索命令或对象').fill('适应');
  await page.keyboard.press('Enter');
  await expect(palette).toHaveCount(0);
  await expect(page.getByTestId('map-canvas')).toHaveAttribute('data-scale', fitScale!);
  expect(errors).toEqual([]);
});

test('shortcuts act on the workspace but never inside inputs', async ({ page }) => {
  const errors: string[] = []; await open(page, errors);
  const search = page.getByLabel('搜索对象');
  await search.fill(''); await search.focus();
  await page.keyboard.type('h?');
  await expect(search).toHaveValue('h?');
  await expect(page.getByRole('dialog', { name: '快捷键与显示约定' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /平移/ })).toHaveAttribute('aria-pressed', 'false');
  await search.fill(''); await search.blur();
  await page.keyboard.press('h');
  await expect(page.getByRole('button', { name: /平移/ })).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('v');
  await page.keyboard.press('?');
  const help = page.getByRole('dialog', { name: '快捷键与显示约定' });
  await expect(help).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(help).toHaveCount(0);
  await clickWorld(page, 30, 22);
  await page.keyboard.press('Escape');
  await expect(inspector(page).getByRole('heading', { name: '地图概览' })).toBeVisible();
  expect(errors).toEqual([]);
});

test('Alt+click cycles through stacked objects at one spot', async ({ page }) => {
  const errors: string[] = []; await open(page, errors);
  // At the origin the entrance and the road leaving it overlap (the shared node is merged into the entrance).
  await clickWorld(page, 0, 0, ['Alt']);
  const heading = inspector(page).locator('.entity-heading');
  await expect(heading).toContainText(accessName);
  await clickWorld(page, 0, 0, ['Alt']);
  await expect(heading).toContainText(internalRoadName);
  expect(errors).toEqual([]);
});

test('Escape and pointer cancel end a box drag without selecting or clearing anything', async ({ page }) => {
  const errors: string[] = []; await open(page, errors);
  await clickWorld(page, 30, 22);
  await expect(inspector(page).locator('.entity-heading')).toContainText(facilityName);
  const a = await at(page, 95, 48), b = await at(page, 85, 44);
  await page.mouse.move(a.x, a.y); await page.mouse.down(); await page.mouse.move(b.x, b.y, { steps: 6 });
  await page.keyboard.press('Escape');
  await page.mouse.up();
  await expect(inspector(page).locator('.entity-heading')).toContainText(facilityName);
  await page.mouse.move(a.x, a.y); await page.mouse.down(); await page.mouse.move(b.x, b.y, { steps: 6 });
  await page.getByTestId('map-canvas').dispatchEvent('pointercancel', { pointerId: 1, bubbles: true });
  await page.mouse.up();
  await expect(inspector(page).locator('.entity-heading')).toContainText(facilityName);
  expect(errors).toEqual([]);
});

test('an invalid file is refused and the open map stays', async ({ page }) => {
  const errors: string[] = []; await open(page, errors);
  await page.getByTestId('open-file-input').setInputFiles(invalid);
  await expect(page.getByRole('alert')).toContainText('无法打开');
  await expect(page.locator('.doc-title')).toHaveText(map.metadata.name);
  expect(errors).toEqual([]);
});

test('a hidden type is neither drawn for selection nor selectable', async ({ page }) => {
  const errors: string[] = []; await open(page, errors);
  await page.getByRole('tab', { name: '图层' }).click();
  await page.getByRole('button', { name: '隐藏建筑' }).click();
  await clickWorld(page, 30, 22);
  await expect(inspector(page).getByRole('heading', { name: '地图概览' })).toBeVisible();
  await page.getByRole('button', { name: '显示建筑' }).click();
  await clickWorld(page, 30, 22);
  await expect(inspector(page).locator('.entity-heading')).toContainText(facilityName);
  expect(errors).toEqual([]);
});
