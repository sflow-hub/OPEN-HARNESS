import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { initialWorkspace } from '../../lib/types';

const control = `http://127.0.0.1:${process.env.OPEN_HARNESS_TEST_PORT || 4317}`;
async function auth(request: APIRequestContext) { return { Authorization: `Bearer ${(await (await request.get(control + '/v1/bootstrap')).json()).token}` }; }
// The page refuses to send chat in test mode, so it has to believe the mock runtime is live.
async function goLive(page: Page) {
  await page.route(`${control}/v1/bootstrap`, async route => {
    const response = await route.fetch();
    await route.fulfill({ response, json: { ...(await response.json()), mode: 'live' } });
  });
  await page.reload();
}

// Every spec shares one coordinator, and the page reattaches to any live run on load, so each test
// works through its own agent and removes it afterwards instead of leaving Atlas with paused work.
let agent: { id: string; name: string };
const label = () => `${agent.name}: Tool request`;
const activeRuns = async (request: APIRequestContext) => ((await (await request.get(control + '/v1/runs', { headers: await auth(request) })).json()).runs as Array<{ id: string; agent_id: string; state: string }>)
  .filter(run => run.agent_id === agent.id && ['queued', 'running', 'waiting_approval', 'waiting_input'].includes(run.state));
const startRun = async (request: APIRequestContext, prompt: string) => expect((await request.post(control + '/v1/runs', { headers: await auth(request), data: { agentId: agent.id, conversationId: `approvals-${agent.id}-${Date.now()}`, prompt } })).status()).toBe(202);
const pendingCount = async (request: APIRequestContext) => (await (await request.get(`${control}/v1/approvals?state=pending&agentId=${encodeURIComponent(agent.id)}`, { headers: await auth(request) })).json()).pendingCount as number;
const openNav = async (page: Page, mobile: boolean) => { if (mobile) await page.getByRole('button', { name: 'Open navigation' }).click(); };

test.beforeEach(async ({ request, page }, testInfo) => {
  const headers = await auth(request);
  await request.post(control + '/v1/agents/sync', { headers, data: { agents: initialWorkspace.agents } });
  const created = await request.post(control + '/v1/agents', { headers, data: { name: `Vale ${testInfo.project.name} ${Date.now().toString(36).slice(-5)}`, role: 'Approvals check' } });
  expect(created.status()).toBe(201);
  agent = (await created.json()).agent;
  await page.addInitScript(() => {
    localStorage.setItem('open-harness.onboarding.v1', 'done');
    localStorage.setItem('open-harness.advanced.v1', 'on');
  });
  await page.goto(`/?controlPort=${process.env.OPEN_HARNESS_TEST_PORT || 4317}`);
  await expect(page.getByRole('button', { name: `Edit ${agent.name} profile` })).toBeVisible();
});

test.afterEach(async ({ request }) => {
  // Stopping a run expires its approval; the agent can only be deleted once nothing is active.
  await expect.poll(async () => {
    const headers = await auth(request);
    for (const run of await activeRuns(request)) await request.post(`${control}/v1/runs/${run.id}/stop`, { headers });
    return (await request.delete(`${control}/v1/agents/${encodeURIComponent(agent.id)}`, { headers })).status();
  }).toBe(200);
});

test('lists a pending approval with a badge and moves it to history once approved', async ({ page }, testInfo) => {
  const mobile = testInfo.project.name === 'mobile';
  await goLive(page);
  await page.locator('.agent-card').filter({ hasText: agent.name }).click();
  await page.getByLabel(`Message ${agent.name}`).fill(`MOCK_APPROVAL inbox ${testInfo.project.name}`);
  await page.getByLabel(`Message ${agent.name}`).press('Enter');
  await expect(page.getByRole('alert').filter({ hasText: `${agent.name} needs approval` })).toBeVisible();

  await openNav(page, mobile);
  const nav = page.getByRole('button', { name: /^Approvals/ });
  await expect(nav).toHaveAccessibleName('Approvals 1');
  await nav.click();

  const item = page.getByRole('list', { name: 'Pending approvals' }).getByRole('listitem', { name: label() });
  await expect(item).toHaveCount(1);
  await expect(item).toContainText('publish mock result');
  await expect(item).toContainText(/Requested (just now|\d+ min ago)/);

  await item.getByRole('button', { name: `Approve Tool request for ${agent.name}` }).click();
  await expect(page.getByText('Nothing is waiting for you.')).toBeVisible();

  await page.getByRole('button', { name: 'History', exact: true }).click();
  await expect(page.getByRole('button', { name: 'History', exact: true })).toHaveAttribute('aria-pressed', 'true');
  const answered = page.getByRole('list', { name: 'Approval history' }).getByRole('listitem', { name: label() });
  await expect(answered).toHaveCount(1);
  await expect(answered).toContainText('publish mock result');
  await expect(answered).toContainText('Approved');

  await openNav(page, mobile);
  await expect(nav).toHaveAccessibleName('Approvals');
});

test('an approval answered elsewhere is reported as no longer pending', async ({ page, request }, testInfo) => {
  const mobile = testInfo.project.name === 'mobile';
  await startRun(request, 'MOCK_APPROVAL stale inbox item');
  await expect.poll(() => pendingCount(request)).toBe(1);
  page.on('dialog', dialog => void dialog.accept());
  await goLive(page);

  await openNav(page, mobile);
  const nav = page.getByRole('button', { name: /^Approvals/ });
  await expect(nav).toHaveAccessibleName('Approvals 1');
  await nav.click();
  const item = page.getByRole('list', { name: 'Pending approvals' }).getByRole('listitem', { name: label() });
  await expect(item).toHaveCount(1);

  // Another tab answers first, so the inbox's copy is stale by the time this decision lands.
  const headers = await auth(request);
  await page.route('**/v1/runs/*/approval', async route => {
    const browserRequest = route.request();
    await request.post(control + new URL(browserRequest.url()).pathname, { headers, data: browserRequest.postDataJSON() });
    await route.continue();
  });
  await item.getByRole('button', { name: `Approve Tool request for ${agent.name}` }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'This approval is no longer pending.' })).toBeVisible();
  await expect(page.getByText('Nothing is waiting for you.')).toBeVisible();
  await page.getByRole('button', { name: 'History', exact: true }).click();
  await expect(page.getByRole('list', { name: 'Approval history' }).getByRole('listitem', { name: label() })).toContainText('Approved');
});

test('a denied approval moves to history and a slow history load never replaces the pending view', async ({ page, request }, testInfo) => {
  const mobile = testInfo.project.name === 'mobile';
  await startRun(request, `MOCK_APPROVAL deny ${testInfo.project.name}`);
  await expect.poll(() => pendingCount(request)).toBe(1);
  await goLive(page);

  await openNav(page, mobile);
  await page.getByRole('button', { name: /^Approvals/ }).click();
  const pending = page.getByRole('list', { name: 'Pending approvals' });
  await pending.getByRole('listitem', { name: label() }).getByRole('button', { name: `Deny Tool request for ${agent.name}` }).click();
  await expect(page.getByText('Nothing is waiting for you.')).toBeVisible();
  await expect.poll(() => pendingCount(request)).toBe(0);
  // The next run is only admitted once the denied one has finished with the agent.
  await expect.poll(async () => (await activeRuns(request)).length).toBe(0);

  await startRun(request, `MOCK_APPROVAL second ${testInfo.project.name}`);
  await expect.poll(() => pendingCount(request)).toBe(1);

  // Hold the history response until the pending view is back, so it can only arrive late.
  const isHistory = (url: URL) => url.pathname === '/v1/approvals' && url.searchParams.get('state') === 'resolved';
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route(isHistory, async route => { const response = await route.fetch(); await held; await route.fulfill({ response }); });
  const sent = page.waitForRequest(browserRequest => isHistory(new URL(browserRequest.url())));
  await page.getByRole('button', { name: 'History', exact: true }).click();
  await sent;
  await page.getByRole('button', { name: 'Pending', exact: true }).click();
  const item = pending.getByRole('listitem', { name: label() });
  await expect(item).toHaveCount(1);

  const delivered = page.waitForEvent('requestfinished', browserRequest => isHistory(new URL(browserRequest.url())));
  release();
  await delivered;
  // Two frames let the page finish handling the late response before checking it was ignored.
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await expect(page.getByRole('list', { name: 'Approval history' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Pending', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(item).toHaveCount(1);
  await expect(item).toContainText(/Requested (just now|\d+ min ago)/);
  await expect(item.getByRole('button', { name: `Approve Tool request for ${agent.name}` })).toBeVisible();
  await expect(page.getByText('Denied')).toHaveCount(0);

  await page.unroute(isHistory);
  await page.getByRole('button', { name: 'History', exact: true }).click();
  const denied = page.getByRole('list', { name: 'Approval history' }).getByRole('listitem', { name: label() });
  await expect(denied).toContainText('Denied');
  await expect(denied.getByRole('button')).toHaveCount(0);
});
