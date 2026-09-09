import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { test, expect, type Locator, type Page, type TestInfo } from '@playwright/test';
import type { YardMap } from '../../src/domain/model';

async function download(page: Page, info: TestInfo, filename: string, button?: Locator): Promise<YardMap> {
  const pending = page.waitForEvent('download');
  await (button ?? page.getByRole('button', { name: '导出 JSON', exact: true })).click();
  const path = info.outputPath(filename);
  await (await pending).saveAs(path);
  return JSON.parse(await readFile(path, 'utf8')) as YardMap;
}
async function saved(page: Page) { await expect(page.getByTestId('browser-save-status')).toContainText('已保存'); }

test('N01 N26 explicit upgrade preserves the old JSON backup, cancels pending-input loss, and has stable undo/redo', async ({ page }, info) => {
  const sourcePath = fileURLToPath(new URL('../../examples/M2A_synthetic.map.json', import.meta.url));
  const sourceText = await readFile(sourcePath, 'utf8');
  const original = JSON.parse(sourceText) as YardMap;
  expect(original.schemaVersion).toBe('0.1.0');
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await expect(page.getByRole('button', { name: '保存工程', exact: true })).toBeEnabled();
  await saved(page);
  await page.getByTestId('json-file-input').setInputFiles(sourcePath);
  const conflict = page.getByRole('dialog', { name: '未保存编辑冲突', exact: true });
  const facilityId = Object.keys(original.facilities)[0]!;
  const item = page.getByTestId('facilities-item-' + facilityId);
  await expect.poll(async () => await conflict.isVisible() || await item.isVisible()).toBe(true);
  if (await conflict.isVisible()) await conflict.getByRole('button', { name: '放弃编辑并重载', exact: true }).click();
  await expect(item).toBeVisible();
  await saved(page);
  const oldHash = await page.getByTestId('map-hash').textContent();
  expect(await download(page, info, 'M2A1-upgrade-original.map.json')).toEqual(original);

  await item.click();
  await page.getByLabel('名称', { exact: true }).fill('尚未提交的升级前名称');
  const upgrade = page.getByRole('button', { name: '升级到 0.2.0', exact: true });
  await upgrade.click();
  const leave = page.getByRole('dialog', { name: '未应用输入保护', exact: true });
  await expect(leave).toBeVisible();
  await leave.getByRole('button', { name: '取消，保留输入', exact: true }).click();
  await expect(page.getByLabel('名称', { exact: true })).toHaveValue('尚未提交的升级前名称');
  await expect(page.getByTestId('map-hash')).toHaveText(oldHash!);
  expect(await download(page, info, 'M2A1-upgrade-cancelled.map.json')).toEqual(original);

  await upgrade.click();
  await leave.getByRole('button', { name: '丢弃未应用输入并继续', exact: true }).click();
  const modal = page.getByRole('dialog', { name: '显式升级地图契约', exact: true });
  await expect(modal).toBeVisible();
  await expect(page.getByLabel('名称', { exact: true })).toHaveValue(original.facilities[facilityId]!.name);
  await modal.getByRole('button', { name: '取消', exact: true }).click();
  await expect(page.getByTestId('map-hash')).toHaveText(oldHash!);
  await upgrade.click();
  expect(await download(page, info, 'M2A1-upgrade-modal-original.map.json', modal.getByRole('button', { name: '导出升级前原图', exact: true }))).toEqual(original);
  await modal.getByRole('button', { name: '保留原图并升级', exact: true }).click();
  await expect(modal).not.toBeVisible();
  await expect(upgrade).not.toBeVisible();
  await saved(page);
  const migrated = await download(page, info, 'M2A1-upgraded.map.json');
  expect(migrated).toEqual({ ...original, schemaVersion: '0.2.0', revision: original.revision + 1 });
  const upgradedHash = await page.getByTestId('map-hash').textContent();
  expect(upgradedHash).not.toBe(oldHash);

  await page.getByRole('button', { name: '撤销', exact: true }).click();
  await expect(page.getByTestId('map-hash')).toHaveText(oldHash!);
  await expect(upgrade).toBeVisible();
  expect(await download(page, info, 'M2A1-upgrade-undone.map.json')).toEqual(original);
  await page.getByRole('button', { name: '重做', exact: true }).click();
  await expect(page.getByTestId('map-hash')).toHaveText(upgradedHash!);
  expect(await download(page, info, 'M2A1-upgrade-redone.map.json')).toEqual(migrated);
  await saved(page);

  await page.getByRole('button', { name: '最近项目', exact: true }).click();
  const recent = page.getByRole('dialog', { name: '最近项目', exact: true });
  const backup = recent.getByRole('button').filter({ has: page.getByText(original.metadata.name + '（恢复副本）', { exact: true }) });
  await expect(backup).toHaveCount(1);
  await backup.click();
  await expect(recent).not.toBeVisible();
  await expect(page.getByTestId('map-hash')).toHaveText(oldHash!);
  await expect(upgrade).toBeVisible();
  expect(await download(page, info, 'M2A1-upgrade-restored-backup.map.json')).toEqual(original);
  expect(await readFile(sourcePath, 'utf8')).toBe(sourceText);
  expect(errors).toEqual([]);
});
