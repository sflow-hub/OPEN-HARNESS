import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('open-harness.onboarding.v1', 'done');
    const subscription = { endpoint: 'https://fcm.googleapis.com/fcm/send/browser-fixture', toJSON: () => ({ endpoint: 'https://fcm.googleapis.com/fcm/send/browser-fixture', keys: { p256dh: 'fixture', auth: 'fixture' } }), unsubscribe: async () => true };
    const registration = { pushManager: { getSubscription: async () => null, subscribe: async () => subscription } };
    Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: { getRegistration: async () => undefined, register: async () => registration, ready: Promise.resolve(registration) } });
    Object.defineProperty(window, 'PushManager', { configurable: true, value: function PushManager() {} });
    Object.defineProperty(window, 'Notification', { configurable: true, value: class { static permission = 'default'; static requestPermission = async () => 'granted'; } });
  });
  await page.route('**/v1/delivery', route => route.fulfill({ json: { publicKey: 'BAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', subscriberCount: 0 } }));
  await page.goto(`/?controlPort=${process.env.OPEN_HARNESS_TEST_PORT || 4317}`);
});

test('phone setup explains HTTPS and Home Screen installation and allows enabling, testing and revoking push', async ({ page }, testInfo) => {
  const requests: Array<{ method: string; body: unknown }> = [];
  await page.route('**/v1/delivery/subscriptions', route => { requests.push({ method: route.request().method(), body: route.request().postDataJSON() }); return route.fulfill({ json: { ok: true, id: 'fixture' } }); });
  await page.route('**/v1/delivery/test', route => route.fulfill({ json: { sent: 1, failed: 0 } }));
  if (testInfo.project.name === 'mobile') await page.getByRole('button', { name: 'Open navigation' }).click();
  await page.getByRole('button', { name: /Settings/ }).first().click();
  const settings = page.getByRole('region', { name: 'Phone and notifications' });
  await expect(settings).toContainText('authenticated HTTPS');
  await expect(settings).toContainText('Add to Home Screen');
  await settings.getByRole('button', { name: 'Enable on this device' }).click();
  await expect(settings.getByRole('status')).toContainText('even when this page is closed');
  await settings.getByRole('button', { name: 'Send test notification' }).click();
  await expect(settings.getByRole('status')).toContainText('Test sent');
  await settings.getByRole('button', { name: 'Turn off on this device' }).click();
  await expect(settings.getByRole('status')).toContainText('Notifications are off');
  expect(requests.map(item => item.method)).toEqual(['POST', 'DELETE']);
  expect(requests[1].body).toEqual({ endpoint: 'https://fcm.googleapis.com/fcm/send/browser-fixture' });
});

test('a failed subscription save stays retryable', async ({ page }, testInfo) => {
  let attempts = 0;
  await page.route('**/v1/delivery/subscriptions', route => { attempts++; return route.fulfill(attempts === 1 ? { status: 503, json: { error: 'Notification settings could not be saved. Try again.' } } : { json: { id: 'fixture' } }); });
  if (testInfo.project.name === 'mobile') await page.getByRole('button', { name: 'Open navigation' }).click();
  await page.getByRole('button', { name: /Settings/ }).first().click();
  const settings = page.getByRole('region', { name: 'Phone and notifications' });
  await settings.getByRole('button', { name: 'Enable on this device' }).click();
  await expect(settings.getByRole('status')).toContainText('could not be saved');
  await settings.getByRole('button', { name: 'Enable on this device' }).click();
  await expect(settings.getByRole('button', { name: 'Turn off on this device' })).toBeVisible();
});
