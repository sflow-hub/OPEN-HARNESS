import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { initialWorkspace } from '../../lib/types';

const control = `http://127.0.0.1:${process.env.OPEN_HARNESS_TEST_PORT || 4317}`;
const KEY = 'browser-decision-key-value-0001';
const DEFAULTS = { enabled: false, credentialRef: '', origin: 'https://api.typesafe.ai', model: 'jev-latest', dailyLimit: 2000 };
let headers: Record<string, string> = {};

// Specs share one control service, so leave decisions off and only this spec's key behind.
async function seed(request: APIRequestContext) {
  const { token } = await (await request.get(control + '/v1/bootstrap')).json();
  headers = { Authorization: `Bearer ${token}` };
  await request.post(control + '/v1/agents/sync', { headers, data: { agents: initialWorkspace.agents } });
  const current = await (await request.get(control + '/v1/decisions/settings', { headers })).json();
  expect((await request.put(control + '/v1/decisions/settings', { headers, data: { settings: DEFAULTS, revision: current.revision } })).ok()).toBe(true);
  const { credentials } = await (await request.get(control + '/v1/credentials', { headers })).json();
  for (const item of credentials as Array<{ ref: string }>) await request.delete(control + `/v1/credentials/${item.ref}?force=1`, { headers });
  const created = await request.post(control + '/v1/credentials', { headers, data: { label: 'TypeSafe key', type: 'bearer', fields: { token: KEY } } });
  expect(created.status()).toBe(201);
  return (await created.json()).ref as string;
}
async function enable(request: APIRequestContext, ref: string) {
  const current = await (await request.get(control + '/v1/decisions/settings', { headers })).json();
  expect((await request.put(control + '/v1/decisions/settings', { headers, data: { settings: { ...DEFAULTS, enabled: true, credentialRef: ref }, revision: current.revision } })).ok()).toBe(true);
}
const openDecisions = async (page: Page, project: string) => {
  if (project === 'mobile') await page.getByRole('button', { name: 'Open navigation' }).click();
  await page.getByRole('button', { name: /Settings/ }).first().click();
  await page.getByRole('button', { name: 'Decisions', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Decisions' });
  await expect(dialog.getByLabel('Decision service key')).toBeVisible();
  return dialog;
};

let ref = '';
test.beforeEach(async ({ request, page }) => {
  ref = await seed(request);
  await page.addInitScript(() => localStorage.setItem('open-harness.onboarding.v1', 'done'));
  await page.goto(`/?controlPort=${process.env.OPEN_HARNESS_TEST_PORT || 4317}`);
  await expect(page.getByRole('button', { name: 'Edit Atlas profile' })).toBeVisible();
});

test('decisions start off, say what is sent, and a refused save keeps the draft', async ({ page }, testInfo) => {
  const dialog = await openDecisions(page, testInfo.project.name);
  await expect(dialog.getByRole('note')).toContainText('the question, context and option text of every decision are sent');
  const toggle = dialog.getByRole('checkbox', { name: /Turn on decisions/ });
  await expect(toggle).not.toBeChecked();
  await toggle.check();
  await dialog.getByRole('button', { name: 'Save decision settings' }).click();
  await expect(dialog.getByRole('alert')).toContainText('Choose the saved credential');
  await expect(toggle).toBeChecked();
  await dialog.getByLabel('Decision service key').selectOption({ label: 'TypeSafe key' });
  await dialog.getByRole('button', { name: 'Save decision settings' }).click();
  await expect(dialog.getByRole('status')).toHaveText('Saved. Decisions are on.');
  await expect(dialog.getByRole('button', { name: 'Save decision settings' })).toBeDisabled();
  expect(await page.content()).not.toContain(KEY);
});

test('recent decisions show IDs and outcomes, never the text that was sent', async ({ page, request }, testInfo) => {
  await enable(request, ref);
  const decided = await request.post(control + '/v1/decide', { headers, data: { op: 'choose', question: 'Which team handles PRIVATE-REFUND-PHRASE billing refunds?', options: [{ id: 'research', text: 'Reads papers' }, { id: 'billing', text: 'Handles billing and refunds' }] } });
  expect(decided.ok()).toBe(true);
  const dialog = await openDecisions(page, testInfo.project.name);
  const log = dialog.getByRole('list', { name: 'Recent decisions' });
  await expect(log).toContainText('choose');
  await expect(log).toContainText('billing');
  await expect(log).toContainText('You');
  expect(await page.content()).not.toContain('PRIVATE-REFUND-PHRASE');
});

test('a save over a newer revision names it, keeps the draft, and can reload', async ({ page, request }, testInfo) => {
  const dialog = await openDecisions(page, testInfo.project.name);
  await dialog.getByLabel('Model').fill('jev-1.13');
  await enable(request, ref);
  await dialog.getByRole('button', { name: 'Save decision settings' }).click();
  await expect(dialog.getByRole('alert')).toContainText(/changed elsewhere \(now revision \d+\)/);
  await expect(dialog.getByLabel('Model')).toHaveValue('jev-1.13');
  await dialog.getByRole('button', { name: 'Reload saved settings' }).click();
  await expect(dialog.getByLabel('Model')).toHaveValue('jev-latest');
  await expect(dialog.getByRole('checkbox', { name: /Turn on decisions/ })).toBeChecked();
});

test('closing with unsaved changes asks first', async ({ page }, testInfo) => {
  const dialog = await openDecisions(page, testInfo.project.name);
  await dialog.getByLabel('Daily request limit').fill('50');
  await dialog.getByRole('button', { name: 'Close decisions' }).click();
  const confirm = dialog.getByRole('alertdialog', { name: 'Discard decision changes' });
  await confirm.getByRole('button', { name: 'Keep editing' }).click();
  await expect(dialog.getByLabel('Daily request limit')).toHaveValue('50');
  await dialog.getByRole('button', { name: 'Close decisions' }).click();
  await confirm.getByRole('button', { name: 'Discard changes' }).click();
  await expect(dialog).toBeHidden();
});
