import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { initialWorkspace } from '../../lib/types';
import { openNavigation } from './navigation';

const port = process.env.OPEN_HARNESS_TEST_PORT || 4317;
const control = `http://127.0.0.1:${port}`;
const shared = control + '/v1/files?scope=shared';
const file = (name: string, content: string) => ({ name, mimeType: 'text/plain', buffer: Buffer.from(content) });

async function auth(request: APIRequestContext) {
  const { token } = await (await request.get(control + '/v1/bootstrap')).json();
  return { Authorization: `Bearer ${token}` };
}
async function open(page: Page, request: APIRequestContext) {
  await request.post(control + '/v1/agents/sync', { headers: await auth(request), data: { agents: initialWorkspace.agents } });
  await page.addInitScript(() => localStorage.setItem('open-harness.onboarding.v1', 'done'));
  const connected = page.waitForResponse(response => response.url() === control + '/v1/routines');
  await page.goto(`/?controlPort=${port}`);
  await connected;
}
const contentOf = async (request: APIRequestContext, name: string) => (await (await request.get(`${shared}&name=${name}`, { headers: await auth(request) })).json()).content;

test('reports only confirmed uploads and never replaces an existing file', async ({ page, request }, testInfo) => {
  const headers = await auth(request);
  const existing = `existing-${testInfo.project.name}.txt`, fresh = `new-${testInfo.project.name}.txt`;
  expect((await request.post(shared, { headers, data: { name: existing, content: 'original' } })).ok()).toBeTruthy();
  try {
    await open(page, request);
    const submitted: Array<{ name: string; createOnly: unknown }> = [];
    page.on('request', req => { if (req.method() === 'POST' && req.url() === shared) submitted.push({ name: req.postDataJSON().name, createOnly: req.postDataJSON().createOnly }); });
    const input = page.locator('input[type=file][multiple]');
    await input.setInputFiles([file(existing, 'replacement'), file(fresh, 'fresh')]);
    await expect(page.locator('.composer').getByRole('status')).toHaveText(`Shared with all agents · ${fresh}`);
    await expect(page.getByText(`A file named ${existing} already exists. Rename the upload first.`)).toBeVisible();
    expect(await contentOf(request, existing)).toBe('original');

    // The confirmed upload is now known locally, so a repeat is stopped before any request.
    await input.setInputFiles(file(fresh, 'second replacement'));
    await expect(page.getByText(`A file named ${fresh} already exists. Rename the upload first.`)).toBeVisible();
    await expect(page.locator('.composer').getByRole('status')).toHaveCount(0);
    expect(submitted).toEqual([{ name: existing, createOnly: true }, { name: fresh, createOnly: true }]);
    expect(await contentOf(request, fresh)).toBe('fresh');
  } finally {
    for (const name of [existing, fresh]) await request.delete(`${shared}&name=${name}`, { headers });
  }
});

test('waits for the coordinator before listing an upload and blocks a second batch meanwhile', async ({ page, request }, testInfo) => {
  const headers = await auth(request), name = `slow-${testInfo.project.name}.md`;
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  try {
    await open(page, request);
    await page.route(url => url.href === shared, async route => { if (route.request().method() !== 'POST') return route.continue(); await held; await route.continue(); });
    await page.locator('input[type=file][multiple]').setInputFiles(file(name, '# Slow'));
    const status = page.locator('.composer').getByRole('status');
    await expect(status).toHaveText('Adding files…');
    await expect(page.getByRole('button', { name: 'Attach text files' })).toBeDisabled();
    await expect(page.locator('input[type=file][multiple]')).toBeDisabled();
    await openNavigation(page);
    await page.locator('aside.sidebar').getByRole('button', { name: /^Files\b/ }).click();
    // Not listed until the coordinator acknowledges the write.
    await expect(page.getByRole('button', { name: `Download ${name}` })).toHaveCount(0);
    await expect(page.locator('.files-page').getByRole('status')).toHaveText('Adding files…');
    await expect(page.locator('.files-page').getByRole('button', { name: 'Add files' })).toBeDisabled();
    release();
    await expect(page.locator('.files-page').getByRole('status')).toHaveText(`Shared with all agents · ${name}`);
    await expect(page.getByRole('button', { name: `Download ${name}` })).toBeVisible();
    await expect(page.locator('.files-page').getByRole('button', { name: 'Add files' })).toBeEnabled();
    expect(await contentOf(request, name)).toBe('# Slow');
  } finally {
    release();
    await request.delete(`${shared}&name=${name}`, { headers });
  }
});

test('a rejected upload is not listed and the draft composer stays usable', async ({ page, request }, testInfo) => {
  const headers = await auth(request), name = `rejected-${testInfo.project.name}.txt`;
  try {
    await open(page, request);
    await page.route(url => url.href === shared, route => route.request().method() === 'POST'
      ? route.fulfill({ status: 409, headers: { 'Access-Control-Allow-Origin': '*' }, contentType: 'application/json', body: JSON.stringify({ error: 'The workspace already has 40 files. Remove a file to add another.' }) })
      : route.continue());
    const composer = page.locator('.composer textarea');
    await composer.fill('Summarize the attached notes');
    await page.locator('input[type=file][multiple]').setInputFiles(file(name, 'notes'));
    await expect(page.getByText('The workspace already has 40 files. Remove a file to add another.')).toBeVisible();
    await expect(page.locator('.composer').getByRole('status')).toHaveCount(0);
    await expect(composer).toHaveValue('Summarize the attached notes');
    await expect(page.getByRole('button', { name: 'Attach text files' })).toBeEnabled();
    expect((await request.get(`${shared}&name=${name}`, { headers })).status()).toBe(404);
  } finally {
    await request.delete(`${shared}&name=${name}`, { headers });
  }
});
