import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, test } from '@playwright/test';
import type { YardMap } from '../../src/domain/model';
import { transformPolygon } from '../../src/geometry/polygons';
import { browserSaved, canvasBox, checkpoint, expectVisiblePosition, exportMapUI, importMapUI, readyWorkbench, selectResult } from '../helpers/RF01_workbench';
import { drawingControl, saveToBrowser } from '../helpers/workbenchUi';

test('HW099 real yard movement preserves its public anchor and exposes blocked larger moves immediately', async ({ page }, info) => {
  test.setTimeout(180000);
  const sourcePath = resolve(process.env.UX02_MQ01_ROOT ?? '../../projects/MQ01_Repair_20260913', 'hanwha/map.json');
  let bytes: Buffer;
  try { bytes = await readFile(sourcePath); } catch (cause) { throw new Error('blocked_input: required Hanwha map missing: ' + sourcePath, { cause }); }
  const digest = createHash('sha256').update(bytes).digest('hex');
  expect(digest, 'blocked_input: frozen Hanwha SHA').toBe('026bf0c409b151aa005fe59d50e0aeda294eca83a5fbccf9b5927b9190cb4749');
  const original = JSON.parse(bytes.toString('utf8')) as YardMap;
  const bundles = new Set<string>();
  page.on('response', response => { if (/\/assets\/[^/]+\.js$/.test(new URL(response.url()).pathname)) bundles.add(response.url()); });
  await readyWorkbench(page); await importMapUI(page, original, bytes);
  await (await drawingControl(page, '网格吸附')).selectOption('1');
  await (await drawingControl(page, '节点吸附')).uncheck();
  await selectResult(page, 'facilities', 'F_HW099');
  await page.getByRole('button', { name: '定位 F_HW099', exact: true }).click();
  const originalHash = (await page.getByTestId('map-hash').textContent())!;
  await page.screenshot({ path: info.outputPath('hw099-before.png'), fullPage: true });
  async function drag(fromX: number, deltaX: number) {
    const from = await expectVisiblePosition(page, [fromX, 2100, 0]);
    const to = await expectVisiblePosition(page, [fromX + deltaX, 2100, 0]);
    await page.mouse.move(from.x, from.y); await page.mouse.down();
    await page.mouse.move(to.x, to.y, { steps: 12 }); await page.mouse.up();
  }
  await drag(2035, 5);
  await expect(page.getByTestId('map-hash')).not.toHaveText(originalHash);
  const moved = (await exportMapUI(page, info, 'five-metres')).map;
  const expected = structuredClone(original);
  expected.revision = original.revision + 1; expected.sources = moved.sources;
  expected.facilities.F_HW099!.boundary = transformPolygon(original.facilities.F_HW099!.boundary, p => [p[0] + 5, p[1], p[2]]);
  expected.facilities.F_HW099!.provenance = moved.facilities.F_HW099!.provenance;
  expected.nodes.N_HW_3bbc98ef77!.position = [2017, 2192.2, 0];
  expected.nodes.N_HW_3bbc98ef77!.provenance = moved.nodes.N_HW_3bbc98ef77!.provenance;
  expect(moved).toEqual(expected);
  for (const [id, source] of Object.entries(original.sources)) expect(moved.sources[id]).toEqual(source);
  await expect(page.locator('.canvas-status')).toContainText('1 个撤销事务');
  await page.screenshot({ path: info.outputPath('hw099-five-metres.png'), fullPage: true });
  const movedHash = (await page.getByTestId('map-hash').textContent())!;
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect(page.getByTestId('map-hash')).toHaveText(originalHash);
  expect((await exportMapUI(page, info, 'undo')).map).toEqual(original);
  await page.getByRole('button', { name: '重做', exact: true }).click();
  await expect(page.getByTestId('map-hash')).toHaveText(movedHash);
  expect((await exportMapUI(page, info, 'redo')).map).toEqual(moved);
  await saveToBrowser(page); await checkpoint(page, movedHash); await browserSaved(page);
  await page.reload(); await browserSaved(page);
  await expect(page.getByTestId('map-hash')).toHaveText(movedHash);
  expect((await exportMapUI(page, info, 'refreshed')).map).toEqual(moved);
  await importMapUI(page, moved); await selectResult(page, 'facilities', 'F_HW099');
  await page.getByRole('button', { name: '定位 F_HW099', exact: true }).click();
  expect((await exportMapUI(page, info, 'roundtrip')).map).toEqual(moved);
  await expect(page.locator('.canvas-status')).toContainText('0 个撤销事务');
  const banner = page.locator('.canvas-context [role="alert"]');
  const beforeErrorCanvas = await canvasBox(page);
  const cameraState = () => page.getByTestId('camera-state').evaluate(element =>
    ['data-offset-x', 'data-offset-y', 'data-scale'].map(name => element.getAttribute(name)));
  const beforeErrorCamera = await cameraState();
  await drag(2040, 20);
  await expect(banner).toBeVisible();
  await expect(banner).toContainText('AP_HW099'); await expect(banner).toContainText('N_HW_a96cfdfffb');
  await expect(banner).toContainText('保持原位'); await expect(banner).toContainText('轮廓外');
  const bannerSize = await banner.evaluate(element => ({
    height: element.getBoundingClientRect().height, limit: 6 * parseFloat(getComputedStyle(document.documentElement).fontSize),
  }));
  expect(bannerSize.height).toBeLessThanOrEqual(bannerSize.limit + 0.01);
  expect(await canvasBox(page)).toEqual(beforeErrorCanvas); expect(await cameraState()).toEqual(beforeErrorCamera);
  await expect(page.getByTestId('map-hash')).toHaveText(movedHash);
  await expect(page.locator('.canvas-status')).toContainText('0 个撤销事务');
  await page.screenshot({ path: info.outputPath('hw099-immediate-rejection.png'), fullPage: true });
  await banner.getByRole('button', { name: '关闭提示', exact: true }).click();
  await expect(banner).not.toBeVisible(); await expect(page.getByTestId('map-hash')).toHaveText(movedHash);
  expect(await canvasBox(page)).toEqual(beforeErrorCanvas); expect(await cameraState()).toEqual(beforeErrorCamera);
  await drag(2040, 20); await expect(banner).toBeVisible();
  await banner.getByRole('button', { name: '查看原因与定位', exact: true }).click();
  const reason = page.locator('.issue-panel').getByRole('button', { name: /^OWNER_ENTRANCE_REPOSITION_REQUIRED / });
  await expect(reason).toBeVisible(); await reason.click();
  await expect(page.getByTestId('map-hash')).toHaveText(movedHash);
  await expect(page.locator('.canvas-status')).toContainText('0 个撤销事务');
  expect((await exportMapUI(page, info, 'refused-and-located')).map).toEqual(moved);
  expect(createHash('sha256').update(await readFile(sourcePath)).digest('hex')).toBe(digest);
  const receipt = { sourcePath, frozenSHA256: digest, originalHash, movedHash, bundles: [...bundles],
    drag5m: 'accepted', publicAnchorPreserved: true, privateServiceMoved: true, hiddenFieldsPreserved: true,
    undoRedo: true, savedRefreshed: true, jsonRoundtrip: true, drag20m: 'refused',
    immediateReasonVisible: true, boundedBannerHeight: bannerSize, errorKeepsViewport: true, dismissAndLocateLeaveMapAndHistoryUnchanged: true, originalUnchanged: true };
  await writeFile(info.outputPath('receipt.json'), JSON.stringify(receipt, null, 2));
  await info.attach('HW099-receipt', { body: JSON.stringify(receipt), contentType: 'application/json' });
});
