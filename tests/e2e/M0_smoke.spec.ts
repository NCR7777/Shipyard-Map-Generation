import { test, expect } from '@playwright/test';
test('React and Konva load in a real browser without runtime errors', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await expect(page.getByTestId('workbench')).toBeVisible();
  await expect(page.locator('canvas').first()).toBeVisible();
  expect(errors).toEqual([]);
});
