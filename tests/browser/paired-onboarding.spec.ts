import { test as base, expect, type APIRequestContext } from '@playwright/test';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Each case pairs with a genuinely empty coordinator instead of hiding seeded
// agents in a route mock. The dashboard itself is the usual production build.
const test = base.extend<{ coordinator: { url: string; port: number; headers: Record<string, string> } }>({
  coordinator: async ({ request }, provide) => {
    const socket = createServer();
    await new Promise<void>(resolve => socket.listen(0, '127.0.0.1', resolve));
    const port = (socket.address() as { port: number }).port;
    await new Promise<void>(resolve => socket.close(() => resolve()));
    const state = mkdtempSync(join(tmpdir(), 'harness-paired-onboarding-'));
    const child = spawn(process.execPath, ['--import', 'tsx', 'runtime/service.ts'], {
      env: { ...process.env, OPEN_HARNESS_MOCK: '1', OPEN_HARNESS_DISABLE_OS_VAULT: '1', OPEN_HARNESS_BIND: '127.0.0.1', OPEN_HARNESS_PORT: String(port), OPEN_HARNESS_STATE_DIR: state, OPEN_HARNESS_ALLOW_LOOPBACK_PAIRING: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { output += chunk; });
    const url = `http://127.0.0.1:${port}`;
    try {
      let token = '';
      for (let i = 0; i < 100; i++) {
        try { const response = await request.get(`${url}/v1/bootstrap`); if (response.ok()) { token = (await response.json()).token; break; } } catch {}
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      expect(token, output).toBeTruthy();
      await provide({ url, port, headers: { Authorization: `Bearer ${token}` } });
    } finally {
      child.kill('SIGTERM');
      const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
      if (child.exitCode === null && child.signalCode === null) await new Promise(resolve => child.once('close', resolve));
      clearTimeout(timer);
      rmSync(state, { recursive: true, force: true });
    }
  },
});

async function pairing(request: APIRequestContext, coordinator: { url: string; headers: Record<string, string> }) {
  const response = await request.post(`${coordinator.url}/v1/machines`, { headers: coordinator.headers, data: { kind: 'device', platform: 'android', name: 'Workspace browser', coordinatorUrl: coordinator.url } });
  expect(response.status()).toBe(201);
  return (await response.json()).code as string;
}

for (const fresh of [true, false]) test(fresh ? 'a fresh paired workspace can set up its coordinator and create its first agent' : 'joining an established hub preserves its agents and allows manual coordinator setup', async ({ page, request, coordinator, isMobile }) => {
  if (!fresh) {
    await request.post(`${coordinator.url}/v1/agents/sync`, { headers: coordinator.headers, data: { agents: [{ id: 'established', name: 'Established agent', role: 'Assistant', description: '', instructions: 'Help.', tone: 0, memory: [] }] } });
  }
  const unexpectedWrites: string[] = [];
  page.on('request', request => { if (/\/v1\/(agents\/sync|migrate|workspace\/model\/import)$/.test(new URL(request.url()).pathname)) unexpectedWrites.push(request.url()); });
  // Compose refuses browser bootstrap, including localhost, then accepts a
  // scoped device credential. Keep that real pairing/session exchange intact.
  await page.route('**/v1/bootstrap', route => route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: 'Pair this browser to connect.' }) }));
  const code = await pairing(request, coordinator);
  await page.goto(`/?controlPort=${coordinator.port}`);
  await page.getByLabel('Pairing code', { exact: true }).fill(code);
  await page.getByRole('button', { name: 'Connect', exact: true }).click();

  if (!fresh) {
    await expect(page.getByRole('button', { name: 'Edit Established agent profile' })).toBeVisible();
    await expect(page.getByRole('dialog', { name: 'Welcome to Open Harness' })).toBeHidden();
    expect((await (await request.get(`${coordinator.url}/v1/agents`, { headers: coordinator.headers })).json()).agents.map((agent: { id: string }) => agent.id)).toEqual(['established']);
    if (isMobile) await page.getByRole('button', { name: 'Open navigation' }).click();
    await page.locator('aside.sidebar').getByRole('button', { name: /^Settings/ }).click();
    await page.getByRole('button', { name: 'Run setup again' }).click();
    await expect(page.getByRole('button', { name: /Use connected computer/ })).toBeVisible();
  } else {
    await expect(page.getByRole('heading', { name: 'No agents yet' })).toBeVisible();
    expect((await (await request.get(`${coordinator.url}/v1/agents`, { headers: coordinator.headers })).json()).agents).toEqual([]);
    const status = { platform: 'linux', platformLabel: 'Linux', executionReady: false, recommendedAccess: 'private', credentialMode: 'coordinator', checks: [{ id: 'agent-runtime', label: 'Agent runtime', state: 'action', detail: 'The fresh coordinator needs its runtime.', action: 'prepare-runtime', actionLabel: 'Set up agent runtime' }] };
    let prepared = 0;
    await page.route('**/v1/onboarding/status', route => route.fulfill({ json: status }));
    await page.route('**/v1/onboarding/action', async route => {
      expect(route.request().url()).toBe(`${coordinator.url}/v1/onboarding/action`);
      expect(route.request().postDataJSON()).toEqual({ action: 'prepare-runtime' });
      expect(route.request().headers()['x-open-harness-machine']).toBeTruthy();
      expect(route.request().headers().authorization).not.toBe(coordinator.headers.Authorization);
      prepared++;
      await route.fulfill({ json: { ...status, executionReady: true, checks: [{ id: 'agent-runtime', label: 'Agent runtime', state: 'ready', detail: 'Fixture runtime ready.' }] } });
    });
    // Provider validation is exercised by runtime tests; here a successful
    // validation fixture saves the selected model in the real coordinator.
    await page.route('**/v1/onboarding/model-test', async route => {
      const input = route.request().postDataJSON();
      expect(input.save).toBe(true);
      const saved = await request.put(`${coordinator.url}/v1/workspace/model`, { headers: coordinator.headers, data: { model: input.model, revision: input.revision } });
      expect(saved.ok()).toBe(true);
      await route.fulfill({ json: { ok: true, message: 'Fixture connection accepted.', ...await saved.json() } });
    });
    await page.getByRole('button', { name: 'Set up connected computer' }).click();
    await page.getByRole('button', { name: /Use connected computer/ }).click();
    await expect(page.getByRole('dialog', { name: 'Check connected computer' })).toBeVisible();
    await page.getByRole('button', { name: 'Set up agent runtime' }).click();
    await expect(page.getByText('Fixture runtime ready.')).toBeVisible();
    expect(prepared).toBe(1);
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    const model = page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: 'Connect your model' }) });
    await model.getByRole('combobox', { name: 'Provider', exact: true }).selectOption('local');
    await model.getByLabel('Model', { exact: true }).fill('fixture-local-model');
    await model.getByLabel('Model server address').fill('http://model-server.local:11434/v1');
    await model.getByRole('button', { name: 'Save and test' }).click();
    await expect(page.getByRole('heading', { name: 'You’re ready' })).toBeVisible();
    await page.getByRole('button', { name: 'Start using Open Harness' }).click();
    await page.getByRole('button', { name: 'Create your first agent' }).click();
    const editor = page.getByRole('dialog', { name: 'Agent settings' });
    await expect(editor.getByText('Loading saved profile…')).toBeHidden();
    await editor.getByLabel('Name', { exact: true }).fill('First agent');
    await editor.getByLabel('Role', { exact: true }).fill('Assistant');
    await editor.getByRole('button', { name: 'Save changes' }).click();
    await expect.poll(async () => (await (await request.get(`${coordinator.url}/v1/agents`, { headers: coordinator.headers })).json()).agents.map((agent: { name: string }) => agent.name)).toEqual(['First agent']);
    await editor.getByRole('button', { name: 'Close agent settings' }).click();
    await expect(page.getByRole('button', { name: 'Edit First agent profile' })).toBeVisible();
    await page.reload();
    await expect(page.getByRole('button', { name: 'Edit First agent profile' })).toBeVisible();
    const savedModel = await (await request.get(`${coordinator.url}/v1/workspace/model`, { headers: coordinator.headers })).json();
    expect(savedModel.model.model).toBe('fixture-local-model');
  }
  expect(unexpectedWrites).toEqual([]);
  await expect(page.getByText('The dashboard hit an error.')).toBeHidden();
});
