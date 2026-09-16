import { test, expect, type APIRequestContext } from '@playwright/test';
import { initialWorkspace } from '../../lib/types';
import { draftProfile } from '../../lib/agent-profile';
const control = `http://127.0.0.1:${process.env.OPEN_HARNESS_TEST_PORT || 4317}`;
async function seed(request: APIRequestContext) {
  const { token } = await (await request.get(control + '/v1/bootstrap')).json();
  const headers = { Authorization: `Bearer ${token}` };
  await request.post(control + '/v1/agents/sync', { headers, data: { agents: initialWorkspace.agents } });
  for (const agent of initialWorkspace.agents) {
    const { profile } = await (await request.get(control + `/v1/agents/${agent.id}/profile`, { headers })).json();
    await request.put(control + `/v1/agents/${agent.id}/profile`, { headers, data: { ...draftProfile(agent), revision: profile.revision } });
  }
}
test.beforeEach(async ({ request, page }) => { await seed(request); await page.addInitScript(() => localStorage.setItem('open-harness.onboarding.v1', 'done')); await page.goto(`/?controlPort=${process.env.OPEN_HARNESS_TEST_PORT || 4317}`); await expect(page.getByRole('button', { name: 'Edit Atlas profile' })).toBeVisible(); });

test('guides first-time users through computer and model readiness', async ({ page }, testInfo) => {
  if (testInfo.project.name === 'mobile') await page.getByRole('button', { name: 'Open navigation' }).click();
  await page.getByRole('button', { name: /Settings/ }).first().click();
  await page.getByRole('button', { name: 'Run setup again' }).click();
  const setup = page.getByRole('dialog', { name: 'Welcome to Open Harness' });
  await expect(setup).toBeVisible();
  await setup.getByRole('button', { name: /Use this computer/ }).click();
  await expect(page.getByRole('dialog', { name: 'Check this computer' }).getByText('The pinned Hermes runtime is ready.')).toBeVisible();
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('dialog', { name: 'Connect your model' })).toBeVisible();
  await page.getByRole('dialog', { name: 'Connect your model' }).getByLabel('API key').fill('test-key');
  await page.getByRole('button', { name: 'Save and test' }).click();
  await expect(page.getByRole('dialog', { name: 'You’re ready' })).toBeVisible();
  await page.getByRole('button', { name: 'Start using Open Harness' }).click();
  await expect(page.getByRole('dialog', { name: 'You’re ready' })).toBeHidden();
});

test('edits identity, model, prompt and tools, then persists on reload', async ({ page }) => {
  await page.getByRole('button', { name: 'Edit Atlas profile' }).click();
  const panel = page.getByRole('dialog', { name: 'Agent settings' });
  await expect(panel.getByText('Loading saved profile…')).toBeHidden();
  await panel.getByLabel('Name', { exact: true }).fill('Atlas Custom');
  await panel.getByLabel('Violet', { exact: true }).check();
  await panel.getByRole('tab', { name: 'Model', exact: true }).click();
  await panel.getByRole('switch', { name: 'Use workspace default' }).uncheck();
  await panel.getByLabel('Provider', { exact: true }).selectOption('openrouter');
  await panel.getByRole('combobox', { name: 'Model', exact: true }).fill('custom-research-model');
  await panel.getByRole('tab', { name: 'System prompt', exact: true }).click();
  await panel.getByLabel('System prompt / agent instructions').fill('Research thoroughly. Save source citations.');
  await panel.getByRole('switch', { name: 'Use custom instructions' }).uncheck();
  await expect(panel.getByLabel('System prompt / agent instructions')).toBeDisabled();
  await panel.getByRole('switch', { name: 'Use custom instructions' }).check();
  await panel.getByRole('tab', { name: 'Tools & connections' }).click();
  await expect(panel.getByText('Deterministic test runtime — tool availability is simulated.')).toBeVisible();
  await panel.getByRole('checkbox', { name: 'Enable Browser', exact: true }).check();
  await panel.getByText('Browser', { exact: true }).click();
  await panel.getByRole('switch', { name: 'browser screenshot', exact: true }).uncheck();
  await panel.getByRole('button', { name: 'Save changes', exact: true }).click();
  await expect(panel.getByText('Saved. Ready for the next task.')).toBeVisible();
  await panel.getByRole('button', { name: 'Close agent settings' }).click();
  await page.reload(); await page.getByRole('button', { name: 'Edit Atlas Custom profile' }).click();
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Atlas Custom');
  await page.getByRole('tab', { name: 'Model', exact: true }).click();
  await expect(page.getByRole('combobox', { name: 'Model', exact: true })).toHaveValue('custom-research-model');
});

test('cancel preserves saved values and validates missing identity', async ({ page }) => {
  await page.getByRole('button', { name: 'Edit Atlas profile' }).click();
  const panel = page.getByRole('dialog', { name: 'Agent settings' });
  await expect(panel.getByText('Loading saved profile…')).toBeHidden();
  await panel.getByLabel('Name', { exact: true }).fill('');
  await panel.getByRole('button', { name: 'Save changes' }).click();
  await expect(panel.getByRole('alert')).toHaveText('Give this agent a name and a role.');
  await panel.getByRole('button', { name: 'Cancel', exact: true }).click();
  await panel.getByRole('button', { name: 'Keep editing' }).click();
  await expect(panel.getByLabel('Name', { exact: true })).toHaveValue('');
  await panel.getByRole('button', { name: 'Cancel', exact: true }).click();
  await panel.getByRole('button', { name: 'Discard changes', exact: true }).click();
  await page.getByRole('button', { name: 'Edit Atlas profile' }).click();
  await expect(page.getByLabel('Name', { exact: true })).toHaveValue('Atlas');
});

test('failed save retains the draft and remains retryable', async ({ page }) => {
  await page.getByRole('button', { name: 'Edit Atlas profile' }).click();
  const panel = page.getByRole('dialog', { name: 'Agent settings' });
  await expect(panel.getByText('Loading saved profile…')).toBeHidden();
  await panel.getByLabel('Role', { exact: true }).fill('A persistent draft');
  await page.route('**/v1/agents/atlas/profile', route => route.request().method() === 'PUT' ? route.fulfill({ status: 503, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ error: 'Service offline. Your draft is still here.' }) }) : route.continue());
  await panel.getByRole('button', { name: 'Save changes' }).click();
  await expect(panel.getByRole('alert')).toContainText('Service offline');
  await expect(panel.getByLabel('Role', { exact: true })).toHaveValue('A persistent draft');
  await page.unroute('**/v1/agents/atlas/profile');
  await panel.getByRole('button', { name: 'Save changes' }).click();
  await expect(panel.getByText('Saved. Ready for the next task.')).toBeVisible();
});

test('connection form discovers individual MCP tools without browser prompts', async ({ page }) => {
  await page.getByRole('button', { name: 'Edit Atlas profile' }).click();
  const panel = page.getByRole('dialog', { name: 'Agent settings' });
  await expect(panel.getByText('Loading saved profile…')).toBeHidden();
  await panel.getByRole('tab', { name: 'Tools & connections' }).click();
  await panel.getByRole('button', { name: 'Add MCP connection', exact: true }).click();
  await panel.getByLabel('Connection name').fill('research');
  await panel.getByLabel('Executable', { exact: true }).fill('npx');
  await panel.getByLabel('Arguments — one per line').fill('-y\nexample-mcp');
  await panel.getByRole('button', { name: 'Test connection', exact: true }).click();
  await expect(panel.getByText('connected · 1 tools discovered')).toBeVisible();
  await panel.getByRole('checkbox', { name: 'Enable MCP connections' }).check();
  await panel.getByRole('button', { name: 'Save changes' }).click();
  await expect(panel.getByText('Saved. Ready for the next task.')).toBeVisible();
});

test('keyboard tab navigation and phone layout keep save controls visible', async ({ page }, testInfo) => {
  await page.getByRole('button', { name: 'Edit Atlas profile' }).click();
  const panel = page.getByRole('dialog', { name: 'Agent settings' });
  await panel.getByRole('tab', { name: 'Profile', exact: true }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(panel.getByRole('tab', { name: 'Computer', exact: true })).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('ArrowRight');
  await expect(panel.getByRole('tab', { name: 'Model', exact: true })).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('End');
  await expect(panel.getByRole('tab', { name: 'Tools & connections' })).toHaveAttribute('aria-selected', 'true');
  const button = await panel.getByRole('button', { name: 'Save changes' }).boundingBox();
  expect(button).not.toBeNull(); expect(button!.y + button!.height).toBeLessThanOrEqual(page.viewportSize()!.height);
  if (testInfo.project.name === 'mobile') {
    const bounds = await panel.boundingBox(); expect(bounds!.width).toBe(page.viewportSize()!.width);
  }
  await page.screenshot({ path: `test-results/profile-${testInfo.project.name}.png`, fullPage: true });
});

test('configures computer access and automatically selects a paired computer', async ({ page, request }) => {
  await page.getByRole('button', { name: 'Edit Atlas profile' }).click();
  const panel = page.getByRole('dialog', { name: 'Agent settings' });
  await expect(panel.getByText('Loading saved profile…')).toBeHidden();
  await panel.getByRole('tab', { name: 'Computer', exact: true }).click();
  await expect(panel.getByLabel('Connected computer')).toContainText(/online/);
  await panel.getByText('Selected folders', { exact: true }).click();
  await panel.getByText('Advanced resources and shared folders').click();
  await panel.getByRole('button', { name: 'Add folder' }).click();
  await panel.getByLabel('Shared folder 1 path').fill('/tmp/open-harness-project');
  await panel.getByLabel('Shared folder 1 access').selectOption('write');
  await panel.getByLabel('Desktop access').selectOption('virtual');
  await panel.getByRole('button', { name: 'Add computer' }).click();
  await panel.getByLabel('Computer name').fill('Design workstation');
  await panel.getByLabel('Computer operating system').selectOption('win32');
  await panel.getByRole('button', { name: 'Create pairing command' }).click();
  await expect(panel.getByLabel('Run on the computer')).toContainText('runner.ps1');
  await expect(panel.getByLabel('Run on the computer')).toContainText('OPEN_HARNESS_PAIRING_CODE');
  await expect(panel.getByText('Waiting for this computer. It will be selected automatically when it connects.')).toBeVisible();
  const command = await panel.getByLabel('Run on the computer').inputValue();
  const code = command.match(/OPEN_HARNESS_PAIRING_CODE='([^']+)'/)?.[1];
  expect(code).toBeTruthy();
  await request.post(control + '/v1/runner/pair', { data: { code, name: 'Design workstation', platform: 'win32', arch: 'x64', capabilities: { container: true, direct: true, desktop: true, virtualDesktop: false } } });
  await expect(panel.getByText('Design workstation connected and was selected for this agent.')).toBeVisible({ timeout: 5_000 });
  await expect(panel.getByLabel('Connected computer')).toHaveValue(/machine-/);
  await panel.getByRole('button', { name: 'Save changes' }).click();
  await expect(panel.getByText('Saved. Ready for the next task.')).toBeVisible();
});

test('group switches and Disable all tools preserve an explicit empty selection', async ({ page, request }) => {
  await page.getByRole('button', { name: 'Edit Atlas profile' }).click();
  const panel = page.getByRole('dialog', { name: 'Agent settings' });
  await expect(panel.getByText('Loading saved profile…')).toBeHidden();
  await panel.getByRole('tab', { name: 'Tools & connections' }).click();
  await panel.getByRole('checkbox', { name: 'Enable Browser', exact: true }).check();
  await panel.getByRole('checkbox', { name: 'Enable Browser', exact: true }).uncheck();
  await panel.getByRole('checkbox', { name: 'Enable Files', exact: true }).check();
  await panel.getByRole('button', { name: 'Save changes' }).click();
  await expect(panel.getByText('Saved. Ready for the next task.')).toBeVisible();
  await panel.getByRole('button', { name: 'Disable all tools' }).click();
  await panel.getByRole('button', { name: 'Save changes' }).click();
  await expect(panel.getByText('Saved. Ready for the next task.')).toBeVisible();
  const { token } = await (await request.get(control + '/v1/bootstrap')).json();
  const { profile } = await (await request.get(control + '/v1/agents/atlas/profile', { headers: { Authorization: `Bearer ${token}` } })).json();
  expect(profile.allowedTools).toEqual([]);
});

test('a stale save keeps the draft and can load the winning revision', async ({ page, request }) => {
  await page.getByRole('button', { name: 'Edit Atlas profile' }).click();
  const panel = page.getByRole('dialog', { name: 'Agent settings' });
  await expect(panel.getByText('Loading saved profile…')).toBeHidden();
  await panel.getByLabel('Role', { exact: true }).fill('My unsaved role');
  const { token } = await (await request.get(control + '/v1/bootstrap')).json();
  const headers = { Authorization: `Bearer ${token}` };
  const { profile } = await (await request.get(control + '/v1/agents/atlas/profile', { headers })).json();
  await request.put(control + '/v1/agents/atlas/profile', { headers, data: { ...profile, role: 'Saved elsewhere' } });
  await panel.getByRole('button', { name: 'Save changes' }).click();
  await expect(panel.getByRole('alert')).toContainText('changed elsewhere');
  await expect(panel.getByLabel('Role', { exact: true })).toHaveValue('My unsaved role');
  await panel.getByRole('button', { name: 'Replace draft with saved version' }).click();
  await expect(panel.getByLabel('Role', { exact: true })).toHaveValue('Saved elsewhere');
});

test('creates, filters, and moves an agent task across desktop and phone layouts', async ({ page }, testInfo) => {
  const boardName = `Release board ${testInfo.project.name}`;
  const title = `Prepare release notes ${testInfo.project.name}`;
  await page.getByRole('button', { name: 'Tasks', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Tasks', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'New board', exact: true }).click();
  const boardDialog = page.getByRole('dialog', { name: 'New project board' });
  await boardDialog.getByLabel('Board name').fill(boardName);
  await boardDialog.getByRole('button', { name: 'Create board' }).click();
  await expect(boardDialog).toBeHidden();
  const projectSelect = page.locator('.task-select select');
  await expect(projectSelect).toHaveValue(/.+/);
  await expect(projectSelect.locator('option', { hasText: boardName })).toHaveCount(1);
  await page.getByRole('button', { name: 'New task', exact: true }).click();
  const drawer = page.locator('.task-drawer');
  await drawer.getByPlaceholder('What needs to be done?').fill(title);
  await drawer.getByLabel('Owner').selectOption('atlas');
  await drawer.getByRole('button', { name: /Scout/ }).click();
  await drawer.getByRole('button', { name: 'Add item' }).click();
  await drawer.getByPlaceholder('Checklist item').fill('Summarize shipped changes');
  await drawer.getByRole('button', { name: 'Save', exact: true }).click();
  await drawer.getByRole('button', { name: 'Close task' }).click();
  const card = page.locator('.task-card').filter({ hasText: title });
  await expect(card).toBeVisible();
  await card.getByRole('button', { name: 'Move right' }).click();
  await page.getByRole('button', { name: 'List', exact: true }).click();
  await expect(page.getByRole('cell', { name: title })).toBeVisible();
  await page.getByRole('button', { name: /Filter/ }).click();
  await page.getByRole('group', { name: 'Owner' }).getByLabel('Atlas').check();
  await expect(page.getByText('atlas', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'By agent', exact: true }).click();
  await expect(page.locator('.agent-task-card').filter({ hasText: 'Atlas' })).toContainText('Owned');
});
