import { test, expect } from '@playwright/test';

const control = `http://127.0.0.1:${process.env.OPEN_HARNESS_TEST_PORT || 4317}`;

test('a forged localhost Host cannot bootstrap through the dashboard proxy', async ({ request, page }) => {
  const forged = await request.get('/api/local/v1/bootstrap', { headers: { Host: `localhost:${process.env.OPEN_HARNESS_APP_PORT || 3107}`, 'X-Open-Harness-Proxy': '0', 'X-Forwarded-For': '127.0.0.1' } });
  expect(forged.status()).toBe(401);
  const denied = await forged.json(); expect(denied.pairingRequired).toBe(true); expect(denied.token).toBeUndefined();
  const direct = await request.get(`${control}/v1/bootstrap`);
  expect(direct.status()).toBe(200);
  const { token } = await direct.json();
  await page.goto(`/?controlPort=${process.env.OPEN_HARNESS_TEST_PORT || 4317}`);
  for (let reload = 0; reload < 3; reload++) {
    const restored = await page.evaluate(async token => {
      const response = await fetch('/api/local/v1/bootstrap', { headers: { Authorization: `Bearer ${token}` } });
      return { status: response.status, token: (await response.json()).token };
    }, token);
    expect(restored.status).toBe(200); expect(restored.token).toBe(token);
    await page.reload();
  }
});
