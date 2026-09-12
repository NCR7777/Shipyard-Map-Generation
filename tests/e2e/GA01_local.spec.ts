import { readFile } from 'node:fs/promises';
import { expect, test, type Page, type TestInfo } from '@playwright/test';
import type { Vec3, YardMap } from '../../src/domain/model';
import { GA01_TARGETS, readGA01Target, assertGA01Equal } from '../helpers/GA01_targets';

async function exported(page: Page, info: TestInfo, name: string): Promise<YardMap> {
  const pending = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出 JSON', exact: true }).click();
  const path = info.outputPath(name + '.map.json'); await (await pending).saveAs(path);
  return JSON.parse(await readFile(path, 'utf8')) as YardMap;
}

test('GA01 B real Hanwha leaf drag is one transaction; locked indirect junctions and resources reject actual numeric submissions', async ({ page }, info) => {
  test.setTimeout(150000);
  const target = GA01_TARGETS.find(item => item.id === 'hanwha_v02')!;
  const before = await readGA01Target(target), node = before.nodes[target.nodeId]!;
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('/'); await expect(page.getByRole('button', { name: '保存工程', exact: true })).toBeEnabled();
  await page.getByTestId('json-file-input').setInputFiles({ name: target.id + '.map.json', mimeType: 'application/json', buffer: await readFile(target.absolutePath) });
  await expect(page.getByLabel('地图名称', { exact: true })).toHaveValue(before.metadata.name, { timeout: 30000 });
  await expect(page.getByTestId('browser-save-status')).toContainText('已保存', { timeout: 30000 });
  assertGA01Equal(await exported(page, info, 'imported'), before);
  await page.getByTestId('object-search').fill(target.nodeId);
  await page.getByTestId('node-item-' + target.nodeId).click();
  await expect(page.getByLabel('稳定 ID', { exact: true })).toHaveValue(target.nodeId);
  await page.getByRole('button', { name: '定位 ' + target.nodeId, exact: true }).click();
  await page.getByLabel('网格吸附', { exact: true }).selectOption('0');
  await page.getByLabel('节点吸附', { exact: true }).uncheck();
  const canvas = await page.getByTestId('map-canvas').locator('canvas').first().boundingBox();
  if (!canvas) throw new Error('canvas unavailable');
  const camera = page.getByTestId('camera-state');
  const scale = Number(await camera.getAttribute('data-scale'));
  const ox = Number(await camera.getAttribute('data-offset-x')), oy = Number(await camera.getAttribute('data-offset-y'));
  const start = { x: canvas.x + ox + node.position[0] * scale, y: canvas.y + oy - node.position[1] * scale };
  const requested: Vec3 = [node.position[0] + 1, node.position[1], node.position[2]];
  const beforeHash = await page.getByTestId('map-hash').textContent();
  await page.mouse.move(start.x, start.y); await page.mouse.down();
  await page.mouse.move(start.x + scale, start.y, { steps: 100 });
  await expect(page.getByTestId('map-hash')).toHaveText(beforeHash!);
  await expect(page.locator('.canvas-status')).toContainText('0 个撤销事务');
  await page.mouse.up();
  await expect(page.getByTestId('map-hash')).not.toHaveText(beforeHash!);
  await expect(page.locator('.canvas-status')).toContainText('1 个撤销事务');
  const after = await exported(page, info, 'dragged');
  assertGA01Equal(after.nodes[target.nodeId]!.position, requested, 'pointer drag must apply exactly the requested metre offset');
  expect(after.revision).toBe(before.revision + 1);
  const provenance = after.nodes[target.nodeId]!.provenance;
  const source = provenance.fieldSources?.position; expect(source).toBeTruthy();
  expect(after.sources[source!]!.category).toBe('design_assumption');
  for (const [id, value] of Object.entries(before.sources)) assertGA01Equal(after.sources[id], value);
  assertGA01Equal(Object.keys(after.sources).filter(id => !Object.hasOwn(before.sources, id)), Object.hasOwn(before.sources, source!) ? [] : [source]);
  assertGA01Equal(provenance, { ...node.provenance, sourceRefs: [...new Set([...(node.provenance.sourceRefs ?? []), source])], fieldSources: { ...node.provenance.fieldSources, position: source } });
  const normalized = structuredClone(after); normalized.nodes[target.nodeId] = structuredClone(node); normalized.sources = structuredClone(before.sources); normalized.revision = before.revision;
  assertGA01Equal(normalized, before, 'all other declarations, coordinate frame, IDs, resources and slots stay exact');
  await expect(page.getByTestId('field-sources')).toContainText('position');
  await page.getByRole('button', { name: '撤销', exact: true }).click();
  assertGA01Equal(await exported(page, info, 'undo'), before);
  await expect(page.getByRole('button', { name: '撤销', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: '重做', exact: true }).click();
  assertGA01Equal(await exported(page, info, 'redo'), after);

  const layers = page.getByText('基础图层与标签', { exact: true });
  if (await layers.locator('..').getAttribute('open') === null) await layers.click();
  const rejections: string[] = [];
  for (const kind of ['junctions', 'resources'] as const) {
    await page.getByTestId('layer-locked-' + kind).check();
    const hash = await page.getByTestId('map-hash').textContent();
    const x = page.getByLabel('X (m)', { exact: true });
    await expect(x).toBeEnabled(); await x.fill(String(requested[0] + 0.01));
    const apply = page.getByRole('button', { name: '应用属性', exact: true });
    await expect(apply).toBeEnabled(); await apply.click();
    await expect(page.getByTestId('issue-panel')).toContainText('LOCKED_DEPENDENCY');
    await expect(page.getByTestId('issue-panel')).toContainText(kind + '/');
    await expect(page.getByTestId('map-hash')).toHaveText(hash!);
    await expect(page.locator('.canvas-status')).toContainText('1 个撤销事务');
    await expect(page.getByRole('button', { name: '重做', exact: true })).toBeDisabled();
    assertGA01Equal(await exported(page, info, 'rejected-' + kind), after);
    rejections.push(kind); await x.fill(String(requested[0]));
    await page.getByTestId('layer-locked-' + kind).uncheck();
  }
  await page.screenshot({ path: info.outputPath('GA01-B-real-drag-and-lock.png'), fullPage: true });
  await info.attach('GA01-local-receipt.json', { body: JSON.stringify({ id: target.id, originalSHA256: target.sha256, nodeId: target.nodeId, requestedPointerSteps: 100, camera: { scale, ox, oy }, expectedPosition: requested, actualPosition: after.nodes[target.nodeId]!.position, oneTransaction: true, exactOtherDeclarations: true, framePreserved: true, undoRedo: true, rejectedNumericSubmissions: rejections }, null, 2), contentType: 'application/json' });
  expect(errors).toEqual([]); await readGA01Target(target);
});
