import { test, expect, type Page } from '@playwright/test';
import { initialWorkspace, type Workspace } from '../../lib/types';
import type { PersistentRun, RemoteConversation } from '../../lib/control-client';

const port = process.env.OPEN_HARNESS_TEST_PORT || '4317';
const control = `http://127.0.0.1:${port}`;
const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization,Content-Type', 'Access-Control-Allow-Methods': 'GET,POST,OPTIONS' };
const gate = () => {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
};

// Every coordinator request stays in this fixture, including run creation. Delayed
// acceptance exercises the real composer without Docker, timers, or paid inference.
async function fixture(page: Page, workspace: Workspace = initialWorkspace) {
  const state = {
    before: (async () => {}) as (path: string, method: string) => Promise<void>,
    runs: [] as PersistentRun[], history: [] as RemoteConversation[],
    events: [] as Array<{ seq: number; id: string; type: string; payload: Record<string, unknown> }>,
    submissions: 0, reject: false,
    features: ['reply-only'], prepares: [] as Array<{ agentId: string; replyOnly: unknown }>,
  };
  await page.addInitScript(saved => {
    localStorage.setItem('open-harness.workspace.v2', JSON.stringify(saved));
    localStorage.setItem('open-harness.onboarding.v1', 'done');
    localStorage.setItem('open-harness.migrated.v1', 'done');
  }, workspace);
  await page.route(`${control}/**`, async route => {
    const path = new URL(route.request().url()).pathname, method = route.request().method();
    if (method === 'OPTIONS') return route.fulfill({ status: 204, headers });
    const submission = path === '/v1/runs' && method === 'POST' ? ++state.submissions : 0;
    await state.before(path, method);
    let json: unknown;
    if (path === '/v1/bootstrap') json = { token: 'fixture', mode: 'live', features: state.features, runtime: { available: true, version: 'fixture', message: 'Fixture' }, version: 'fixture', hermes: { release: 'fixture', commit: 'fixture' } };
    else if (path === '/v1/agents/sync') json = { agents: workspace.agents };
    else if (/^\/v1\/agents\/[^/]+\/prepare$/.test(path) && method === 'POST') { state.prepares.push({ agentId: decodeURIComponent(path.split('/')[3]), replyOnly: route.request().postDataJSON()?.replyOnly }); json = { preparing: true, ready: false }; }
    else if (path === '/v1/teams') json = { teams: [] };
    else if (path === '/v1/workspace/model/import') json = { model: { provider: 'xai', model: 'fixture', baseUrl: '', credentialRef: '' }, revision: 1 };
    else if (path === '/v1/credentials') json = { credentials: [] };
    else if (path === '/v1/routines') json = { routines: [] };
    else if (path === '/v1/conversations') json = { conversations: state.history };
    else if (path === '/v1/runs' && method === 'GET') json = { runs: state.runs };
    else if (path === '/v1/runs' && method === 'POST') {
      if (state.reject) return route.fulfill({ status: 503, headers, json: { error: 'Please try again when the runtime is ready.' } });
      const input = route.request().postDataJSON();
      const run: PersistentRun = { id: `submitted-${submission}`, agent_id: input.agentId, conversation_id: input.conversationId, prompt: input.prompt, state: 'queued', reply_only:input.replyOnly===true, pendingInputs: [], pendingApprovals: [] };
      state.runs.push(run); json = run;
    } else if (path.endsWith('/events')) json = { events: state.events.splice(0), run: state.runs.find(run => path.includes(`/${run.id}/`)) };
    else if (path.endsWith('/context')) json = { memory: '', user: '', skills: [], capabilities: {} };
    else if (path === '/v1/files') json = { files: [] };
    else return route.fulfill({ status: 404, headers, json: { error: `Unexpected fixture request: ${path}` } });
    await route.fulfill({ headers, json });
  });
  return state;
}

async function openAgent(page: Page, name: string, isMobile: boolean) {
  if (isMobile) await page.getByRole('button', { name: 'Open navigation' }).click();
  await page.locator('aside.sidebar .agent-row', { hasText: name }).click();
  await expect(page.getByRole('textbox', { name: `Message ${name}` })).toBeVisible();
}

test('shows connecting while cached conversations remain usable', async ({ page, isMobile }) => {
  const pending = gate();
  const state = await fixture(page, { ...initialWorkspace, conversations: [{ id: 'cached', agentId: 'atlas', title: 'Saved notes', updatedAt: new Date().toISOString(), messages: [{ id: 'saved', role: 'assistant', content: 'Your saved work is still here.', settled: true }] }] });
  state.before = async path => { if (path === '/v1/bootstrap') await pending.promise; };
  try {
    await page.goto(`/?controlPort=${port}`);
    await expect(page.locator('.sidebar-bottom')).toContainText('Connecting…');
    await expect(page.locator('.sidebar-bottom')).not.toContainText('needs setup');
    await openAgent(page, 'Atlas', isMobile);
    await expect(page.locator('.transcript')).toContainText('Your saved work is still here.');
  } finally { pending.release(); }
  await expect(page.locator('.sidebar-bottom')).toContainText('Agent runtime ready');
});

test('loads history before slow settings and credentials finish', async ({ page, isMobile }) => {
  const pending = gate();
  const state = await fixture(page);
  const run: PersistentRun = { id: 'remembered-run', agent_id: 'atlas', conversation_id: 'remembered', prompt: 'Remembered task', state: 'completed', result: 'History arrived independently.' };
  state.history = [{ id: 'remembered', agentId: 'atlas', title: 'Remembered task', updatedAt: new Date().toISOString(), runs: [run] }];
  state.before = async path => { if (['/v1/workspace/model/import', '/v1/credentials', '/v1/teams'].includes(path)) await pending.promise; };
  try {
    await page.goto(`/?controlPort=${port}`);
    if (isMobile) await page.getByRole('button', { name: 'Open navigation' }).click();
    await page.locator('aside.sidebar .recent', { hasText: 'Remembered task' }).click();
    await expect(page.locator('.transcript')).toContainText('History arrived independently.');
    await expect(page.getByText('Refreshing conversations…')).toHaveCount(0);
  } finally { pending.release(); }
});

test('late recovery attaches active work without changing the selected conversation', async ({ page, isMobile }) => {
  const pending = gate();
  const state = await fixture(page);
  state.runs = [{ id: 'other-run', agent_id: 'atlas', conversation_id: 'other-chat', prompt: 'Work from another client', state: 'running', pendingInputs: [], pendingApprovals: [] }];
  state.before = async path => { if (path === '/v1/runs' || path === '/v1/conversations') await pending.promise; };
  try {
    await page.goto(`/?controlPort=${port}`);
    await openAgent(page, 'Scout', isMobile);
  } finally { pending.release(); }
  await expect(page.getByText('Refreshing conversations…')).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'Message Scout' })).toBeVisible();
  await expect(page.locator('aside.sidebar').getByLabel('Atlas is working')).toHaveCount(1);
});

test('opening an agent before history arrives restores its latest conversation and keeps the draft', async ({ page, isMobile }) => {
  const pending = gate(), state = await fixture(page);
  const run: PersistentRun = { id: 'remembered-scribe', agent_id: 'scribe', conversation_id: 'scribe-history', prompt: 'Earlier writing task', state: 'completed', result: 'The writing is ready.' };
  state.history = [{ id: run.conversation_id, agentId: 'scribe', title: run.prompt, updatedAt: new Date().toISOString(), runs: [run] }];
  state.before = async path => { if (path === '/v1/conversations') await pending.promise; };
  try {
    await page.goto(`/?controlPort=${port}`);
    await openAgent(page, 'Scribe', isMobile);
    await page.getByRole('textbox', { name: 'Message Scribe' }).fill('Continue editing the introduction.');
    await expect(page.locator('.transcript .message')).toHaveCount(0);
  } finally { pending.release(); }
  await expect(page.locator('.transcript .message.assistant')).toContainText('The writing is ready.');
  await expect(page.getByRole('textbox', { name: 'Message Scribe' })).toHaveValue('Continue editing the introduction.');
});

test('choosing a new conversation cancels pending restoration of an agent history', async ({ page, isMobile }) => {
  const pending = gate(), state = await fixture(page);
  const run: PersistentRun = { id: 'remembered-scribe', agent_id: 'scribe', conversation_id: 'scribe-history', prompt: 'Earlier writing task', state: 'completed', result: 'The writing is ready.' };
  state.history = [{ id: run.conversation_id, agentId: 'scribe', title: run.prompt, updatedAt: new Date().toISOString(), runs: [run] }];
  state.before = async path => { if (path === '/v1/conversations') await pending.promise; };
  try {
    await page.goto(`/?controlPort=${port}`);
    await openAgent(page, 'Scribe', isMobile);
    await page.getByRole('button', { name: 'New conversation' }).click();
    await page.getByRole('textbox', { name: 'Message Scribe' }).fill('Start a separate writing task.');
  } finally { pending.release(); }
  await expect(page.getByText('Refreshing conversations…')).toHaveCount(0);
  await expect(page.locator('.transcript .message')).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'Message Scribe' })).toHaveValue('Start a separate writing task.');
});

test('shows sending before acceptance, prevents duplicates, and preserves a newer draft', async ({ page, isMobile }) => {
  const pending = gate();
  const state = await fixture(page);
  state.before = async (path, method) => { if (path === '/v1/runs' && method === 'POST') await pending.promise; };
  await page.goto(`/?controlPort=${port}`);
  await expect(page.locator('.sidebar-bottom')).toContainText('Agent runtime ready');
  await openAgent(page, 'Atlas', isMobile);
  const input = page.getByRole('textbox', { name: 'Message Atlas' });
  try {
    await input.fill('Start this task');
    await page.getByRole('button', { name: 'Send message' }).click();
    await expect(page.locator('.transcript .working')).toHaveText('Sending…');
    await expect(page.getByRole('button', { name: 'Send message' })).toBeDisabled();
    await input.press('Enter');
    await input.fill('Keep this newer draft');
    await expect.poll(() => state.submissions).toBe(1);
  } finally { pending.release(); }
  await expect(page.locator('.transcript .working')).toContainText('Queued…');
  await expect(input).toHaveValue('Keep this newer draft');
  await expect(page.locator('.transcript .message.user')).toHaveCount(1);
  await expect(page.locator('.transcript .message.assistant')).toHaveCount(1);
  expect(state.submissions).toBe(1);
});

test('failed submission keeps the draft and clears the sending indicator', async ({ page, isMobile }) => {
  const state = await fixture(page); state.reject = true;
  await page.goto(`/?controlPort=${port}`);
  await expect(page.locator('.sidebar-bottom')).toContainText('Agent runtime ready');
  await openAgent(page, 'Atlas', isMobile);
  const input = page.getByRole('textbox', { name: 'Message Atlas' });
  await input.fill('Keep my task for retry');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.locator('.message-error')).toContainText('Please try again when the runtime is ready.');
  await expect(input).toHaveValue('Keep my task for retry');
  await expect(page.locator('.transcript .working')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Send message' })).toBeEnabled();
});

test('chat progress follows real phases, respects reduced motion, and stops at completion', async ({ page, isMobile }, testInfo) => {
  const state = await fixture(page);
  let seq = 0;
  const emit = (type: string, payload: Record<string, unknown> = {}) => state.events.push({ seq: ++seq, id: `progress-${seq}`, type, payload });
  await page.goto(`/?controlPort=${port}`);
  await expect(page.locator('.sidebar-bottom')).toContainText('Agent runtime ready');
  await openAgent(page, 'Atlas', isMobile);
  const input = page.getByRole('textbox', { name: 'Message Atlas' });
  await input.fill('Check a file and report what you found.');
  await page.getByRole('button', { name: 'Send message' }).click();
  const progress = page.locator('.message.assistant .chat-progress'), status = progress.getByRole('status');
  await expect(status).toHaveText('Queued…');
  state.runs[0] = { ...state.runs[0], state: 'running' };
  emit('run.phase', { phase: 'gateway-ready' });
  await expect(status).toHaveText('Getting ready…');
  emit('run.phase', { phase: 'prompt-dispatched' });
  emit('thinking.delta', { text: 'Private reasoning must never appear in the transcript.' });
  await expect(status).toHaveText('Thinking…');
  await expect(page.locator('.transcript')).not.toContainText('Private reasoning');
  await expect(progress.locator('i').first()).toHaveCSS('animation-name', 'chat-breathe');
  await page.screenshot({ path: testInfo.outputPath('chat-thinking.png') });

  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(progress.locator('i').first()).toHaveCSS('animation-name', 'none');
  await expect(status).toHaveText('Thinking…');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  emit('tool.start', { tool_id: 'file-call', name: 'read_file', context: 'notes.txt' });
  await expect(status).toHaveText('Reading a file…');
  emit('tool.complete', { tool_id: 'file-call', name: 'read_file', result: 'File checked.' });
  await expect(status).toHaveText('Thinking…');
  await expect(page.locator('.activity.done')).toContainText('File checked.');

  const chunks = Array.from({ length: 300 }, (_, index) => `word${index} `);
  chunks.forEach(text => emit('message.delta', { text }));
  await expect(status).toHaveText('Responding…');
  await expect(page.locator('.message.assistant .markdown')).toHaveText(chunks.join('').trim());
  await input.fill('Keep my next question while the reply streams.');
  await expect(input).toHaveValue('Keep my next question while the reply streams.');
  emit('thinking.delta');
  await expect(status).toHaveText('Thinking…');

  state.runs[0] = { ...state.runs[0], state: 'waiting_approval' };
  await expect(status).toHaveText('Waiting for your approval…');
  await expect(progress.locator('i').first()).toHaveCSS('animation-name', 'none');
  state.runs[0] = { ...state.runs[0], state: 'running' };
  emit('message.complete', { text: chunks.join('') });
  await expect(status).toHaveText('Finishing up…');
  state.runs[0] = { ...state.runs[0], state: 'completed', result: 'The file check is complete.' };
  await expect(progress).toHaveCount(0);
  await expect(page.locator('.message.assistant .markdown')).toHaveText('The file check is complete.');
  await expect(input).toHaveValue('Keep my next question while the reply streams.');
  await expect(page.getByRole('button', { name: 'Stop run' })).toHaveCount(0);
});

test('reply-only is an explicit per-message choice and stays fixed while its task runs', async ({ page, isMobile }, testInfo) => {
  const state=await fixture(page);await page.goto(`/?controlPort=${port}`);
  await expect(page.locator('.sidebar-bottom')).toContainText('Agent runtime ready');await openAgent(page,'Atlas',isMobile);
  const mode=page.getByRole('checkbox',{name:/Reply only/});await expect(mode).not.toBeChecked();await mode.check();
  await page.getByRole('textbox',{name:'Message Atlas'}).fill('Answer directly from this conversation.');
  const sent=page.waitForRequest(request=>request.url().endsWith('/v1/runs')&&request.method()==='POST');
  await page.getByRole('button',{name:'Send message'}).click();expect((await sent).postDataJSON().replyOnly).toBe(true);
  await expect(mode).toBeChecked();await expect(mode).toBeDisabled();
  await page.screenshot({path:testInfo.outputPath('reply-only.png')});
  state.runs[0]={...state.runs[0],state:'completed',result:'A direct reply.'};await expect(mode).toBeEnabled();await mode.uncheck();
  await page.getByRole('textbox',{name:'Message Atlas'}).fill('Now use my tools.');
  const ordinary=page.waitForRequest(request=>request.url().endsWith('/v1/runs')&&request.method()==='POST');
  await page.getByRole('button',{name:'Send message'}).click();expect((await ordinary).postDataJSON().replyOnly).toBeUndefined();
});

test('a pending request stays with its conversation when switching agents', async ({ page, isMobile }) => {
  const pending = gate();
  const state = await fixture(page);
  state.before = async (path, method) => { if (path === '/v1/runs' && method === 'POST') await pending.promise; };
  await page.goto(`/?controlPort=${port}`);
  await expect(page.locator('.sidebar-bottom')).toContainText('Agent runtime ready');
  await openAgent(page, 'Atlas', isMobile);
  try {
    await page.getByRole('textbox', { name: 'Message Atlas' }).fill('Same words, different conversation');
    await page.getByRole('button', { name: 'Send message' }).click();
    await expect(page.locator('.transcript .working')).toHaveText('Sending…');
    await openAgent(page, 'Scout', isMobile);
    await page.getByRole('textbox', { name: 'Message Scout' }).fill('Same words, different conversation');
    await expect(page.locator('.transcript .working')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Send message' })).toBeEnabled();
  } finally { pending.release(); }
  await expect(page.locator('aside.sidebar').getByLabel('Atlas is working')).toHaveCount(1);
  await expect(page.getByRole('textbox', { name: 'Message Scout' })).toHaveValue('Same words, different conversation');
  await expect(page.locator('.transcript .message')).toHaveCount(0);
});

test('completion releases the composer before deliverables finish loading', async ({ page, isMobile }) => {
  const pending = gate();
  const state = await fixture(page);
  state.before = async path => { if (path === '/v1/files') await pending.promise; };
  await page.goto(`/?controlPort=${port}`);
  await expect(page.locator('.sidebar-bottom')).toContainText('Agent runtime ready');
  await openAgent(page, 'Atlas', isMobile);
  try {
    await page.getByRole('textbox', { name: 'Message Atlas' }).fill('Finish while files load');
    await page.getByRole('button', { name: 'Send message' }).click();
    await expect(page.getByRole('button', { name: 'Stop run' })).toBeVisible();
    state.runs[0] = { ...state.runs[0], state: 'completed', result: 'Task complete.' };
    await expect(page.locator('.message.assistant')).toContainText('Task complete.');
    await expect(page.getByRole('button', { name: 'Send message' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Stop run' })).toHaveCount(0);
  } finally { pending.release(); }
});

// Wait for React to commit a response already delivered by the fixture, rather than
// letting a negative assertion pass just before an obsolete response changes the page.
const rendered = (page: Page) => page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));

test('a stale startup response cannot overwrite a successful retry', async ({ page }) => {
  await fixture(page);
  const pending = gate();
  let teamReads = 0, routineReads = 0;
  await page.route(`${control}/v1/routines`, async route => {
    if (route.request().method() !== 'GET') return route.fallback();
    routineReads++;
    await route.fulfill({ status: routineReads === 1 ? 503 : 200, headers, json: routineReads === 1 ? { error: 'Retry this read.' } : { routines: [] } });
  });
  await page.route(`${control}/v1/teams?includeRetired=1`, async route => {
    if (route.request().method() !== 'GET') return route.fallback();
    const read = ++teamReads;
    if (read === 1) await pending.promise;
    await route.fulfill({ headers, json: { teams: [{ id: 'retry-team', revision: read, name: read === 1 ? 'Old team name' : 'New team name', description: '', color: 'sage', icon: 'people', memberAgentIds: ['atlas'], retiredAt: null, createdAt: '2026-10-19T00:00:00Z', updatedAt: '2026-10-19T00:00:00Z' }] } });
  });
  try {
    await page.goto(`/?controlPort=${port}`);
    await expect(page.getByRole('button', { name: 'New team name', exact: true })).toBeVisible({ timeout: 10_000 });
    const stale = page.waitForResponse(response => response.url().includes('/v1/teams?includeRetired=1'));
    pending.release();
    await (await stale).finished();
    await rendered(page);
    await expect(page.getByRole('button', { name: 'New team name', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Old team name', exact: true })).toHaveCount(0);
  } finally { pending.release(); }
});

test('a pending first message does not silently block a different new conversation', async ({ page, isMobile }) => {
  const pending = gate();
  const state = await fixture(page);
  state.before = async (path, method) => { if (path === '/v1/runs' && method === 'POST') await pending.promise; };
  await page.goto(`/?controlPort=${port}`);
  await expect(page.locator('.sidebar-bottom')).toContainText('Agent runtime ready');
  await openAgent(page, 'Atlas', isMobile);
  try {
    await page.getByRole('textbox', { name: 'Message Atlas' }).fill('First conversation');
    await page.getByRole('button', { name: 'Send message' }).click();
    await expect(page.locator('.transcript .working')).toHaveText('Sending…');
    await page.getByRole('button', { name: 'New conversation' }).click();
    await page.getByRole('textbox', { name: 'Message Atlas' }).fill('Second conversation');
    await page.getByRole('button', { name: 'Send message' }).click();
    await expect(page.locator('.transcript .message.user')).toHaveText(/Second conversation/);
    await expect.poll(() => state.submissions).toBe(2);
  } finally { pending.release(); }
});

test('a recovered task refreshes its deliverables when it finishes', async ({ page, isMobile }) => {
  const state = await fixture(page);
  state.runs = [{ id: 'recovered', agent_id: 'atlas', conversation_id: 'recovered-chat', prompt: 'Finish this report', state: 'running' }];
  await page.route(`${control}/v1/files?*`, async route => {
    if (route.request().method() !== 'GET') return route.fallback();
    const file = { name: 'report.txt', size: 12, updatedAt: '2026-10-19T00:00:00Z', encoding: 'utf8', mimeType: 'text/plain' };
    await route.fulfill({ headers, json: new URL(route.request().url()).searchParams.has('name') ? { ...file, content: 'Fresh report' } : { files: [file] } });
  });
  await page.goto(`/?controlPort=${port}`);
  await expect(page.getByRole('button', { name: 'Stop run' })).toBeVisible();
  state.runs[0] = { ...state.runs[0], state: 'completed', result: 'Report ready.' };
  await expect(page.getByRole('button', { name: 'Send message' })).toBeVisible();
  if (isMobile) await page.getByRole('button', { name: 'Open navigation' }).click();
  await page.locator('aside.sidebar .nav-item', { hasText: 'Files' }).click();
  await expect(page.getByRole('button', { name: 'Download report.txt' })).toBeVisible();
});

test('a background file refresh preserves a file uploaded while it was loading', async ({ page, isMobile }) => {
  const pending = gate();
  const state = await fixture(page);
  let fileReads = 0;
  state.before = async (path, method) => { if (path === '/v1/files' && method === 'GET') { fileReads++; await pending.promise; } };
  await page.goto(`/?controlPort=${port}`);
  await expect(page.locator('.sidebar-bottom')).toContainText('Agent runtime ready');
  await openAgent(page, 'Atlas', isMobile);
  try {
    await page.getByRole('textbox', { name: 'Message Atlas' }).fill('Finish before the upload');
    await page.getByRole('button', { name: 'Send message' }).click();
    await expect(page.getByRole('button', { name: 'Stop run' })).toBeVisible();
    state.runs[0] = { ...state.runs[0], state: 'completed', result: 'Done.' };
    await expect(page.getByRole('button', { name: 'Send message' })).toBeVisible();
    await expect.poll(() => fileReads).toBe(1);
    await page.locator('input[type="file"][multiple]').setInputFiles({ name: 'draft.txt', mimeType: 'text/plain', buffer: Buffer.from('Keep my upload') });
    if (isMobile) await page.getByRole('button', { name: 'Open navigation' }).click();
    await page.locator('aside.sidebar .nav-item', { hasText: 'Files' }).click();
    await expect(page.getByRole('button', { name: 'Download draft.txt' })).toBeVisible();
    const stale = page.waitForResponse(response => response.url().includes('/v1/files?') && response.request().method() === 'GET');
    pending.release();
    await (await stale).finished();
    await rendered(page);
    await expect(page.getByRole('button', { name: 'Download draft.txt' })).toBeVisible();
  } finally { pending.release(); }
});

test('recovery during follow-up acceptance does not add the same messages twice', async ({ page }) => {
  const state = await fixture(page), failFirstRead = gate(), acceptFollowup = gate();
  state.runs = [{ id: 'original-run', agent_id: 'atlas', conversation_id: 'active-chat', prompt: 'Original task', state: 'running' }];
  let routineReads = 0, accepted = false;
  await page.route(`${control}/v1/routines`, async route => {
    if (route.request().method() !== 'GET') return route.fallback();
    const read = ++routineReads;
    if (read === 1) await failFirstRead.promise;
    await route.fulfill({ status: read === 1 ? 503 : 200, headers, json: read === 1 ? { error: 'Retry this read.' } : { routines: [] } });
  });
  await page.route(`${control}/v1/runs`, async route => {
    if (route.request().method() !== 'POST') return route.fallback();
    const input = route.request().postDataJSON();
    const run: PersistentRun = { id: 'accepted-followup', agent_id: input.agentId, conversation_id: input.conversationId, prompt: input.prompt, state: 'queued' };
    state.runs.push(run); accepted = true;
    await acceptFollowup.promise;
    await route.fulfill({ headers, json: run });
  });
  try {
    await page.goto(`/?controlPort=${port}`);
    await expect(page.getByRole('button', { name: 'Stop run' })).toBeVisible();
    await page.getByRole('button', { name: 'Follow-up', exact: true }).click();
    await page.getByRole('textbox', { name: 'Message Atlas' }).fill('Follow-up accepted before the response');
    await page.getByRole('button', { name: 'Send followup' }).click();
    await expect.poll(() => accepted).toBe(true);
    failFirstRead.release();
    await expect(page.locator('.transcript .message.assistant')).toHaveCount(2, { timeout: 10_000 });
    const response = page.waitForResponse(response => response.url() === `${control}/v1/runs` && response.request().method() === 'POST');
    acceptFollowup.release();
    await (await response).finished();
    await rendered(page);
    await expect(page.locator('.transcript .message.user')).toHaveCount(2);
    await expect(page.locator('.transcript .message.assistant')).toHaveCount(2);
  } finally { failFirstRead.release(); acceptFollowup.release(); }
});

test('overlapping completed tasks keep the newest deliverable refresh', async ({ page, isMobile }) => {
  const state = await fixture(page), older = gate(), newer = gate();
  let fileReads = 0;
  await page.route(`${control}/v1/files?*`, async route => {
    if (route.request().method() !== 'GET') return route.fallback();
    const name = new URL(route.request().url()).searchParams.get('name');
    if (name) return route.fulfill({ headers, json: { name, content: name, encoding: 'utf8', mimeType: 'text/plain' } });
    const read = ++fileReads;
    await (read === 1 ? older.promise : newer.promise);
    await route.fulfill({ headers, json: { files: [{ name: read === 1 ? 'old.txt' : 'new.txt', size: 7, updatedAt: '2026-10-19T00:00:00Z', encoding: 'utf8', mimeType: 'text/plain' }] } });
  });
  try {
    await page.goto(`/?controlPort=${port}`);
    await expect(page.locator('.sidebar-bottom')).toContainText('Agent runtime ready');
    for (const name of ['Atlas', 'Scout']) {
      await openAgent(page, name, isMobile);
      await page.getByRole('textbox', { name: `Message ${name}` }).fill(`Finish ${name}'s task`);
      await page.getByRole('button', { name: 'Send message' }).click();
      await expect(page.getByRole('button', { name: 'Stop run' })).toBeVisible();
    }
    state.runs[0] = { ...state.runs[0], state: 'completed', result: 'Atlas finished.' };
    await expect.poll(() => fileReads).toBe(1);
    state.runs[1] = { ...state.runs[1], state: 'completed', result: 'Scout finished.' };
    await expect.poll(() => fileReads).toBe(2);
    const oldResponse = page.waitForResponse(response => response.url() === `${control}/v1/files?scope=shared`);
    older.release();
    await (await oldResponse).finished();
    await rendered(page);
    newer.release();
    if (isMobile) await page.getByRole('button', { name: 'Open navigation' }).click();
    await page.locator('aside.sidebar .nav-item', { hasText: 'Files' }).click();
    await expect(page.getByRole('button', { name: 'Download new.txt' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Download old.txt' })).toHaveCount(0);
  } finally { older.release(); newer.release(); }
});

test('starts the agent runtime once when someone begins a message, and only if the coordinator offers it', async ({ page, isMobile }) => {
  const state = await fixture(page);
  await page.goto(`/?controlPort=${port}`);
  await expect(page.locator('.sidebar-bottom')).toContainText('Agent runtime ready');
  await openAgent(page, 'Atlas', isMobile);
  const input = page.getByRole('textbox', { name: 'Message Atlas' });
  await input.fill('An older coordinator gets no preparation request');
  await page.waitForTimeout(300);
  expect(state.prepares).toEqual([]);

  state.features = ['reply-only', 'agent-prepare'];
  await page.reload();
  await expect(page.locator('.sidebar-bottom')).toContainText('Agent runtime ready');
  await openAgent(page, 'Atlas', isMobile);
  await input.fill('Plan');
  await input.fill('Plan my week');
  await input.blur(); await input.focus();
  await expect.poll(() => state.prepares).toEqual([{ agentId: 'atlas', replyOnly: false }]);
  // Preparation is a hint: it never sends, queues, or shows anything in the transcript.
  expect(state.submissions).toBe(0);
  await expect(page.locator('.transcript .message')).toHaveCount(0);
  await expect(input).toHaveValue('Plan my week');
});
