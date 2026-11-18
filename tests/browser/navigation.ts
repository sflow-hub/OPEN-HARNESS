import { expect, type Page } from '@playwright/test';

export async function openNavigation(page: Page) {
  const drawer = page.locator('aside.sidebar.open');
  if (!await drawer.isVisible()) await page.getByRole('button', { name: 'Open navigation', exact: true }).click();
  await expect(drawer).toBeVisible();
}

export async function closeNavigation(page: Page) {
  const drawer = page.locator('aside.sidebar.open');
  if (await drawer.isVisible()) await drawer.getByRole('button', { name: 'Close navigation' }).click();
  await expect(drawer).toBeHidden();
}

export async function openWorkspaceSettings(page: Page) {
  await closeNavigation(page);
  await page.locator('main > header').getByRole('button', { name: 'Settings', exact: true }).click();
}
