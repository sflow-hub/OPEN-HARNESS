import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { initialWorkspace } from '../../lib/types';
import { draftProfile } from '../../lib/agent-profile';

// The conversation is the product: a task goes to a named agent, its run is followed, and
// what the agent asks for on the way — an approval, an answer — gets answered here. Every
// spec runs against the mock coordinator, whose prompts carry markers (MOCK_APPROVAL,
// MOCK_CLARIFY, MOCK_SLOW) that make a run pause exactly where a real one would.
const control = `http://127.0.0.1:${process.env.OPEN_HARNESS_TEST_PORT || 4317}`;
const MOCK_REPLY = 'Hermes mock completed the task.';

async function operator(request: APIRequestContext) {
  const { token } = await (await request.get(control + '/v1/bootstrap')).json();
  return { Authorization: `Bearer ${token}` };
}
async function seed(request: APIRequestContext) {
  const headers = await operator(request);
  await request.post(control + '/v1/agents/sync', { headers, data: { agents: initialWorkspace.agents } });
  for (const agent of initialWorkspace.agents) {
    const { profile } = await (await request.get(control + `/v1/agents/${agent.id}/profile`, { headers })).json();
    await request.put(control + `/v1/agents/${agent.id}/profile`, { headers, data: { ...draftProfile(agent), revision: profile.revision } });
  }
}
// The coordinator is shared by the whole suite, so a run one spec leaves waiting would be
// recovered — and opened — by the next spec's dashboard.
async function stopEverything(request: APIRequestContext) {
  const headers = await operator(request);
  const stopped = await request.post(control + '/v1/runs/stop-all', { headers });
  expect(stopped.ok()).toBeTruthy();
  await expect.poll(async () => {
    const { runs } = await (await request.get(control + '/v1/runs', { headers })).json();
    return runs.filter((run: { state: string }) => ['queued', 'running', 'waiting_approval', 'waiting_input'].includes(run.state)).length;
  }).toBe(0);
}
async function liveRuns(request: APIRequestContext) {
  const headers = await operator(request);
  const { runs } = await (await request.get(control + '/v1/runs', { headers })).json();
  return runs.filter((run: { state: string }) => ['queued', 'running', 'waiting_approval', 'waiting_input'].includes(run.state)) as Array<{ id: string; agent_id: string; state: string; prompt: string }>;
}
// Opening an agent continues its latest conversation — on this shared coordinator that is
// whatever the previous spec said to it — so each spec starts a conversation of its own,
// the way a person would.
async function openAgent(page: Page, name: string, isMobile: boolean, fresh = true) {
  if (isMobile) await page.getByRole('button', { name: 'Open navigation' }).click();
  await page.locator('aside.sidebar .agent-row', { hasText: name }).click();
  await expect(page.getByRole('textbox', { name: `Message ${name}` })).toBeVisible();
  if (fresh && await page.locator('.transcript .message').count()) {
    await page.getByRole('button', { name: 'New conversation' }).click();
    await expect(page.locator('.transcript .message')).toHaveCount(0);
  }
}
async function send(page: Page, name: string, text: string) {
  await page.getByRole('textbox', { name: `Message ${name}` }).fill(text);
  await page.getByRole('button', { name: 'Send message' }).click();
}
const replies = (page: Page) => page.locator('.transcript .message.assistant');

test.beforeEach(async ({ request, page }) => {
  await stopEverything(request);
  await seed(request);
  await page.addInitScript(() => localStorage.setItem('open-harness.onboarding.v1', 'done'));
  await page.route(`${control}/v1/bootstrap`, async route => {
    const response = await route.fetch();
    await route.fulfill({ response, json: { ...await response.json(), mode: 'live' } });
  });
  await page.goto(`/?controlPort=${process.env.OPEN_HARNESS_TEST_PORT || 4317}`);
  await expect(page.getByRole('button', { name: 'Edit Atlas profile' })).toBeVisible();
});
test.afterEach(async ({ request }) => { await stopEverything(request); });

test('sends a task and shows the agent working, then its reply', async ({ page, isMobile }) => {
  await openAgent(page, 'Atlas', isMobile);
  await send(page, 'Atlas', 'Summarize my notes MOCK_SLOW');
  // The prompt is in the transcript before the coordinator has answered, and the reply
  // placeholder says the agent is on it.
  await expect(page.locator('.transcript .message.user')).toContainText('Summarize my notes');
  await expect(page.locator('.transcript .working')).toContainText(/Working on it|Queued/);
  await expect(page.getByRole('button', { name: 'Stop run' })).toBeVisible();
  await expect(replies(page).last()).toContainText(MOCK_REPLY, { timeout: 15_000 });
  // Finished: the composer is back to plain sending.
  await expect(page.getByRole('button', { name: 'Send message' })).toBeVisible();
});

test('two agents work at the same time and each conversation follows its own run', async ({ page, request, isMobile }) => {
  // Atlas pauses on an approval, which keeps its run live for as long as this test likes.
  await openAgent(page, 'Atlas', isMobile);
  await send(page, 'Atlas', 'Publish the report MOCK_APPROVAL');
  await expect(page.locator('.approval-banner')).toContainText('Atlas needs approval', { timeout: 15_000 });

  // Switching to Scout is allowed while Atlas works, and Scout gets a run of its own.
  await openAgent(page, 'Scout', isMobile);
  await expect(page.getByRole('button', { name: 'Send message' })).toBeVisible();
  await send(page, 'Scout', 'Compare the files in my workspace');
  await expect(replies(page).last()).toContainText(MOCK_REPLY, { timeout: 15_000 });
  await expect(page.locator('.transcript .message.user')).toHaveCount(1);
  // Atlas's request is still visible from here, because its slot is held until answered,
  // and Atlas still shows as busy in the sidebar.
  await expect(page.locator('.approval-banner')).toContainText('Atlas needs approval');
  if (isMobile) await page.getByRole('button', { name: 'Open navigation' }).click();
  await expect(page.locator('aside.sidebar .agent-row', { hasText: 'Atlas' }).getByLabel('Atlas is working')).toBeVisible();
  if (isMobile) await page.keyboard.press('Escape');

  // Back in Atlas's conversation nothing of Scout's leaked in, and Stop acts on Atlas's
  // run — not on whichever run was started last.
  const [atlas] = (await liveRuns(request)).filter(run => run.agent_id === 'atlas');
  expect(atlas).toBeTruthy();
  await openAgent(page, 'Atlas', isMobile, false);
  await expect(page.locator('.transcript .message.user')).toContainText('Publish the report');
  await expect(page.locator('.transcript .message.user')).toHaveCount(1);
  const stop = page.waitForRequest(candidate => candidate.url().endsWith(`/v1/runs/${atlas.id}/stop`) && candidate.method() === 'POST');
  await page.getByRole('button', { name: 'Stop run' }).click();
  await stop;
  await expect(replies(page).last()).toContainText(/Stopped|cancelled|interrupted|denied/i, { timeout: 15_000 });
  await expect(page.locator('.approval-banner')).toBeHidden();
});

test('a follow-up queued behind a running task is shown, then followed to its own reply', async ({ page, isMobile }) => {
  await openAgent(page, 'Atlas', isMobile);
  await send(page, 'Atlas', 'Publish the report MOCK_APPROVAL');
  await expect(page.locator('.approval-banner')).toContainText('Atlas needs approval', { timeout: 15_000 });

  await page.getByRole('button', { name: 'Follow-up' }).click();
  await page.getByRole('textbox', { name: 'Message Atlas' }).fill('Then draft the announcement');
  await page.getByRole('button', { name: 'Send followup' }).click();
  // The follow-up is in the transcript straight away, waiting its turn.
  await expect(page.locator('.transcript .message.user').nth(1)).toContainText('Then draft the announcement');
  await expect(page.locator('.transcript .working').last()).toContainText('Queued behind the current task');
  await expect(page.getByRole('status')).toContainText('Follow-up queued');

  await page.getByRole('button', { name: 'Approve once' }).click();
  // Both runs finish, each into its own reply, in order.
  await expect(replies(page)).toHaveCount(2);
  await expect(replies(page).nth(0)).toContainText(MOCK_REPLY, { timeout: 15_000 });
  await expect(replies(page).nth(1)).toContainText(MOCK_REPLY, { timeout: 15_000 });
  await expect(page.getByRole('button', { name: 'Send message' })).toBeVisible();
});

test('an approval survives a reload and can still be answered', async ({ page, isMobile }) => {
  await openAgent(page, 'Atlas', isMobile);
  await send(page, 'Atlas', 'Publish the report MOCK_APPROVAL');
  await expect(page.locator('.approval-banner')).toContainText('publish mock result', { timeout: 15_000 });

  // A reload resumes past the events already shown — including the request itself. The
  // banner has to come from what the coordinator says the run is waiting on.
  await page.reload();
  await expect(page.locator('.approval-banner')).toContainText('publish mock result', { timeout: 15_000 });
  await expect(page.locator('.transcript .working')).toContainText('Waiting for your approval');
  await page.getByRole('button', { name: 'Approve once' }).click();
  await expect(page.locator('.approval-banner')).toBeHidden();
  await expect(replies(page).last()).toContainText(MOCK_REPLY, { timeout: 15_000 });
});

test('a question from the agent is answered from the conversation', async ({ page, isMobile }) => {
  await openAgent(page, 'Atlas', isMobile);
  await send(page, 'Atlas', 'Set up the project MOCK_CLARIFY');
  const question = page.getByRole('form', { name: 'Atlas has a question' });
  await expect(question).toContainText('What should I use?', { timeout: 15_000 });
  await expect(page.locator('.transcript .working')).toContainText('Waiting for your answer');
  await expect(question.getByRole('button', { name: 'Send answer' })).toBeDisabled();
  await question.getByRole('textbox', { name: 'Your answer' }).fill('the blue one');
  await question.getByRole('button', { name: 'Send answer' }).click();
  await expect(question).toBeHidden();
  await expect(replies(page).last()).toContainText('Answer: the blue one', { timeout: 15_000 });
});

test('a fresh client rebuilds earlier conversations from the coordinator', async ({ page, request, isMobile }) => {
  const headers = await operator(request);
  const run = await (await request.post(control + '/v1/runs', { headers, data: { agentId: 'scribe', prompt: 'Write the launch note from another client' } })).json();
  await expect.poll(async () => (await (await request.get(control + `/v1/runs/${run.id}`, { headers })).json()).state).toBe('completed');

  // This browser has never seen that run: its storage is empty. The coordinator's history
  // is enough to show the conversation, with the prompt and the reply.
  await page.reload();
  await expect(page.getByRole('button', { name: 'Edit Atlas profile' })).toBeVisible();
  if (isMobile) await page.getByRole('button', { name: 'Open navigation' }).click();
  await page.getByRole('textbox', { name: 'Search conversations' }).fill('launch note from another client');
  await page.locator('aside.sidebar .recent', { hasText: 'Write the launch note from another client' }).first().click();
  await expect(page.locator('.transcript .message.user')).toContainText('Write the launch note from another client');
  await expect(replies(page).last()).toContainText(MOCK_REPLY);
  await expect(page.getByRole('button', { name: 'Send message' })).toBeVisible();
});


test('a run that finishes while the page is closed shows its reply when the page reopens', async ({ page, request, isMobile }) => {
  const headers = await operator(request);
  await openAgent(page, 'Atlas', isMobile);
  await send(page, 'Atlas', 'Publish the report MOCK_APPROVAL');
  await expect(page.locator('.approval-banner')).toContainText('Atlas needs approval', { timeout: 15_000 });
  const [run] = (await liveRuns(request)).filter(item => item.agent_id === 'atlas');
  const { pendingApprovals } = await (await request.get(control + `/v1/runs/${run.id}`, { headers })).json();

  // The page goes away with the reply still empty; the run finishes without it.
  await page.goto('about:blank');
  await request.post(control + `/v1/runs/${run.id}/approval`, { headers, data: { approvalId: pendingApprovals[0].approvalId, decision: 'approve' } });
  await expect.poll(async () => (await (await request.get(control + `/v1/runs/${run.id}`, { headers })).json()).state).toBe('completed');

  // Reopened, the saved conversation is caught up from the coordinator instead of keeping
  // an empty reply forever.
  await page.goto(`/?controlPort=${process.env.OPEN_HARNESS_TEST_PORT || 4317}`);
  await expect(page.getByRole('button', { name: 'Edit Atlas profile' })).toBeVisible();
  await openAgent(page, 'Atlas', isMobile, false);
  await expect(page.locator('.transcript .message.user').last()).toContainText('Publish the report');
  await expect(replies(page).last()).toContainText(MOCK_REPLY, { timeout: 15_000 });
  await expect(page.locator('.transcript .working')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Send message' })).toBeVisible();
});

test('catching up a finished run reads every page of its events, not just the first', async ({ page, request, isMobile }) => {
  // A real run, so the dashboard finds it; its events are served here in the coordinator's
  // 500-per-page shape, with the result on the second page.
  const headers = await operator(request);
  const created = await (await request.post(control + '/v1/runs', { headers, data: { agentId: 'scribe', prompt: 'Write a very long piece MOCK_APPROVAL' } })).json();
  await expect.poll(async () => (await (await request.get(control + `/v1/runs/${created.id}`, { headers })).json()).state).toBe('waiting_approval');
  const total = 505;
  const event = (seq: number) => seq <= total - 1
    ? { seq, id: `e${seq}`, type: 'message.delta', payload: { text: `part${seq} ` } }
    : { seq, id: `e${seq}`, type: 'run.completed', payload: { result: 'ignored: the deltas were streamed' } };
  const eventsOf = (url: URL) => url.pathname.endsWith(`/v1/runs/${created.id}/events`);
  await page.route(eventsOf, async route => {
    const after = Number(new URL(route.request().url()).searchParams.get('after') || 0);
    const events = []; for (let seq = after + 1; seq <= total && events.length < 500; seq += 1) events.push(event(seq));
    const live = await (await request.get(control + `/v1/runs/${created.id}`, { headers })).json();
    await route.fulfill({ status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ events, run: { ...live, state: 'completed', result: null, error: null, pendingApprovals: [] } }) });
  });

  await page.reload();
  await expect(page.getByRole('button', { name: 'Edit Atlas profile' })).toBeVisible();
  await openAgent(page, 'Scribe', isMobile, false);
  const reply = replies(page).last();
  await expect(reply).toContainText('part1 ', { timeout: 15_000 });
  await expect(reply).toContainText('part504', { timeout: 15_000 });
  await expect(page.locator('.transcript .working')).toHaveCount(0);
  await page.unroute(eventsOf);
});

test('a request the coordinator reopens after an answer is shown again', async ({ page, request, isMobile }) => {
  await openAgent(page, 'Atlas', isMobile);
  await send(page, 'Atlas', 'Publish the report MOCK_APPROVAL');
  await expect(page.locator('.approval-banner')).toContainText('publish mock result', { timeout: 15_000 });
  const [run] = (await liveRuns(request)).filter(item => item.agent_id === 'atlas');

  // The answer is accepted by the coordinator (it enqueues it for a runner) but is never
  // actually taken: the request stays pending server-side. Played here by acknowledging
  // the POST without forwarding it, and by reporting the request gone exactly once.
  await page.route(url => url.pathname.endsWith(`/v1/runs/${run.id}/approval`), route => route.fulfill({ status: 200, contentType: 'application/json', headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify({ ok: true }) }));
  let dropped = false;
  await page.route(url => url.pathname.endsWith(`/v1/runs/${run.id}/events`), async route => {
    if (dropped) return route.fallback();
    const response = await route.fetch();
    const body = await response.json();
    dropped = true;
    await route.fulfill({ response, body: JSON.stringify({ ...body, run: { ...body.run, pendingApprovals: [] } }) });
  });
  await page.getByRole('button', { name: 'Approve once' }).click();
  await expect(page.locator('.approval-banner')).toBeHidden();
  // The coordinator's next snapshots list it again, so the card comes back rather than
  // being suppressed forever by the answer given here.
  await expect(page.locator('.approval-banner')).toContainText('publish mock result', { timeout: 15_000 });
});


test('a reply that had streamed only its first words when the page closed is completed on reopen', async ({ page, request, isMobile }) => {
  const headers = await operator(request);
  await openAgent(page, 'Atlas', isMobile);
  // The run pauses on an approval; meanwhile the coordinator's first page of events is
  // played here as a single streamed fragment, so the saved reply is non-empty but partial.
  const anyEvents = (url: URL) => url.pathname.includes('/v1/runs/') && url.pathname.endsWith('/events');
  await page.route(anyEvents, async route => {
    const after = Number(new URL(route.request().url()).searchParams.get('after') || 0);
    const response = await route.fetch();
    const body = await response.json();
    await route.fulfill({ response, body: JSON.stringify({ ...body, events: after === 0 ? [{ seq: 1, id: 'p1', type: 'message.delta', payload: { text: 'Starting the draft ' } }] : [] }) });
  });
  await send(page, 'Atlas', 'Publish the report MOCK_APPROVAL');
  await expect(replies(page).last()).toContainText('Starting the draft', { timeout: 15_000 });
  await expect(page.locator('.approval-banner')).toContainText('publish mock result', { timeout: 15_000 });
  const [run] = (await liveRuns(request)).filter(item => item.agent_id === 'atlas');
  const { pendingApprovals } = await (await request.get(control + `/v1/runs/${run.id}`, { headers })).json();

  await page.goto('about:blank');
  await page.unroute(anyEvents);
  await request.post(control + `/v1/runs/${run.id}/approval`, { headers, data: { approvalId: pendingApprovals[0].approvalId, decision: 'approve' } });
  await expect.poll(async () => (await (await request.get(control + `/v1/runs/${run.id}`, { headers })).json()).state).toBe('completed');

  // Non-empty is not the same as finished: the rest of the run is fetched from where the
  // client left off and appended.
  await page.goto(`/?controlPort=${process.env.OPEN_HARNESS_TEST_PORT || 4317}`);
  await expect(page.getByRole('button', { name: 'Edit Atlas profile' })).toBeVisible();
  await openAgent(page, 'Atlas', isMobile, false);
  // The run's stored result is what the agent answered, so it replaces the fragment.
  await expect(replies(page).last().locator('.markdown')).toHaveText(MOCK_REPLY, { timeout: 15_000 });
  await expect(page.locator('.transcript .working')).toHaveCount(0);
});

test('a reply saved by an older client — partial text, no cursor — is completed without repeating itself', async ({ page, request, isMobile }) => {
  const headers = await operator(request);
  const run = await (await request.post(control + '/v1/runs', { headers, data: { agentId: 'scribe', prompt: 'Draft the launch note MOCK_SLOW' } })).json();
  await expect.poll(async () => (await (await request.get(control + `/v1/runs/${run.id}`, { headers })).json()).state).toBe('completed');
  // What an earlier version of the dashboard left in storage: the first words, no cursor,
  // and nothing saying the run was over. Written as the next document starts, once: the
  // page still open here may be finishing its own first sync, and its delayed save would
  // otherwise land on top of this and turn the scenario into an ordinary reload.
  await expect.poll(() => page.evaluate(() => localStorage.getItem('open-harness.workspace.v2'))).not.toBeNull();
  await page.addInitScript(([conversationId, runId, agentId]) => {
    const stored = localStorage.getItem('open-harness.workspace.v2');
    if (!stored || sessionStorage.getItem('legacy-reply-seeded')) return;
    sessionStorage.setItem('legacy-reply-seeded', '1');
    const saved = JSON.parse(stored);
    saved.conversations = [{ id: conversationId, agentId, title: 'Draft the launch note', updatedAt: new Date().toISOString(), messages: [
      { id: 'old-prompt', role: 'user', content: 'Draft the launch note MOCK_SLOW' },
      { id: 'old-reply', runId, role: 'assistant', content: 'Hermes mock', activities: [{ id: 'step', name: 'saved legacy step', detail: 'Running…', status: 'running' }] },
    ] }, ...(saved.conversations || []).filter((item: { id: string }) => item.id !== conversationId)];
    localStorage.setItem('open-harness.workspace.v2', JSON.stringify(saved));
  }, [run.conversation_id, run.id, 'scribe']);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Edit Atlas profile' })).toBeVisible();
  await openAgent(page, 'Scribe', isMobile, false);
  const reply = replies(page).last();
  await expect(reply.locator('.markdown')).toHaveText(MOCK_REPLY, { timeout: 15_000 });
  // The step that was still "running" when the page closed is settled with the run.
  await expect(reply.locator('.activity.running')).toHaveCount(0);
  await expect(reply.locator('.activity.done').filter({ hasText: 'saved legacy step' })).toHaveCount(1);
  // And a second visit does not fetch or append anything again.
  await page.reload();
  await expect(page.getByRole('button', { name: 'Edit Atlas profile' })).toBeVisible();
  await openAgent(page, 'Scribe', isMobile, false);
  await expect(replies(page).last().locator('.markdown')).toHaveText(MOCK_REPLY, { timeout: 15_000 });
});

test('history rebuilt from the coordinator says each reply once, however often the page is opened', async ({ page, request, isMobile }) => {
  const headers = await operator(request);
  const run = await (await request.post(control + '/v1/runs', { headers, data: { agentId: 'scout', prompt: 'Check the sources once' } })).json();
  await expect.poll(async () => (await (await request.get(control + `/v1/runs/${run.id}`, { headers })).json()).state).toBe('completed');
  for (let visit = 0; visit < 2; visit += 1) {
    await page.reload();
    await expect(page.getByRole('button', { name: 'Edit Atlas profile' })).toBeVisible();
    if (isMobile) await page.getByRole('button', { name: 'Open navigation' }).click();
    await page.getByRole('textbox', { name: 'Search conversations' }).fill('Check the sources once');
    await page.locator('aside.sidebar .recent', { hasText: 'Check the sources once' }).first().click();
    await expect(page.locator('.transcript .message.user')).toHaveCount(1);
    await expect(replies(page).last().locator('.markdown')).toHaveText(MOCK_REPLY, { timeout: 15_000 });
  }
});
