import { expect, test, type Page } from '@playwright/test';
import { initialWorkspace } from '../../lib/types';
import type { PersistentRun } from '../../lib/control-client';
import { openNavigation } from './navigation';

const port = process.env.OPEN_HARNESS_TEST_PORT || 4317;
const control = `http://127.0.0.1:${port}`;
const url = `/?controlPort=${port}`;

async function enableChat(page: Page) {
  await page.route(`${control}/v1/bootstrap`, async route => {
    const response = await route.fetch(), status = await response.json();
    await route.fulfill({ response, json: { ...status, mode: 'live', runtime: { ...status.runtime, available: true } } });
  });
}

async function openConversation(page: Page, title: string) {
  await openNavigation(page);
  await page.locator('aside.sidebar').getByRole('button', { name: title, exact: true }).click();
}

test.beforeEach(async ({ context }) => {
  await context.addInitScript(workspace => {
    localStorage.setItem('open-harness.onboarding.v1', 'done');
    localStorage.setItem('open-harness.migrated.v1', 'done');
    if (!localStorage.getItem('open-harness.workspace.v2')) localStorage.setItem('open-harness.workspace.v2', JSON.stringify(workspace));
  }, {
    ...initialWorkspace,
    conversations: ['Research notes', 'Project outline'].map((title, i) => ({
      id: `draft-test-${i}`, agentId: 'atlas', title, messages: [], updatedAt: new Date().toISOString(),
    })),
  });
  await context.route(`${control}/v1/agents/sync`, route => route.fulfill({ json: { agents: initialWorkspace.agents } }));
  await context.route(`${control}/v1/conversations`, route => route.fulfill({ json: { conversations: [] } }));
  await context.route(`${control}/v1/runs`, route => route.request().method() === 'GET' ? route.fulfill({ json: { runs: [] } }) : route.fallback());
});

test('keeps fresh drafts per agent and other drafts with their conversation across reloads', async ({ page }) => {
  await page.goto(url);
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

test('a pending first send preserves newer edits in its conversation and the fresh draft in another tab', async ({ page, context }) => {
  await enableChat(page);
  let acknowledge!: () => void;
  const acceptance = new Promise<void>(resolve => { acknowledge = resolve; });
  let posts = 0;
  let run: PersistentRun | undefined;
  await page.route(`${control}/v1/runs`, async route => {
    if (route.request().method() !== 'POST') return route.fallback();
    const { agentId, conversationId, prompt } = route.request().postDataJSON();
    posts++;
    await acceptance;
    run = { id: 'draft-run', agent_id: agentId, conversation_id: conversationId, prompt, state: 'completed', result: 'Finished draft task' };
    await route.fulfill({ json: run });
  });
  await page.route(`${control}/v1/runs/draft-run/events*`, route => route.fulfill({ json: { events: [], run } }));
  await page.goto(url);
  const composer = page.getByLabel('Message Atlas');
  const send = page.getByRole('button', { name: 'Send message', exact: true });
  await expect(page.getByRole('img', { name: 'Agent runtime ready' })).toBeVisible();
  await composer.fill('Start the original task');
  await send.click();
  try {
    await expect(page.locator('.transcript .working')).toContainText('Sending');
    await expect(composer).toHaveValue('Start the original task');
    await composer.press('Enter');
    await composer.fill('Newer text in this conversation');
    const other = await context.newPage();
    await other.goto(url);
    await expect(other.getByLabel('Message Atlas')).toHaveValue('Start the original task');
    await other.getByLabel('Message Atlas').fill('A fresh idea in another tab');
    await other.close();
  } finally { acknowledge(); }
  await expect(page.locator('.transcript')).toContainText('Finished draft task');
  await expect(composer).toHaveValue('Newer text in this conversation');
  await page.reload();
  await expect(composer).toHaveValue('A fresh idea in another tab');
  await openConversation(page, 'Start the original task');
  await expect(composer).toHaveValue('Newer text in this conversation');
  expect(posts).toBe(1);
});

test('a rejected first message remains editable until its explicit retry is accepted', async ({ page }) => {
  await enableChat(page);
  let attempts = 0;
  let run: PersistentRun | undefined;
  await page.route(`${control}/v1/runs`, route => {
    if (route.request().method() !== 'POST') return route.fallback();
    if (++attempts === 1) return route.fulfill({ status: 503, json: { error: 'The coordinator is busy.' } });
    const { agentId, conversationId, prompt } = route.request().postDataJSON();
    run = { id: 'retry-run', agent_id: agentId, conversation_id: conversationId, prompt, state: 'completed', result: 'Accepted on retry' };
    return route.fulfill({ json: run });
  });
  await page.route(`${control}/v1/runs/retry-run/events*`, route => route.fulfill({ json: { events: [], run } }));
  await page.goto(url);
  await expect(page.getByRole('img', { name: 'Agent runtime ready' })).toBeVisible();
  const composer = page.getByLabel('Message Atlas');
  const send = page.getByRole('button', { name: 'Send message', exact: true });
  await composer.fill('Review the project notes');
  await send.click();
  await expect(page.locator('.message-error')).toContainText('The coordinator is busy.');
  await expect(composer).toHaveValue('Review the project notes');
  await page.reload();
  await openConversation(page, 'Review the project notes');
  await expect(composer).toHaveValue('Review the project notes');
  expect(attempts).toBe(1);
  await send.click();
  await expect(page.locator('.transcript')).toContainText('Accepted on retry');
  await expect(composer).toHaveValue('');
  await page.getByRole('button', { name: 'Open Harness home' }).click();
  await expect(composer).toHaveValue('');
  expect(attempts).toBe(2);
});
