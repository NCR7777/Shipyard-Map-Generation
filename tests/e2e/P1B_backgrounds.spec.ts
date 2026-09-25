import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { storedZip } from '../../src/adapters/storedZip';
import { backgroundMap, QUADRANT_POINTS, quadrantPng } from '../helpers/P1B_backgroundMap';

const png = quadrantPng(), other = readFileSync(fileURLToPath(new URL('../fixtures/BG01/small.png', import.meta.url)));
const json = (name: string, text: string) => ({ name, mimeType: 'application/json', buffer: Buffer.from(text) });
const image = (name: string, buffer: Buffer) => ({ name, mimeType: 'image/png', buffer });
const COLORS = { red: [220, 40, 40], blue: [40, 80, 220], green: [40, 170, 60], yellow: [230, 200, 40], none: [247, 249, 250] } as const;
type Color = keyof typeof COLORS | 'outside';

async function at(page: Page, x: number, y: number) {
  const canvas = page.getByTestId('map-canvas'), box = (await canvas.boundingBox())!;
  const [s, ox, oy] = await Promise.all(['data-scale', 'data-offset-x', 'data-offset-y'].map(async name => Number(await canvas.getAttribute(name))));
  return { x: box.x + ox! + x * s!, y: box.y + oy! - y * s! };
}
/** The nearest reference colour of the canvas pixel under a world point; `outside` when the point is off the canvas. */
async function colourAt(page: Page, x: number, y: number): Promise<Color> {
  const point = await at(page, x, y);
  const rgb = await page.evaluate(({ x, y }) => {
    const canvas = document.querySelector<HTMLCanvasElement>('[data-testid=map-canvas] canvas')!, rect = canvas.getBoundingClientRect(), ratio = canvas.width / rect.width;
    if (x < rect.left || y < rect.top || x >= rect.right || y >= rect.bottom) return null;
    return [...canvas.getContext('2d')!.getImageData(Math.round((x - rect.left) * ratio), Math.round((y - rect.top) * ratio), 1, 1).data].slice(0, 3);
  }, point);
  if (!rgb) return 'outside';
  return (Object.keys(COLORS) as (keyof typeof COLORS)[]).sort((a, b) => distance(rgb, COLORS[a]) - distance(rgb, COLORS[b]))[0]!;
}
const distance = (a: readonly number[], b: readonly number[]) => Math.hypot(a[0]! - b[0]!, a[1]! - b[1]!, a[2]! - b[2]!);
const layer = (page: Page) => page.getByRole('group', { name: '底图 四色测试底图' });
async function open(page: Page, files: Parameters<ReturnType<Page['getByTestId']>['setInputFiles']>[0], errors: string[]) {
  page.on('pageerror', error => errors.push(error.message));
  if (page.url() === 'about:blank') await page.goto('/');
  await page.getByTestId('open-file-input').setInputFiles(files);
}
async function showLayers(page: Page) {
  await page.getByRole('tab', { name: '图层' }).click();
}

test('the image lands where imageToWorld puts it, and visibility and opacity apply', async ({ page }) => {
  const errors: string[] = []; await open(page, [json('bg.map.json', backgroundMap()), image('any-name.png', png)], errors);
  await showLayers(page);
  await expect(layer(page).locator('.badge')).toHaveText('就绪');
  await layer(page).getByRole('button', { name: '适应底图' }).click();
  for (const [colour, [x, y]] of Object.entries(QUADRANT_POINTS)) await expect.poll(() => colourAt(page, x, y)).toBe(colour);
  await layer(page).getByRole('button', { name: '隐藏底图' }).click();
  await expect.poll(() => colourAt(page, ...QUADRANT_POINTS.red)).toBe('none');
  await layer(page).getByRole('button', { name: '显示底图' }).click();
  await expect.poll(() => colourAt(page, ...QUADRANT_POINTS.red)).toBe('red');
  await layer(page).getByLabel('底图不透明度').fill('0');
  await expect.poll(() => colourAt(page, ...QUADRANT_POINTS.red)).toBe('none');
  expect(errors).toEqual([]);
});

test('a large image drawn from a reduced level still covers exactly its footprint', async ({ page }) => {
  // 2048 × 1536 px over 64 × 48 m: at the fitted view each image pixel is far below one screen pixel, so a halved copy is drawn.
  const large = quadrantPng(2048, 1536);
  const errors: string[] = []; await open(page, [json('large.map.json', backgroundMap({ image: large })), image('large.png', large)], errors);
  await showLayers(page);
  await expect(layer(page).locator('.badge')).toHaveText('就绪');
  await layer(page).getByRole('button', { name: '适应底图' }).click();
  for (const [colour, [x, y]] of Object.entries(QUADRANT_POINTS)) await expect.poll(() => colourAt(page, x, y)).toBe(colour);
  // Just outside each edge is empty canvas: the reduced copy is stretched to the full image rect, no more.
  for (const [x, y] of [[118, 24], [186, 24], [152, 50], [152, -2]] as const) await expect.poll(() => colourAt(page, x, y)).toBe('none');
  expect(errors).toEqual([]);
});

test('a rotated, unevenly scaled placement keeps every quadrant where imageToWorld puts it', async ({ page }) => {
  // Pixel x runs along world +y at 1 m/px, pixel y along world +x at 0.5 m/px: swapping any two components moves the colours.
  const rotated = backgroundMap({ transform: [0, 1, 0.5, 0, 120, 0] });
  const errors: string[] = []; await open(page, [json('rotated.map.json', rotated), image('q.png', png)], errors);
  await showLayers(page);
  await expect(layer(page).locator('.badge')).toHaveText('就绪');
  await layer(page).getByRole('button', { name: '适应底图' }).click();
  const expected = { red: [126, 16], blue: [126, 48], green: [138, 16], yellow: [138, 48] } as const;
  for (const [colour, [x, y]] of Object.entries(expected)) await expect.poll(() => colourAt(page, x, y)).toBe(colour);
  expect(errors).toEqual([]);
});

test('an unsupported layer says why, and a missing image says where to add it', async ({ page }) => {
  const errors: string[] = []; await open(page, [json('unsized.map.json', backgroundMap({ unsized: true }))], errors);
  await showLayers(page);
  await expect(layer(page).locator('.badge')).toHaveText('不支持');
  await expect(layer(page)).toContainText('图片需要明确的正整数像素尺寸');
  await page.getByTestId('open-file-input').setInputFiles([json('bg.map.json', backgroundMap({ mapId: 'map_missing' }))]);
  await expect(page.getByRole('status')).toContainText('有 1 张底图还没有图片');
  await expect(layer(page).locator('.badge')).toHaveText('缺图');
  expect(errors).toEqual([]);
});

test('an image with another hash is refused and the layer stays missing', async ({ page }) => {
  const errors: string[] = []; await open(page, [json('bg.map.json', backgroundMap()), image('quadrants.png', other)], errors);
  await expect(page.getByRole('alert')).toContainText('SHA-256');
  await showLayers(page);
  await expect(layer(page).locator('.badge')).toHaveText('缺图');
  await expect(layer(page)).toContainText('按内容匹配，文件名不限');
  expect(errors).toEqual([]);
});

test('an image comes back from this tool\'s own browser database after a reload', async ({ page }) => {
  const errors: string[] = []; await open(page, [json('bg.map.json', backgroundMap()), image('q.png', png)], errors);
  await showLayers(page);
  await expect(layer(page).locator('.badge')).toHaveText('就绪');
  await page.reload();
  await page.getByTestId('open-file-input').setInputFiles([json('bg.map.json', backgroundMap())]);
  await showLayers(page);
  await expect(layer(page).locator('.badge')).toHaveText('就绪');
  // Never the old editor's database: the two tools must not share projects or images.
  expect(await page.evaluate(async () => (await indexedDB.databases()).map(db => db.name))).toEqual(['shipyard-map-studio']);
  expect(errors).toEqual([]);
});

test('a zip package opens its map and finds the image by content in another folder', async ({ page }) => {
  const zip = storedZip([
    { name: 'pkg/maps/yard.map.json', bytes: new TextEncoder().encode(backgroundMap()) },
    { name: 'pkg/maps/calibration.json', bytes: new TextEncoder().encode('{"format":"calibration"}') },
    { name: 'pkg/images/background.png', bytes: png },
    { name: 'pkg/images/unrelated.png', bytes: other },
  ]);
  const errors: string[] = []; await open(page, [{ name: 'yard.zip', mimeType: 'application/zip', buffer: Buffer.from(zip) }], errors);
  await expect(page.getByRole('contentinfo')).toContainText('yard.zip');
  await showLayers(page);
  await expect(layer(page).locator('.badge')).toHaveText('就绪');
  await expect(page.getByRole('alert')).toHaveCount(1);
  await expect(page.getByRole('alert')).toBeEmpty();
  expect(errors).toEqual([]);
});

/** The quadrant PNG with its compressed pixel data overwritten: the header still passes, decoding fails. */
function corrupted(): Buffer {
  const bytes = Buffer.from(png), at = bytes.indexOf('IDAT'), length = bytes.readUInt32BE(at - 4);
  bytes.fill(0xab, at + 4, at + 4 + length);
  return bytes;
}
/** Rewrites the declared (uncompressed) size of every image record in a stored zip's central directory. */
function declareImageSizes(zip: Uint8Array, size: number): Buffer {
  const bytes = Buffer.from(zip), end = bytes.length - 22;
  for (let at = bytes.readUInt32LE(end + 16); at < end;) {
    const nameLength = bytes.readUInt16LE(at + 28), name = bytes.toString('utf8', at + 46, at + 46 + nameLength);
    if (name.endsWith('.png')) bytes.writeUInt32LE(size, at + 24);
    at += 46 + nameLength + bytes.readUInt16LE(at + 30) + bytes.readUInt16LE(at + 32);
  }
  return bytes;
}
const zipFile = (name: string, entries: { name: string; bytes: Uint8Array }[]) => ({ name, mimeType: 'application/zip', buffer: Buffer.from(storedZip(entries)) });

test('a package image whose hash matches is reported when it fails, and a package note is never hidden', async ({ page }) => {
  const errors: string[] = [];
  // A: hash matches, pixels do not decode. Quiet package offers must still say so instead of only "choose the image".
  const bad = corrupted();
  await open(page, [zipFile('a.zip', [{ name: 'map.json', bytes: new TextEncoder().encode(backgroundMap({ image: bad })) }, { name: 'images/bg.png', bytes: bad }])], errors);
  await expect(page.getByRole('alert')).toContainText('images/bg.png');
  // B: hash matches, the map declares another width. The error stays; no later hint replaces it.
  const wider = JSON.parse(backgroundMap({ mapId: 'map_wider' })); wider.assets.imgQuadrants.widthPx = 65;
  await page.getByTestId('open-file-input').setInputFiles([zipFile('b.zip', [{ name: 'map.json', bytes: new TextEncoder().encode(JSON.stringify(wider)) }, { name: 'b/bg.png', bytes: png }])]);
  await expect(page.getByRole('alert')).toContainText('尺寸或格式与地图记录不一致');
  await page.waitForTimeout(500);
  await expect(page.getByRole('alert')).toContainText('尺寸或格式与地图记录不一致');
  await expect(page.getByRole('status')).toBeEmpty();
  // C: images declared past 512 MiB are not read; the reason and the missing image arrive in one message.
  const many = Array.from({ length: 17 }, (_, index) => ({ name: `tiles/${index}.png`, bytes: png }));
  const huge = declareImageSizes(storedZip([{ name: 'map.json', bytes: new TextEncoder().encode(backgroundMap({ mapId: 'map_huge' })) }, ...many]), 31 * 1024 * 1024);
  await page.getByTestId('open-file-input').setInputFiles([{ name: 'c.zip', mimeType: 'application/zip', buffer: huge }]);
  await expect(page.getByRole('alert')).toContainText('512 MiB');
  await expect(page.getByRole('alert')).toContainText('还没有图片');
  expect(errors).toEqual([]);
});

test('several maps ask which one to open; images alone need an open map', async ({ page }) => {
  const errors: string[] = []; await open(page, [image('q.png', png)], errors);
  await expect(page.getByRole('alert')).toContainText('请先打开地图');
  await page.getByTestId('open-file-input').setInputFiles([json('a.map.json', backgroundMap({ mapId: 'map_a' })), json('b.map.json', backgroundMap({ mapId: 'map_b', empty: true })), image('q.png', png)]);
  const dialog = page.getByRole('dialog', { name: '选择要打开的地图' });
  await expect(dialog.locator('.choice-list .choice-label')).toHaveText(['a.map.json', 'b.map.json']);
  // The summary tells a traced map from an empty one before opening it.
  await expect(dialog.locator('.choice-list .choice-detail')).toHaveText([/^底图 1 层 · 对象 [1-9]\d* 个$/, '底图 1 层 · 对象 0 个']);
  await dialog.getByRole('button', { name: /^b\.map\.json/ }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId('map-canvas')).toHaveAttribute('data-scale', /\d/);
  // A map with nothing drawn yet fits its background: the canvas centre shows the image.
  await showLayers(page);
  await expect(layer(page).locator('.badge')).toHaveText('就绪');
  await page.getByRole('button', { name: '适应', exact: true }).click();
  await expect.poll(() => colourAt(page, 152, 24)).toMatch(/^(red|blue|green|yellow)$/);
  expect(errors).toEqual([]);
});

test('imagery comparison fades area fills', async ({ page }) => {
  const errors: string[] = []; await open(page, [json('bg.map.json', backgroundMap()), image('q.png', png)], errors);
  await showLayers(page);
  const sample = async () => {
    // Inside the 60 × 30 m workshop, away from its label and outline; a 3 × 3 average ignores a stray grid line.
    const point = await at(page, 45, 24);
    return page.evaluate(({ x, y }) => {
      const canvas = document.querySelector<HTMLCanvasElement>('[data-testid=map-canvas] canvas')!, rect = canvas.getBoundingClientRect(), ratio = canvas.width / rect.width;
      const data = canvas.getContext('2d')!.getImageData(Math.round((x - rect.left) * ratio) - 1, Math.round((y - rect.top) * ratio) - 1, 3, 3).data;
      const mean = (offset: number) => [0, 1, 2, 3, 4, 5, 6, 7, 8].reduce((sum, i) => sum + data[i * 4 + offset]!, 0) / 9;
      return Math.hypot(mean(0) - 247, mean(1) - 249, mean(2) - 250);
    }, point);
  };
  const before = await sample();
  await page.getByLabel('影像对照（进一步淡化填充）').check();
  await expect.poll(sample).toBeLessThan(before * 0.7);
  expect(errors).toEqual([]);
});
