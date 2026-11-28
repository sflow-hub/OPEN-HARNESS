import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { initialWorkspace } from '../../lib/types';

const controlPort = process.env.OPEN_HARNESS_TEST_PORT || 4317;
const control = `http://127.0.0.1:${controlPort}`;
async function seed(request: APIRequestContext) {
  const { token } = await (await request.get(control + '/v1/bootstrap')).json();
  await request.post(control + '/v1/agents/sync', { headers: { Authorization: `Bearer ${token}` }, data: { agents: initialWorkspace.agents } });
}

// The page talks to the coordinator cross-origin, so mocked replies need the CORS headers it would send.
const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS' };
const stamp = '2026-11-01T09:00:00.000Z';
const fixtures = () => ({
  routines: [
    { id: 'r-interval', agent_id: 'atlas', name: 'Daily digest', prompt: 'Summarize the shared files.', interval_minutes: 1440, timezone: 'UTC', enabled: 1, next_run_at: stamp, last_run_at: null, created_at: stamp, updated_at: stamp },
    { id: 'r-cron', agent_id: 'atlas', name: 'Weekday standup', prompt: 'Post the standup notes.', interval_minutes: 1440, timezone: 'America/Denver', enabled: 0, next_run_at: stamp, last_run_at: stamp, created_at: stamp, updated_at: stamp, schedule_kind: 'cron', cron_expression: '0 9 * * 1-5', misfire_policy: 'skip' },
  ],
  history: {
    'r-interval': [
      { schedule_id: 'r-interval', run_id: 'run-2', scheduled_for: '2026-11-02T09:00:00.000Z', state: 'failed', result: null, error: 'The model provider timed out.', updated_at: '2026-11-02T09:01:00.000Z' },
      { schedule_id: 'r-interval', run_id: 'run-1', scheduled_for: '2026-11-01T09:00:00.000Z', state: 'completed', result: 'Digest saved as digest.md.', error: null, updated_at: '2026-11-01T09:02:00.000Z' },
    ],
    'r-cron': [],
  } as Record<string, unknown[]>,
});

async function mockRoutines(page: Page, options: { failHistory?: number } = {}) {
  const data = fixtures(), calls: string[] = [], bodies: Record<string, unknown> = {};
  let historyFailures = options.failHistory || 0;
  await page.route(url => url.port === String(controlPort) && url.pathname.startsWith('/v1/routines'), async route => {
    const method = route.request().method(), { pathname } = new URL(route.request().url());
    if (method === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    calls.push(`${method} ${pathname}`);
    if (pathname === '/v1/routines' && method === 'GET') return route.fulfill({ headers: cors, json: { routines: data.routines } });
    const [, id, action] = pathname.match(/^\/v1\/routines\/([^/]+)(?:\/(history|run|toggle))?$/) || [];
    const routine = data.routines.find(item => item.id === id);
    if (!routine) return route.fulfill({ status: 404, headers: cors, json: { error: 'Routine not found.' } });
    if (!action && method === 'PUT') { const input = route.request().postDataJSON(); bodies[`PUT ${pathname}`] = input; Object.assign(routine, { name: input.name, prompt: input.prompt, agent_id: input.agentId }); return route.fulfill({ headers: cors, json: { ...routine, nextRunAt: stamp } }); }
    if (action === 'history' && method === 'GET') {
      if (historyFailures-- > 0) return route.fulfill({ status: 500, headers: cors, json: { error: 'History is unavailable right now.' } });
      return route.fulfill({ headers: cors, json: { history: data.history[routine.id] } });
    }
    if (action === 'toggle' && method === 'POST') { routine.enabled = routine.enabled ? 0 : 1; return route.fulfill({ headers: cors, json: { enabled: Boolean(routine.enabled) } }); }
    if (action === 'run' && method === 'POST') { routine.last_run_at = new Date().toISOString(); return route.fulfill({ status: 202, headers: cors, json: { id: 'run-now', agent_id: routine.agent_id, conversation_id: 'c-now', prompt: routine.prompt, state: 'queued' } }); }
    return route.fulfill({ status: 405, headers: cors, json: { error: 'Unexpected routine call.' } });
  });
  return Object.assign(calls, { bodies });
}

async function openRoutines(page: Page, project: string) {
  if (project === 'mobile') await page.getByRole('button', { name: 'Open navigation' }).click();
  await page.getByRole('button', { name: /Routines/ }).first().click();
  await expect(page.getByRole('heading', { name: 'Routines', level: 1 })).toBeVisible();
}
const row = (page: Page, name: string) => page.locator('.file-table-row').filter({ hasText: name });

test.beforeEach(async ({ request, page }) => {
  await seed(request);
  await page.addInitScript(() => localStorage.setItem('open-harness.onboarding.v1', 'done'));
});

async function load(page: Page) {
  await page.goto(`/?controlPort=${controlPort}`);
  await expect(page.getByRole('button', { name: 'Edit Atlas profile' })).toBeVisible();
}

test('lists interval and cron routines with their schedules', async ({ page }, testInfo) => {
  await mockRoutines(page);
  await load(page);
  await openRoutines(page, testInfo.project.name);
  await expect(row(page, 'Daily digest')).toContainText('every day');
  await expect(row(page, 'Daily digest')).toContainText('Enabled');
  await expect(row(page, 'Daily digest')).toContainText('Has not run yet');
  await expect(row(page, 'Weekday standup')).toContainText('cron 0 9 * * 1-5 (America/Denver)');
  await expect(row(page, 'Weekday standup')).not.toContainText('every day');
  await expect(row(page, 'Weekday standup')).toContainText('Paused');
});

test('opens a routine history drawer listing runs and their states', async ({ page }, testInfo) => {
  const calls = await mockRoutines(page);
  await load(page);
  await openRoutines(page, testInfo.project.name);
  await page.getByRole('button', { name: 'History for Daily digest' }).click();
  const drawer = page.getByRole('dialog', { name: 'History for Daily digest' });
  await expect(drawer.locator('.run-history')).toHaveCount(2);
  await expect(drawer.locator('.run-pill.failed')).toHaveText('failed');
  await expect(drawer.locator('.run-pill.completed')).toHaveText('completed');
  await expect(drawer.getByText('The model provider timed out.')).toBeVisible();
  await expect(drawer.getByText('Digest saved as digest.md.')).toBeVisible();
  expect(calls).toContain('GET /v1/routines/r-interval/history');
  await drawer.getByRole('button', { name: 'Close history' }).click();
  await expect(drawer).toBeHidden();
});

test('keeps keyboard focus inside the history drawer and returns it on Escape', async ({ page }, testInfo) => {
  await mockRoutines(page);
  await load(page);
  await openRoutines(page, testInfo.project.name);
  const trigger = page.getByRole('button', { name: 'History for Weekday standup' });
  await trigger.click();
  const drawer = page.getByRole('dialog', { name: 'History for Weekday standup' });
  const close = drawer.getByRole('button', { name: 'Close history' });
  await expect(drawer.getByRole('heading', { name: 'No runs yet.' })).toBeVisible();
  await expect(close).toBeFocused();
  // Close is the only control while the history is empty, so Tab must wrap back onto it.
  await page.keyboard.press('Tab');
  await expect(close).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(close).toBeFocused();
  // Escape must still dismiss once focus has left the drawer entirely.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('Escape');
  await expect(drawer).toBeHidden();
  await expect(trigger).toBeFocused();
});

test('wraps focus between the drawer controls when there are several', async ({ page }, testInfo) => {
  await mockRoutines(page, { failHistory: 1 });
  await load(page);
  await openRoutines(page, testInfo.project.name);
  await page.getByRole('button', { name: 'History for Daily digest' }).click();
  const drawer = page.getByRole('dialog', { name: 'History for Daily digest' });
  const close = drawer.getByRole('button', { name: 'Close history' }), retry = drawer.getByRole('button', { name: 'Try again' });
  await expect(retry).toBeVisible();
  await expect(close).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(retry).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(close).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(retry).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(drawer).toBeHidden();
  await expect(page.getByRole('button', { name: 'History for Daily digest' })).toBeFocused();
});

test('editing a cron routine keeps its schedule and timezone', async ({ page }, testInfo) => {
  const calls = await mockRoutines(page);
  await load(page);
  await openRoutines(page, testInfo.project.name);
  await row(page, 'Weekday standup').getByRole('button', { name: 'Edit' }).click();
  const dialog = page.getByRole('dialog', { name: 'Edit routine' });
  await expect(dialog).toContainText('0 9 * * 1-5 (America/Denver)');
  await expect(dialog.getByText('Run every')).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('Routine updated.')).toBeVisible();
  const sent = calls.bodies['PUT /v1/routines/r-cron'] as Record<string, unknown>;
  expect(sent).toMatchObject({ name: 'Weekday standup', agentId: 'atlas' });
  expect(sent).not.toHaveProperty('timezone');
  expect(sent).not.toHaveProperty('intervalMinutes');
  expect(sent).not.toHaveProperty('scheduleKind');
});

test('says so when a routine has never run', async ({ page }, testInfo) => {
  await mockRoutines(page);
  await load(page);
  await openRoutines(page, testInfo.project.name);
  await page.getByRole('button', { name: 'History for Weekday standup' }).click();
  const drawer = page.getByRole('dialog', { name: 'History for Weekday standup' });
  await expect(drawer.getByRole('heading', { name: 'No runs yet.' })).toBeVisible();
  await expect(drawer.locator('.run-history')).toHaveCount(0);
});

test('a history that fails to load can be retried', async ({ page }, testInfo) => {
  await mockRoutines(page, { failHistory: 1 });
  await load(page);
  await openRoutines(page, testInfo.project.name);
  await page.getByRole('button', { name: 'History for Daily digest' }).click();
  const drawer = page.getByRole('dialog', { name: 'History for Daily digest' });
  await expect(drawer.getByRole('alert')).toContainText('History is unavailable right now.');
  await drawer.getByRole('button', { name: 'Try again' }).click();
  await expect(drawer.locator('.run-history')).toHaveCount(2);
});

test('pause and run now call the routine endpoints', async ({ page }, testInfo) => {
  const calls = await mockRoutines(page);
  await load(page);
  await openRoutines(page, testInfo.project.name);
  await row(page, 'Daily digest').getByRole('button', { name: 'Pause' }).click();
  await expect(row(page, 'Daily digest').getByRole('button', { name: 'Enable' })).toBeVisible();
  expect(calls).toContain('POST /v1/routines/r-interval/toggle');

  await row(page, 'Weekday standup').getByRole('button', { name: 'Run now' }).click();
  await expect(page.getByText('Routine queued now.')).toBeVisible();
  expect(calls).toContain('POST /v1/routines/r-cron/run');
  expect(calls).not.toContain('POST /v1/routines/r-interval/run');
});
