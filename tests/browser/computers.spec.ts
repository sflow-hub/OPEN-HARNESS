import { test, expect, type APIRequestContext } from '@playwright/test';
const control = `http://127.0.0.1:${process.env.OPEN_HARNESS_TEST_PORT || 4317}`;
async function headers(request: APIRequestContext) { const { token } = await (await request.get(control + '/v1/bootstrap')).json(); return { Authorization: `Bearer ${token}` }; }
async function pairRunner(request: APIRequestContext, name: string) {
  const { code } = await (await request.post(control + '/v1/machines', { headers: await headers(request), data: { name, platform: 'linux' } })).json();
  const response = await request.post(control + '/v1/runner/pair', { data: { code, name, platform: 'linux', arch: 'arm64', capabilities: { container: true, direct: false, desktop: false, virtualDesktop: true } } });
  expect(response.status()).toBe(201);
  return (await response.json()) as { machineId: string; token: string };
}

test.beforeEach(async ({ page }) => { await page.addInitScript(() => { localStorage.setItem('open-harness.onboarding.v1', 'done'); localStorage.setItem('open-harness.advanced.v1', 'on'); }); });

test('lists computers and revokes a paired one after confirmation', async ({ page, request }, testInfo) => {
  const name = `Build server ${testInfo.project.name}`, runner = await pairRunner(request, name);
  await page.goto(`/?controlPort=${process.env.OPEN_HARNESS_TEST_PORT || 4317}`);
  if (testInfo.project.name === 'mobile') await page.getByRole('button', { name: 'Open navigation' }).click();
  await page.locator('.nav-item', { hasText: 'Computers' }).click();
  await expect(page.getByRole('heading', { name: 'Computers', level: 1 })).toBeVisible();

  const local = page.locator('article.computer-card', { hasText: 'This computer' });
  await expect(local).toHaveCount(1);
  await expect(local.getByRole('button', { name: /^Revoke / })).toBeDisabled();
  const paired = page.getByRole('article', { name });
  await expect(paired).toContainText('Linux · arm64');
  await expect(paired).toContainText('Online');
  await expect(paired).toContainText('0 agents');

  await paired.getByRole('button', { name: `Revoke ${name}` }).click();
  const dialog = page.getByRole('alertdialog', { name: `Revoke ${name}?` });
  await expect(dialog).toContainText('No agents are assigned');
  await expect(dialog).toContainText('credential stops working immediately');
  await expect(dialog).toContainText('pair it again');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toBeHidden();
  await expect(paired).toBeVisible();

  await paired.getByRole('button', { name: `Revoke ${name}` }).click();
  await dialog.getByRole('button', { name: 'Revoke computer' }).click();
  await expect(dialog).toBeHidden();
  await expect(paired).toHaveCount(0);
  await expect(local).toHaveCount(1);

  const auth = await headers(request);
  const { events } = await (await request.get(control + `/v1/audit?action=machine.revoke&targetId=${encodeURIComponent(runner.machineId)}`, { headers: auth })).json();
  expect(events).toHaveLength(1);
  expect(events[0]).toMatchObject({ actorKind: 'operator', action: 'machine.revoke', targetKind: 'machine', targetId: runner.machineId });
  const heartbeat = await request.post(control + '/v1/runner/heartbeat', { headers: { Authorization: `Bearer ${runner.token}`, 'X-Open-Harness-Machine': runner.machineId }, data: {} });
  expect(heartbeat.status()).toBe(401);
});

test('a failed revoke stays reported after the list refreshes', async ({ page, request }, testInfo) => {
  const name = `Flaky server ${testInfo.project.name}`, runner = await pairRunner(request, name);
  // The coordinator is shared across specs, so the paired runner is revoked even when an assertion fails.
  try {
    await page.route('**/v1/machines/*/revoke', route => route.fulfill({ status: 500, json: { error: 'The coordinator could not revoke it.' } }));
    await page.goto(`/?controlPort=${process.env.OPEN_HARNESS_TEST_PORT || 4317}`);
    if (testInfo.project.name === 'mobile') await page.getByRole('button', { name: 'Open navigation' }).click();
    await page.locator('.nav-item', { hasText: 'Computers' }).click();
    const paired = page.getByRole('article', { name });
    await expect(paired).toContainText('Online');

    await paired.getByRole('button', { name: `Revoke ${name}` }).click();
    await page.getByRole('alertdialog', { name: `Revoke ${name}?` }).getByRole('button', { name: 'Revoke computer' }).click();
    const failure = page.getByRole('alert').filter({ hasText: `${name} was not revoked: The coordinator could not revoke it.` });
    await expect(failure).toBeVisible();

    const isList = (url: string) => new URL(url).pathname === '/v1/machines';
    const listed = page.waitForResponse(response => isList(response.url()) && response.request().method() === 'GET' && response.ok());
    await page.getByRole('button', { name: 'Refresh computers' }).click();
    await listed;
    await expect(failure).toBeVisible();
    await expect(paired).toBeVisible();
  } finally {
    expect((await request.post(control + `/v1/machines/${encodeURIComponent(runner.machineId)}/revoke`, { headers: await headers(request), data: {} })).status()).toBe(200);
  }
});
