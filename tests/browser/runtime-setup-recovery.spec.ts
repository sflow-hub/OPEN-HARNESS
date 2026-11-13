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
