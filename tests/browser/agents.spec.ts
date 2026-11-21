import { openNavigation, closeNavigation } from './navigation';
import { test, expect, type APIRequestContext, type Page } from '@playwright/test';
import { initialWorkspace } from '../../lib/types';

const controlPort = process.env.OPEN_HARNESS_TEST_PORT || 4317;
const control = `http://127.0.0.1:${controlPort}`;
const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'Authorization, Content-Type', 'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS' };
async function auth(request: APIRequestContext) {
  const { token } = await (await request.get(control + '/v1/bootstrap')).json();
  return { Authorization: `Bearer ${token}` };
}
async function serverAgents(request: APIRequestContext) {
  const { agents } = await (await request.get(control + '/v1/agents', { headers: await auth(request) })).json();
  return agents as Array<{ id: string; name: string }>;
}
// null until the debounced save has written the workspace at least once.
const storedAgentIds = (page: Page) => page.evaluate(() => {
  const saved = localStorage.getItem('open-harness.workspace.v2');
  return saved ? (JSON.parse(saved).agents as Array<{ id: string }>).map(agent => agent.id) : null;
});
const storedWithout = async (page: Page, id: string) => { const ids = await storedAgentIds(page); return ids !== null && !ids.includes(id); };
const createResponse = (page: Page) => page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname.endsWith('/v1/agents'));
const unique = (prefix: string) => `${prefix} ${Date.now().toString(36).slice(-6)}`;
const card = (page: Page, name: string) => page.locator('.agent-card').filter({ hasText: name });
// Phones start with the workspace panel, where the delete action lives, closed.
async function deleteButton(page: Page) {
  const button = page.getByRole('button', { name: 'Delete agent' });
  if (!(await button.isVisible())) await page.getByRole('button', { name: 'Toggle workspace panel' }).click();
  return button;
}

let createdAgents: string[] = [];
test.beforeEach(async ({ request, page }) => {
  createdAgents = [];
  await request.post(control + '/v1/agents/sync', { headers: await auth(request), data: { agents: initialWorkspace.agents } });
  await page.addInitScript(() => localStorage.setItem('open-harness.onboarding.v1', 'done'));
});

test.afterEach(async ({ request }) => {
  for (const id of createdAgents) expect([200, 404]).toContain((await request.delete(`${control}/v1/agents/${id}`, { headers: await auth(request) })).status());
});

async function load(page: Page) {
  await page.goto(`/?controlPort=${controlPort}`);
  await expect(page.getByRole('button', { name: 'Edit Atlas profile' })).toBeVisible();
}

test('creating an agent uses the coordinator and survives a reload', async ({ page, request }) => {
  const name = unique('Scribe');
  await load(page);
  const created = createResponse(page);
  await page.getByRole('button', { name: 'Create agent' }).click();
  const response = await created;
  expect(response.status()).toBe(201);
  const id = (await response.json()).agent.id as string;
  createdAgents.push(id);
  const dialog = page.getByRole('dialog', { name: 'Agent settings' });
  await expect(dialog.getByLabel('Name', { exact: true })).toHaveValue('New agent');
  await dialog.getByLabel('Name', { exact: true }).fill(name);
  await dialog.getByRole('button', { name: 'Save changes' }).click();
  await expect(dialog.getByText('Saved. Ready for the next task.')).toBeVisible();
  await dialog.getByRole('button', { name: 'Close agent settings' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('button', { name: `Edit ${name} profile` })).toBeVisible();
  // Renaming keeps the id the coordinator minted.
  expect((await serverAgents(request)).find(agent => agent.id === id)?.name).toBe(name);

  await page.reload();
  await expect(page.getByRole('button', { name: `Edit ${name} profile` })).toBeVisible();
  expect((await serverAgents(request)).find(agent => agent.id === id)?.name).toBe(name);
  await expect.poll(() => storedAgentIds(page)).toContain(id);
});

test('a new agent starts with an empty conversation', async ({ page, request }) => {
  await page.addInitScript(({ workspace }) => {
    localStorage.setItem('open-harness.workspace.v2', JSON.stringify({
      ...workspace,
      conversations: [{ id: 'conversation-earlier', agentId: 'atlas', title: 'Earlier work', updatedAt: new Date().toISOString(), messages: [{ id: 'm-old', role: 'user' as const, content: 'Earlier work here' }] }],
    }));
  }, { workspace: initialWorkspace });
  await load(page);
  await card(page, 'Atlas').click();
  await expect(page.getByText('Earlier work here')).toBeVisible();
  await page.getByPlaceholder('Message Atlas…').fill('A half-written request');

  await openNavigation(page);
  const created = createResponse(page);
  await page.getByRole('button', { name: 'New agent', exact: true }).click();
  const id = (await (await created).json()).agent.id as string;
  createdAgents.push(id);
  const dialog = page.getByRole('dialog', { name: 'Agent settings' });
  await dialog.getByRole('button', { name: 'Close agent settings' }).click();
  await expect(dialog).toBeHidden();
  await closeNavigation(page);

  await expect(page.locator('.chat-toolbar strong')).toHaveText('New agent');
  await expect(page.getByText('Earlier work here')).toHaveCount(0);
  await expect(page.getByPlaceholder('Message New agent…')).toHaveValue('');
  await request.delete(`${control}/v1/agents/${id}`, { headers: await auth(request) });
});

test('a deleted agent stays gone after reload, even from a stale cache', async ({ page, request }) => {
  const name = unique('Courier');
  // Install seeded cache after pagehide has flushed the old page's React state.
  await page.addInitScript(() => {
    const pending = localStorage.getItem('fixture.next-workspace');
    if (pending) { localStorage.setItem('open-harness.workspace.v2', pending); localStorage.removeItem('fixture.next-workspace'); }
  });
  const created = await (await request.post(control + '/v1/agents', { headers: await auth(request), data: { name, role: 'Delivers' } })).json();
  const id = created.agent.id as string;
  createdAgents.push(id);
  await load(page);
  await expect.poll(() => storedAgentIds(page)).toContain(id);
  // Deleting an agent with cached history must not invalidate everyone else's workspace.
  await page.evaluate(agentId => {
    const saved = JSON.parse(localStorage.getItem('open-harness.workspace.v2')!);
    saved.conversations = [
      { id: 'deleted-history', agentId, title: 'Courier history', updatedAt: new Date().toISOString(), messages: [{ id: 'deleted-message', role: 'user', content: 'Courier private history' }] },
      { id: 'kept-history', agentId: 'atlas', title: 'Keep this history', updatedAt: new Date().toISOString(), messages: [{ id: 'kept-message', role: 'user', content: 'Unrelated history survives' }] },
    ];
    saved.files.push({ id: 'kept-file', agentId: 'atlas', name: 'kept.txt', content: 'Unrelated file survives', updatedAt: new Date().toISOString() });
    localStorage.setItem('fixture.next-workspace', JSON.stringify(saved));
  }, id);
  await page.reload();
  await card(page, name).click();
  page.once('dialog', dialog => void dialog.accept());
  await (await deleteButton(page)).click();
  await expect(page.getByText(`${name} was deleted.`)).toBeVisible();
  expect((await serverAgents(request)).map(agent => agent.id)).not.toContain(id);
  await expect.poll(() => storedWithout(page, id)).toBe(true);
  const expectPreservedCache = async () => {
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('open-harness.workspace.v2')!));
    expect(saved.conversations.some((item: { agentId: string }) => item.agentId === id)).toBe(false);
    expect(saved.conversations.find((item: { id: string }) => item.id === 'kept-history')?.messages[0].content).toBe('Unrelated history survives');
    expect(saved.files.find((item: { id: string }) => item.id === 'kept-file')?.content).toBe('Unrelated file survives');
  };
  await expectPreservedCache();
  await page.reload();
  await expect.poll(() => storedWithout(page, id)).toBe(true);
  await expectPreservedCache();

  // A tab that never saw the delete still has the agent cached; sync must not bring it back.
  await page.evaluate(([agentId, agentName]) => {
    const saved = JSON.parse(localStorage.getItem('open-harness.workspace.v2')!);
    saved.agents.push({ id: agentId, name: agentName, role: 'Delivers', description: '', instructions: '', memory: [], tone: 0 });
    saved.conversations.push({ id: 'stale-deleted-chat', agentId, title: 'Stale chat', messages: [], updatedAt: new Date().toISOString() });
    localStorage.setItem('fixture.next-workspace', JSON.stringify(saved));
  }, [id, name]);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Edit Atlas profile' })).toBeVisible();
  await expect(card(page, name)).toHaveCount(0);
  await expect.poll(() => storedWithout(page, id)).toBe(true);
  expect((await serverAgents(request)).map(agent => agent.id)).not.toContain(id);
  await expectPreservedCache();
});

test('a missing team member in cached or refreshed data preserves the conversation and its draft', async ({ page }) => {
  const stamp = '2026-11-20T12:00:00Z';
  const team = { id: 'notes-team', name: 'Notes team', description: '', color: 'sage', icon: 'writing', revision: 1,
    memberAgentIds: ['atlas', 'former-agent'], retiredAt: null, createdAt: stamp, updatedAt: stamp };
  const conversation = { id: 'cached-notes', agentId: 'atlas', title: 'Saved meeting notes', updatedAt: stamp,
    messages: [{ id: 'cached-reply', role: 'assistant', content: 'The meeting summary is saved.' }] };
  const backup = JSON.stringify({ ...initialWorkspace, teams: [team], conversations: [conversation] });
  await page.addInitScript(saved => {
    localStorage.setItem('open-harness.migrated.v1', 'done');
    if (!localStorage.getItem('open-harness.workspace.v2')) localStorage.setItem('open-harness.workspace.v2', saved);
  }, backup);
  await page.route(`${control}/v1/conversations`, route => route.fulfill({ json: { conversations: [] } }));
  await page.route(`${control}/v1/runs`, route => route.fulfill({ json: { runs: [] } }));
  await page.route(`${control}/v1/teams/sync`, route => route.fulfill({ json: { ok: true } }));
  const refreshed = { ...team, revision: 2, memberAgentIds: ['scout', 'agent-added-after-roster'] };
  let releaseSnapshot!: () => void;
  const snapshot = new Promise<void>(resolve => { releaseSnapshot = resolve; });
  await page.route(`${control}/v1/teams?includeRetired=1`, async route => {
    await snapshot;
    await route.fulfill({ json: { teams: [refreshed] } });
  });

  const storedTeams = () => page.evaluate(() => JSON.parse(localStorage.getItem('open-harness.workspace.v2')!).teams);
  const recent = page.locator('aside.sidebar').getByRole('button', { name: conversation.title, exact: true });
  const composer = page.getByRole('textbox', { name: 'Message Atlas' });
  try {
    await page.goto(`/?controlPort=${controlPort}`);
    await openNavigation(page);
    await expect(recent).toBeVisible();
    await recent.click();
    await expect(page.locator('.transcript')).toContainText(conversation.messages[0].content);
    await composer.fill('Add the action items before sending.');
    await expect.poll(storedTeams).toEqual([{ ...team, memberAgentIds: ['atlas'] }]);
  } finally { releaseSnapshot(); }
  await expect.poll(storedTeams).toEqual([{ ...refreshed, memberAgentIds: ['scout'] }]);
  await page.reload();
  await openNavigation(page);
  await expect(recent).toBeVisible();
  await recent.click();
  await expect(page.locator('.transcript')).toContainText(conversation.messages[0].content);
  await expect(composer).toHaveValue('Add the action items before sending.');

  await page.locator('input[type=file][accept=".json"]').setInputFiles({ name: 'stale-team.json', mimeType: 'application/json', buffer: Buffer.from(backup) });
  await expect(page.getByRole('status').filter({ hasText: 'not a valid Open Harness backup' })).toBeVisible();
});

test('a refused delete shows the reason and keeps the agent', async ({ page }) => {
  let deletes = 0;
  await page.route(url => url.port === String(controlPort) && url.pathname === '/v1/agents/atlas', route => {
    const method = route.request().method();
    if (method === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    if (method !== 'DELETE') return route.continue();
    deletes++;
    return route.fulfill({ status: 409, headers: cors, json: { error: 'Stop this agent’s active runs before deleting it.' } });
  });
  await load(page);
  await card(page, 'Atlas').click();
  page.once('dialog', dialog => void dialog.accept());
  await (await deleteButton(page)).click();
  await expect(page.getByRole('status').filter({ hasText: 'Stop this agent’s active runs before deleting it.' })).toBeVisible();
  expect(deletes).toBe(1);
  await expect(page.locator('.chat-toolbar strong')).toHaveText('Atlas');
  await page.reload();
  await expect(page.getByRole('button', { name: 'Edit Atlas profile' })).toBeVisible();
});
