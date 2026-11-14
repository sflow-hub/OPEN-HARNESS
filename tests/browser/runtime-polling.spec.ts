import { test, expect } from '@playwright/test';
import { initialWorkspace } from '../../lib/types';
import { draftProfile } from '../../lib/agent-profile';

const control = `http://127.0.0.1:${process.env.OPEN_HARNESS_TEST_PORT || 4317}`;

test('a slow runtime check completes without overlapping polls or losing the draft', async ({ page, request }) => {
  const { token } = await (await request.get(control + '/v1/bootstrap')).json();
  const headers = { Authorization: `Bearer ${token}` };
  await request.post(control + '/v1/runs/stop-all', { headers });
  await request.post(control + '/v1/agents/sync', { headers, data: { agents: initialWorkspace.agents } });
  for (const agent of initialWorkspace.agents) {
    const { profile } = await (await request.get(control + `/v1/agents/${agent.id}/profile`, { headers })).json();
    await request.put(control + `/v1/agents/${agent.id}/profile`, { headers, data: { ...draftProfile(agent), revision: profile.revision } });
  }
  await page.addInitScript(() => localStorage.setItem('open-harness.onboarding.v1', 'done'));
  let reads = 0, finishProbe!: () => void;
  const probe = new Promise<void>(resolve => { finishProbe = resolve; });
  await page.route(`${control}/v1/bootstrap`, async route => {
    const read = ++reads, response = await route.fetch(), body = await response.json();
    if (read > 1) await probe;
    await route.fulfill({ response, json: { ...body, mode: 'live', runtime: { available: read > 1, version: '29.5.3', message: read > 1 ? 'Docker is ready.' : 'Docker could not check the agent runtime image.' } } });
  });
  try {
    await page.goto(`/?controlPort=${process.env.OPEN_HARNESS_TEST_PORT || 4317}`);
    await page.getByRole('button', { name: 'Meet Atlas' }).click();
    const draft = page.getByRole('textbox', { name: 'Message Atlas' });
    await draft.fill('Keep this through a slow Docker check');
    await expect.poll(() => reads, { timeout: 8_000 }).toBe(2);
    // Hold the response past another polling interval; no replacement may start.
    await page.waitForTimeout(5_500);
    expect(reads).toBe(2);
    finishProbe();
    await expect(page.locator('.model-choice')).toContainText('Hermes');
    await expect(page.getByRole('button', { name: 'Send message' })).toBeEnabled();
    await expect(draft).toHaveValue('Keep this through a slow Docker check');
  } finally { finishProbe(); }
});

test('a computer without the agent runtime offers setup right where chat is blocked', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('open-harness.onboarding.v1', 'done'));
  const message = 'Docker is running, but the agent runtime is not set up in its current context yet. Open Workspace settings → Run setup again and choose Set up agent runtime.';
  await page.route(`${control}/v1/bootstrap`, async route => {
    const response = await route.fetch(), body = await response.json();
    await route.fulfill({ response, json: { ...body, mode: 'live', runtime: { available: false, version: '29.5.3', message } } });
  });
  await page.goto(`/?controlPort=${process.env.OPEN_HARNESS_TEST_PORT || 4317}`);
  await page.getByRole('button', { name: 'Meet Atlas' }).click();
  await expect(page.locator('.composer-note')).toContainText(message);
  await expect(page.getByRole('button', { name: 'Send message' })).toBeDisabled();
  await page.getByRole('button', { name: 'Open setup' }).click();
  await expect(page.getByRole('dialog', { name: 'Welcome to Open Harness' })).toBeVisible();
});
