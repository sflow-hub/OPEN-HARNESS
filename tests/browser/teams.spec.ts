import { test, expect, type APIRequestContext } from '@playwright/test';
import { initialWorkspace } from '../../lib/types';

const control = `http://127.0.0.1:${process.env.OPEN_HARNESS_TEST_PORT || 4317}`;
async function seed(request: APIRequestContext) {
  const { token } = await (await request.get(control + '/v1/bootstrap')).json();
  await request.post(control + '/v1/agents/sync', { headers: { Authorization: `Bearer ${token}` }, data: { agents: initialWorkspace.agents } });
}

test.beforeEach(async ({ request, page }) => {
  await seed(request);
  await page.addInitScript(() => localStorage.setItem('open-harness.onboarding.v1', 'done'));
  await page.goto(`/?controlPort=${process.env.OPEN_HARNESS_TEST_PORT || 4317}`);
  await expect(page.getByRole('button', { name: 'Edit Atlas profile' })).toBeVisible();
});

test('creates a visual team with multiple members and filters agents', async ({ page }, testInfo) => {
  const teamName = `Launch crew ${testInfo.project.name}`;
  if (testInfo.project.name === 'mobile') await page.getByRole('button', { name: 'Open navigation' }).click();
  await page.getByRole('button', { name: /Teams/ }).first().click();
  await page.getByRole('button', { name: 'Create team' }).click();
  const dialog = page.getByRole('dialog', { name: 'Create team' });
  await dialog.getByLabel('Team name').fill(teamName);
  await dialog.getByLabel('Description').fill('Ships the release together.');
  await dialog.getByRole('button', { name: 'violet team color' }).click();
  await dialog.getByRole('button', { name: 'rocket team icon' }).click();
  await dialog.getByRole('button', { name: /Atlas/ }).click();
  await dialog.getByRole('button', { name: /Scout/ }).click();
  await dialog.getByRole('button', { name: 'Save team' }).click();
  const teamCard = page.getByRole('button', { name: `Manage ${teamName}` });
  await expect(teamCard).toBeVisible();
  await expect(teamCard.getByText('2 members')).toBeVisible();

  if (testInfo.project.name === 'mobile') await page.getByRole('button', { name: 'Open navigation' }).click();
  await page.getByRole('button', { name: /Agents/ }).first().click();
  await page.getByRole('button', { name: teamName, exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Atlas' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Scout' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Scribe' })).toBeHidden();
});

test('scopes task assignment choices to the selected team', async ({ page, request }) => {
  const { token } = await (await request.get(control + '/v1/bootstrap')).json();
  const headers = { Authorization: `Bearer ${token}` };
  const teamName = `Task crew ${Date.now()}`;
  await request.post(control + '/v1/teams', { headers, data: { name: teamName, description: '', color: 'sage', icon: 'people', memberAgentIds: ['atlas', 'scout'] } });
  await page.reload();
  await page.getByRole('button', { name: 'Tasks' }).click();
  await page.getByRole('button', { name: 'New task' }).click();
  const drawer = page.locator('.task-drawer');
  await drawer.getByLabel('Team').selectOption({ label: teamName });
  await expect(drawer.getByLabel('Owner')).toContainText('Atlas');
  await expect(drawer.getByLabel('Owner')).toContainText('Scout');
  await expect(drawer.getByLabel('Owner')).not.toContainText('Scribe');
  await drawer.getByLabel('Owner').selectOption('atlas');
  await drawer.getByRole('button', { name: /Scout/ }).click();
  await drawer.getByPlaceholder('What needs to be done?').fill('Prepare the launch brief');
  await drawer.getByRole('button', { name: /Save/ }).last().click();
  await expect(page.getByRole('dialog', { name: 'Task details' })).toBeVisible();
  await expect(drawer.getByLabel('Team').locator('option:checked')).toHaveText(teamName);
});
