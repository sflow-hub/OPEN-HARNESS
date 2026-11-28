import { expect, test } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { initialWorkspace } from '../../lib/types';
import type { LocalImprovement } from '../../lib/local-improvements';

const port = process.env.OPEN_HARNESS_TEST_PORT || '4317';
const control = 'http://127.0.0.1:' + port;
const prompt = 'Change the Assistant heading to “How can I help?”';
test.use({ actionTimeout: 12_000 });

test('an owner asks a named agent for a local dashboard change, reviews it, applies it and restores the original', async ({ page, request }) => {
  test.setTimeout(300_000);
  const bootstrap = await request.get(control + '/v1/bootstrap');
  const headers = { Authorization: 'Bearer ' + (await bootstrap.json()).token };
  expect((await request.post(control + '/v1/agents/sync', { headers, data: { agents: initialWorkspace.agents } })).ok()).toBeTruthy();
  const newAgent = await request.post(control + '/v1/agents', { headers, data: { name: 'Dashboard editor ' + crypto.randomUUID().slice(0, 8), role: 'Dashboard editor' } });
  expect(newAgent.ok(), await newAgent.text()).toBeTruthy();
  const { agent } = await newAgent.json();
  const filename = 'saved-notes-' + crypto.randomUUID() + '.bin';
  const bytes = Buffer.from([0x00, 0xff, 0x0d, 0x0a, 0x61, 0x80]);
  const stored = await request.post(control + '/v1/files?scope=shared', { headers, data: { name: filename, encoding: 'base64', content: bytes.toString('base64') } });
  expect(stored.ok(), await stored.text()).toBeTruthy();
  async function verifySavedFile() {
    const read = await request.get(control + '/v1/files?scope=shared&name=' + filename, { headers });
    expect(read.ok()).toBeTruthy();
    const saved = await read.json();
    expect(saved.encoding).toBe('base64');
    expect(Buffer.from(saved.content, 'base64')).toEqual(bytes);
  }
  await verifySavedFile();
  await page.addInitScript(() => {
    localStorage.setItem('open-harness.onboarding.v1', 'done');
    localStorage.setItem('open-harness.assistant-home', '1');
  });
  await page.goto('/?controlPort=' + port);
  const start = page.getByRole('button', { name: 'Improve my Open Harness' });
  await expect(start).toBeVisible();
  await start.click();
  const dialog = page.getByRole('dialog', { name: 'Improve my Open Harness' });
  await expect(dialog).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(start).toBeFocused();
  await start.click();
  const input = dialog.getByRole('textbox', { name: 'What would you like to change?' });
  const agentChoice = dialog.getByRole('combobox', { name: 'Agent', exact: true });
  await expect(agentChoice).toBeVisible();
  await agentChoice.selectOption(agent.id);
  await input.fill(prompt);
  const sent = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname.endsWith('/v1/local-improvements'));
  await dialog.getByRole('button', { name: 'Ask for a change' }).click();
  const response = await sent;
  expect(response.ok(), await response.text()).toBeTruthy();
  const proposal: LocalImprovement = await response.json();
  expect(proposal).toMatchObject({ agentId: agent.id, request: prompt });
  try {
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    await page.reload();
    await start.click();
    const review = dialog.getByRole('article', { name: 'Selected improvement' });
    await expect(review.getByText('Ready for review', { exact: true })).toBeVisible({ timeout: 180_000 });
    await expect(review.getByText('Check result', { exact: true })).toBeVisible();
    const files = review.getByRole('region', { name: 'Changed files' });
    const change = files.locator('details').filter({ has: page.locator('summary', { hasText: 'components/assistant-workspace.tsx' }) });
    await change.locator('summary').click();
    await expect(change.getByLabel('Changes to components/assistant-workspace.tsx')).toContainText('How can I help?');
    const downloading = page.waitForEvent('download');
    await files.getByRole('button', { name: 'Download source patch' }).click();
    const download = await downloading, patch = test.info().outputPath('change.patch');
    expect(download.suggestedFilename()).toBe('open-harness-' + proposal.id + '.patch');
    await download.saveAs(patch);
    const copy = test.info().outputPath('source-checkout'), filename = 'components/assistant-workspace.tsx';
    mkdirSync(join(copy, 'components'), { recursive: true });
    copyFileSync(filename, join(copy, filename));
    execFileSync('git', ['init', '--quiet'], { cwd: copy });
    execFileSync('git', ['apply', '--check', patch], { cwd: copy });
    execFileSync('git', ['apply', patch], { cwd: copy });
    expect(readFileSync(join(copy, filename), 'utf8')).toContain('<h1>How can I help?</h1>');
    await review.getByRole('button', { name: 'Preview dashboard' }).click();
    const frame = review.locator('iframe[title="Preview of your dashboard change"]');
    await expect(frame).toHaveAttribute('sandbox', 'allow-scripts');
    await expect(frame.contentFrame().getByRole('heading', { name: 'How can I help?' })).toBeVisible();
    const reconnectMessage = frame.contentFrame().getByText('Open Harness cannot reach its control service.', { exact: true });
    await expect(reconnectMessage).toBeAttached({ timeout: 20_000 });
    await expect(reconnectMessage).toBeHidden();
    await expect(review.getByRole('link', { name: 'Open the original dashboard' })).toHaveAttribute('href', /original=1/);
    await review.getByRole('button', { name: 'Apply on this computer' }).click();
    const changedHeading = page.getByRole('heading', { name: 'How can I help?', exact: true });
    await expect(changedHeading).toBeVisible({ timeout: 30_000 });
    await verifySavedFile();
    await page.reload();
    await expect(changedHeading).toBeVisible({ timeout: 30_000 });
    await verifySavedFile();
    await page.getByRole('link', { name: 'Open original dashboard', exact: true }).click();
    await expect(page).toHaveURL(url => url.searchParams.get('original') === '1' && url.searchParams.get('controlPort') === port);
    await start.click();
    await expect(review.getByText('Applied on this computer', { exact: true })).toBeVisible();
    await review.getByRole('button', { name: 'Undo this change' }).click();
    await expect(dialog).toBeHidden();
    await page.goto('/?controlPort=' + port);
    await expect(page.getByRole('heading', { name: 'What would you like done?' })).toBeVisible();
    await verifySavedFile();
    const restored = await request.get(control + '/v1/local-improvements', { headers });
    expect((await restored.json()).items.find((item: LocalImprovement) => item.id === proposal.id)?.state).toBe('undone');
  } finally {
    // A failed UI assertion must not leave the shared browser test workspace on a candidate.
    const latest = await request.get(control + '/v1/local-improvements', { headers });
    if (latest.ok() && (await latest.json()).activeId === proposal.id) await request.post(control + '/v1/local-improvements/' + proposal.id + '/undo', { headers, data: {} });
  }
});

test('an interrupted request list can be retried without losing the owner’s draft', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('open-harness.onboarding.v1', 'done');
    localStorage.setItem('open-harness.assistant-home', '1');
  });
  await page.goto('/?controlPort=' + port + '&original=1');
  const launch = page.getByRole('button', { name: 'Improve my Open Harness' });
  await expect(launch).toBeVisible();
  await page.route(/\/v1\/local-improvements$/, route => route.abort('failed'), { times: 1 });
  await launch.click();
  const dialog = page.getByRole('dialog', { name: 'Improve my Open Harness' });
  await expect(dialog.getByRole('alert')).toBeVisible();
  const text = 'Make it easier to find the Files screen';
  const input = dialog.getByRole('textbox', { name: 'What would you like to change?' });
  await input.fill(text);
  const send = dialog.getByRole('button', { name: 'Ask for a change' });
  await expect(send).toBeDisabled();
  await dialog.getByRole('button', { name: 'Refresh requests' }).click();
  await expect(send).toBeEnabled();
  await expect(input).toHaveValue(text);
  await page.reload();
  await launch.click();
  await expect(input).toHaveValue(text);
});
