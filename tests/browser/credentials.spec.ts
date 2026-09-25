import { test, expect, type APIRequestContext } from '@playwright/test';
import { initialWorkspace } from '../../lib/types';
import { draftProfile } from '../../lib/agent-profile';

const control = `http://127.0.0.1:${process.env.OPEN_HARNESS_TEST_PORT || 4317}`;
const WORK_KEY = 'browser-work-key-value', PERSONAL_KEY = 'browser-personal-key-value';

async function seed(request: APIRequestContext) {
  const { token } = await (await request.get(control + '/v1/bootstrap')).json();
  const headers = { Authorization: `Bearer ${token}` };
  await request.post(control + '/v1/agents/sync', { headers, data: { agents: initialWorkspace.agents } });
  for (const agent of initialWorkspace.agents) {
    const { profile } = await (await request.get(control + `/v1/agents/${agent.id}/profile`, { headers })).json();
    await request.put(control + `/v1/agents/${agent.id}/profile`, { headers, data: { ...draftProfile(agent), revision: profile.revision } });
  }
  // Leave no credentials behind; specs run in one shared control service.
  const { credentials } = await (await request.get(control + '/v1/credentials', { headers })).json();
  for (const item of credentials as Array<{ ref: string }>) await request.delete(control + `/v1/credentials/${item.ref}?force=1`, { headers });
}

type Page = import('@playwright/test').Page;
const openManager = async (page: Page, project: string) => {
  if (project === 'mobile') await page.getByRole('button', { name: 'Open navigation' }).click();
  await page.getByRole('button', { name: /Settings/ }).first().click();
  await page.getByRole('button', { name: 'Saved credentials' }).click();
  return page.getByRole('dialog', { name: 'Saved credentials' });
};
// On phones the drawer stays open behind the modal and would swallow later clicks.
const closeSettings = async (page: Page, project: string) => {
  await page.getByRole('button', { name: 'Close settings' }).click();
  if (project === 'mobile') await page.getByRole('button', { name: 'Close navigation' }).dispatchEvent('click');
};
// The card and the conversation header render the same switcher. On phones the workspace
// panel overlays the chat header (as it already does the toolbar buttons), so the card is
// the reachable surface there.
const openSwitcher = async (page: Page, project: string) => {
  if (project !== 'mobile') await page.getByRole('button', { name: 'Meet Atlas' }).click();
  await page.getByRole('button', { name: 'Credential for Atlas' }).click();
};
async function addCredential(page: Page, label: string, value: string) {
  const dialog = page.getByRole('dialog', { name: 'Saved credentials' });
  await dialog.getByRole('button', { name: 'Add credential' }).click();
  await dialog.getByLabel('Name').fill(label);
  await dialog.getByLabel('Value').fill(value);
  await dialog.getByRole('button', { name: 'Save credential' }).click();
  await expect(dialog.getByText(label, { exact: true })).toBeVisible();
}

test.beforeEach(async ({ request, page }) => {
  await seed(request);
  await page.addInitScript(() => localStorage.setItem('open-harness.onboarding.v1', 'done'));
  await page.goto(`/?controlPort=${process.env.OPEN_HARNESS_TEST_PORT || 4317}`);
  await expect(page.getByRole('button', { name: 'Edit Atlas profile' })).toBeVisible();
});

test('stores several credentials without ever exposing a value', async ({ page }, testInfo) => {
  const dialog = await openManager(page, testInfo.project.name);
  await expect(dialog.getByText('No saved credentials yet.')).toBeVisible();
  await addCredential(page, 'Work key', WORK_KEY);
  await addCredential(page, 'Personal key', PERSONAL_KEY);
  await expect(dialog.getByText('Not in use').first()).toBeVisible();
  // The value is write-only: it must not survive into the rendered page anywhere.
  const rendered = await page.content();
  expect(rendered).not.toContain(WORK_KEY);
  expect(rendered).not.toContain(PERSONAL_KEY);
});

test('switches an agent between credentials from the quick switcher', async ({ page }, testInfo) => {
  await openManager(page, testInfo.project.name);
  await addCredential(page, 'Work key', WORK_KEY);
  await addCredential(page, 'Personal key', PERSONAL_KEY);
  await page.getByRole('button', { name: 'Close saved credentials' }).click();
  await closeSettings(page, testInfo.project.name);

  await openSwitcher(page, testInfo.project.name);
  await page.getByLabel('Saved credential').selectOption({ label: 'Work key' });
  await page.getByRole('button', { name: 'Apply model and credential' }).click();
  await expect(page.getByRole('button', { name: 'Credential for Atlas' })).toContainText('Work key');

  // The choice is a profile edit, so it must survive a reload.
  await page.reload();
  await expect(page.getByRole('button', { name: 'Credential for Atlas' })).toContainText('Work key');

  await page.getByRole('button', { name: 'Credential for Atlas' }).click();
  await page.getByLabel('Saved credential').selectOption({ label: 'Personal key' });
  await page.getByRole('button', { name: 'Apply model and credential' }).click();
  await expect(page.getByRole('button', { name: 'Credential for Atlas' })).toContainText('Personal key');
});

test('names the agents using a credential before deleting it', async ({ page }, testInfo) => {
  await openManager(page, testInfo.project.name);
  await addCredential(page, 'Work key', WORK_KEY);
  await addCredential(page, 'Personal key', PERSONAL_KEY);
  await page.getByRole('button', { name: 'Close saved credentials' }).click();
  await closeSettings(page, testInfo.project.name);
  await openSwitcher(page, testInfo.project.name);
  await page.getByLabel('Saved credential').selectOption({ label: 'Work key' });
  await page.getByRole('button', { name: 'Apply model and credential' }).click();
  await expect(page.getByRole('button', { name: 'Credential for Atlas' })).toContainText('Work key');

  const dialog = await openManager(page, testInfo.project.name);
  await expect(dialog.getByText('Used by 1 agent')).toBeVisible();
  await dialog.getByRole('button', { name: 'Delete Work key' }).click();
  const confirm = page.getByRole('alertdialog', { name: 'Delete Work key' });
  await expect(confirm).toContainText('Atlas');
  await confirm.getByLabel('Move them to').selectOption({ label: 'Personal key' });
  await confirm.getByRole('button', { name: 'Move and delete' }).click();
  await expect(dialog.getByText('Work key', { exact: true })).toHaveCount(0);
  await expect(dialog.getByText('Used by 1 agent')).toBeVisible();

  // An unused credential deletes without any confirmation step.
  await addCredential(page, 'Spare key', 'browser-spare-key-value');
  await dialog.getByRole('button', { name: 'Delete Spare key' }).click();
  await expect(dialog.getByText('Spare key', { exact: true })).toHaveCount(0);
});

test('offers saved credentials in agent settings and workspace settings', async ({ page }, testInfo) => {
  await openManager(page, testInfo.project.name);
  await addCredential(page, 'Work key', WORK_KEY);
  await page.getByRole('button', { name: 'Close saved credentials' }).click();
  await expect(page.getByRole('combobox', { name: /^Credential/ })).toContainText('Work key');
  await closeSettings(page, testInfo.project.name);

  await page.getByRole('button', { name: 'Edit Atlas profile' }).click();
  await page.getByRole('tab', { name: 'Model' }).click();
  await page.getByRole('switch', { name: 'Use workspace default' }).uncheck();
  await expect(page.getByLabel('Saved credential')).toContainText('Work key');
  await page.getByLabel('Saved credential').selectOption({ label: 'Work key' });
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText(/^Saved[.—]/)).toBeVisible();
});


test('selects models when adding a key and switches providers independently per agent', async ({ page, request }, testInfo) => {
  const dialog = await openManager(page, testInfo.project.name);
  await dialog.getByRole('button', { name: 'Add credential' }).click();
  await dialog.getByLabel('Name').fill('Router key');
  await dialog.getByLabel('Provider', { exact: true }).selectOption('openrouter');
  await dialog.getByLabel('Value', { exact: true }).fill('router-browser-secret');
  await dialog.getByLabel('Available models').selectOption('mock-scout');
  await expect(dialog.getByLabel('Default model')).toHaveValue('mock-scout');
  await dialog.getByRole('button', { name: 'Save credential' }).click();
  await expect(dialog.getByText('Router key', { exact: true })).toBeVisible();
  await expect(dialog.getByText('mock-scout', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Close saved credentials' }).click();
  await closeSettings(page, testInfo.project.name);
  await openSwitcher(page, testInfo.project.name);
  const picker = page.getByRole('dialog', { name: 'Model and credential for Atlas' });
  await picker.getByLabel('Saved credential').selectOption({ label: 'Router key' });
  await expect(picker.getByLabel('Provider', { exact: true })).toHaveValue('openrouter');
  await expect(picker.getByLabel('Model', { exact: true })).toHaveValue('mock-scout');
  await picker.getByLabel('Available models').selectOption('mock-atlas');
  await picker.getByRole('button', { name: 'Apply model and credential' }).click();
  await expect(picker).not.toBeVisible();
  await page.reload();
  await expect(page.getByRole('button', { name: 'Credential for Atlas' })).toContainText('Router key · mock-atlas');
  const { token } = await (await request.get(control + '/v1/bootstrap')).json();
  const headers = { Authorization: `Bearer ${token}` };
  const { profile: atlas } = await (await request.get(control + '/v1/agents/atlas/profile', { headers })).json();
  expect(atlas.model).toMatchObject({ provider: 'openrouter', model: 'mock-atlas', credentialRef: 'ROUTER_KEY', inherit: false });
  const { profile: scout } = await (await request.get(control + '/v1/agents/scout/profile', { headers })).json();
  expect(scout.model.inherit).toBe(true);
  await page.getByRole('button', { name: 'Credential for Atlas' }).click();
  await picker.getByRole('button', { name: 'Use workspace default' }).click();
  await expect(page.getByRole('button', { name: 'Credential for Atlas' })).toContainText('Workspace default');
});

test('new credentials become selectable without discarding an agent draft', async ({ page }) => {
  await page.getByRole('button', { name: 'Edit Atlas profile' }).click();
  const editor = page.getByRole('dialog', { name: 'Agent settings' });
  await expect(editor.getByText('Loading saved profile…')).toBeHidden();
  await editor.getByLabel('Name', { exact: true }).fill('Atlas draft');
  await editor.getByRole('tab', { name: 'Model' }).click();
  await editor.getByRole('switch', { name: 'Use workspace default' }).uncheck();
  await editor.getByLabel('Saved credential').selectOption('__manage');
  await addCredential(page, 'New shared key', 'editor-key');
  await page.getByRole('button', { name: 'Close saved credentials' }).click();
  await expect(editor.getByLabel('Saved credential')).toContainText('New shared key');
  await editor.getByLabel('Saved credential').selectOption({ label: 'New shared key' });
  await editor.getByRole('tab', { name: 'Profile', exact: true }).click();
  await expect(editor.getByLabel('Name', { exact: true })).toHaveValue('Atlas draft');
  await editor.getByRole('button', { name: 'Save changes' }).click();
  await expect(editor.getByText(/^Saved[.—]/)).toBeVisible();
});

test('first-run setup discovers models with a pasted key before saving it', async ({ page }, testInfo) => {
  if (testInfo.project.name === 'mobile') await page.getByRole('button', { name: 'Open navigation' }).click();
  await page.getByRole('button', { name: /Settings/ }).first().click();
  await page.getByRole('button', { name: 'Run setup again' }).click();
  await page.getByRole('button', { name: /Use this computer/ }).click();
  await page.getByRole('button', { name: 'Continue' }).click();
  const setup = page.getByRole('dialog', { name: 'Connect your model' });
  const discovery = page.waitForRequest(request => request.url().endsWith('/v1/models') && request.method() === 'POST');
  await setup.getByLabel('API key').fill('setup-discovery-key');
  expect((await discovery).postDataJSON()).toMatchObject({ value: 'setup-discovery-key' });
  await expect(setup.locator('datalist option[value="mock-scout"]')).toHaveCount(1);
  await setup.getByRole('combobox', { name: /^Model/ }).fill('mock-scout');
  await setup.getByRole('button', { name: 'Save and test' }).click();
  await expect(page.getByRole('dialog', { name: 'You’re ready' })).toBeVisible();
});
