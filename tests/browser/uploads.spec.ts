import { expect, test } from '@playwright/test';

const port = process.env.OPEN_HARNESS_TEST_PORT || 4317;
const control = `http://127.0.0.1:${port}`;

test('reports only confirmed uploads and preserves the original on a name conflict', async ({ page, request }, testInfo) => {
  const { token } = await (await request.get(control + '/v1/bootstrap')).json();
  const headers = { Authorization: `Bearer ${token}` };
  const existing = `existing-${testInfo.project.name}.txt`;
  const fresh = `new-${testInfo.project.name}.txt`;
  const path = control + '/v1/files?scope=shared';
  const seed = await request.post(path, { headers, data: { name: existing, content: 'original' } });
  expect(seed.ok()).toBeTruthy();
  try {
    await page.addInitScript(() => localStorage.setItem('open-harness.onboarding.v1', 'done'));
    const connected = page.waitForResponse(response => response.url() === control + '/v1/routines');
    await page.goto(`/?controlPort=${port}`);
    await connected;
    const input = page.locator('input[type=file][multiple]');
    const file = (name: string, content: string) => ({ name, mimeType: 'text/plain', buffer: Buffer.from(content) });
    const submitted: string[] = [];
    page.on('request', req => {
      if (req.method() === 'POST' && req.url() === path) submitted.push(req.postDataJSON().name);
    });
    await input.setInputFiles([file(existing, 'replacement'), file(fresh, 'fresh')]);
    await expect(page.locator('.composer').getByRole('status')).toHaveText(`Shared with all agents · ${fresh}`);
    await expect(page.getByText(`A file named ${existing} already exists. Rename the upload first.`)).toBeVisible();
    expect((await (await request.get(path + '&name=' + existing, { headers })).json()).content).toBe('original');

    await input.setInputFiles(file(fresh, 'second replacement'));
    await expect(page.getByText(`A file named ${fresh} already exists. Rename the upload first.`)).toBeVisible();
    await expect(page.locator('.composer').getByRole('status')).toHaveCount(0);
    expect(submitted).toEqual([existing, fresh]);
    expect((await (await request.get(path + '&name=' + fresh, { headers })).json()).content).toBe('fresh');
  } finally {
    for (const name of [existing, fresh]) await request.delete(path + '&name=' + name, { headers });
  }
});
