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
    localStorage.setItem('open-harness.advanced.v1', 'on');
  });
  await page.goto(`/?controlPort=${process.env.OPEN_HARNESS_TEST_PORT || 4317}`);
  await expect(page.getByRole('button', { name: 'Edit Atlas profile' })).toBeVisible();
});

test.afterEach(async ({ request }) => {
  const { token } = await (await request.get(control + '/v1/bootstrap')).json();
  await request.post(control + '/v1/runs/stop-all', { headers: { Authorization: `Bearer ${token}` } });
});

test('offers a focused workspace when advanced features are turned off, and restores them', async ({ page }, testInfo) => {
  // Teams, boards and remote computers ship on, so turning them off is what produces the
  // focused workspace. Routines stay reachable either way: the coordinator runs them whether
  // or not the view is shown, and hiding the only place to pause one would strand them.
  const mobile = testInfo.project.name === 'mobile';
  const openNav = async () => { if (mobile) await page.getByRole('button', { name: 'Open navigation' }).click(); };
  const closeNav = async () => { if (mobile) await page.getByRole('button', { name: 'Close navigation' }).dispatchEvent('click'); };

  await openNav();
  await expect(page.getByRole('button', { name: /Teams/ }).first()).toBeVisible();
  await page.getByRole('button', { name: /Settings/ }).first().click();
  await page.getByLabel('Advanced features').uncheck();
  await page.getByRole('button', { name: 'Close settings' }).click();
  await expect(page.getByRole('button', { name: /Routines/ }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: /Teams/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Tasks', exact: true })).toHaveCount(0);

  await closeNav();
  await page.getByRole('button', { name: 'Edit Atlas profile' }).click();
  await expect(page.getByRole('tab', { name: 'Computer' })).toHaveCount(0);
  await page.getByRole('tab', { name: 'Tools & connections' }).click();
  await expect(page.getByRole('heading', { name: 'MCP connections' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Close agent settings' }).click();

  await openNav();
  await page.getByRole('button', { name: /Settings/ }).first().click();
  await page.getByLabel('Advanced features').check();
  await page.getByRole('button', { name: 'Close settings' }).click();
  await expect(page.getByRole('button', { name: /Teams/ }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: /Routines/ }).first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Tasks', exact: true })).toBeVisible();
});

test('a hidden Computer tab never opens a panel with no way back', async ({ page }, testInfo) => {
  const mobile = testInfo.project.name === 'mobile';
  if (mobile) await page.getByRole('button', { name: 'Open navigation' }).click();
  await page.getByRole('button', { name: /Settings/ }).first().click();
  await page.getByLabel('Advanced features').uncheck();
  await page.getByRole('button', { name: 'Close settings' }).click();
  if (mobile) await page.getByRole('button', { name: 'Close navigation' }).dispatchEvent('click');
  await page.getByRole('button', { name: 'Edit Atlas profile' }).click();
  await expect(page.getByRole('tab', { name: 'Computer' })).toHaveCount(0);
  // Whatever panel opens has to belong to a tab the tablist actually offers.
  const selected = page.getByRole('tab', { selected: true });
  await expect(selected).toHaveCount(1);
  await expect(selected).toHaveAccessibleName('Profile');
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

test('a coordinator that cannot be reached is stated plainly and recovered from', async ({ page }, testInfo) => {
  // The failure used to be a toast that cleared itself after a few seconds, leaving the app
  // looking healthy beside a status dot that was always green.
  let reachable = false;
  await page.route(`${control}/v1/bootstrap`, async route => {
    if (!reachable) return route.abort('connectionrefused');
    await route.continue();
  });
  await page.reload();

  const banner = page.getByRole('alert').filter({ hasText: 'cannot reach its control service' });
  await expect(banner).toBeVisible();
  const dot = page.locator('.status-dot.offline');
  await expect(dot).toHaveCount(1);
  if (testInfo.project.name === 'desktop') await expect(dot).toBeVisible();
  // It has to still be there well after the old toast would have cleared.
  await page.waitForTimeout(7000);
  await expect(banner).toBeVisible();

  reachable = true;
  await banner.getByRole('button', { name: 'Try again' }).click();
  await expect(banner).toBeHidden();
  await expect(page.locator('.status-dot.offline')).toHaveCount(0);
});

test('reopening a task run streams the work into the conversation it belongs to', async ({ page, request }) => {
  await page.route(`${control}/v1/bootstrap`, async route => {
    const response = await route.fetch();
    await route.fulfill({ response, json: { ...(await response.json()), mode: 'live' } });
  });
  await page.reload();

  // A conversation that already exists but holds no reply for this run is the case that used
  // to drop everything: the page followed a message id it had never added to the thread, so
  // every token, tool call and error went nowhere.
  const { token } = await (await request.get(control + '/v1/bootstrap')).json();
  const conversationId = `conversation-${Date.now()}`;
  // Written before page scripts run, and built outright rather than patched onto whatever a
  // previous test happened to save, so the conversation is always there when the page hydrates.
  await page.addInitScript(({ workspace, id }) => {
    localStorage.setItem('open-harness.workspace.v2', JSON.stringify({
      ...workspace,
      conversations: [{ id, agentId: 'atlas', title: 'Earlier work', updatedAt: new Date().toISOString(), messages: [{ id: 'm-old', role: 'user' as const, content: 'Earlier work here' }] }],
    }));
  }, { workspace: initialWorkspace, id: conversationId });

  // Pause the run on an approval so it is still live when the page comes back.
  await request.post(control + '/v1/runs', {
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    data: { agentId: 'atlas', conversationId, prompt: 'MOCK_APPROVAL reattach into the right message' },
  });
  page.on('dialog', dialog => void dialog.accept());
  await page.reload();

  const approval = page.getByRole('alert').filter({ hasText: 'needs approval' });
  await expect(approval).toBeVisible();
  await approval.getByRole('button', { name: 'Approve once' }).click();
  // Visible completion text means the events landed in a message the conversation actually has.
  await expect(page.getByText('Hermes mock completed the task.')).toBeVisible();
  await expect(page.getByText('Earlier work here')).toBeVisible();
});
