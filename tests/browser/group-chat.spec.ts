import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { initialWorkspace } from '../../lib/types';

const controlPort = process.env.OPEN_HARNESS_TEST_PORT || 4317;
const control = `http://127.0.0.1:${controlPort}`;
async function seed(request: APIRequestContext) {
  const { token } = await (await request.get(control + '/v1/bootstrap')).json();
  await request.post(control + '/v1/agents/sync', { headers: { Authorization: `Bearer ${token}` }, data: { agents: initialWorkspace.agents } });
}

// The page talks to the coordinator cross-origin, so mocked replies need the CORS headers it would send.
const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS' };
const stamp = '2026-11-01T09:00:00.000Z';
const names: Record<string, string> = { atlas: 'Atlas', scout: 'Scout', scribe: 'Scribe' };
type Row = Record<string, unknown> & { id: string; title: string; members: Record<string, unknown>[]; messages: Record<string, unknown>[] };
const member = (conversationId: string, id: string) => ({ conversation_id: conversationId, participant_kind: 'agent', participant_id: id, role: 'member', session_id: null, joined_at: stamp, removed_at: null });
const owner = (conversationId: string) => ({ ...member(conversationId, 'user'), participant_kind: 'user', role: 'owner' });
const chat = (id: string, title: string, agents: string[]): Row => ({ id, title, kind: 'group', turn_policy: 'manual', auto_turns_enabled: 1, source: 'native', created_at: stamp, updated_at: stamp, members: [owner(id), ...agents.map(agent => member(id, agent))], messages: [] });

async function mockConversations(page: Page, options: { chats?: Row[]; failList?: number; noHalt?: boolean; holdSend?: Promise<void>; interject?: { agentId: string; body: string }; noScheduledRuns?: boolean } = {}) {
  const chats = options.chats || [], calls: string[] = [], bodies: Record<string, unknown>[] = [];
  let failures = options.failList || 0, seq = 0;
  const message = (conversationId: string, fields: Record<string, unknown>) => ({ seq: ++seq, id: `m-${seq}`, conversation_id: conversationId, idempotency_key: null, mentions_json: '[]', in_reply_to: null, origin_run_id: null, round_id: null, source: 'native', created_at: stamp, ...fields });
  const replies: { conversationId: string; agentId: string; body: string }[] = [];
  await page.route(url => url.port === String(controlPort) && url.pathname.startsWith('/v1/conversations'), async route => {
    const request = route.request(), method = request.method(), url = new URL(request.url()), { pathname } = url;
    if (method === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    calls.push(`${method} ${pathname}${url.search}`);
    if (pathname === '/v1/conversations' && method === 'GET') {
      if (failures-- > 0) return route.fulfill({ status: 500, headers: cors, json: { error: 'Group chats are unavailable right now.' } });
      return route.fulfill({ headers: cors, json: { conversations: chats.map(item => ({ ...item, members: undefined, messages: undefined })) } });
    }
    if (pathname === '/v1/conversations' && method === 'POST') {
      const input = request.postDataJSON(); bodies.push(input);
      const created = chat(`c-${chats.length + 1}`, input.title, input.members.map((item: { id: string }) => item.id)); chats.unshift(created);
      return route.fulfill({ status: 201, headers: cors, json: created });
    }
    const [, id, resource, sub] = pathname.match(/^\/v1\/conversations\/([^/]+)(?:\/(members|messages|halt|resume)(?:\/([^/]+))?)?$/) || [];
    const row = chats.find(item => item.id === id);
    if (!row) return route.fulfill({ status: 404, headers: cors, json: { error: 'Conversation not found.' } });
    if (!resource && method === 'GET') return route.fulfill({ headers: cors, json: row });
    if (resource === 'messages' && method === 'POST') {
      const input = request.postDataJSON(); bodies.push(input);
      await options.holdSend;
      // An agent speaks between the last poll and this send, so the send response's seq jumps past it.
      if (options.interject) row.messages.push(message(row.id, { sender_kind: 'agent', sender_id: options.interject.agentId, sender_name: names[options.interject.agentId], body: options.interject.body }));
      const sent = message(row.id, { sender_kind: 'user', sender_id: 'user', sender_name: 'User', body: input.body, idempotency_key: input.idempotencyKey, mentions_json: JSON.stringify(input.mentions || []) });
      row.messages.push(sent);
      for (const agentId of input.mentions || []) replies.push({ conversationId: row.id, agentId, body: `${names[agentId]} here — on it.` });
      if (options.noScheduledRuns) return route.fulfill({ status: 201, headers: cors, json: sent });
      return route.fulfill({ status: 201, headers: cors, json: { ...sent, scheduledRuns: (input.mentions || []).map((agentId: string) => ({ agentId, runId: `run-${agentId}` })) } });
    }
    if (resource === 'messages' && method === 'GET') {
      // Agents reply between polls, exactly as the coordinator would after a scheduled turn finishes.
      for (const reply of replies.splice(0)) row.messages.push(message(reply.conversationId, { sender_kind: 'agent', sender_id: reply.agentId, sender_name: names[reply.agentId], body: reply.body }));
      const after = Number(url.searchParams.get('after') || 0);
      return route.fulfill({ headers: cors, json: { messages: row.messages.filter(item => Number(item.seq) > after) } });
    }
    if (resource === 'members' && !sub && method === 'POST') { const input = request.postDataJSON(); bodies.push(input); const added = member(row.id, input.id); row.members.push(added); return route.fulfill({ status: 201, headers: cors, json: added }); }
    if (resource === 'members' && sub && method === 'DELETE') { row.members = row.members.filter(item => item.participant_id !== sub); return route.fulfill({ headers: cors, json: { ...member(row.id, sub), removed_at: stamp } }); }
    if ((resource === 'halt' || resource === 'resume') && method === 'POST') {
      if (options.noHalt) return route.fulfill({ status: 404, headers: cors, json: { error: 'Not found.' } });
      row.auto_turns_enabled = resource === 'halt' ? 0 : 1;
      return route.fulfill({ headers: cors, json: resource === 'halt' ? { halted: true, stopped: 1 } : { resumed: true } });
    }
    return route.fulfill({ status: 405, headers: cors, json: { error: 'Unexpected conversation call.' } });
  });
  return { calls, bodies, chats };
}

async function openGroupChats(page: Page, project: string) {
  if (project === 'mobile') await page.getByRole('button', { name: 'Open navigation' }).click();
  await page.getByRole('button', { name: /Group chats/ }).first().click();
  await expect(page.getByRole('heading', { name: 'Group chats', level: 1 })).toBeVisible();
}
const row = (page: Page, name: string) => page.locator('.file-table-row').filter({ hasText: name });

test.beforeEach(async ({ request, page }) => {
  await seed(request);
  await page.addInitScript(() => localStorage.setItem('open-harness.onboarding.v1', 'done'));
});

async function load(page: Page) {
  await page.goto(`/?controlPort=${controlPort}`);
  await expect(page.getByRole('button', { name: 'Edit Atlas profile' })).toBeVisible();
}

test('shows an empty state and creates a group with two agents', async ({ page }, testInfo) => {
  const mock = await mockConversations(page);
  await load(page);
  await openGroupChats(page, testInfo.project.name);
  await expect(page.getByRole('heading', { name: 'No group chats yet.' })).toBeVisible();
  await page.getByRole('button', { name: 'New group chat' }).click();
  const dialog = page.getByRole('dialog', { name: 'New group chat' });
  const create = dialog.getByRole('button', { name: 'Create group chat' });
  await dialog.getByLabel('Title').fill('Launch planning');
  await expect(create).toBeDisabled();
  await dialog.getByRole('checkbox', { name: /Atlas/ }).check();
  await dialog.getByRole('checkbox', { name: /Scout/ }).check();
  await create.click();
  await expect(dialog).toBeHidden();
  await expect(row(page, 'Launch planning')).toBeVisible();
  expect(mock.bodies[0]).toMatchObject({ kind: 'group', title: 'Launch planning', turnPolicy: 'manual', members: [{ kind: 'agent', id: 'atlas' }, { kind: 'agent', id: 'scout' }] });
});

test('sends an @mention once and shows the agent reply from polling', async ({ page }, testInfo) => {
  const mock = await mockConversations(page, { chats: [chat('c-1', 'Launch planning', ['atlas', 'scout'])] });
  await load(page);
  await openGroupChats(page, testInfo.project.name);
  await page.getByRole('button', { name: 'Open Launch planning' }).click();
  await expect(page.getByRole('heading', { name: 'No messages yet.' })).toBeVisible();
  const composer = page.getByRole('textbox', { name: 'Message the group' });
  await composer.fill('@Sc');
  await page.getByRole('listbox', { name: 'Mention an agent' }).getByRole('option', { name: '@Scout' }).click();
  await expect(composer).toHaveValue('@Scout ');
  await composer.pressSequentially('can you check the launch notes?');
  await page.getByRole('button', { name: 'Send message' }).dblclick();
  await expect(page.locator('article[data-sender-kind="user"]')).toContainText('@Scout can you check the launch notes?');
  const reply = page.locator('article[data-sender-kind="agent"]');
  await expect(reply).toContainText('Scout');
  await expect(reply).toContainText('Scout here — on it.');
  const posts = mock.calls.filter(call => call === 'POST /v1/conversations/c-1/messages');
  expect(posts).toHaveLength(1);
  expect(mock.bodies[0]).toMatchObject({ body: '@Scout can you check the launch notes?', mentions: ['scout'] });
  expect(typeof (mock.bodies[0] as { idempotencyKey?: unknown }).idempotencyKey).toBe('string');
  await expect.poll(() => mock.calls.some(call => call.startsWith('GET /v1/conversations/c-1/messages?after=2'))).toBe(true);
});

test('a send response never moves polling past agent messages it has not fetched', async ({ page }, testInfo) => {
  const mock = await mockConversations(page, { chats: [chat('c-1', 'Launch planning', ['atlas', 'scout'])], interject: { agentId: 'scout', body: 'I already drafted the notes.' }, noScheduledRuns: true });
  await load(page);
  await openGroupChats(page, testInfo.project.name);
  await page.getByRole('button', { name: 'Open Launch planning' }).click();
  const composer = page.getByRole('textbox', { name: 'Message the group' });
  await composer.fill('@Atlas thanks, can you review them?');
  await composer.press('Enter');
  await expect(page.locator('article[data-sender-kind]')).toHaveText([/I already drafted the notes\./, /@Atlas thanks, can you review them\?/, /Atlas here — on it\./]);
  expect(mock.bodies[0]).toMatchObject({ mentions: ['atlas'] });
  expect(mock.calls).not.toContainEqual(expect.stringMatching(/messages\?after=2/));
  await expect(page.getByText('will reply shortly')).toHaveCount(0);
});

test('the composer cannot be edited while a send is pending, so no typed text is lost', async ({ page }, testInfo) => {
  let release = () => {};
  const holdSend = new Promise<void>(resolve => { release = resolve; });
  const mock = await mockConversations(page, { chats: [chat('c-1', 'Launch planning', ['atlas'])], holdSend });
  await load(page);
  await openGroupChats(page, testInfo.project.name);
  await page.getByRole('button', { name: 'Open Launch planning' }).click();
  const composer = page.getByRole('textbox', { name: 'Message the group' });
  await composer.fill('First thought');
  await composer.press('Enter');
  await expect(composer).not.toBeEditable();
  await composer.press('x');
  await expect(composer).toHaveValue('First thought');
  release();
  await expect(page.locator('article[data-sender-kind="user"]')).toContainText('First thought');
  await expect(composer).toHaveValue('');
  await expect(composer).toBeEditable();
  await composer.fill('Second thought');
  await expect(composer).toHaveValue('Second thought');
  expect(mock.calls.filter(call => call === 'POST /v1/conversations/c-1/messages')).toHaveLength(1);
});

test('dialogs close on Escape, keep focus inside, and return it to their opener', async ({ page }, testInfo) => {
  await mockConversations(page, { chats: [chat('c-1', 'Launch planning', ['atlas', 'scout'])] });
  await load(page);
  await openGroupChats(page, testInfo.project.name);
  const newChat = page.getByRole('button', { name: 'New group chat' });
  await newChat.click();
  const create = page.getByRole('dialog', { name: 'New group chat' });
  await expect(create.getByLabel('Title')).toBeFocused();
  await create.getByRole('button', { name: 'Close new group chat' }).focus();
  await page.keyboard.press('Shift+Tab');
  await expect(create.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(create.getByRole('button', { name: 'Close new group chat' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(create).toBeHidden();
  await expect(newChat).toBeFocused();

  await page.getByRole('button', { name: 'Open Launch planning' }).click();
  const membersButton = page.getByRole('button', { name: 'Members', exact: true });
  await membersButton.click();
  const members = page.getByRole('dialog', { name: 'Members', exact: true });
  await expect(members.getByRole('button', { name: 'Close members' })).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(members.getByRole('button', { name: 'Add member' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(members).toBeHidden();
  await expect(membersButton).toBeFocused();
});

test('adds and removes members', async ({ page }, testInfo) => {
  const mock = await mockConversations(page, { chats: [chat('c-1', 'Launch planning', ['atlas', 'scout'])] });
  await load(page);
  await openGroupChats(page, testInfo.project.name);
  await page.getByRole('button', { name: 'Open Launch planning' }).click();
  await page.getByRole('button', { name: 'Members', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Members', exact: true });
  await dialog.getByLabel('Agent to add').selectOption('scribe');
  await dialog.getByRole('button', { name: 'Add member' }).click();
  await expect(page.getByText('Scribe joined the chat.')).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Remove Scribe' })).toBeVisible();
  expect(mock.bodies[0]).toMatchObject({ kind: 'agent', id: 'scribe' });
  await dialog.getByRole('button', { name: 'Remove Scout' }).click();
  await expect(page.getByText('Scout left the chat.')).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Remove Scout' })).toHaveCount(0);
  expect(mock.calls).toContain('DELETE /v1/conversations/c-1/members/scout');
});

test('Stop halts the chat and Resume restarts it', async ({ page }, testInfo) => {
  const mock = await mockConversations(page, { chats: [chat('c-1', 'Launch planning', ['atlas'])] });
  await load(page);
  await openGroupChats(page, testInfo.project.name);
  await page.getByRole('button', { name: 'Open Launch planning' }).click();
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Resume', exact: true })).toBeVisible();
  expect(mock.calls).toContain('POST /v1/conversations/c-1/halt');
  await page.getByRole('button', { name: 'Resume', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeVisible();
  expect(mock.calls).toContain('POST /v1/conversations/c-1/resume');
});

test('hides Stop when the coordinator has no halt route', async ({ page }, testInfo) => {
  await mockConversations(page, { chats: [chat('c-1', 'Launch planning', ['atlas'])], noHalt: true });
  await load(page);
  await openGroupChats(page, testInfo.project.name);
  await page.getByRole('button', { name: 'Open Launch planning' }).click();
  await page.getByRole('button', { name: 'Stop', exact: true }).click();
  await expect(page.getByText('cannot pause group chats yet')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Stop', exact: true })).toHaveCount(0);
});

test('a list that fails to load can be retried', async ({ page }, testInfo) => {
  await mockConversations(page, { failList: 1 });
  await load(page);
  await openGroupChats(page, testInfo.project.name);
  await expect(page.getByRole('alert').filter({ hasText: 'Group chats are unavailable right now.' })).toBeVisible();
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(page.getByRole('heading', { name: 'No group chats yet.' })).toBeVisible();
});
