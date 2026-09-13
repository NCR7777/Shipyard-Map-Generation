import { expect, type Locator, type Page } from '@playwright/test';

/** Use the visible workbench entry points; do not set DOM open state or bypass commands. */
export async function openFileMenu(page: Page): Promise<void> {
  const summary = page.locator('.workbench-menu > summary').filter({ hasText: /^文件$/ });
  if (!await summary.evaluate(element => (element.parentElement as HTMLDetailsElement).open)) await summary.click();
}
export async function fileAction(page: Page, name: string): Promise<void> {
  const dialogAction = page.getByRole('dialog').getByRole('button', { name, exact: true });
  if (await dialogAction.isVisible()) { await dialogAction.click(); return; }
  await openFileMenu(page);
  await page.getByRole('button', { name, exact: true }).click();
}
export async function chooseBrowserSaveTarget(page: Page): Promise<void> {
  const target = page.getByRole('dialog', { name: '选择保存目标', exact: true });
  if (await target.isVisible()) await target.getByRole('button', { name: '仅保存浏览器恢复', exact: true }).click();
}
export async function saveToBrowser(page: Page): Promise<void> {
  await page.getByRole('button', { name: '保存工程', exact: true }).click();
  await chooseBrowserSaveTarget(page);
}
export async function saveShortcutToBrowser(page: Page): Promise<void> {
  await page.keyboard.press('Control+s');
  await chooseBrowserSaveTarget(page);
}
export async function openDrawingSettings(page: Page): Promise<void> {
  const summary = page.locator('summary').filter({ hasText: /^绘图与显示设置$/ });
  if (!await summary.evaluate(element => (element.parentElement as HTMLDetailsElement).open)) await summary.click();
}
export async function drawingAction(page: Page, name: string): Promise<void> {
  await openDrawingSettings(page);
  await page.getByRole('button', { name, exact: true }).click();
}
export async function drawingControl(page: Page, label: string): Promise<Locator> {
  await openDrawingSettings(page);
  return page.getByLabel(label, { exact: true });
}
export async function openChecks(page: Page): Promise<void> {
  const button = page.getByRole('button', { name: '检查与问题', exact: true });
  if (await button.getAttribute('aria-expanded') !== 'true') await button.click();
  await expect(page.getByRole('region', { name: '检查与问题', exact: true })).toBeVisible();
}

// Independent expected preference contract, kept explicit in whole EditorState comparisons.
export const defaultWorkbench = {
  leftWidth: 240, rightWidth: 300, leftCollapsed: 'auto', rightCollapsed: 'auto',
  drawerHeight: 240, saveTarget: 'ask',
} as const;
