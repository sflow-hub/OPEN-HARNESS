import { test, expect, type Page } from '@playwright/test';
import { initialWorkspace, type Conversation, type Message } from '../../lib/types';

// Long conversations come from this browser's own storage, and the coordinator's history and
// run list are answered by fixtures: the shared coordinator holds whatever earlier specs did,
// and a live run there would open its own conversation over the one under test.
const control = `http://127.0.0.1:${process.env.OPEN_HARNESS_TEST_PORT || 4317}`;
const RUN_ID = 'run-transcript-stream';
const label = (title: string, index: number) => `${title} message ${String(index).padStart(4, '0')}`;
function chat(id: string, title: string, count: number, last: Partial<Message> = {}): Conversation {
  const messages: Message[] = Array.from({ length: count }, (_, index) => ({
    id: `${id}-${index + 1}`,
    role: index % 2 ? 'assistant' : 'user',
    content: `${label(title, index + 1)}\n\nA second paragraph gives each message an ordinary height.`,
  }));
  messages[count - 1] = { ...messages[count - 1], ...last };
  return { id, agentId: 'atlas', title, updatedAt: new Date().toISOString(), messages };
}
type Delta = { seq: number; id: string; type: string; payload: { text: string } };

// history answers the coordinator's conversation list; holding it back stands in for work
// another client did arriving while this one is already open.
async function open(page: Page, conversations: Conversation[], runs: unknown[] = [], history: Promise<unknown[]> = Promise.resolve([])) {
  await page.addInitScript(saved => {
    localStorage.setItem('open-harness.onboarding.v1', 'done');
    // Migration would copy the fixture conversations into the shared coordinator.
    localStorage.setItem('open-harness.migrated.v1', 'done');
    localStorage.setItem('open-harness.workspace.v2', saved);
  }, JSON.stringify({ ...initialWorkspace, conversations }));
  await page.route(`${control}/v1/conversations`, route => route.request().method() === 'GET' ? history.then(remote => route.fulfill({ json: { conversations: remote } })) : route.fallback());
  await page.route(`${control}/v1/runs`, route => route.request().method() === 'GET' ? route.fulfill({ json: { runs } }) : route.fallback());
  await page.goto(`/?controlPort=${process.env.OPEN_HARNESS_TEST_PORT || 4317}`);
  await expect(page.getByRole('button', { name: 'Edit Atlas profile' })).toBeVisible();
}
async function openConversation(page: Page, title: string, isMobile: boolean) {
  if (isMobile) await page.getByRole('button', { name: 'Open navigation' }).click();
  await page.getByRole('button', { name: title, exact: true }).click();
}
const transcript = (page: Page) => page.locator('.transcript');
const messages = (page: Page) => page.locator('.transcript .message');
const message = (page: Page, title: string, index: number) => page.locator('.transcript .message', { hasText: label(title, index) });
const fromBottom = (page: Page) => transcript(page).evaluate(el => el.scrollHeight - el.scrollTop - el.clientHeight);
// Where a message sits inside the transcript's viewport: what a reader sees not moving.
const offsetOf = (page: Page, title: string, index: number) => message(page, title, index).evaluate(el => el.getBoundingClientRect().top - el.closest('.transcript')!.getBoundingClientRect().top);
const scrollToTop = (page: Page) => transcript(page).evaluate(el => el.scrollTo({ top: 0, behavior: 'instant' }));

test('a long cached conversation opens on its newest messages and loads earlier ones in place', async ({ page, isMobile }) => {
  await open(page, [chat('long-a', 'Long chat A', 300)]);
  await openConversation(page, 'Long chat A', isMobile);
  await expect(messages(page)).toHaveCount(60);
  await expect(message(page, 'Long chat A', 300)).toBeInViewport();
  await expect(message(page, 'Long chat A', 241)).toHaveCount(1);
  await expect(message(page, 'Long chat A', 240)).toHaveCount(0);
  await expect.poll(() => fromBottom(page)).toBeLessThan(4);

  await scrollToTop(page);
  const earlier = page.getByRole('button', { name: 'Load earlier messages' });
  await expect(earlier).toBeVisible();
  const before = await offsetOf(page, 'Long chat A', 241);
  await earlier.click();
  await expect(messages(page)).toHaveCount(120);
  await expect(message(page, 'Long chat A', 181)).toHaveCount(1);
  // The message that was at the top of the view stays exactly where it was; the new batch
  // is above it, not in its place.
  await expect.poll(async () => Math.abs(await offsetOf(page, 'Long chat A', 241) - before)).toBeLessThanOrEqual(1);
  await expect(message(page, 'Long chat A', 241)).toBeInViewport();
  await expect(message(page, 'Long chat A', 181)).not.toBeInViewport();

  // Nothing is lost: every batch comes back, and the button goes once there is nothing left.
  for (const count of [180, 240, 300]) {
    await earlier.click();
    await expect(messages(page)).toHaveCount(count);
  }
  await expect(earlier).toHaveCount(0);
  await expect(message(page, 'Long chat A', 1)).toHaveCount(1);
});

test('switching conversations starts each one on its newest messages', async ({ page, isMobile }) => {
  await open(page, [chat('long-a', 'Long chat A', 300), chat('long-b', 'Long chat B', 150)]);
  await openConversation(page, 'Long chat A', isMobile);
  await expect(messages(page)).toHaveCount(60);
  await scrollToTop(page);
  await page.getByRole('button', { name: 'Load earlier messages' }).click();
  await expect(messages(page)).toHaveCount(120);

  await openConversation(page, 'Long chat B', isMobile);
  await expect(messages(page)).toHaveCount(60);
  await expect(message(page, 'Long chat A', 300)).toHaveCount(0);
  // At the end straight away, not partway through a smooth scroll down a long chat.
  await expect.poll(() => fromBottom(page), { timeout: 1_000 }).toBeLessThan(4);
  await expect(message(page, 'Long chat B', 150)).toBeInViewport();

  // Coming back does not restore the batches loaded earlier or the old reading position.
  await openConversation(page, 'Long chat A', isMobile);
  await expect(messages(page)).toHaveCount(60);
  await expect(message(page, 'Long chat A', 240)).toHaveCount(0);
  await expect.poll(() => fromBottom(page), { timeout: 1_000 }).toBeLessThan(4);
  await expect(message(page, 'Long chat A', 300)).toBeInViewport();
});

test('streamed text follows the end only while the reader is already there', async ({ page }) => {
  const title = 'Streaming chat';
  const run = { id: RUN_ID, agent_id: 'atlas', conversation_id: 'streaming', prompt: label(title, 199), state: 'running', pendingApprovals: [], pendingInputs: [] };
  const pending: Delta[] = [];
  let seq = 0;
  const stream = (text: string) => { seq += 1; pending.push({ seq, id: `delta-${seq}`, type: 'message.delta', payload: { text } }); };
  await page.route(`${control}/v1/runs/${RUN_ID}/events*`, route => route.fulfill({ json: { events: pending.splice(0), run } }));
  // A run still live on the coordinator opens its conversation by itself.
  await open(page, [chat('streaming', title, 200, { runId: RUN_ID, settled: false })], [run]);
  await expect(messages(page)).toHaveCount(60);
  await expect(message(page, title, 200)).toBeInViewport();

  stream(' First streamed words.');
  await expect(message(page, title, 200)).toContainText('First streamed words.');
  await expect.poll(() => fromBottom(page)).toBeLessThan(4);

  // Reading something further up: a long burst of output must not move it.
  await message(page, title, 170).evaluate(el => el.scrollIntoView({ block: 'start', behavior: 'instant' }));
  await expect.poll(() => fromBottom(page)).toBeGreaterThan(200);
  const scrolled = await transcript(page).evaluate(el => el.scrollTop);
  const before = await offsetOf(page, title, 170);
  stream(`\n\n${Array.from({ length: 40 }, (_, index) => `Streamed line ${index + 1} while reading.`).join('\n\n')}`);
  await expect(message(page, title, 200)).toContainText('Streamed line 40 while reading.');
  expect(Math.abs(await transcript(page).evaluate(el => el.scrollTop) - scrolled)).toBeLessThanOrEqual(1);
  expect(Math.abs(await offsetOf(page, title, 170) - before)).toBeLessThanOrEqual(1);
  await expect(message(page, title, 170)).toBeInViewport();
  await expect(messages(page)).toHaveCount(60);

  // Back at the end, following resumes.
  await transcript(page).evaluate(el => el.scrollTo({ top: el.scrollHeight, behavior: 'instant' }));
  stream(`\n\n${Array.from({ length: 20 }, (_, index) => `Final line ${index + 1}.`).join('\n\n')}`);
  await expect(message(page, title, 200)).toContainText('Final line 20.');
  await expect.poll(() => fromBottom(page)).toBeLessThan(4);
});

test('a transcript that gets shorter keeps the newest message in view', async ({ page, isMobile }) => {
  await open(page, [chat('long-a', 'Long chat A', 300)]);
  await openConversation(page, 'Long chat A', isMobile);
  await expect.poll(() => fromBottom(page)).toBeLessThan(4);
  // A phone keyboard or a smaller window takes height from the transcript without any new
  // content, so nothing used to bring the end back into view.
  const size = page.viewportSize()!;
  await page.setViewportSize({ width: size.width, height: size.height - 240 });
  await expect.poll(() => fromBottom(page)).toBeLessThan(4);
  await expect(message(page, 'Long chat A', 300)).toBeInViewport();
  if (!isMobile) {
    // The workspace panel narrows the transcript, so every message wraps onto more lines.
    for (let index = 0; index < 2; index++) {
      await page.getByRole('button', { name: 'Toggle workspace panel' }).click();
      await expect.poll(() => fromBottom(page)).toBeLessThan(4);
    }
  }
});

test('sending from older messages returns to the newest one', async ({ page, isMobile }) => {
  const sent = { id: 'run-transcript-send', agent_id: 'atlas', conversation_id: 'long-a', prompt: 'Fixture question from older messages', state: 'running', pendingApprovals: [], pendingInputs: [] };
  // Chat is disabled against the mock runtime, so the send itself is answered by fixtures.
  await page.route(`${control}/v1/bootstrap`, async route => {
    const response = await route.fetch();
    const status = await response.json();
    await route.fulfill({ response, json: { ...status, mode: 'live', runtime: { ...status.runtime, available: true } } });
  });
  await page.route(`${control}/v1/runs`, route => route.request().method() === 'POST' ? route.fulfill({ json: sent }) : route.fallback());
  await page.route(`${control}/v1/runs/${sent.id}/events*`, route => route.fulfill({ json: { events: [], run: { ...sent, state: 'completed', result: 'Fixture reply to the question.' } } }));
  await open(page, [chat('long-a', 'Long chat A', 300)]);
  await openConversation(page, 'Long chat A', isMobile);
  await message(page, 'Long chat A', 250).evaluate(el => el.scrollIntoView({ block: 'start', behavior: 'instant' }));
  await expect.poll(() => fromBottom(page)).toBeGreaterThan(200);

  await page.getByRole('textbox', { name: 'Message Atlas' }).fill(sent.prompt);
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.locator('.transcript .message.user', { hasText: sent.prompt })).toBeInViewport();
  await expect(page.locator('.transcript .message.assistant', { hasText: 'Fixture reply to the question.' })).toBeInViewport();
  await expect.poll(() => fromBottom(page)).toBeLessThan(4);
  // Older messages that were already on screen are still there; nothing was dropped.
  await expect(message(page, 'Long chat A', 241)).toHaveCount(1);
});

// Where the message being read sits once the transcript's width changes: every message above
// it wraps differently, which moves it unless something holds it in place.
test('a width change keeps the older message being read in place', async ({ page, isMobile }) => {
  // Messages are capped at 730px, so short text, or a desktop transcript still wider than
  // that cap, never rewraps. Long paragraphs and a window narrower than the cap both do.
  const wrapping = 'This paragraph is long enough to wrap onto several lines at any transcript width, so a narrower window changes how tall every message above the one being read is. '.repeat(3);
  const long = chat('long-a', 'Long chat A', 300);
  await open(page, [{ ...long, messages: long.messages.map(item => ({ ...item, content: `${item.content}\n\n${wrapping}` })) }]);
  await openConversation(page, 'Long chat A', isMobile);
  await message(page, 'Long chat A', 250).evaluate(el => el.scrollIntoView({ block: 'start', behavior: 'instant' }));
  await expect.poll(() => fromBottom(page)).toBeGreaterThan(200);
  const before = await offsetOf(page, 'Long chat A', 250);
  const height = await transcript(page).evaluate(el => el.scrollHeight);
  const size = page.viewportSize()!;
  await page.setViewportSize({ width: Math.min(700, size.width - 70), height: size.height });
  // The content really did reflow; otherwise this would pass without holding anything.
  await expect.poll(async () => Math.abs(await transcript(page).evaluate(el => el.scrollHeight) - height)).toBeGreaterThan(200);
  await expect.poll(async () => Math.abs(await offsetOf(page, 'Long chat A', 250) - before)).toBeLessThanOrEqual(2);
  await expect(message(page, 'Long chat A', 250)).toBeInViewport();
  expect(await fromBottom(page)).toBeGreaterThan(200);
});

test('messages another client adds do not pull a reader away from older ones', async ({ page, isMobile }) => {
  let release: (remote: unknown[]) => void = () => {};
  const history = new Promise<unknown[]>(resolve => { release = resolve; });
  const prompt = 'Remote prompt from another client';
  const remote = { id: 'long-a', agentId: 'atlas', title: 'Long chat A', updatedAt: new Date().toISOString(), runs: [{ id: 'run-transcript-remote', agent_id: 'atlas', conversation_id: 'long-a', prompt, state: 'completed', result: 'Remote reply from another client.' }] };
  await open(page, [chat('long-a', 'Long chat A', 300)], [], history);
  await openConversation(page, 'Long chat A', isMobile);
  await message(page, 'Long chat A', 250).evaluate(el => el.scrollIntoView({ block: 'start', behavior: 'instant' }));
  await expect.poll(() => fromBottom(page)).toBeGreaterThan(200);
  const scrolled = await transcript(page).evaluate(el => el.scrollTop);
  const before = await offsetOf(page, 'Long chat A', 250);

  release([remote]);
  await expect(page.locator('.transcript .message.user', { hasText: prompt })).toHaveCount(1);
  await expect(page.locator('.transcript .message.assistant', { hasText: 'Remote reply from another client.' })).toHaveCount(1);
  expect(Math.abs(await transcript(page).evaluate(el => el.scrollTop) - scrolled)).toBeLessThanOrEqual(1);
  expect(Math.abs(await offsetOf(page, 'Long chat A', 250) - before)).toBeLessThanOrEqual(1);
  await expect(page.locator('.transcript .message.user', { hasText: prompt })).not.toBeInViewport();

  // Back at the end, the next remote addition is followed; here the reader returns and sees it.
  await transcript(page).evaluate(el => el.scrollTo({ top: el.scrollHeight, behavior: 'instant' }));
  await expect(page.locator('.transcript .message.assistant', { hasText: 'Remote reply from another client.' })).toBeInViewport();
});
