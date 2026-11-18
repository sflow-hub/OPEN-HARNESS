import { test, expect } from '@playwright/test';
import { initialWorkspace } from '../../lib/types';

const control = `http://127.0.0.1:${process.env.OPEN_HARNESS_TEST_PORT || 4317}`;

test.beforeEach(async ({ request, page }) => {
  const { token } = await (await request.get(control + '/v1/bootstrap')).json();
  await request.post(control + '/v1/agents/sync', { headers: { Authorization: `Bearer ${token}` }, data: { agents: initialWorkspace.agents } });
  await page.addInitScript(() => localStorage.setItem('open-harness.onboarding.v1', 'done'));
});

test('starts work with the chosen agent from home and creates a fresh conversation on return', async ({ page }) => {
  await page.route('**/v1/bootstrap', async route => {
    const response = await route.fetch();
    await route.fulfill({ response, json: { ...await response.json(), mode: 'live' } });
  });
  await page.goto(`/?controlPort=${process.env.OPEN_HARNESS_TEST_PORT || 4317}`);
  await expect(page.getByRole('img', { name: 'Agent runtime ready' })).toBeVisible();
  await page.getByLabel('Choose agent').selectOption('scout');
  await page.getByLabel('Message Scout').fill('First task from home');
  const firstRequest = page.waitForRequest(request => request.url().endsWith('/v1/runs') && request.method() === 'POST');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  const first = (await firstRequest).postDataJSON();
  expect(first.agentId).toBe('scout');
  await expect(page.getByText('Hermes mock completed the task.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeVisible();

  await page.getByRole('button', { name: 'Open Harness home' }).click();
  await page.getByLabel('Message Scout').fill('A separate task from home');
  const secondRequest = page.waitForRequest(request => request.url().endsWith('/v1/runs') && request.method() === 'POST');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  const second = (await secondRequest).postDataJSON();
  expect(second.agentId).toBe('scout');
  expect(second.conversationId).not.toBe(first.conversationId);
  await expect(page.locator('.transcript').getByText('A separate task from home', { exact: true })).toBeVisible();
  await expect(page.locator('.transcript').getByText('First task from home', { exact: true })).toHaveCount(0);
});

test('opens conversation search with the keyboard and returns to the quiet workspace', async ({ page }) => {
  await page.goto(`/?controlPort=${process.env.OPEN_HARNESS_TEST_PORT || 4317}`);
  await expect(page.getByRole('button', { name: 'Edit Atlas profile' })).toBeVisible();
  await page.keyboard.press('ControlOrMeta+k');
  await expect(page.getByLabel('Search conversations')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Workspace navigation' })).toHaveCount(0);
  await expect(page.getByLabel('Message Atlas')).toBeVisible();
});
