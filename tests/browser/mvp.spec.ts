import { test, expect, type APIRequestContext } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { initialWorkspace } from '../../lib/types';

const control = `http://127.0.0.1:${process.env.OPEN_HARNESS_TEST_PORT || 4317}`;
async function seed(request: APIRequestContext) {
  const { token } = await (await request.get(control + '/v1/bootstrap')).json();
  await request.post(control + '/v1/agents/sync', {
    headers: { Authorization: `Bearer ${token}` },
    data: { agents: initialWorkspace.agents },
  });
}

test.beforeEach(async ({ request, page }) => {
  await seed(request);
  await page.addInitScript(() => {
    localStorage.setItem('open-harness.onboarding.v1', 'done');
    localStorage.removeItem('open-harness.advanced.v1');
  });
  await page.goto(`/?controlPort=${process.env.OPEN_HARNESS_TEST_PORT || 4317}`);
  await expect(page.getByRole('button', { name: 'Edit Atlas profile' })).toBeVisible();
});

test.afterEach(async ({ request }) => {
  const { token } = await (await request.get(control + '/v1/bootstrap')).json();
  await request.post(control + '/v1/runs/stop-all', { headers: { Authorization: `Bearer ${token}` } });
});

test('keeps the MVP navigation focused until advanced features are enabled', async ({ page }, testInfo) => {
  if (testInfo.project.name === 'mobile') await page.getByRole('button', { name: 'Open navigation' }).click();
  await expect(page.getByRole('button', { name: /Teams/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /Routines/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Tasks', exact: true })).toHaveCount(0);
  if (testInfo.project.name === 'mobile') await page.getByRole('button', { name: 'Close navigation' }).dispatchEvent('click');
  await page.getByRole('button', { name: 'Edit Atlas profile' }).click();
  await expect(page.getByRole('tab', { name: 'Computer' })).toHaveCount(0);
  await page.getByRole('tab', { name: 'Tools & connections' }).click();
  await expect(page.getByRole('heading', { name: 'MCP connections' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Close agent settings' }).click();

  if (testInfo.project.name === 'mobile') await page.getByRole('button', { name: 'Open navigation' }).click();
  await page.getByRole('button', { name: /Settings/ }).first().click();
  await page.getByLabel('Advanced features').check();
  await page.getByRole('button', { name: 'Close settings' }).click();
  await expect(page.getByRole('button', { name: /Teams/ }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: /Routines/ }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Tasks', exact: true })).toBeVisible();
});

test('does not mark setup complete after a failed model check and supports retry', async ({ page }, testInfo) => {
  let attempts = 0;
  await page.route('**/v1/onboarding/model-test', async route => {
    attempts += 1;
    if (attempts === 1) await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: false, message: 'The API key was rejected.' }) });
    else await route.continue();
  });
  if (testInfo.project.name === 'mobile') await page.getByRole('button', { name: 'Open navigation' }).click();
  await page.getByRole('button', { name: /Settings/ }).first().click();
  await page.getByRole('button', { name: 'Run setup again' }).click();
  await page.getByRole('button', { name: /Use this computer/ }).click();
  await page.getByRole('button', { name: 'Continue' }).click();
  const setup = page.getByRole('dialog', { name: 'Connect your model' });
  await setup.getByLabel('API key').fill('test-key');
  await setup.getByRole('button', { name: 'Save and test' }).click();
  await expect(setup.getByRole('status')).toContainText('API key was rejected');
  await expect(page.getByRole('dialog', { name: 'You’re ready' })).toHaveCount(0);
  await setup.getByRole('button', { name: 'Save and test' }).click();
  await expect(page.getByRole('dialog', { name: 'You’re ready' })).toBeVisible();
});

test('creates an agent from the focused interface', async ({ page }, testInfo) => {
  const name = testInfo.project.name === 'mobile' ? 'Mobile Launch Writer' : 'Desktop Launch Writer';
  await page.getByRole('button', { name: 'Create agent' }).click();
  const editor = page.getByRole('dialog', { name: 'Agent settings' });
  await expect(editor.getByText('Loading saved profile…')).toBeHidden();
  await editor.getByLabel('Name').fill(name);
  await editor.getByLabel('Role').fill('Release notes editor');
  await editor.getByRole('button', { name: 'Save changes' }).click();
  await expect(editor.getByText(/Saved\. Ready for the next task\./)).toBeVisible();
  await editor.getByRole('button', { name: 'Close agent settings' }).click();
  await expect(page.getByRole('button', { name: `Edit ${name} profile` })).toBeVisible();
});

test('submits work and restores a pending approval after reconnect', async ({ page }) => {
  await page.route(`${control}/v1/bootstrap`, async route => {
    const response = await route.fetch();
    const status = await response.json();
    await route.fulfill({ response, json: { ...status, mode: 'live' } });
  });
  await page.reload();
  await page.getByRole('button', { name: 'Meet Atlas' }).click();
  await page.getByLabel('Message Atlas').fill('MOCK_APPROVAL verify browser reconnect');
  await page.getByLabel('Message Atlas').press('Enter');
  await expect(page.getByRole('alert')).toContainText('Atlas needs approval');

  page.on('dialog', dialog => void dialog.accept());
  await page.reload();
  const approval = page.getByRole('alert');
  await expect(approval).toContainText('Atlas needs approval');
  await approval.getByRole('button', { name: 'Approve once' }).click();
  await expect(page.getByText('Hermes mock completed the task.')).toBeVisible();
});

test('downloads the exact contents of a workspace file', async ({ page }, testInfo) => {
  const contents = '# Launch smoke\n\nExact browser download contents.\n';
  await page.locator('input[type="file"][multiple]').setInputFiles({
    name: 'launch-smoke.md',
    mimeType: 'text/markdown',
    buffer: Buffer.from(contents),
  });
  if (testInfo.project.name === 'mobile') await page.getByRole('button', { name: 'Open navigation' }).click();
  await page.getByRole('button', { name: /Files/ }).first().click();
  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download launch-smoke.md' }).click();
  const saved = await downloadPromise;
  expect(saved.suggestedFilename()).toBe('launch-smoke.md');
  expect(readFileSync(await saved.path(), 'utf8')).toBe(contents);
});
