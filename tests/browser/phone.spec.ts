import { test, expect, type APIRequestContext } from '@playwright/test';
import { initialWorkspace } from '../../lib/types';

// The phone app is the same dashboard behind a pairing screen. Playwright cannot run the
// Android build, but lib/platform.ts has a forced-mobile mode for exactly this: the pairing
// screen, the stored device credential, and the hub-backed dashboard all run in Chromium
// with their web fallbacks, against the same mock coordinator the desktop suite uses. What
// this cannot cover is the Tauri side (Stronghold, the native HTTP client, the QR scanner);
// ANDROID.md describes the emulator run for that.
const control = `http://127.0.0.1:${process.env.OPEN_HARNESS_TEST_PORT || 4317}`;

async function operator(request: APIRequestContext) {
  const { token } = await (await request.get(control + '/v1/bootstrap')).json();
  return { Authorization: `Bearer ${token}` };
}

test.describe('phone companion', () => {
  test.skip(({ isMobile }) => !isMobile, 'the pairing screen only exists on phones');

  test.beforeEach(async ({ request, page }) => {
    const headers = await operator(request);
    // The hub already has agents; the phone must show these, not its own starter set.
    await request.post(control + '/v1/agents/sync', { headers, data: { agents: initialWorkspace.agents } });
    await page.addInitScript(() => {
      localStorage.setItem('open-harness.onboarding.v1', 'done');
      localStorage.setItem('open-harness.force-mobile', '1');
    });
  });

  test('pairs with the code from the computer, survives a relaunch, and disconnects from the phone', async ({ page, request }) => {
    const headers = await operator(request);
    // What the operator does on the computer: Agent settings → Computer → Add computer → Android.
    const pairing = await (await request.post(control + '/v1/machines', { headers, data: { name: 'Test phone', platform: 'android', kind: 'device', coordinatorUrl: control } })).json();
    expect(pairing.kind).toBe('device');
    expect(pairing.code).toMatch(/^[0-9A-Z]{12}$/);
    expect(pairing.pairingUri).toContain('openharness://pair?');

    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Connect this phone' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Connect' })).toBeDisabled();

    // A wrong code is explained in words, and the form stays put.
    await page.getByRole('textbox', { name: /^Hub address/ }).fill(pairing.hubUrl);
    await page.getByLabel('Pairing code', { exact: true }).fill('AAAA AAAA AAAA');
    await page.getByRole('button', { name: 'Connect' }).click();
    await expect(page.getByRole('alert')).toContainText(/expired or was already used/);

    // Typed the way a person types it: grouped, and in whatever case the keyboard gave.
    await page.getByLabel('Pairing code', { exact: true }).fill(pairing.code.replace(/(.{4})/g, '$1 ').trim().toLowerCase());
    // The phone names itself; the name the operator typed on the computer is only a label
    // for the pairing code until the device reports what it actually is.
    await page.getByText('This device’s name and hosted access').click();
    await page.getByLabel('Device name').fill('Test phone');
    await page.getByRole('button', { name: 'Connect' }).click();

    await expect(page.getByRole('button', { name: 'Edit Atlas profile' })).toBeVisible({ timeout: 10_000 });
    const { machines } = await (await request.get(control + '/v1/machines', { headers })).json();
    const phone = machines.find((machine: { kind: string }) => machine.kind === 'device');
    expect(phone).toMatchObject({ name: 'Test phone', status: 'online' });
    expect(['ios', 'android']).toContain(phone.platform);
    // Companion only: the coordinator must never treat this row as somewhere agents can run.
    expect(phone.capabilities).toMatchObject({ mobile: true, container: false, direct: false });

    // The credential lives on the device, so a relaunch goes straight to the dashboard.
    await page.reload();
    await expect(page.getByRole('button', { name: 'Edit Atlas profile' })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole('heading', { name: 'Connect this phone' })).toBeHidden();

    await page.getByRole('button', { name: 'Open navigation' }).click();
    await page.locator('aside.sidebar').getByRole('button', { name: /^Settings/ }).click();
    const summary = page.locator('.hub-summary');
    await expect(summary).toContainText('Connected to your hub');
    await expect(summary).toContainText(pairing.hubUrl);
    await expect(summary).toContainText('Paired as Test phone');
    await page.getByRole('button', { name: 'Disconnect this phone' }).click();

    // Back to the pairing screen here, and the credential is dead on the hub too.
    await expect(page.getByRole('heading', { name: 'Connect this phone' })).toBeVisible();
    const after = await (await request.get(control + '/v1/machines', { headers })).json();
    expect(after.machines.some((machine: { kind: string }) => machine.kind === 'device')).toBe(false);
  });

  test('a revoked phone is sent back to pairing instead of showing a broken dashboard', async ({ page, request }) => {
    const headers = await operator(request);
    const pairing = await (await request.post(control + '/v1/machines', { headers, data: { name: 'Old phone', platform: 'android', kind: 'device', coordinatorUrl: control } })).json();
    await page.goto('/');
    await page.getByRole('textbox', { name: /^Hub address/ }).fill(pairing.hubUrl);
    await page.getByLabel('Pairing code', { exact: true }).fill(pairing.code);
    await page.getByRole('button', { name: 'Connect' }).click();
    await expect(page.getByRole('button', { name: 'Edit Atlas profile' })).toBeVisible({ timeout: 10_000 });

    // The operator revokes it from the computer while the phone is closed.
    const { machines } = await (await request.get(control + '/v1/machines', { headers })).json();
    const phone = machines.find((machine: { kind: string }) => machine.kind === 'device');
    expect(phone).toBeTruthy();
    await request.post(control + `/v1/machines/${phone.id}/revoke`, { headers });

    await page.reload();
    await expect(page.getByRole('heading', { name: 'Connect this phone' })).toBeVisible({ timeout: 10_000 });
  });
});

// A phone browser pointed at a self-hosted coordinator is the other way to reach a remote
// server, and it must not be handed the master control token. Deliberately no forced-mobile
// flag here: this is a browser, not the app, so isMobileApp() must stay false and the phone
// layout has to come from the viewport alone.
test.describe('phone browser against a self-hosted coordinator', () => {
  test.skip(({ isMobile }) => !isMobile, 'this is the phone-sized browser case');

  test.beforeEach(async ({ request, page }) => {
    const headers = await operator(request);
    await request.post(control + '/v1/agents/sync', { headers, data: { agents: initialWorkspace.agents } });
    await page.addInitScript(() => localStorage.setItem('open-harness.onboarding.v1', 'done'));
  });

  test('a browser refused the control token pairs for its own scoped credential', async ({ page, request }) => {
    const headers = await operator(request);
    const pairing = await (await request.post(control + '/v1/machines', { headers, data: { name: 'Kitchen tablet', platform: 'android', kind: 'device', coordinatorUrl: control } })).json();

    // What the proxy does for real when the dashboard was reached over the network: refuse
    // the token that authorizes run creation, host-path mounts and direct OS execution.
    // Chromium cannot be given a non-loopback hostname here, so the refusal is injected.
    await page.route('**/v1/bootstrap', route => route.fulfill({
      status: 403,
      contentType: 'application/json',
      body: JSON.stringify({ error: 'Open Harness will not hand the control token to a remote dashboard.' }),
    }));

    await page.goto(`/?controlPort=${process.env.OPEN_HARNESS_TEST_PORT || 4317}`);

    // Refusing the token is not an outage, so it offers pairing rather than an error.
    await expect(page.getByRole('heading', { name: 'Connect this device' })).toBeVisible();
    // The browser is already looking at the hub, so there is nothing to type and nothing to
    // get wrong. This is the difference from the app's pairing screen.
    await expect(page.getByRole('textbox', { name: /^Hub address/ })).toHaveCount(0);

    await page.getByLabel('Pairing code', { exact: true }).fill(pairing.code);
    await page.getByRole('button', { name: 'Connect' }).click();

    // Paired, and reading the hub's agents rather than pushing its own starter set.
    await expect(page.getByRole('button', { name: 'Edit Atlas profile' })).toBeVisible({ timeout: 10_000 });
    const { machines } = await (await request.get(control + '/v1/machines', { headers })).json();
    const paired = machines.find((machine: { kind: string }) => machine.kind === 'device');
    expect(paired.capabilities).toMatchObject({ mobile: true, container: false, direct: false });

    // The credential outlives the refusal: a reload goes straight back to the dashboard
    // through /v1/device/session, which the 403 above never touched.
    await page.reload();
    await expect(page.getByRole('button', { name: 'Edit Atlas profile' })).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole('heading', { name: 'Connect this device' })).toBeHidden();
  });
});

// The phone layout has to hold for a browser too, and horizontal overflow is the failure
// that keeps coming back: it is invisible on a desktop-sized viewport and obvious on a phone.
test.describe('phone layout', () => {
  test.skip(({ isMobile }) => !isMobile, 'this is about the phone viewport');

  test.beforeEach(async ({ request, page }) => {
    const headers = await operator(request);
    await request.post(control + '/v1/agents/sync', { headers, data: { agents: initialWorkspace.agents } });
    await page.addInitScript(() => localStorage.setItem('open-harness.onboarding.v1', 'done'));
  });

  test('the task board fits the screen instead of panning sideways', async ({ page }) => {
    await page.goto(`/?controlPort=${process.env.OPEN_HARNESS_TEST_PORT || 4317}`);
    await page.getByRole('button', { name: 'Tasks', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Tasks', exact: true })).toBeVisible();

    await page.getByRole('button', { name: 'New board', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'New project board' });
    await dialog.getByLabel('Board name').fill('Phone board');
    await dialog.getByRole('button', { name: 'Create board' }).click();
    await expect(dialog).toBeHidden();

    // The stages stack rather than sitting in a 1300px row. Measured rather than asserted
    // on CSS, because what matters is the result on this viewport.
    const board = page.locator('.kanban-board');
    await expect(board).toBeVisible();
    const boardFits = await board.evaluate((el: HTMLElement) => el.scrollWidth <= el.clientWidth + 1);
    expect(boardFits, 'the board scrolls sideways on a phone').toBe(true);

    // And nothing else pushes the page wider than the screen either.
    const pageFits = await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);
    expect(pageFits, 'the page scrolls sideways on a phone').toBe(true);
  });

  test('the primary touch targets are big enough to hit', async ({ page }) => {
    await page.goto(`/?controlPort=${process.env.OPEN_HARNESS_TEST_PORT || 4317}`);
    // Open a conversation so the composer, and its send button, exist.
    await page.getByRole('button', { name: /^Meet Atlas|^Atlas/ }).first().click();
    const send = page.locator('.send-button').first();
    await expect(send).toBeVisible();
    const box = await send.boundingBox();
    // 44px is the smallest target a finger hits reliably, and this is the primary action
    // of the chat screen.
    expect(Math.min(box!.width, box!.height)).toBeGreaterThanOrEqual(44);
  });
});
