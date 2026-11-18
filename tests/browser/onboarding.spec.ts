import { expect, test, type Page } from '@playwright/test';
import type { OnboardingStatus, SetupJob } from '../../lib/onboarding';

const url = `/?controlPort=${process.env.OPEN_HARNESS_TEST_PORT || 4317}`;
const progressKey = 'open-harness.onboarding.progress.v1';

async function reloadAndResume(page: Page) {
  const connected = page.waitForResponse(response => response.url().endsWith('/v1/routines'));
  await page.reload();
  await connected;
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByRole('button', { name: 'Settings', exact: true }).first().click();
  await page.getByRole('button', { name: 'Resume setup' }).click();
}

test('defers model setup, restores safe fields, and retries a lost model check', async ({ page }) => {
  let modelWrites = 0, checks = 0;
  await page.route('**/v1/workspace/model', route => {
    modelWrites++;
    const { revision, model } = route.request().postDataJSON();
    return route.fulfill({ json: { revision: revision + 1, model } });
  });
  await page.route('**/v1/secrets', route => route.fulfill({ json: { ok: true } }));
  await page.route('**/v1/onboarding/model-test', route => ++checks === 1
    ? route.abort('failed') : route.fulfill({ json: { ok: true, message: 'Verified' } }));
  await page.goto(url);
  await page.getByRole('button', { name: /Use this computer/ }).click();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  const model = page.getByRole('dialog', { name: 'Connect your model' });
  await model.getByLabel('Provider').selectOption('local');
  await model.getByLabel('Model server address').fill('https://name:draft-secret@localhost/v1');
  await expect.poll(() => page.evaluate(key => JSON.parse(localStorage.getItem(key) || '{}').provider, progressKey)).toBe('local');
  expect(await page.evaluate(key => localStorage.getItem(key), progressKey)).not.toContain('draft-secret');
  await model.getByLabel('Provider').selectOption('openai');
  await model.getByLabel('Model', { exact: true }).fill('draft-model');
  await model.getByLabel('API key').fill('draft-secret');
  await model.getByRole('button', { name: 'Set up later' }).click();
  expect(await page.evaluate(key => localStorage.getItem(key), progressKey)).not.toContain('draft-secret');
  await reloadAndResume(page);
  await expect(model.getByLabel('Model', { exact: true })).toHaveValue('draft-model');
  await expect(model.getByLabel('Provider')).toHaveValue('openai');
  await expect(model.getByLabel('API key')).toHaveValue('');
  await model.getByLabel('API key').fill('test-only');
  await model.getByRole('button', { name: 'Save and test' }).click();
  await expect(model.getByRole('status')).toContainText(/fetch|network/i);
  await model.getByRole('button', { name: 'Save and test' }).click();
  await page.getByRole('button', { name: 'Start using Open Harness' }).click();
  expect(modelWrites).toBe(1);
  expect(checks).toBe(2);
  expect(await page.evaluate(key => localStorage.getItem(key), progressKey)).toBeNull();
  expect(await page.evaluate(() => localStorage.getItem('open-harness.onboarding.v1'))).toBe('done');
});

test('rejoins a running setup after reload and retries only on request', async ({ page }) => {
  let starts = 0;
  let job: SetupJob | undefined;
  function status(): OnboardingStatus {
    const ready = job?.state === 'succeeded';
    return {
      platform: 'darwin', platformLabel: 'macOS', executionReady: ready, recommendedAccess: 'private',
      credentialMode: 'coordinator', credentialNames: [], setupJob: job,
      checks: [{ id: 'agent-runtime', label: 'Agent runtime', detail: ready ? 'Ready.' : 'Prepare the runtime.',
        state: ready ? 'ready' : 'action', ...(ready ? {} : { action: 'prepare-runtime', actionLabel: 'Set up agent runtime' }) }],
    };
  }
  await page.route('**/v1/onboarding/status', route => route.fulfill({ json: status() }));
  await page.route('**/v1/onboarding/action', route => {
    starts++;
    job = { action: 'prepare-runtime', state: 'running', message: 'Preparing the runtime…' };
    return route.fulfill({ status: 202, json: status() });
  });
  await page.goto(url);
  await page.getByRole('button', { name: /Use this computer/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Check this computer' });
  await dialog.getByRole('button', { name: 'Set up agent runtime' }).click();
  await expect(dialog.getByRole('status')).toHaveText('Preparing the runtime…');
  await dialog.getByRole('button', { name: 'Continue setup later' }).click();
  await reloadAndResume(page);
  await expect(dialog.getByRole('button', { name: 'Working…' })).toBeDisabled();
  job = { action: 'prepare-runtime', state: 'failed', message: 'Docker needs more disk space.' };
  await expect(dialog.getByRole('status')).toHaveText(job.message!);
  expect(starts).toBe(1);
  await dialog.getByRole('button', { name: 'Try again' }).click();
  await expect(dialog.getByRole('status')).toHaveText('Preparing the runtime…');
  await dialog.getByRole('button', { name: 'Connect my model while I finish this later' }).click();
  await page.route('**/v1/workspace/model', route => {
    const { model, revision } = route.request().postDataJSON();
    return route.fulfill({ json: { model, revision: revision + 1 } });
  });
  const model = page.getByRole('dialog', { name: 'Connect your model' });
  await model.getByLabel('Provider').selectOption('local');
  await model.getByLabel('Model', { exact: true }).fill('test-model');
  await model.getByLabel('Model server address').fill('http://localhost:11434/v1');
  await model.getByRole('button', { name: 'Save and test' }).click();
  await expect(dialog.getByRole('status')).toHaveText('Preparing the runtime…');
  job = { action: 'prepare-runtime', state: 'succeeded', message: 'Runtime ready.' };
  await expect(page.getByRole('dialog', { name: 'You’re ready' })).toBeVisible();
  expect(starts).toBe(2);
});
