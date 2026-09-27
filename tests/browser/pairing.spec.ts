import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { initialWorkspace } from '../../lib/types';

// The Docker-backed local install hands its operator token only to a browser that arrives
// with the launcher's one-use link (http://localhost:3000/#pair=<code>). The shared mock
// coordinator does not enforce pairing itself, so these cases put the contract in front of
// it with route handlers: an unauthenticated bootstrap is refused with 401 + pairingRequired,
// a good code answers with the real status (and real token), a stale one is refused.
const control = `http://127.0.0.1:${process.env.OPEN_HARNESS_TEST_PORT || 4317}`;
const GOOD = 'one-use-code';
const REFUSED = { error: 'Open Open Harness with its launcher to connect this browser. The launcher creates a new one-use connection link.', pairingRequired: true };
const INVALID = { error: 'This browser connection link is invalid or expired. Open Open Harness with its launcher to get a new link.', pairingRequired: true };

async function seed(request: APIRequestContext) {
  const { token } = await (await request.get(control + '/v1/bootstrap')).json();
  await request.post(control + '/v1/agents/sync', { headers: { Authorization: `Bearer ${token}` }, data: { agents: initialWorkspace.agents } });
  return token as string;
}
// Puts the pairing contract in front of the mock coordinator and counts what the page tried.
async function enforcePairing(page: Page, realToken: string, { bareDelayMs = 0 } = {}) {
  const attempts = { unauthenticated: 0, authenticated: 0, pair: [] as string[] };
  await page.route(`${control}/v1/bootstrap`, async route => {
    const presented = route.request().headers()['authorization'] || '';
    if (presented !== `Bearer ${realToken}`) {
      attempts.unauthenticated += 1;
      if (bareDelayMs) await new Promise(resolve => setTimeout(resolve, bareDelayMs));
      return route.fulfill({ status: 401, json: REFUSED });
    }
    attempts.authenticated += 1;
    const response = await route.fetch();
    await route.fulfill({ response, json: { ...await response.json(), mode: 'live' } });
  });
  await page.route(`${control}/v1/browser/pair`, async route => {
    const { code } = route.request().postDataJSON();
    attempts.pair.push(code);
    if (code !== GOOD) return route.fulfill({ status: 401, json: INVALID });
    // Fetched with the page's Origin so the coordinator's CORS answer fits the dashboard.
    const response = await page.request.get(`${control}/v1/bootstrap`, { headers: { origin: route.request().headers()['origin'] || '' } });
    await route.fulfill({ response, json: { ...await response.json(), mode: 'live' } });
  });
  return attempts;
}
const dashboard = (page: Page) => page.getByRole('button', { name: 'Edit Atlas profile' });
const storedToken = (page: Page) => page.evaluate(base => localStorage.getItem(`open-harness.pair.v1:${base}`), control);
// The connection status sits in the sidebar, which the phone layout keeps behind a button.
async function sidebarShows(page: Page, text: string) {
  const open = page.getByRole('button', { name: 'Open navigation' });
  if (await open.isVisible() && !await page.getByRole('button', { name: 'Close navigation' }).isVisible()) await open.click();
  await expect(page.getByText(text)).toBeVisible();
}

test.beforeEach(async ({ page }) => { await page.addInitScript(() => localStorage.setItem('open-harness.onboarding.v1', 'done')); });

test('the launcher link pairs the browser, disappears from the address bar, and the token reopens the dashboard', async ({ page, request }) => {
  const token = await seed(request);
  const attempts = await enforcePairing(page, token);
  await page.goto(`/?controlPort=${process.env.OPEN_HARNESS_TEST_PORT || 4317}#pair=${GOOD}`);
  await expect(dashboard(page)).toBeVisible();
  await expect(page).not.toHaveURL(/#/);
  await expect(page).toHaveURL(/\?controlPort=\d+$/);
  expect(await storedToken(page)).toBe(token);
  expect(attempts.pair).toEqual([GOOD]);
  expect(attempts.unauthenticated).toBe(0);
  await sidebarShows(page, 'Agent runtime ready');
  // Reopened later, without any link: the stored token is presented, nothing is tried bare.
  await page.reload();
  await sidebarShows(page, 'Agent runtime ready');
  expect(attempts.unauthenticated).toBe(0);
  expect(attempts.authenticated).toBeGreaterThanOrEqual(2);
  expect(attempts.pair).toEqual([GOOD]);
});

test('a browser with no token and a used or expired link is told to relaunch, and never loads unauthenticated', async ({ page, request }) => {
  const token = await seed(request);
  const attempts = await enforcePairing(page, token);
  await page.goto(`/?controlPort=${process.env.OPEN_HARNESS_TEST_PORT || 4317}#pair=stale-code`);
  const gate = page.getByRole('alert').filter({ hasText: 'already been used or has expired' });
  await expect(gate).toBeVisible();
  await expect(gate).toContainText('Run Start Open Harness again');
  await expect(page).not.toHaveURL(/#/);
  await sidebarShows(page, 'Browser not paired');
  await expect(page.getByText('Agent runtime ready')).toHaveCount(0);
  // What is on screen is the copy this device saved; nothing came from the coordinator.
  await expect(page.getByText('Saved on this device')).toBeVisible();
  expect(await storedToken(page)).toBeNull();
  expect(attempts.pair).toEqual(['stale-code']);
  expect(attempts.authenticated).toBe(0);
  // One bare bootstrap told the page pairing is required; the refusal is not polled away.
  await page.waitForTimeout(2_500);
  expect(attempts.unauthenticated).toBe(1);
  // Trying again asks once more and stays refused, still without a token.
  await gate.getByRole('button', { name: 'Try again' }).click();
  await expect(gate).toBeVisible();
  await expect.poll(() => attempts.unauthenticated).toBe(2);
});

test('a plain visit without a token explains how to get a paired window', async ({ page, request }) => {
  const token = await seed(request);
  const attempts = await enforcePairing(page, token);
  await page.goto(`/?controlPort=${process.env.OPEN_HARNESS_TEST_PORT || 4317}`);
  const gate = page.getByRole('alert').filter({ hasText: 'isn’t paired with Open Harness' });
  await expect(gate).toBeVisible();
  await expect(gate).toContainText('launchers/start.sh');
  await sidebarShows(page, 'Browser not paired');
  await expect(page.getByText('Agent runtime ready')).toHaveCount(0);
  expect(attempts.pair).toEqual([]);
  expect(attempts.authenticated).toBe(0);
  expect(await storedToken(page)).toBeNull();
});

test('an already paired browser keeps working when it arrives with a link that has been used', async ({ page, request }) => {
  const token = await seed(request);
  const attempts = await enforcePairing(page, token);
  await page.goto(`/?controlPort=${process.env.OPEN_HARNESS_TEST_PORT || 4317}#pair=${GOOD}`);
  await sidebarShows(page, 'Agent runtime ready');
  // A second launch opens a fresh window with a fresh link; here the link is one that has
  // been consumed. The document is left first so this is a real load, not a hash change.
  await page.goto('about:blank');
  await page.goto(`/?controlPort=${process.env.OPEN_HARNESS_TEST_PORT || 4317}#pair=stale-code`);
  await sidebarShows(page, 'Agent runtime ready');
  await expect(page).not.toHaveURL(/#/);
  await expect(page.getByRole('alert').filter({ hasText: 'paired' })).toHaveCount(0);
  expect(attempts.pair).toEqual([GOOD, 'stale-code']);
  expect(attempts.unauthenticated).toBe(0);
  expect(await storedToken(page)).toBe(token);
});

test('a source dashboard whose coordinator does not require pairing is unchanged', async ({ page, request }) => {
  await seed(request);
  await page.goto(`/?controlPort=${process.env.OPEN_HARNESS_TEST_PORT || 4317}`);
  await expect(dashboard(page)).toBeVisible();
  await sidebarShows(page, 'Automated test mode');
  expect(await storedToken(page)).toBeNull();
  await expect(page.getByRole('alert').filter({ hasText: 'paired' })).toHaveCount(0);
});

// Manual pairing, as the docs describe it: the operator mints a code and pastes the link
// into a dashboard that is already open. Only the fragment changes, so nothing reloads.
const pasteLink = (page: Page, code: string) => page.evaluate(value => { window.location.hash = `#pair=${value}`; }, code);

test('a fresh link pasted into an open unpaired dashboard pairs it in place, and a stale one pasted later is refused and cleared', async ({ page, request }) => {
  const token = await seed(request);
  const attempts = await enforcePairing(page, token);
  await page.goto(`/?controlPort=${process.env.OPEN_HARNESS_TEST_PORT || 4317}`);
  await expect(page.getByRole('alert').filter({ hasText: 'isn’t paired with Open Harness' })).toBeVisible();
  expect(attempts.unauthenticated).toBe(1);
  await pasteLink(page, GOOD);
  await sidebarShows(page, 'Agent runtime ready');
  await expect(page.getByRole('alert').filter({ hasText: 'paired' })).toHaveCount(0);
  await expect(page).not.toHaveURL(/#/);
  expect(await storedToken(page)).toBe(token);
  expect(attempts.pair).toEqual([GOOD]);
  // The paired connection presented the token; nothing was tried bare.
  expect(attempts.unauthenticated).toBe(1);
  // A used link pasted into the now paired dashboard: exchanged once, refused, cleared; the
  // dashboard stays connected on its token and no gate appears.
  await pasteLink(page, 'stale-code');
  await expect(page).not.toHaveURL(/#/);
  await expect.poll(() => attempts.pair).toEqual([GOOD, 'stale-code']);
  await sidebarShows(page, 'Agent runtime ready');
  await expect(page.getByRole('alert').filter({ hasText: 'paired' })).toHaveCount(0);
  expect(attempts.unauthenticated).toBe(1);
  expect(await storedToken(page)).toBe(token);
});

test('a stale link pasted into an open unpaired dashboard is refused and cleared, and the page still never loads unauthenticated', async ({ page, request }) => {
  const token = await seed(request);
  const attempts = await enforcePairing(page, token);
  await page.goto(`/?controlPort=${process.env.OPEN_HARNESS_TEST_PORT || 4317}`);
  await expect(page.getByRole('alert').filter({ hasText: 'isn’t paired with Open Harness' })).toBeVisible();
  await pasteLink(page, 'stale-code');
  const gate = page.getByRole('alert').filter({ hasText: 'already been used or has expired' });
  await expect(gate).toBeVisible();
  await expect(page).not.toHaveURL(/#/);
  await sidebarShows(page, 'Browser not paired');
  expect(await storedToken(page)).toBeNull();
  expect(attempts.pair).toEqual(['stale-code']);
  // The plain visit and the attempt after the refused link: one bare bootstrap each, then
  // nothing on a timer.
  await page.waitForTimeout(2_500);
  expect(attempts.unauthenticated).toBe(2);
  // A fresh link afterwards still works from that gate.
  await pasteLink(page, GOOD);
  await sidebarShows(page, 'Agent runtime ready');
  await expect(gate).toHaveCount(0);
  expect(attempts.pair).toEqual(['stale-code', GOOD]);
  expect(attempts.unauthenticated).toBe(2);
});

test('a slow refusal of the plain visit, landing after a link pasted meanwhile has paired the browser, changes nothing', async ({ page, request }) => {
  // The bare bootstrap of the plain visit is still in flight when the operator pastes a
  // fresh link. The pairing wins the race; the old refusal then arrives and must neither
  // clear the new token nor put the gate up.
  const token = await seed(request);
  const attempts = await enforcePairing(page, token, { bareDelayMs: 1_500 });
  await page.goto(`/?controlPort=${process.env.OPEN_HARNESS_TEST_PORT || 4317}`);
  await expect(dashboard(page)).toBeVisible();
  await expect.poll(() => attempts.unauthenticated).toBe(1);
  await pasteLink(page, GOOD);
  await sidebarShows(page, 'Agent runtime ready');
  expect(attempts.pair).toEqual([GOOD]);
  // Now the stale refusal lands.
  await page.waitForTimeout(2_000);
  await expect(page.getByRole('alert').filter({ hasText: 'paired' })).toHaveCount(0);
  await sidebarShows(page, 'Agent runtime ready');
  expect(await storedToken(page)).toBe(token);
  expect(attempts.unauthenticated).toBe(1);
  // And the browser is really paired: a reload presents the token and never asks bare.
  await page.reload();
  await sidebarShows(page, 'Agent runtime ready');
  expect(attempts.unauthenticated).toBe(1);
  expect(await storedToken(page)).toBe(token);
});
