import { test, expect, type APIRequestContext, type Locator, type Page, type Route } from '@playwright/test';
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
// Coordinator-wide, not agent-scoped: the nav badge reflects this, so other specs' pending work counts too.
const globalPendingCount = async (request: APIRequestContext) => (await (await request.get(`${control}/v1/approvals?state=pending`, { headers: await auth(request) })).json()).pendingCount as number;
// app/page.tsx renders 'Approvals N' from the global pending count, and plain 'Approvals' at zero.
const expectBadgeMatchesGlobal = (nav: Locator, request: APIRequestContext) => expect(async () => {
  const count = await globalPendingCount(request);
  await expect(nav).toHaveAccessibleName(count ? `Approvals ${count}` : 'Approvals');
}).toPass();
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

test('lists a pending approval with a badge and moves it to history once approved', async ({ page, request }, testInfo) => {
  const mobile = testInfo.project.name === 'mobile';
  await goLive(page);
  await page.locator('.agent-card').filter({ hasText: agent.name }).click();
  await page.getByLabel(`Message ${agent.name}`).fill(`MOCK_APPROVAL inbox ${testInfo.project.name}`);
  await page.getByLabel(`Message ${agent.name}`).press('Enter');
  await expect(page.getByRole('alert').filter({ hasText: `${agent.name} needs approval` })).toBeVisible();

  await openNav(page, mobile);
  const nav = page.getByRole('button', { name: /^Approvals/ });
  // This agent owns exactly one pending request; the badge counts every agent's, so just check it tracks the API.
  await expect.poll(() => pendingCount(request)).toBe(1);
  expect(await globalPendingCount(request)).toBeGreaterThanOrEqual(1);
  await expectBadgeMatchesGlobal(nav, request);
  await nav.click();

  const item = page.getByRole('list', { name: 'Pending approvals' }).getByRole('listitem', { name: label() });
  await expect(item).toHaveCount(1);
  await expect(item).toContainText('publish mock result');
  await expect(item).toContainText(/Requested (just now|\d+ min ago)/);

  await item.getByRole('button', { name: `Approve Tool request for ${agent.name}` }).click();
  await expect(item).toHaveCount(0);
  await expect.poll(() => pendingCount(request)).toBe(0);

  await page.getByRole('button', { name: 'History', exact: true }).click();
  await expect(page.getByRole('button', { name: 'History', exact: true })).toHaveAttribute('aria-pressed', 'true');
  const answered = page.getByRole('list', { name: 'Approval history' }).getByRole('listitem', { name: label() });
  await expect(answered).toHaveCount(1);
  await expect(answered).toContainText('publish mock result');
  await expect(answered).toContainText('Approved');

  await openNav(page, mobile);
  await expectBadgeMatchesGlobal(nav, request);
});

test('a badge poll that lands after the inbox reports a newer count does not restore the old count', async ({ page, request }, testInfo) => {
  const mobile = testInfo.project.name === 'mobile';
  await startRun(request, `MOCK_APPROVAL late badge ${testInfo.project.name}`);
  await expect.poll(() => pendingCount(request)).toBe(1);

  // The page polls the badge on load and every 15 s. Capture the load's poll while this approval is
  // still pending and hold it; later polls are dropped so only the inbox can correct a stale count.
  const isBadgePoll = (url: URL) => url.pathname === '/v1/approvals' && url.searchParams.get('state') === 'pending' && url.searchParams.get('limit') === '1';
  let release!: () => void, fetched!: (count: number) => void, holding = false;
  const held = new Promise<void>(resolve => { release = resolve; });
  const heldCount = new Promise<number>(resolve => { fetched = resolve; });
  await page.route(isBadgePoll, async route => {
    if (holding) return route.abort();
    holding = true;
    const response = await route.fetch();
    fetched((await response.json()).pendingCount);
    await held;
    await route.fulfill({ response });
  });
  // The inbox also reports the count, on every refresh and every 10 s. Once it has reported the new
  // count its refreshes are held, so it cannot correct a stale badge while the late poll is checked.
  const isInboxList = (url: URL) => url.pathname === '/v1/approvals' && url.searchParams.get('limit') === '100';
  const heldInbox: Route[] = [];
  let holdInbox = false, inboxInFlight = 0;
  await page.route(isInboxList, async route => {
    if (holdInbox) return void heldInbox.push(route);
    inboxInFlight++;
    try { await route.fulfill({ response: await route.fetch() }); } finally { inboxInFlight--; }
  });
  const sent = page.waitForRequest(browserRequest => isBadgePoll(new URL(browserRequest.url())));
  await page.reload();
  const poll = await sent;

  await openNav(page, mobile);
  const nav = page.getByRole('button', { name: /^Approvals/ });
  await nav.click();
  const item = page.getByRole('list', { name: 'Pending approvals' }).getByRole('listitem', { name: label() });
  await expect(item).toHaveCount(1);
  // The held poll must carry the count from before the decision, or there is nothing stale to drop.
  const staleCount = await heldCount;
  expect(staleCount).toBeGreaterThanOrEqual(1);
  await item.getByRole('button', { name: `Approve Tool request for ${agent.name}` }).click();
  // The item only leaves the list on the post-decision refresh, which reports the new count with it.
  await expect(item).toHaveCount(0);
  await expect.poll(() => pendingCount(request)).toBe(0);
  await openNav(page, mobile);
  await expectBadgeMatchesGlobal(nav, request);

  holdInbox = true;
  await expect.poll(() => inboxInFlight).toBe(0);
  const current = await globalPendingCount(request);
  expect(current).toBeLessThan(staleCount);
  const delivered = page.waitForEvent('requestfinished', browserRequest => browserRequest === poll);
  release();
  await delivered;
  // Two frames let the page finish handling the late poll; then one read, since a retry could outwait a stale badge.
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  expect((await nav.textContent())?.replace(/\s+/g, ' ').trim()).toBe(current ? `Approvals ${current}` : 'Approvals');

  holdInbox = false;
  await Promise.all(heldInbox.map(route => route.continue()));
  await page.unroute(isInboxList);
  await page.unroute(isBadgePoll);
});

test('an approval answered elsewhere is reported as no longer pending', async ({ page, request }, testInfo) => {
  const mobile = testInfo.project.name === 'mobile';
  await startRun(request, 'MOCK_APPROVAL stale inbox item');
  await expect.poll(() => pendingCount(request)).toBe(1);
  page.on('dialog', dialog => void dialog.accept());
  await goLive(page);

  await openNav(page, mobile);
  const nav = page.getByRole('button', { name: /^Approvals/ });
  expect(await globalPendingCount(request)).toBeGreaterThanOrEqual(1);
  await expectBadgeMatchesGlobal(nav, request);
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
  await expect(item).toHaveCount(0);
  await expect.poll(() => pendingCount(request)).toBe(0);
  await page.getByRole('button', { name: 'History', exact: true }).click();
  await expect(page.getByRole('list', { name: 'Approval history' }).getByRole('listitem', { name: label() })).toContainText('Approved');
});

test('a decision error that lands after switching views is not shown', async ({ page, request }, testInfo) => {
  const mobile = testInfo.project.name === 'mobile';
  await startRun(request, `MOCK_APPROVAL late conflict ${testInfo.project.name}`);
  await expect.poll(() => pendingCount(request)).toBe(1);
  await goLive(page);

  await openNav(page, mobile);
  await page.getByRole('button', { name: /^Approvals/ }).click();
  const item = page.getByRole('list', { name: 'Pending approvals' }).getByRole('listitem', { name: label() });
  await expect(item).toHaveCount(1);

  // Hold the decision until History is on screen, then answer it with a conflict.
  const isDecision = (url: URL) => /^\/v1\/runs\/[^/]+\/approval$/.test(url.pathname);
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/v1/runs/*/approval', async route => { await held; await route.fulfill({ status: 409, json: { error: 'Approval is not pending.' } }); });
  const sent = page.waitForRequest(browserRequest => isDecision(new URL(browserRequest.url())));
  await item.getByRole('button', { name: `Approve Tool request for ${agent.name}` }).click();
  await sent;

  await page.getByRole('button', { name: 'History', exact: true }).click();
  await expect(page.getByRole('button', { name: 'History', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.approvals-loading')).toHaveCount(0);

  const isHistoryList = (url: URL) => url.pathname === '/v1/approvals' && url.searchParams.get('state') === 'resolved' && url.searchParams.get('limit') === '100';
  const answered = page.waitForEvent('requestfinished', browserRequest => isDecision(new URL(browserRequest.url())));
  const refreshed = page.waitForResponse(response => isHistoryList(new URL(response.url())));
  release();
  await answered;
  await refreshed;
  // Two frames let the page finish handling the late conflict before checking it was ignored.
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const conflict = page.getByRole('alert').filter({ hasText: 'This approval is no longer pending.' });
  await expect(conflict).toHaveCount(0);

  await page.getByRole('button', { name: 'Pending', exact: true }).click();
  await expect(item).toHaveCount(1);
  await expect(conflict).toHaveCount(0);
});

test('a failed approvals load is cleared once a later refresh succeeds', async ({ page }, testInfo) => {
  const mobile = testInfo.project.name === 'mobile';
  // limit=100 is the inbox's own list; the nav badge polls with limit=1 and must not consume the failure.
  const isInboxList = (url: URL) => url.pathname === '/v1/approvals' && url.searchParams.get('limit') === '100';
  await page.route(isInboxList, route => route.fulfill({ status: 500, json: { error: 'Approvals are briefly unavailable.' } }), { times: 1 });
  await openNav(page, mobile);
  await page.getByRole('button', { name: /^Approvals/ }).click();
  const failure = page.getByRole('alert').filter({ hasText: 'Approvals are briefly unavailable.' });
  await expect(failure).toBeVisible();

  // The inbox polls every 10 s; that next load is the refresh that should clear the alert.
  await page.waitForResponse(response => isInboxList(new URL(response.url())) && response.ok(), { timeout: 15_000 });
  await expect(failure).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Pending', exact: true })).toHaveAttribute('aria-pressed', 'true');
});

test('a denied approval moves to history and a slow history load never replaces the pending view', async ({ page, request }, testInfo) => {
  const mobile = testInfo.project.name === 'mobile';
  await startRun(request, `MOCK_APPROVAL deny ${testInfo.project.name}`);
  await expect.poll(() => pendingCount(request)).toBe(1);
  await goLive(page);

  await openNav(page, mobile);
  await page.getByRole('button', { name: /^Approvals/ }).click();
  const pending = page.getByRole('list', { name: 'Pending approvals' });
  const denyItem = pending.getByRole('listitem', { name: label() });
  await denyItem.getByRole('button', { name: `Deny Tool request for ${agent.name}` }).click();
  await expect(denyItem).toHaveCount(0);
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
  await expect(item).not.toContainText('Denied');

  await page.unroute(isHistory);
  await page.getByRole('button', { name: 'History', exact: true }).click();
  const denied = page.getByRole('list', { name: 'Approval history' }).getByRole('listitem', { name: label() });
  await expect(denied).toContainText('Denied');
  await expect(denied.getByRole('button')).toHaveCount(0);
});
