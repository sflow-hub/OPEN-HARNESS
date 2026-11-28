import { expect, test, type Page } from '@playwright/test';
import { openWorkspaceSettings } from './navigation';
import { setupFixture } from './setup-fixture';
import { BUNDLED_MODEL, type ModelChoice } from '../../lib/agent-profile';
import type { SetupJob } from '../../lib/product';
import type { OnboardingStatus } from '../../lib/onboarding';

const url = `/?controlPort=${process.env.OPEN_HARNESS_TEST_PORT || 4317}`;
const progressKey = 'open-harness.onboarding.progress.v1:' + encodeURIComponent(`http://127.0.0.1:${process.env.OPEN_HARNESS_TEST_PORT || 4317}`);

async function reloadAndResume(page: Page) {
  const connected = page.waitForResponse(response => response.url().endsWith('/v1/routines'));
  await page.reload();
  await connected;
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await openWorkspaceSettings(page);
  await page.getByRole('button', { name: 'Resume setup' }).click();
}

test('defers model setup, restores safe fields, and retries a lost model check', async ({ page }) => {
  let checks = 0;
  const ready = {
    platform: 'darwin' as const,
    platformLabel: 'macOS',
    executionReady: true,
    bundledModelAvailable: false,
    recommendedAccess: 'private' as const,
    credentialMode: 'coordinator' as const,
    credentialNames: [] as string[],
    checks: [] as OnboardingStatus['checks'],
  };
  await setupFixture(page, { status: () => ready });
  await page.route('**/v1/onboarding/status', route => route.fulfill({ json: ready }));
  await page.route('**/v1/onboarding/model-test', route => {
    const body = route.request().postDataJSON();
    checks++;
    if (checks === 1) return route.abort('failed');
    return route.fulfill({
      json: {
        ok: true,
        message: 'Verified',
        model: body.model,
        revision: (body.revision ?? 0) + 1,
      },
    });
  });
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
  expect(await page.evaluate(() => localStorage.getItem('open-harness.onboarding.v1'))).toBe('deferred');
  await reloadAndResume(page);
  await expect(model.getByLabel('Model', { exact: true })).toHaveValue('draft-model');
  await expect(model.getByLabel('Provider')).toHaveValue('openai');
  await expect(model.getByLabel('API key')).toHaveValue('');
  await model.getByLabel('API key').fill('test-only');
  await model.getByRole('button', { name: 'Save and test' }).click();
  await expect(model.getByRole('status').filter({ hasText: /cannot reach.*coordinator/i })).toBeVisible();
  await model.getByRole('button', { name: 'Save and test' }).click();
  const verify = page.getByRole('dialog', { name: 'Verify a task' });
  await expect(verify).toBeVisible();
  await verify.getByRole('button', { name: 'Run verification task' }).click();
  await expect(page.getByRole('dialog', { name: 'You’re ready' })).toBeVisible();
  await page.getByRole('button', { name: 'Start using Open Harness' }).click();
  expect(checks).toBe(2);
  expect(await page.evaluate(key => localStorage.getItem(key), progressKey)).toBeNull();
  expect(await page.evaluate(() => localStorage.getItem('open-harness.onboarding.v1'))).toBe('done');
});

test('rejoins a running setup after reload and retries only on request', async ({ page }) => {
  let starts = 0;
  let job: SetupJob | undefined;
  const stamp = () => new Date().toISOString();
  function status(): OnboardingStatus & { setupJobs: SetupJob[]; taskVerified: boolean; bundledModelAvailable: boolean } {
    const ready = job?.state === 'completed';
    return {
      platform: 'darwin',
      platformLabel: 'macOS',
      executionReady: ready,
      bundledModelAvailable: false,
      recommendedAccess: 'private',
      credentialMode: 'coordinator',
      credentialNames: [],
      taskVerified: false,
      setupJobs: job ? [job] : [],
      checks: [{
        id: 'agent-runtime',
        label: 'Agent runtime',
        detail: ready ? 'Ready.' : (job?.detail || 'Prepare the runtime.'),
        state: ready ? 'ready' : 'action',
        ...(ready ? {} : { action: 'prepare-runtime' as const, actionLabel: 'Set up agent runtime' }),
      }],
    };
  }
  await page.route(/\/v1\/(readiness|onboarding\/status)$/, route => route.fulfill({ json: status() }));
  await page.route('**/v1/setup/jobs', async route => {
    if (route.request().method() !== 'POST') return route.fallback();
    const kind = route.request().postDataJSON().kind as SetupJob['kind'];
    if (kind === 'verify-task') {
      const now = stamp();
      const verifyJob: SetupJob = { id: 'fixture-verify', kind: 'verify-task', state: 'completed', detail: 'Fixture independent file readback passed.', runId: null, createdAt: now, updatedAt: now };
      return route.fulfill({
        status: 202,
        headers: {
          'Access-Control-Allow-Origin': route.request().headers().origin || '*',
          'Access-Control-Allow-Credentials': 'true',
        },
        json: verifyJob,
      });
    }
    starts++;
    const now = stamp();
    job = { id: 'fixture-runtime', kind: 'prepare-runtime', state: 'running', detail: 'Preparing the runtime…', runId: null, createdAt: now, updatedAt: now };
    await route.fulfill({
      status: 202,
      headers: {
        'Access-Control-Allow-Origin': route.request().headers().origin || '*',
        'Access-Control-Allow-Credentials': 'true',
      },
      json: job,
    });
  });
  await page.route('**/v1/setup/jobs/*/resume', async route => {
    starts++;
    const now = stamp();
    job = { id: 'fixture-runtime', kind: 'prepare-runtime', state: 'running', detail: 'Preparing the runtime…', runId: null, createdAt: now, updatedAt: now };
    await route.fulfill({ json: job });
  });
  await page.goto(url);
  await page.getByRole('button', { name: /Use this computer/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Check this computer' });
  await dialog.getByRole('button', { name: 'Set up agent runtime' }).click();
  await expect(dialog.getByRole('status').filter({ hasText: 'Preparing the runtime…' })).toBeVisible();
  await dialog.getByRole('button', { name: 'Continue setup later' }).click();
  await reloadAndResume(page);
  await expect(dialog.getByRole('button', { name: 'Working…' })).toBeDisabled();
  job = { id: 'fixture-runtime', kind: 'prepare-runtime', state: 'failed', detail: 'Docker needs more disk space.', runId: null, createdAt: stamp(), updatedAt: stamp() };
  await expect(dialog.getByRole('status').filter({ hasText: job.detail })).toBeVisible();
  expect(starts).toBe(1);
  await dialog.getByRole('button', { name: 'Try again' }).click();
  await expect(dialog.getByRole('status').filter({ hasText: 'Preparing the runtime…' })).toBeVisible();
  await dialog.getByRole('button', { name: 'Connect my model while I finish this later' }).click();
  await page.route('**/v1/onboarding/model-test', route => {
    const body = route.request().postDataJSON();
    return route.fulfill({ json: { ok: true, message: 'Verified', model: body.model, revision: (body.revision ?? 0) + 1 } });
  });
  const model = page.getByRole('dialog', { name: 'Connect your model' });
  await model.getByLabel('Provider').selectOption('local');
  await model.getByLabel('Available models').selectOption('__custom');
  await model.getByLabel('Model', { exact: true }).fill('test-model');
  await model.getByLabel('Model server address').fill('http://localhost:11434/v1');
  await model.getByRole('button', { name: 'Save and test' }).click();
  await expect(model.getByRole('status').filter({ hasText: 'Finish preparing' })).toBeVisible();
  job = { id: 'fixture-runtime', kind: 'prepare-runtime', state: 'completed', detail: 'Runtime ready.', runId: null, createdAt: stamp(), updatedAt: stamp() };
  await model.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.getByRole('dialog', { name: /Verify a task|You’re ready/ })).toBeVisible();
  expect(starts).toBe(2);
});

test('restores the chosen model source and account, and checks a changed credential before verification', async ({ page }) => {
  let executionReady = false, revision = 0;
  let savedModel: ModelChoice = BUNDLED_MODEL;
  const checked: string[] = [];
  const accounts = ['CODEX_ACCOUNT_A', 'CODEX_ACCOUNT_B'];
  const readiness = () => ({ executionReady, checks: [], bundledModelAvailable: true, credentialNames: accounts, setupJobs: [], taskVerified: false });
  await page.route(/\/v1\/(readiness|onboarding\/status)$/, route => route.fulfill({ json: readiness() }));
  await page.route('**/v1/workspace/model/import', route => route.fulfill({ json: { revision, model: savedModel } }));
  await page.route('**/v1/credentials', route => route.fulfill({ json: { credentials: accounts.map(ref => ({ provider: 'openai-codex', ref, label: ref, present: true })) } }));
  await page.route('**/v1/onboarding/model-test', route => {
    savedModel = route.request().postDataJSON().model;
    checked.push(savedModel.credentialRef);
    return route.fulfill({ json: { ok: true, model: savedModel, revision: ++revision, message: 'Connection verified' } });
  });
  await page.goto(url);
  await page.getByRole('button', { name: /Use this computer/ }).click();
  await page.getByRole('button', { name: 'Connect my model while I finish this later' }).click();
  const model = page.getByRole('dialog', { name: 'Connect your model' });
  const account = model.getByLabel('ChatGPT account');
  await model.getByRole('button', { name: 'Choose another model' }).click();
  await model.getByLabel('Provider').selectOption('openai-codex');
  await account.selectOption(accounts[0]);
  await model.getByLabel('Available models').selectOption('__custom');
  await model.getByLabel('Model', { exact: true }).fill('fixture-codex-model');
  await model.getByRole('button', { name: 'Set up later' }).click();
  await reloadAndResume(page);
  await expect(account).toHaveValue(accounts[0]);
  await expect(model.getByLabel('Model', { exact: true })).toHaveValue('fixture-codex-model');
  await model.getByRole('button', { name: 'Save and test' }).click();
  await expect(model.getByRole('button', { name: 'Continue', exact: true })).toBeVisible();
  await account.selectOption(accounts[1]);
  await expect(model.getByRole('button', { name: 'Save and test' })).toBeVisible();
  await model.getByRole('button', { name: 'Set up later' }).click();
  executionReady = true;
  await reloadAndResume(page);
  await expect(account).toHaveValue(accounts[1]);
  await model.getByRole('button', { name: 'Save and test' }).click();
  const verify = page.getByRole('dialog', { name: 'Verify a task' });
  await expect(verify).toBeVisible();
  await verify.getByRole('button', { name: 'Set up later' }).click();
  await reloadAndResume(page);
  await expect(verify).toBeVisible();
  await verify.getByRole('button', { name: 'Set up later' }).click();
  revision++;
  await reloadAndResume(page);
  await expect(model.getByRole('button', { name: 'Save and test' })).toBeVisible();
  expect(checked).toEqual(accounts);
});
