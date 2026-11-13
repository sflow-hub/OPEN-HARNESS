import { test, expect } from '@playwright/test';
import { initialWorkspace } from '../../lib/types';
const controlPort = process.env.OPEN_HARNESS_TEST_PORT || 4317;

test.beforeEach(async ({ page, request, isMobile }) => {
  test.skip(!isMobile, 'Phone browser behavior');
  const { token } = await (await request.get(`http://127.0.0.1:${controlPort}/v1/bootstrap`)).json();
  await request.post(`http://127.0.0.1:${controlPort}/v1/agents/sync`, { headers: { Authorization: `Bearer ${token}` }, data: { agents: initialWorkspace.agents } });
  await page.addInitScript(() => localStorage.setItem('open-harness.onboarding.v1', 'done'));
  await page.goto(`/?controlPort=${controlPort}`);
  await expect(page.getByRole('button', { name: 'Edit Atlas profile' })).toBeVisible();
});

test('the composer follows a shrunken visual viewport and recovers when the keyboard closes', async ({ page }) => {
  await page.locator('.agent-card').filter({ hasText: 'Atlas' }).click();
  const layout = page.locator('.chat-layout'), composer = page.locator('.composer-wrap');
  const send = (await page.locator('.send-button').boundingBox())!;
  expect(Math.min(send.width, send.height)).toBeGreaterThanOrEqual(44);
  const initial = (await layout.boundingBox())!.height;
  await page.evaluate(() => {
    Object.defineProperty(window.visualViewport!, 'height', { configurable: true, value: window.innerHeight - 280 });
    Object.defineProperty(window.visualViewport!, 'offsetTop', { configurable: true, value: 0 });
    Object.defineProperty(window.visualViewport!, 'scale', { configurable: true, value: 1 });
    window.visualViewport!.dispatchEvent(new Event('resize'));
  });
  await expect.poll(async () => Math.round((await layout.boundingBox())!.height)).toBe(Math.round(initial - 280));
  expect((await composer.boundingBox())!.y + (await composer.boundingBox())!.height).toBeLessThanOrEqual(await page.evaluate(() => window.innerHeight - 280 + 1));
  await page.evaluate(() => {
    Object.defineProperty(window.visualViewport!, 'height', { configurable: true, value: window.innerHeight });
    window.visualViewport!.dispatchEvent(new Event('resize'));
  });
  await expect.poll(async () => Math.round((await layout.boundingBox())!.height)).toBe(Math.round(initial));
});

test('Back dismisses stacked workspace panels without leaving the dashboard', async ({ page }) => {
  const url = page.url();
  await page.getByRole('button', { name: 'Open navigation' }).click();
  await page.locator('aside.sidebar').getByRole('button', { name: /^Settings/ }).click();
  const settings = page.getByRole('dialog', { name: 'Workspace settings' });
  await expect(settings).toBeVisible();
  await page.goBack();
  await expect(settings).toBeHidden();
  await expect(page.locator('aside.sidebar.open')).toBeVisible();
  await page.goBack();
  await expect(page.locator('aside.sidebar.open')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Edit Atlas profile' })).toBeVisible();
  expect(page.url()).toBe(url);
});

test('Back preserves an unsaved agent profile and works after an overlay handoff', async ({ page }) => {
  await page.getByRole('button', { name: 'Edit Atlas profile' }).click();
  const panel = page.getByRole('dialog', { name: 'Agent settings' });
  await expect(panel.getByText('Loading saved profile…')).toBeHidden();
  await panel.getByLabel('Name', { exact: true }).fill('Keep my draft');
  await page.goBack();
  await expect(panel.getByRole('alertdialog')).toBeVisible();
  await expect(panel.getByLabel('Name', { exact: true })).toHaveValue('Keep my draft');
  await panel.getByRole('button', { name: 'Discard changes' }).click();
  await expect(panel).toBeHidden();
  await page.getByRole('button', { name: 'Open navigation' }).click();
  await page.locator('aside.sidebar').getByRole('button', { name: /^Settings/ }).click();
  await page.getByRole('button', { name: 'Run setup again' }).click();
  const onboarding = page.getByRole('dialog', { name: 'Welcome to Open Harness' });
  await expect(onboarding).toBeVisible();
  await page.goBack();
  await expect(onboarding).toBeHidden();
  await expect(page.getByRole('button', { name: 'Edit Atlas profile' })).toBeVisible();
});
