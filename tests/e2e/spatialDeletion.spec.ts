import { test, expect, type Page } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import type { YardMap, Vec3 } from '../../src/domain/model';
import { GA01_TARGETS, readGA01Target } from '../helpers/GA01_targets';
import { readyWorkbench, importMapUI, browserSaved, storedWorkspace, expectVisiblePosition } from '../helpers/RF01_workbench';

test.use({ viewport: { width: 1920, height: 1080 } });
async function current(page: Page): Promise<YardMap> {
  await browserSaved(page);
  await expect.poll(async () => (await storedWorkspace(page)).record?.draft?.contentHash).toBe(await page.getByTestId('map-hash').textContent());
  return JSON.parse((await storedWorkspace(page)).record!.draft!.mapJson);
}
async function choose(page: Page, kind: 'facilities' | 'zones', id: string) {
  await page.getByTestId('object-search').fill(id);
  await page.getByTestId(kind + '-item-' + id).click();
}

test('real CIMC with existing advanced references deletes new outlines and explicit members atomically', async ({ page }, info) => {
  test.setTimeout(120000);
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  const original = await readGA01Target(GA01_TARGETS.find(target => target.id === 'cimc_v02')!);
  const sample = structuredClone(original); sample.mapId = 'MAP_CIMC_DELETE_EDITING'; sample.metadata.name = 'CIMC 真实底图删除事务验收副本';
  await readyWorkbench(page); await importMapUI(page, sample);
  const image = resolve('.cache/BG01/calibrated-cimc/background.jpg');
  expect(createHash('sha256').update(await readFile(image)).digest('hex')).toBe('8ec6e74a72c9757f7113a440832dc9d9166518fe7f9da75979629a2cdb2ef713');
  await page.getByRole('button', { name: '底图', exact: true }).click();
  await page.getByTestId('background-file-input').setInputFiles([image, resolve('.cache/BG01/calibrated-cimc/calibration.json')]);
  await expect(page.getByTestId('background-calibration-status')).toContainText('校准匹配');
  await page.getByRole('button', { name: '添加此底图', exact: true }).click();
  await expect(page.getByTestId('background-render-state')).toHaveAttribute('data-loaded', '1');
  await page.getByRole('button', { name: '适应底图', exact: true }).click();
  await page.locator('summary').filter({ hasText: /^底图显示与调整$/ }).click();
  await page.getByRole('button', { name: '收起属性面板', exact: true }).click();
  await page.getByRole('button', { name: '道路', exact: true }).click();
  await page.getByRole('button', { name: '保留原图并升级', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const click = async (point: Vec3) => { const p = await expectVisiblePosition(page, point); await page.mouse.click(p.x, p.y); };
  const baseline = await current(page);
  expect(Object.keys(baseline.movements).length + Object.keys(baseline.junctions).length + Object.keys(baseline.resources).length).toBeGreaterThan(0);
  const deletion = page.getByRole('dialog', { name: '删除空间对象', exact: true });
  for (const kind of ['facilities', 'zones'] as const) {
    const before = await current(page);
    await page.getByLabel(kind === 'facilities' ? '建筑绘制形状' : '区域绘制形状', { exact: true }).selectOption(kind === 'facilities' ? 'facilityRect' : 'zoneRect');
    await click([320, 930, 0]); await click([380, 990, 0]);
    await page.getByRole('button', { name: '选择', exact: true }).click();
    const drawn = await current(page), id = Object.keys(drawn[kind]).find(id => !before[kind][id])!;
    expect(id).toBeTruthy();
    await choose(page, kind, id);
    await page.getByRole('button', { name: '删除', exact: true }).click();
    await expect(deletion.getByTestId('delete-impact')).not.toContainText('OPERATION_DEPENDENCIES_UNSUPPORTED');
    await deletion.getByRole('button', { name: '确认删除', exact: true }).click();
    await expect(deletion).toHaveCount(0);
    const removed = await current(page); expect(removed[kind][id]).toBeUndefined();
    expect(removed.nodes).toEqual(before.nodes); expect(removed.roads).toEqual(before.roads);
    expect(removed.movements).toEqual(before.movements); expect(removed.junctions).toEqual(before.junctions); expect(removed.resources).toEqual(before.resources);
    await page.getByRole('button', { name: '撤销', exact: true }).click(); expect(await current(page)).toEqual(drawn);
    await page.getByRole('button', { name: '重做', exact: true }).click(); expect(await current(page)).toEqual(removed);
  }
  await page.getByLabel('建筑绘制形状', { exact: true }).selectOption('facilityRect');
  await click([320, 930, 0]); await click([380, 990, 0]); await page.getByRole('button', { name: '选择', exact: true }).click();
  const drawn = await current(page), id = Object.keys(drawn.facilities).find(id => !baseline.facilities[id])!;
  await choose(page, 'facilities', id);
  await page.getByRole('button', { name: '添加入口', exact: true }).last().click();
  await expect(page.getByLabel('创建时接路', { exact: true })).toHaveValue('deferred');
  await page.getByRole('button', { name: '在画布放置入口', exact: true }).click(); await click([320, 960, 0]);
  await page.getByRole('button', { name: '创建入口', exact: true }).click();
  await expect(page.getByRole('dialog', { name: '添加入口', exact: true })).toHaveCount(0);
  const member = await current(page), gateId = Object.keys(member.accessPoints).find(key => !drawn.accessPoints[key])!;
  expect(member.facilities[id]!.accessPointIds).toEqual([gateId]);
  expect(member.roads).toEqual(drawn.roads);
  await choose(page, 'facilities', id); await page.getByRole('button', { name: '删除', exact: true }).click();
  await expect(deletion.getByTestId('delete-impact')).toContainText('FACILITY_HAS_POINTS');
  const hash = await page.getByTestId('map-hash').textContent();
  await deletion.getByRole('button', { name: '确认删除', exact: true }).click();
  await expect(page.getByTestId('map-hash')).toHaveText(hash!); expect(await current(page)).toEqual(member);
  await deletion.getByLabel('一并删除设施或区域成员入口和服务点', { exact: true }).check();
  await deletion.getByLabel('清理成员点不再使用的节点', { exact: true }).check();
  await deletion.getByRole('button', { name: '确认删除', exact: true }).click(); await expect(deletion).toHaveCount(0);
  const removed = await current(page);
  expect(removed.facilities[id]).toBeUndefined(); expect(removed.accessPoints[gateId]).toBeUndefined();
  expect(removed.nodes).toEqual(drawn.nodes); expect(removed.roads).toEqual(drawn.roads); expect(removed.resources).toEqual(drawn.resources);
  await page.getByRole('button', { name: '撤销', exact: true }).click(); expect(await current(page)).toEqual(member);
  await page.getByRole('button', { name: '保存工程', exact: true }).click(); await browserSaved(page);
  await page.screenshot({ path: info.outputPath('real-cimc-outline-delete-restored.png'), fullPage: true });
  await page.reload(); await expect(page.getByRole('button', { name: '保存工程', exact: true })).toBeEnabled(); expect(await current(page)).toEqual(member);
  expect(errors).toEqual([]);
});
