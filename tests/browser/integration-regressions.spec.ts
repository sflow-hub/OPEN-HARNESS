import { test, expect, type APIRequestContext } from '@playwright/test';
import { initialWorkspace } from '../../lib/types';
import { draftProfile } from '../../lib/agent-profile';

const control = `http://127.0.0.1:${process.env.OPEN_HARNESS_TEST_PORT || 4317}`;
async function operator(request: APIRequestContext) {
  const { token } = await (await request.get(control + '/v1/bootstrap')).json();
  return { Authorization: `Bearer ${token}` };
}
test.beforeEach(async ({ request, page }) => {
  const headers = await operator(request);
  await request.post(control + '/v1/runs/stop-all', { headers });
  const { credentials } = await (await request.get(control + '/v1/credentials', { headers })).json();
  for (const item of credentials as Array<{ ref: string }>) await request.delete(control + `/v1/credentials/${item.ref}?force=1`, { headers });
  await request.post(control + '/v1/agents/sync', { headers, data: { agents: initialWorkspace.agents } });
  for (const agent of initialWorkspace.agents) {
    const { profile } = await (await request.get(control + `/v1/agents/${agent.id}/profile`, { headers })).json();
    await request.put(control + `/v1/agents/${agent.id}/profile`, { headers, data: { ...draftProfile(agent), revision: profile.revision } });
  }
  await page.addInitScript(() => localStorage.setItem('open-harness.onboarding.v1', 'done'));
});

test('a rejected onboarding key preserves the selected saved credential and workspace model', async ({ page, request, isMobile }) => {
  const headers = await operator(request);
  const created = await (await request.post(control + '/v1/credentials', { headers, data: { label: 'Working onboarding key', provider: 'xai', value: 'working-provider-key' } })).json();
  const defaults = await (await request.get(control + '/v1/workspace/model', { headers })).json();
  const model = { provider: 'xai', model: 'working-model', credentialRef: created.ref, baseUrl: '' };
  const saved = await (await request.put(control + '/v1/workspace/model', { headers, data: { revision: defaults.revision, model } })).json();
  await page.route('**/v1/onboarding/model-test', route => route.fulfill({ json: { ok: false, message: 'Candidate API key rejected.' } }));
  await page.goto(`/?controlPort=${process.env.OPEN_HARNESS_TEST_PORT || 4317}`);
  await expect(page.getByRole('button', { name: 'Edit Atlas profile' })).toBeVisible();
  if (isMobile) await page.getByRole('button', { name: 'Open navigation' }).click();
  await page.getByRole('button', { name: /Settings/ }).first().click();
  await page.getByRole('button', { name: 'Run setup again' }).click();
  await page.getByRole('button', { name: 'Use this computer' }).click();
  await page.getByRole('button', { name: 'Continue' }).click();
  const setup = page.getByRole('dialog', { name: 'Connect your model' });
  await setup.getByLabel('Model', { exact: true }).fill('rejected-candidate');
  await setup.getByLabel('API key').fill('rejected-candidate-key');
  const validation = page.waitForRequest(candidate => candidate.url().endsWith('/v1/onboarding/model-test'));
  await setup.getByRole('button', { name: 'Save and test' }).click();
  const input = (await validation).postDataJSON();
  await expect(setup.getByRole('status')).toContainText('Candidate API key rejected');
  expect(await (await request.get(control + '/v1/workspace/model', { headers })).json()).toEqual(saved);
  expect(input).toMatchObject({ apiKey: 'rejected-candidate-key', save: true, revision: saved.revision, model: { credentialRef: created.ref } });
  const list = await (await request.get(control + '/v1/credentials', { headers })).json();
  expect(list.credentials.find((item: { ref: string }) => item.ref === created.ref).fingerprint).toEqual(created.fingerprint);
  await expect(setup.getByLabel('API key')).toHaveValue('rejected-candidate-key');
});

test('an inheriting agent offers credentials for its effective workspace provider', async ({ page, request, isMobile }) => {
  const headers = await operator(request);
  const created = await (await request.post(control + '/v1/credentials', { headers, data: { label: 'OpenAI workspace key', provider: 'openai', value: 'openai-workspace-value' } })).json();
  const defaults = await (await request.get(control + '/v1/workspace/model', { headers })).json();
  await request.put(control + '/v1/workspace/model', { headers, data: { revision: defaults.revision, model: { provider: 'openai', model: 'workspace-model', credentialRef: created.ref, baseUrl: '' } } });
  await page.goto(`/?controlPort=${process.env.OPEN_HARNESS_TEST_PORT || 4317}`);
  await expect(page.getByRole('button', { name: 'Edit Atlas profile' })).toBeVisible();
  if (!isMobile) await page.getByRole('button', { name: 'Meet Atlas' }).click();
  await page.getByRole('button', { name: 'Credential for Atlas' }).click();
  await expect(page.getByRole('menuitem', { name: /^OpenAI workspace key/ }).last()).toBeVisible();
});

test('runtime preparation can outlast ordinary control requests', async ({ page }) => {
  await page.route('**/v1/onboarding/status', async route => {
    const response = await route.fetch();
    const status = await response.json();
    await route.fulfill({ response, json: { ...status, executionReady: false, checks: [{ id: 'runtime', label: 'Hermes runtime', state: 'missing', detail: 'Runtime image missing.', action: 'prepare-runtime', actionLabel: 'Prepare runtime' }] } });
  });
  await page.route('**/v1/onboarding/action', async route => {
    await new Promise(resolve => setTimeout(resolve, 250));
    await route.fulfill({ json: { executionReady: true, checks: [{ id: 'runtime', label: 'Hermes runtime', state: 'ready', detail: 'Prepared slowly.' }] } });
  });
  await page.goto(`/?controlPort=${process.env.OPEN_HARNESS_TEST_PORT || 4317}`);
  await expect(page.getByRole('button', { name: 'Edit Atlas profile' })).toBeVisible();
  if (await page.getByRole('button', { name: 'Open navigation' }).isVisible()) await page.getByRole('button', { name: 'Open navigation' }).click();
  await page.getByRole('button', { name: /Settings/ }).first().click();
  await page.getByRole('button', { name: 'Run setup again' }).click();
  await page.getByRole('button', { name: 'Use this computer' }).click();
  await expect(page.getByRole('button', { name: 'Prepare runtime' })).toBeVisible();
  // Scale only the ordinary request deadline; the slow endpoint exceeds that budget.
  await page.evaluate(() => {
    const timeout = AbortSignal.timeout.bind(AbortSignal);
    AbortSignal.timeout = (milliseconds: number) => timeout(milliseconds === 30_000 ? 50 : milliseconds);
  });
  await page.getByRole('button', { name: 'Prepare runtime' }).click();
  await expect(page.getByText('Prepared slowly.')).toBeVisible();
});

test('workspace Save and test keeps a rejected model draft without committing it', async ({ page, request, isMobile }) => {
  const headers = await operator(request);
  await page.route('**/v1/onboarding/model-test', route => route.fulfill({ json: { ok: false, message: 'Workspace candidate rejected.' } }));
  await page.goto(`/?controlPort=${process.env.OPEN_HARNESS_TEST_PORT || 4317}`);
  await expect(page.getByRole('button', { name: 'Edit Atlas profile' })).toBeVisible();
  const before = await (await request.get(control + '/v1/workspace/model', { headers })).json();
  if (isMobile) await page.getByRole('button', { name: 'Open navigation' }).click();
  await page.getByRole('button', { name: /Settings/ }).first().click();
  const settings = page.getByRole('dialog', { name: 'Workspace settings' });
  // Type only once the saved model has arrived in the form: an untouched form takes the
  // coordinator's answer, and a value replaced under a selection would be appended to.
  await expect(settings.getByLabel('Model ID')).toHaveValue(before.model.model);
  await settings.getByLabel('Model ID').fill('rejected-workspace-model');
  const validation = page.waitForRequest(candidate => candidate.url().endsWith('/v1/onboarding/model-test'));
  await settings.getByRole('button', { name: 'Save and test' }).click();
  expect((await validation).postDataJSON()).toMatchObject({ save: true, revision: before.revision });
  await expect(page.getByRole('status')).toContainText('Workspace candidate rejected');
  expect(await (await request.get(control + '/v1/workspace/model', { headers })).json()).toEqual(before);
  await expect(settings.getByLabel('Model ID')).toHaveValue('rejected-workspace-model');
});

test('task labels can be typed one comma at a time', async ({ page }) => {
  await page.goto(`/?controlPort=${process.env.OPEN_HARNESS_TEST_PORT || 4317}`);
  await expect(page.getByRole('button', { name: 'Edit Atlas profile' })).toBeVisible();
  await page.getByRole('button', { name: 'Tasks', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Tasks', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'New task', exact: true }).click();
  const drawer = page.locator('.task-drawer');
  await drawer.getByPlaceholder('What needs to be done?').fill('Label this');
  const labels = drawer.getByPlaceholder('research, launch, writing');
  // Keystroke by keystroke: the comma used to vanish as soon as it was typed.
  await labels.pressSequentially('research, launch', { delay: 20 });
  await expect(labels).toHaveValue('research, launch');
  await drawer.getByRole('button', { name: 'Save', exact: true }).click();
  await drawer.getByRole('button', { name: 'Close task' }).click();
  const card = page.locator('.task-card').filter({ hasText: 'Label this' }).first();
  await expect(card.locator('.task-labels')).toContainText('research');
  await expect(card.locator('.task-labels')).toContainText('launch');
});
