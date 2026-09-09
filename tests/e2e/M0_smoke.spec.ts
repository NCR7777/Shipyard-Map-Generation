import { test, expect } from '@playwright/test';
test('React and Konva load in a real browser without runtime errors', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '船厂空间布局编辑器', exact: true })).toBeVisible();
  await expect(page.locator('canvas').first()).toBeVisible();
  expect(errors).toEqual([]);
});
