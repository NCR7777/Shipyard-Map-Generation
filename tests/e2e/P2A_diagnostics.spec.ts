import { readFile } from 'node:fs/promises';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import type { Polygon, YardMap } from '../../src/domain/model';
import { P1_TARGETS, readP1Target } from '../helpers/P1_targets';

async function open(page: Page, map: YardMap, path?: string) {
  await page.goto('/');
  await expect(page.getByRole('button', { name: '保存工程', exact: true })).toBeEnabled();
  await page.getByTestId('json-file-input').setInputFiles(path ?? { name: map.mapId + '.map.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(map)) });
  await expect(page.getByLabel('地图名称', { exact: true })).toHaveValue(map.metadata.name, { timeout: 30000 });
  await page.getByRole('button', { name: '适应地图', exact: true }).click();
  await page.getByTestId('diagnostic-controls').locator('summary').click();
}
async function exportMap(page: Page, info: TestInfo, name: string) {
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出 JSON', exact: true }).click();
  const path = info.outputPath(name); await (await download).saveAs(path);
  return JSON.parse(await readFile(path, 'utf8')) as YardMap;
}
async function diagnose(page: Page, hash: string) {
  await page.getByTestId('run-diagnostics').click();
  await expect(page.getByTestId('diagnostic-status')).toHaveAttribute('data-map-hash', hash, { timeout: 30000 });
}
async function route(page: Page) {
  await page.getByLabel('路径起点', { exact: true }).selectOption('servicePoints:SP_001');
  await page.getByLabel('路径终点', { exact: true }).selectOption('servicePoints:SP_002');
  await page.getByTestId('preview-path').click();
}
const originalA = P1_TARGETS.find(target => target.id === 'SR03_A')!;

test('P2A original A: locate, path, hidden/locked inclusion, unchanged JSON and stale-result protection', async ({ page }, info) => {
  test.setTimeout(120000);
  const original = await readP1Target(originalA); await open(page, original.map, originalA.absolutePath);
  const hash = (await page.getByTestId('map-hash').textContent())!;
  const undo = page.getByRole('button', { name: '撤销', exact: true });
  await diagnose(page, hash);
  await expect(page.getByTestId('issue-panel')).toContainText('0 错误');
  await expect(page.getByTestId('diagnostic-controls')).toContainText('未检查');
  await page.getByTestId('issue-panel').getByRole('button').filter({ hasText: 'P2A_FACILITY_NO_SERVICE' }).first().click();
  await expect(page.getByTestId('diagnostic-marker')).toHaveAttribute('data-position', JSON.stringify(original.map.facilities.F_010!.boundary.outer[0]));
  await route(page);
  await expect(page.getByTestId('path-status')).toHaveText('在已声明条件下找到路径');
  await expect(page.getByTestId('diagnostic-controls')).toContainText('78.500 m');
  await expect(page.getByTestId('path-overlay')).toHaveAttribute('data-map-hash', hash);
  await expect(undo).toBeDisabled();
  expect(await exportMap(page, info, 'A-after-diagnosis.map.json')).toEqual(original.map);
  await page.getByText('基础图层与标签', { exact: true }).click();
  await page.getByTestId('layer-visible-facilities').uncheck(); await page.getByTestId('layer-locked-facilities').check();
  await diagnose(page, hash);
  await expect(page.getByTestId('issue-panel').getByRole('button').filter({ hasText: 'P2A_FACILITY_NO_SERVICE' })).toHaveCount(8);
  expect(await exportMap(page, info, 'A-hidden-diagnosis.map.json')).toEqual(original.map);
  await page.getByLabel('地图名称', { exact: true }).fill(original.map.metadata.name + ' pending');
  await diagnose(page, hash); // Pending input remains pending, excluded from committed analysis.
  await expect(page.getByLabel('地图名称', { exact: true })).toHaveValue(original.map.metadata.name + ' pending');
  await expect(undo).toBeDisabled();
  await page.getByRole('button', { name: '应用地图名称', exact: true }).click();
  await expect(page.getByTestId('diagnostic-status')).toContainText('旧诊断已失效');
  await expect(page.getByTestId('path-status')).toContainText('旧路线已失效');
  await expect(page.getByTestId('path-overlay')).toHaveAttribute('data-map-hash', '');
  await expect(page.getByTestId('diagnostic-marker')).toHaveAttribute('data-position', 'null');
  await undo.click(); await expect(page.getByTestId('map-hash')).toHaveText(hash);
  expect(await exportMap(page, info, 'A-diagnosis-undo.map.json')).toEqual(original.map);
  await page.getByRole('button', { name: '保存工程', exact: true }).click();
  await expect(page.getByTestId('browser-save-status')).toContainText('已保存', { timeout: 30000 });
  await page.reload(); await expect(page.getByTestId('map-hash')).toHaveText(hash, { timeout: 30000 });
  expect(await exportMap(page, info, 'A-diagnosis-recovered.map.json')).toEqual(original.map);
  await page.getByTestId('diagnostic-controls').locator('summary').click();
  await expect(page.getByTestId('diagnostic-status')).toHaveText('尚未运行。');
  await diagnose(page, hash); await route(page);
  await page.getByRole('button', { name: '适应地图', exact: true }).click();
  const viewport = page.viewportSize()!;
  const layout = await page.evaluate(() => ({ height: document.documentElement.scrollHeight, absoluteOverflow: [...document.querySelectorAll('*')].filter(node => getComputedStyle(node).position === 'absolute' && node.getBoundingClientRect().bottom > innerHeight + 1).slice(0, 20).map(node => ({ tag: node.tagName, class: node.className, testid: node.getAttribute('data-testid'), bottom: node.getBoundingClientRect().bottom, parent: node.parentElement?.className })) }));
  if (layout.height > viewport.height + 1) console.info(JSON.stringify(layout));
  expect(layout.height).toBeLessThanOrEqual(viewport.height + 1);
  const canvas = await page.getByTestId('map-canvas').boundingBox();
  expect(canvas?.height).toBeGreaterThan(300);
  await page.screenshot({ path: info.outputPath('P2A-original-A-current.png'), fullPage: true });
  await readP1Target(originalA);
});

test('P2A original D: complete input diagnostic remains bounded and readonly', async ({ page }, info) => {
  test.setTimeout(120000);
  const target = P1_TARGETS.find(target => target.id === 'SR03_D')!;
  const original = await readP1Target(target); await open(page, original.map, target.absolutePath);
  const hash = (await page.getByTestId('map-hash').textContent())!; const started = performance.now();
  await diagnose(page, hash); const elapsedMs = performance.now() - started;
  await route(page); await expect(page.getByTestId('path-status')).toHaveText('在已声明条件下找到路径');
  await expect(page.getByTestId('diagnostic-controls')).toContainText('570.000 m');
  await expect(page.getByRole('button', { name: '撤销', exact: true })).toBeDisabled();
  expect(await exportMap(page, info, 'D-after-diagnosis.map.json')).toEqual(original.map);
  await info.attach('diagnostic-observation', { body: JSON.stringify({ inputSha256: target.sha256, mapContentHash: hash, elapsedMs, environment: 'dev browser integration observation, not production performance evidence' }), contentType: 'application/json' });
  await readP1Target(target);
});

test('P2A fault-injected A slot outside owner: precise issue location and no repair on save/reload', async ({ page }, info) => {
  const { map } = await readP1Target(originalA); map.mapId = 'P2A_fault_browser_SR03_A_slot_outside'; map.metadata.name = map.mapId + ' synthetic test clone';
  const slots = (map.facilities.F_001!.extensions!['sr02.planning'] as { slots: { boundary: Polygon }[] }).slots;
  slots[0]!.boundary.outer = slots[0]!.boundary.outer.map(([x,y,z]) => [x - 1000,y,z]) as Polygon['outer'];
  await open(page, map); const hash = (await page.getByTestId('map-hash').textContent())!;
  await diagnose(page, hash);
  const issue = page.getByTestId('issue-panel').getByRole('button').filter({ hasText: 'SPATIAL_SLOT_OUTSIDE_OWNER' });
  await expect(issue).toContainText('/facilities/F_001/extensions/sr02.planning/slots/0/boundary'); await issue.click();
  await expect(page.getByTestId('diagnostic-marker')).toHaveAttribute('data-position', JSON.stringify(slots[0]!.boundary.outer[0]));
  await expect(page.getByRole('button', { name: '撤销', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '保存工程', exact: true }).click();
  await expect(page.getByTestId('browser-save-status')).toContainText('已保存', { timeout: 30000 });
  await page.reload(); await expect(page.getByTestId('map-hash')).toHaveText(hash, { timeout: 30000 });
  expect(await exportMap(page, info, 'P2A_fault_slot_outside-preserved.map.json')).toEqual(map);
  await readP1Target(originalA);
});

for (const fault of ['unknown_direction', 'unknown_behavior'] as const) {
  test('P2A fault-injected A ' + fault + ': unknown conditions never become a confirmed route', async ({ page }, info) => {
    const { map } = await readP1Target(originalA); map.mapId = 'P2A_fault_browser_A_' + fault; map.metadata.name = map.mapId + ' synthetic test clone';
    if (fault === 'unknown_direction') { map.roads.R_0009!.direction = 'unknown'; map.roads.R_0010!.direction = 'unknown'; }
    else { map.extensionNamespaces['test.unknown'] = { category: 'behavior', version: '1' }; map.extensions['test.unknown'] = { mustKeep: 'unknown semantics' }; }
    await open(page, map); await route(page);
    await expect(page.getByTestId('path-status')).toContainText(fault === 'unknown_direction' ? '未确认' : '未检查');
    if (fault === 'unknown_behavior') {
      await expect(page.getByLabel('地图名称', { exact: true })).toBeDisabled();
      await expect(page.getByTestId('path-overlay')).toHaveAttribute('data-map-hash', '');
    } else await expect(page.getByTestId('diagnostic-controls')).toContainText('方向未声明允许');
    expect(await exportMap(page, info, map.mapId + '.map.json')).toEqual(map);
    await expect(page.getByRole('button', { name: '撤销', exact: true })).toBeDisabled();
    await readP1Target(originalA);
  });
}
