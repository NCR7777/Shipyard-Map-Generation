import { expect, type Page } from '@playwright/test';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Vec3, YardMap } from '../../src/domain/model';
import { GA01_TARGETS, readGA01Target } from './GA01_targets';
import { browserSaved, expectVisiblePosition, importMapUI, readyWorkbench, storedWorkspace } from './RF01_workbench';

export async function savedMap(page: Page): Promise<YardMap> {
  await browserSaved(page);
  await expect.poll(async () => (await storedWorkspace(page)).record?.draft?.contentHash).toBe(await page.getByTestId('map-hash').textContent());
  return JSON.parse((await storedWorkspace(page)).record!.draft!.mapJson) as YardMap;
}
export async function canvasClick(page: Page, point: Vec3) {
  const p = await expectVisiblePosition(page, point); await page.mouse.click(p.x, p.y);
}
export async function chooseSpatial(page: Page, kind: 'facilities' | 'zones', id: string) {
  await page.getByRole('button', { name: '选择', exact: true }).click();
  await page.getByTestId('object-search').fill(id); await page.getByTestId(kind + '-item-' + id).click();
}
export async function classificationBackground(page: Page, suffix: string) {
  const target = GA01_TARGETS.find(target => target.id === 'cimc_v02')!;
  const original = await readGA01Target(target), sample = structuredClone(original);
  sample.mapId = 'MAP_CLASSIFICATION_' + suffix; sample.metadata.name = 'CIMC 分类与深度编辑验收 ' + suffix;
  await readyWorkbench(page); await importMapUI(page, sample);
  const imagePath = resolve('.cache/BG01/calibrated-cimc/background.jpg');
  const imageSHA = createHash('sha256').update(await readFile(imagePath)).digest('hex');
  expect(imageSHA).toBe('8ec6e74a72c9757f7113a440832dc9d9166518fe7f9da75979629a2cdb2ef713');
  await page.getByRole('button', { name: '底图', exact: true }).click();
  await page.getByTestId('background-file-input').setInputFiles([imagePath, resolve('.cache/BG01/calibrated-cimc/calibration.json')]);
  await expect(page.getByTestId('background-calibration-status')).toContainText('校准匹配');
  await page.getByRole('button', { name: '添加此底图', exact: true }).click();
  await expect(page.getByTestId('background-render-state')).toHaveAttribute('data-loaded', '1');
  await page.getByRole('button', { name: '适应底图', exact: true }).click();
  await page.locator('summary').filter({ hasText: /^底图显示与调整$/ }).click();
  await page.getByRole('button', { name: '收起属性面板', exact: true }).click();
  await page.getByRole('button', { name: '道路', exact: true }).click();
  await page.getByRole('button', { name: '保留原图并升级', exact: true }).click();
  const baseline = await savedMap(page); expect(baseline.schemaVersion).toBe('0.3.0');
  for (const kind of ['roads', 'nodes', 'junctions', 'movements', 'resources', 'accessPoints', 'servicePoints'] as const) expect(Object.keys(baseline[kind]).length).toBeGreaterThan(0);
  return { baseline, original, target, imageSHA };
}
export async function undoRedoMap(page: Page, before: YardMap, after: YardMap) {
  await page.getByRole('button', { name: '撤销', exact: true }).click(); expect(await savedMap(page)).toEqual(before);
  await page.getByRole('button', { name: '重做', exact: true }).click(); expect(await savedMap(page)).toEqual(after);
}
export function unchangedNetwork(before: YardMap, after: YardMap) {
  for (const field of ['coordinateFrame', 'nodes', 'roads', 'junctions', 'movements', 'resources', 'accessPoints', 'servicePoints'] as const) expect(after[field]).toEqual(before[field]);
  for (const kind of ['facilities', 'zones'] as const) for (const [id, entity] of Object.entries(before[kind])) {
    expect(after[kind][id]!.boundary).toEqual(entity.boundary);
    expect(after[kind][id]!.kind).toBe(entity.kind);
    expect(after[kind][id]!.extensions?.['sr02.planning']).toEqual(entity.extensions?.['sr02.planning']);
  }
}
