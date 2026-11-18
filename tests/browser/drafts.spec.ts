import { expect, test, type Page } from '@playwright/test';
import { initialWorkspace } from '../../lib/types';

const port = process.env.OPEN_HARNESS_TEST_PORT || 4317;

async function enableChat(page: Page) {
  await page.route('**/v1/bootstrap', async route => {
    const response = await route.fetch();
    await route.fulfill({ response, json: { ...await response.json(), mode: 'live' } });
  });
}

async function openConversation(page: Page, title: string) {
  await page.getByRole('button', { name: 'Open navigation' }).click();
  await page.getByRole('dialog', { name: 'Workspace navigation' }).getByRole('button', { name: title, exact: true }).click();
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('open-harness.onboarding.v1', 'done'));
});

test('keeps fresh drafts per agent and other drafts with their conversation across reloads', async ({ page }) => {
  await page.addInitScript(workspace => {
    if (!localStorage.getItem('open-harness.workspace.v2')) {
      localStorage.setItem('open-harness.workspace.v2', JSON.stringify(workspace));
    }
  }, {
    ...initialWorkspace,
    conversations: ['Research notes', 'Project outline'].map((title, i) => ({
      id: `draft-test-${i}`, agentId: 'atlas', title, messages: [], updatedAt: new Date().toISOString(),
    })),
  });
  await page.goto(`/?controlPort=${port}`);
  const atlas = page.getByRole('textbox', { name: 'Message Atlas' });
  const scout = page.getByRole('textbox', { name: 'Message Scout' });
  await atlas.fill('Start a fresh Atlas task');
  await page.getByLabel('Choose agent').selectOption('scout');
  await expect(scout).toHaveValue('');
  await scout.fill('Draft for Scout');
  await page.getByRole('button', { name: 'Start new conversation' }).click();
  await expect(scout).toHaveValue('Draft for Scout');
  await openConversation(page, 'Research notes');
  await expect(atlas).toHaveValue('');
  await atlas.fill('An unsent research question');
  await openConversation(page, 'Project outline');
  await expect(atlas).toHaveValue('');
  await atlas.fill('An outline revision');
  await page.reload();
  await expect(atlas).toHaveValue('Start a fresh Atlas task');
  await openConversation(page, 'Research notes');
  await expect(atlas).toHaveValue('An unsent research question');
  await openConversation(page, 'Project outline');
  await expect(atlas).toHaveValue('An outline revision');
  await page.getByRole('button', { name: 'Open Harness home' }).click();
  await expect(atlas).toHaveValue('Start a fresh Atlas task');
  await page.getByLabel('Choose agent').selectOption('scout');
  await expect(scout).toHaveValue('Draft for Scout');
});

test('retains a rejected submission and preserves edits made while a successful send is pending', async ({ page }) => {
  await enableChat(page);
  let attempts = 0;
  let accept!: () => void;
  const resume = new Promise<void>(resolve => { accept = resolve; });
  await page.route('**/v1/runs', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    attempts++;
    if (attempts === 1) return route.fulfill({ status: 503, json: { error: 'The coordinator is busy.' } });
    if (attempts === 2) await resume;
    await route.continue();
  });
  await page.goto(`/?controlPort=${port}`);
  await expect(page.getByRole('img', { name: 'Agent runtime ready' })).toBeVisible();
  const composer = page.getByRole('textbox', { name: 'Message Atlas' });
  const send = page.getByRole('button', { name: 'Send message', exact: true });
  await composer.fill('Review the project notes');
  await send.click();
  await expect(page.getByText('The coordinator is busy.')).toBeVisible();
  await expect(composer).toHaveValue('Review the project notes');
  await expect(page.locator('.transcript')).toHaveCount(0);
  await page.reload();
  await expect(page.getByRole('img', { name: 'Agent runtime ready' })).toBeVisible();
  await expect(composer).toHaveValue('Review the project notes');
  expect(attempts).toBe(1);

  await send.click();
  await expect.poll(() => attempts).toBe(2);
  await expect(send).toBeDisabled();
  await composer.fill('One more question');
  accept();
  await expect(page.locator('.transcript').getByText('Review the project notes', { exact: true })).toBeVisible();
  await expect(composer).toHaveValue('One more question');
  await expect(send).toBeEnabled();
  await send.click();
  await expect(page.locator('.transcript').getByText('One more question', { exact: true })).toBeVisible();
  await expect(composer).toHaveValue('');
  await expect(send).toBeVisible();
  await page.getByRole('button', { name: 'Open Harness home' }).click();
  await expect(composer).toHaveValue('');
  expect(attempts).toBe(3);
});

test('protects a newer draft from another tab and directs running controls to their conversation', async ({ page, context }) => {
  await enableChat(page);
  let acknowledge!: () => void;
  let finish!: () => void;
  const acceptance = new Promise<void>(resolve => { acknowledge = resolve; });
  const completion = new Promise<void>(resolve => { finish = resolve; });
  const sent: { conversationId: string; prompt: string }[] = [];
  const guidance: string[] = [];
  await page.route('**/v1/runs', async route => {
    if (route.request().method() !== 'POST') return route.continue();
    sent.push(route.request().postDataJSON());
    if (sent.length > 1) return route.fulfill({ json: {} });
    await acceptance;
    await route.continue();
  });
  await page.route('**/v1/runs/*/events?*', async route => {
    await completion;
    await route.continue();
  });
  await page.route('**/v1/runs/*/steer', async route => {
    guidance.push(route.request().postDataJSON().text);
    await route.fulfill({ json: {} });
  });
  const url = `/?controlPort=${port}`;
  await page.goto(url);
  await expect(page.getByRole('img', { name: 'Agent runtime ready' })).toBeVisible();
  const composer = page.getByLabel('Message Atlas');
  await composer.fill('Start the original task');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect.poll(() => sent.length).toBe(1);
  const other = await context.newPage();
  await other.goto(url);
  await expect(other.getByLabel('Message Atlas')).toHaveValue('Start the original task');
  await other.getByLabel('Message Atlas').fill('A fresh idea in another tab');
  await other.close();
  acknowledge();
  await expect(page.getByRole('button', { name: 'Send steer' })).toBeVisible();
  await expect(composer).toHaveValue('');
  await page.getByRole('button', { name: 'Open Harness home' }).click();
  await expect(composer).toHaveValue('A fresh idea in another tab');
  await expect(page.getByRole('button', { name: 'Steer', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Follow-up', exact: true })).toHaveCount(0);
  await composer.press('Enter');
  await page.getByRole('button', { name: 'Return to running task' }).click();
  await expect(page.locator('.transcript').getByText('Start the original task', { exact: true })).toBeVisible();
  await expect(composer).toHaveValue('');
  expect(guidance).toEqual([]);
  expect(sent).toHaveLength(1);

  await page.getByRole('button', { name: 'Follow-up', exact: true }).click();
  await composer.fill('Continue in this conversation');
  await page.getByRole('button', { name: 'Send followup' }).click();
  await expect(composer).toHaveValue('');
  expect(sent[1]).toMatchObject({ conversationId: sent[0].conversationId, prompt: 'Continue in this conversation' });
  finish();
  await expect(page.getByRole('button', { name: 'Send message', exact: true })).toBeVisible();
  await page.reload();
  await expect(composer).toHaveValue('A fresh idea in another tab');
});
