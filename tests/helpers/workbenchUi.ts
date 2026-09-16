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
  await expect(target).toHaveCount(0);
}
export async function saveToBrowser(page: Page): Promise<void> {
  const options = page.getByLabel('保存选项', { exact: true });
  if (!await options.evaluate(element => (element.parentElement as HTMLDetailsElement).open)) await options.click();
  await page.getByRole('button', { name: '仅保存浏览器恢复', exact: true }).click();
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
  await page.locator('details').filter({ has: page.locator(':scope > summary').filter({ hasText: /^绘图与显示设置$/ }) }).getByRole('button', { name, exact: true }).click();
  // Existing low-level association fixtures explicitly use the retained advanced declaration path.
  // UX02 ordinary-flow tests exercise the canvas wizard instead.
  if (name === '添加入口' || name === '添加服务点') {
    const continuous = page.getByRole('complementary', { name: '连续添加入口', exact: true });
    if (await continuous.isVisible()) await continuous.getByRole('button', { name: '单个入口与接路设置', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.locator('summary').filter({ hasText: /^高级关联声明$/ }).click();
    await dialog.getByRole('button', { name: '打开高级关联表单', exact: true }).click();
  }
}
export async function drawingControl(page: Page, label: string): Promise<Locator> {
  await openDrawingSettings(page);
  return revealProperty(page, label);
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

/** Reveal an existing property through real summary clicks; never force a hidden input. */
export async function revealProperty(page: Page, label: string): Promise<Locator> {
  const field = page.getByLabel(label, { exact: true });
  const ancestors = await field.locator('xpath=ancestor::details').all();
  for (const details of ancestors) {
    if (!await details.evaluate(element => (element as HTMLDetailsElement).open)) await details.locator(':scope > summary').click();
  }
  return field;
}

/** Open one declared property section through its real disclosure control. */
export async function openPropertyDetails(page: Page, title: string): Promise<void> {
  const summary = page.locator('summary').filter({ hasText: new RegExp('^' + title + '$') });
  if (!await summary.evaluate(element => (element.parentElement as HTMLDetailsElement).open)) await summary.click();
}
