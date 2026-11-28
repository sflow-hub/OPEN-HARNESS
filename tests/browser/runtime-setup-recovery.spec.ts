import { openWorkspaceSettings } from './navigation';
import { test, expect } from '@playwright/test';

test('ready runtime clears obsolete setup failures from onboarding and the workspace', async ({ page }) => {
  let ready = false;
  const failure = 'The previous runtime build could not download its pinned CA package.';
  await page.addInitScript(() => localStorage.setItem('open-harness.assistant-home', '1'));
  await page.route(/\/v1\/(readiness|onboarding\/status)$/, async route => {
    const response = await route.fetch(), status = await response.json(), stamp = new Date().toISOString();
    await route.fulfill({ response, json: { ...status, executionReady: ready, taskVerified: false,
      checks: [{ id: 'agent-runtime', label: 'Agent runtime', state: ready ? 'ready' : 'action', detail: ready ? 'The pinned runtime is ready.' : 'Runtime setup is needed.', ...(ready ? {} : { action: 'prepare-runtime', actionLabel: 'Set up agent runtime' }) }],
      setupJobs: [{ id: 'old-build', kind: 'prepare-runtime', state: 'failed', detail: failure, runId: null, createdAt: stamp, updatedAt: stamp }],
    } });
  });
  await page.goto(`/?controlPort=${process.env.OPEN_HARNESS_TEST_PORT || 4317}`);
  await page.getByRole('button', { name: 'Use this computer' }).click();
  const setup = page.getByRole('dialog', { name: 'Check this computer' });
  await expect(setup.getByText(failure)).toBeVisible();
  await expect(setup.getByRole('button', { name: 'Resume setup' })).toBeVisible();
  ready = true;
  await setup.getByRole('button', { name: 'Check again' }).click();
  await expect(setup.getByRole('button', { name: 'Continue', exact: true })).toBeEnabled();
  await expect(setup.getByText(failure)).toHaveCount(0);
  await expect(setup.getByRole('button', { name: 'Resume setup' })).toHaveCount(0);
  await setup.getByRole('button', { name: 'Set up later' }).click();
  await expect(page.getByText(failure, { exact: false })).toHaveCount(0, { timeout: 10000 });
});

test('Set up later survives recovery, reconnect and other tabs while setup remains available', async ({ page, context }) => {
  const url = '/?controlPort=' + (process.env.OPEN_HARNESS_TEST_PORT || 4317);
  const welcome = (tab: typeof page) => tab.getByRole('dialog', { name: 'Welcome to Open Harness' });
  await page.goto(url);
  await expect(welcome(page)).toBeVisible();
  const second = await context.newPage();
  await second.goto(url);
  await expect(welcome(second)).toBeVisible();
  await welcome(page).getByRole('button', { name: 'Set up later' }).click();
  await expect(welcome(second)).toBeHidden();
  expect(await second.evaluate(() => localStorage.getItem('open-harness.onboarding.v1'))).toBe('deferred');

  // Returning from an applied edition opens the original dashboard. Its first
  // coordinator connection can fail, so exercise both automatic setup paths.
  await page.route(/\/v1\/bootstrap$/, route => route.abort('failed'), { times: 1 });
  await page.goto(url + '&original=1');
  await expect(page.locator('.offline-banner')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Improve my Open Harness' })).toBeVisible({ timeout: 15_000 });
  await expect(page.locator('.offline-banner')).toBeHidden();
  await expect(welcome(page)).toBeHidden();
  await openWorkspaceSettings(page);
  await page.getByRole('button', { name: 'Resume setup' }).click();
  await expect(welcome(page)).toBeVisible();
  await welcome(page).getByRole('button', { name: 'Set up later' }).click();
  expect(await page.evaluate(() => localStorage.getItem('open-harness.onboarding.v1'))).toBe('deferred');
  await second.close();
});

test('closing manually reopened setup preserves an existing completion', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('open-harness.onboarding.v1', 'done'));
  await page.goto('/?controlPort=' + (process.env.OPEN_HARNESS_TEST_PORT || 4317));
  await expect(page.getByRole('button', { name: 'Edit Atlas profile' })).toBeVisible();
  await openWorkspaceSettings(page);
  await page.getByRole('button', { name: 'Run setup again' }).click();
  await page.getByRole('button', { name: 'Set up later' }).click();
  expect(await page.evaluate(() => localStorage.getItem('open-harness.onboarding.v1'))).toBe('done');
});

test('the launcher model can be tested without entering a provider or a key', async ({ page }) => {
  const model = { provider: 'local', model: 'atlas-linux', baseUrl: 'http://atlas-model:8080/v1', credentialRef: '' };
  await page.route(/\/v1\/workspace\/model(?:\/import)?$/, route => route.fulfill({ json: { model, revision: 0 } }));
  await page.route(/\/v1\/(readiness|onboarding\/status)$/, async route => {
    const response = await route.fetch();
    await route.fulfill({ response, json: { ...await response.json(), executionReady: true, bundledModelAvailable: true } });
  });
  await page.route('**/v1/onboarding/model-test', route => route.fulfill({ json: { ok: true, model, revision: 1, message: 'Model ready.' } }));
  await page.goto('/?controlPort=' + (process.env.OPEN_HARNESS_TEST_PORT || 4317));
  await page.getByRole('button', { name: 'Use this computer' }).click();
  await page.getByRole('button', { name: 'Continue' }).click();
  const dialog = page.getByRole('dialog', { name: 'Connect your model' });
  await expect(dialog.getByRole('heading', { name: 'Use the model on this computer' })).toBeVisible();
  await expect(dialog.getByLabel('Model server address')).toHaveCount(0);
  await expect(dialog.getByLabel('API key')).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Choose another model' }).click();
  await expect(dialog.getByLabel('Model server address')).toBeVisible();
  await dialog.getByRole('button', { name: 'Use the model on this computer' }).click();
  const saved = page.waitForRequest(request => request.url().endsWith('/v1/onboarding/model-test'));
  await dialog.getByRole('button', { name: 'Save and test' }).click();
  expect((await saved).postDataJSON()).toEqual({ model, save: true, revision: 0 });
  await expect(page.getByRole('dialog', { name: /Verify a task|You’re ready/ })).toBeVisible();
});

const atlas = { provider: 'local', model: 'atlas-linux', baseUrl: 'http://atlas-model:8080/v1', credentialRef: '' };
const hosted = { provider: 'openai', model: 'fixture-remote', baseUrl: '', credentialRef: 'OPENAI_API_KEY' };
const launcherPort = process.env.OPEN_HARNESS_TEST_PORT || 4317;

async function returningWorkspace(page: import('@playwright/test').Page, model: typeof atlas, bundledModelAvailable: boolean) {
  await page.addInitScript(() => localStorage.setItem('open-harness.onboarding.v1', 'done'));
  await page.route(/\/v1\/workspace\/model(?:\/import)?$/, route => route.fulfill({ json: { model, revision: 4 } }));
  await page.route(/\/v1\/(?:readiness|onboarding\/status)$/, async route => {
    await route.fulfill({ json: { ...await (await route.fetch()).json(), executionReady: true, bundledModelAvailable } });
  });
  await page.route(/\/v1\/models$/, route => route.fulfill({ json: { models: [] } }));
}

test('explicit local launch confirms a saved hosted workspace after pairing and survives refresh', async ({ page }) => {
  await returningWorkspace(page, hosted, true);
  let paired = 0, saves = 0;
  await page.route(/\/v1\/browser\/pair$/, async route => {
    expect(route.request().postDataJSON()).toEqual({ code: 'launcher-fixture' });
    paired++;
    const { token } = await (await page.request.get('http://127.0.0.1:' + launcherPort + '/v1/bootstrap')).json();
    await route.fulfill({ json: { token } });
  });
  await page.route('**/v1/onboarding/model-test', async route => {
    saves++;
    expect(route.request().postDataJSON()).toEqual({ model: atlas, revision: 4, save: true });
    await route.fulfill({ json: { ok: saves > 1, ...(saves > 1 ? { model: atlas, revision: 5 } : {}), message: saves > 1 ? 'Saved' : 'Transient model failure.' } });
  });
  await page.goto('/?controlPort=' + launcherPort + '&setupModel=local#pair=launcher-fixture');
  const dialog = page.getByRole('dialog', { name: 'Connect your model' });
  await expect(dialog.getByRole('heading', { name: 'Use the model on this computer' })).toBeVisible();
  await expect(dialog.getByText(hosted.model, { exact: true })).toBeVisible();
  await expect(page).toHaveURL(url => !url.searchParams.has('setupModel') && url.searchParams.get('controlPort') === launcherPort.toString() && !url.hash);
  await page.reload();
  await expect(dialog.getByRole('heading', { name: 'Use the model on this computer' })).toBeVisible();
  expect(paired).toBe(1);
  expect(saves).toBe(0);
  await dialog.getByRole('button', { name: 'Save and test' }).click();
  await expect(dialog.getByRole('status')).toContainText('Transient model failure');
  await dialog.getByRole('button', { name: 'Save and test' }).click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => saves).toBe(2);
  await page.reload();
  await expect(page.getByRole('main')).toBeVisible();
  await expect(dialog).toHaveCount(0);
});

test('explicit provider launch opens a clean provider form after a saved on-device choice', async ({ page }) => {
  await returningWorkspace(page, atlas, false);
  await page.goto('/?controlPort=' + launcherPort + '&setupModel=provider');
  const dialog = page.getByRole('dialog', { name: 'Connect your model' });
  await expect(dialog.getByRole('combobox', { name: 'Provider', exact: true })).toBeVisible();
  await expect(dialog.getByLabel('Model server address')).toHaveCount(0);
  await expect(dialog.getByText('http://atlas-model:8080/v1')).toHaveCount(0);
  await dialog.getByRole('combobox', { name: 'Provider', exact: true }).selectOption('openai');
  await dialog.getByLabel('API key').fill('fixture-only');
  await page.route('**/v1/onboarding/model-test', async route => {
    const body = route.request().postDataJSON();
    expect(body.model).toMatchObject({ provider: 'openai', baseUrl: '', credentialRef: 'OPENAI_API_KEY' });
    expect(body.revision).toBe(4);
    await route.fulfill({ json: { ok: true, model: body.model, revision: 5, message: 'Saved' } });
  });
  await dialog.getByRole('button', { name: 'Save and test' }).click();
  await expect(dialog).toHaveCount(0);
});

test('launcher matching the saved model returns to the existing dashboard without a setup prompt', async ({ page }) => {
  await returningWorkspace(page, hosted, false);
  await page.goto('/?controlPort=' + launcherPort + '&setupModel=provider');
  await expect(page).toHaveURL(url => !url.searchParams.has('setupModel'));
  await expect(page.getByRole('dialog', { name: 'Connect your model' })).toHaveCount(0);
  await expect(page.getByRole('dialog', { name: 'Welcome to Open Harness' })).toHaveCount(0);
});

test('launcher confirms a conflicting setting in the original dashboard before reopening an older local edition', async ({ page }) => {
  await returningWorkspace(page, hosted, true);
  await page.route(/\/v1\/bootstrap$/, async route => {
    await route.fulfill({ json: { ...await (await route.fetch()).json(), localDashboardRevision: 'older-edition' } });
  });
  await page.route(/\/local-edition(?:\?|$)/, route => route.fulfill({ contentType: 'text/html', body: '<main>Previously applied dashboard</main>' }));
  await page.goto('/?controlPort=' + launcherPort + '&setupModel=local');
  const dialog = page.getByRole('dialog', { name: 'Connect your model' });
  await expect(dialog).toBeVisible();
  await expect(page).toHaveURL(url => url.pathname === '/' && !url.searchParams.has('setupModel'));
  await dialog.getByRole('button', { name: 'Keep current model' }).click();
  await expect(page.getByText('Previously applied dashboard')).toBeVisible();
});
