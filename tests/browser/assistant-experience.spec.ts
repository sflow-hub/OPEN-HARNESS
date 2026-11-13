import { test, expect, type Page, type Route } from '@playwright/test';
import { initialWorkspace } from '../../lib/types';
import { PRIMARY_ASSISTANT_ID, type ActionIntent, type Connection } from '../../lib/product';
import type { AssistantOutcome } from '../../lib/assistant-overview';
import { assistantStarters } from '../../lib/assistant-starters';

// Coordinator responses below are fixtures; they exercise the interface, not live accounts or models.
const port = process.env.OPEN_HARNESS_TEST_PORT || 4317, control = `http://127.0.0.1:${port}`;
const stamp = new Date().toISOString();
const cors = (route: Route) => ({ 'Access-Control-Allow-Origin': route.request().headers().origin || '*', 'Access-Control-Allow-Credentials': 'true' });
const reply = (route: Route, json: unknown, status = 200) => route.fulfill({ status, headers: cors(route), json });
const gmail: Connection = { id: 'conn-gmail', app: 'gmail', account: 'me@example.test', ownerId: 'local-owner', sharedAgentIds: [PRIMARY_ASSISTANT_ID], scopes: [], state: 'connected', lastError: null, updatedAt: stamp };
const calendar: Connection = { ...gmail, id: 'conn-calendar', app: 'calendar', account: 'calendar@example.test', sharedAgentIds: [] };
const draftAction: ActionIntent = { id: 'act-1', runId: 'run-done', connectionId: gmail.id, operation: 'gmail.create_draft', resource: 'gmail:drafts', summary: 'Draft a follow-up to Dana', state: 'awaiting_approval', request: { to: 'dana@example.test', subject: 'Thursday follow-up', body: 'Hi Dana,\nThe revised proposal is attached.', draftHash: 'internal-hash' }, result: null, createdAt: stamp, updatedAt: stamp };
const outcome = (patch: Partial<AssistantOutcome>): AssistantOutcome => ({ runId: 'run-done', title: 'Weekly research summary', summary: 'Three vendors compared.', state: 'completed', agentId: PRIMARY_ASSISTANT_ID, parentRunId: null, sourceRunId: null, artifacts: [], sources: [], verification: { state: 'unreviewed', evidence: '', checkedAt: null }, actions: [], delegation: [], createdAt: stamp, updatedAt: stamp, ...patch });
const run = (id: string, prompt: string, updated = stamp) => ({ id, agent_id: PRIMARY_ASSISTANT_ID, conversation_id: 'assistant-local', prompt, state: 'completed', result: 'Done.', created_at: updated, updated_at: updated, pendingApprovals: [], pendingInputs: [] });

type Fixture = { actions?: ActionIntent[]; connections?: Connection[]; outcomes?: AssistantOutcome[]; runs?: ReturnType<typeof run>[]; brief?: string | null; responsibilities?: unknown[]; role?: 'owner' | 'operator' | 'viewer' };
async function open(page: Page, request: import('@playwright/test').APIRequestContext, fixture: Fixture) {
  const { token } = await (await request.get(control + '/v1/bootstrap')).json(), headers = { Authorization: `Bearer ${token}` };
  await request.post(control + '/v1/agents/sync', { headers, data: { agents: initialWorkspace.agents } }); await request.post(control + '/v1/assistant/activate', { headers, data: {} });
  await page.route(/\/v1\/assistant$/, async route => {
    if (route.request().method() !== 'GET') return route.fallback();
    // The inbox polls; a poll still in flight when a test ends must not fail it.
    try { const response = await route.fetch(), real = await response.json();
    await route.fulfill({ response, json: { ...real, actions: fixture.actions ?? [], connections: fixture.connections ?? [], runs: fixture.runs ?? [], pending: [], ...(fixture.responsibilities ? { responsibilities: fixture.responsibilities } : {}), ...(fixture.role ? { workspace: { ...real.workspace, actor: { ...real.workspace.actor, role: fixture.role } } } : {}), overview: { generatedAt: stamp, outcomes: fixture.outcomes ?? [], latestBriefRunId: fixture.brief ?? null, availability: { detail: '' } } } }); } catch {}
  });
  await page.route(/\/v1\/assistant\/starters$/, async route => route.request().method() === 'GET' ? reply(route, { starters: assistantStarters, agents: [{ id: 'scout', name: 'Scout' }, { id: 'scribe', name: 'Scribe' }] }) : route.fallback());
  await page.addInitScript(() => { localStorage.setItem('open-harness.onboarding.v1', 'done'); localStorage.setItem('open-harness.assistant-home', '1'); });
  await page.goto(`/?controlPort=${port}`);
  const panel = page.getByRole('region', { name: 'Assistant workspace' });
  await expect(panel.getByRole('heading', { name: 'What would you like done?' })).toBeVisible();
  return { panel, headers };
}
const shot = async (page: Page, name: string) => { if (process.env.OPEN_HARNESS_VISUAL_QA_DIR) await page.screenshot({ path: `${process.env.OPEN_HARNESS_VISUAL_QA_DIR}/${name}-${test.info().project.name}.png`, fullPage: true }); };
const noOverflow = async (page: Page) => expect(page.locator('html')).toHaveJSProperty('scrollWidth', await page.evaluate(() => document.documentElement.clientWidth));

test('a prepared action shows its exact content, and an edit must be approved again', async ({ page, request }) => {
  const revised: ActionIntent = { ...draftAction, id: 'act-2', request: { ...draftAction.request, subject: 'Thursday follow-up (revised)' } };
  const calls: string[] = []; let reviseBody: Record<string, unknown> = {}, approval: Record<string, unknown> = {};
  const { panel } = await open(page, request, { actions: [draftAction], connections: [gmail] });
  await page.route(/\/v1\/actions\/act-\d(\/[a-z]+)?$/, async route => {
    const url = new URL(route.request().url()), path = url.pathname; calls.push(`${route.request().method()} ${path}`);
    if (path.endsWith('/act-1')) return reply(route, { ...draftAction, confirmation: 'confirm-1' });
    if (path.endsWith('/act-1/revise')) { reviseBody = route.request().postDataJSON(); return reply(route, { ...revised, confirmation: 'confirm-2' }, 201); }
    if (path.endsWith('/act-2/decision')) { approval = route.request().postDataJSON(); return reply(route, { ...revised, state: 'approved' }); }
    if (path.endsWith('/act-2/execute')) return reply(route, { ...revised, state: 'completed' });
    return reply(route, { error: 'Unexpected fixture request.' }, 500);
  });
  const needs = panel.getByRole('region', { name: 'Needs you' });
  await expect(needs.getByRole('article', { name: 'Create an email draft' })).toContainText('me@example.test');
  await needs.getByRole('button', { name: 'Review and decide' }).click();
  const dialog = page.getByRole('dialog', { name: 'Review connected action' });
  await expect(dialog.getByText('dana@example.test', { exact: true })).toBeVisible();
  await expect(dialog.getByText('Thursday follow-up', { exact: true })).toBeVisible();
  await expect(dialog.getByLabel('Exact content')).toHaveText('Hi Dana,\nThe revised proposal is attached.');
  await expect(dialog).toContainText('It will not be sent.');
  await expect(dialog.getByText('internal-hash')).toBeHidden();
  await shot(page, 'assistant-action-review');
  await dialog.getByRole('button', { name: 'Edit before approving' }).click();
  await expect(dialog.getByLabel('Draft Hash')).toHaveCount(0);
  await dialog.getByLabel('Subject').fill('Thursday follow-up (revised)');
  await dialog.getByRole('button', { name: 'Prepare edited action for review' }).click();
  await expect(dialog.getByText('Thursday follow-up (revised)', { exact: true })).toBeVisible();
  expect(reviseBody).toMatchObject({ confirmation: 'confirm-1', input: { subject: 'Thursday follow-up (revised)', to: 'dana@example.test' } });
  expect((reviseBody.input as Record<string, unknown>).draftHash).toBeUndefined();
  expect(calls.some(call => call.includes('/decision'))).toBe(false);
  await noOverflow(page);
  await dialog.getByRole('button', { name: 'Approve and execute this action' }).click();
  await expect(dialog).toBeHidden();
  expect(approval).toEqual({ approved: true, confirmation: 'confirm-2' });
  expect(calls).not.toContain('POST /v1/actions/act-1/decision');
});

test('finished work separates completion from acceptance, opens safe deliverables, and keeps corrections reviewable', async ({ page, request }) => {
  const accepted = outcome({ runId: 'run-accepted', title: 'Vendor comparison', verification: { state: 'accepted', evidence: 'Checked the sheet totals.', checkedAt: stamp }, artifacts: [{ label: 'Comparison notes', kind: 'file', path: 'vendors.md' }, { label: 'Unsafe link', kind: 'link', url: 'javascript:alert(1)' }], sources: [{ label: 'Vendor pricing page', url: 'https://example.test/pricing' }], delegation: [{ runId: 'child-1', agentId: 'scout', parentRunId: 'run-accepted', fromAgentId: PRIMARY_ASSISTANT_ID, state: 'completed', summary: 'Found three vendors with public pricing.' }, { runId: 'grand-1', agentId: 'scribe', parentRunId: 'child-1', fromAgentId: 'scout', state: 'completed', summary: 'Wrote the comparison table.' }] });
  const historical = outcome({ runId: 'run-old', title: 'Old quarterly report' });
  const unreviewed = outcome({ runId: 'run-done', title: 'Weekly research summary' });
  let feedback: Record<string, unknown> = {}; const order: string[] = [];
  const { panel } = await open(page, request, { outcomes: [accepted, unreviewed, outcome({ runId: 'child-1', parentRunId: 'run-accepted', agentId: 'scout', title: 'Child research' }), historical], runs: [run('run-accepted', 'Vendor comparison'), run('run-done', 'Weekly research summary')] });
  await page.route(/\/v1\/files\?/, route => reply(route, { name: 'vendors.md', content: '# Vendors\nA, B, C', encoding: 'utf8', mimeType: 'text/markdown', scope: 'shared' }));
  await page.route(/\/v1\/runs\/run-done\/feedback$/, route => { order.push('feedback'); feedback = route.request().postDataJSON(); return reply(route, { feedbackId: 'f1', repairRunId: null, duplicate: false }, 202); });
  await page.route(/\/v1\/workflow-drafts$/, route => { order.push('draft'); return reply(route, { id: 'draft-1', agentId: PRIMARY_ASSISTANT_ID, sourceRunId: route.request().postDataJSON().sourceRunId, title: 'Weekly research summary', instructions: 'Steps.\n\nCorrection: skip newsletters.', successCriteria: 'Sources linked.', state: 'draft', revision: 1, workflowId: null, createdAt: stamp, updatedAt: stamp }, 201); });
  const finished = panel.getByRole('region', { name: 'Finished work' });
  const card = finished.getByRole('article', { name: 'Result: Vendor comparison' });
  await expect(card).toContainText('Accepted');
  await expect(card).toContainText('Checked the sheet totals.');
  await expect(finished.getByRole('article', { name: 'Result: Weekly research summary' })).toContainText('Not reviewed yet');
  await expect(finished.getByRole('article', { name: 'Result: Child research' })).toHaveCount(0);
  await expect(card.getByText(/ → Scout$/)).toBeVisible();
  // A nested handoff names the teammate that actually delegated it, not the top-level agent.
  await expect(card.getByText('Scout → Scribe', { exact: true })).toBeVisible();
  await page.route(/\/v1\/runs\/run-old$/, route => reply(route, { error: 'Task not found.' }, 404));
  await finished.getByRole('article', { name: 'Result: Old quarterly report' }).getByRole('button', { name: 'Open task' }).click();
  await expect(panel.getByRole('alert').filter({ hasText: 'Task not found.' })).toBeVisible();
  await expect(card).toContainText('Found three vendors with public pricing.');
  await shot(page, 'assistant-finished');
  await expect(card.getByRole('link', { name: 'Vendor pricing page' })).toHaveAttribute('href', 'https://example.test/pricing');
  await expect(card.getByRole('link', { name: 'Unsafe link' })).toHaveCount(0);
  await card.getByRole('button', { name: /Comparison notes/ }).click();
  await expect(page.getByRole('dialog', { name: 'Shared file vendors.md' })).toContainText('A, B, C');
  await page.getByRole('dialog', { name: 'Shared file vendors.md' }).getByRole('button', { name: 'Close' }).click();
  await noOverflow(page);
  const pending = finished.getByRole('article', { name: 'Result: Weekly research summary' });
  await pending.getByRole('button', { name: 'Remember this correction' }).click();
  await pending.getByLabel('What should be different next time?').fill('Skip newsletters.');
  await pending.getByRole('button', { name: 'Save correction to a workflow draft' }).click();
  const draft = page.getByRole('dialog', { name: 'Workflow draft' });
  await expect(draft.getByRole('textbox', { name: 'Procedure', exact: true })).toHaveValue(/skip newsletters/);
  expect(feedback).toMatchObject({ evidence: 'Skip newsletters.', repair: false });
  expect(typeof feedback.requestId).toBe('string');
  expect(order).toEqual(['feedback', 'draft']);
  await draft.getByRole('button', { name: 'Close' }).click();
  await card.getByRole('button', { name: 'Do this again' }).click();
  await expect(page.getByRole('dialog', { name: 'Workflow draft' })).toBeVisible();
});

test('Today shows a clear empty state, then the actual latest brief with its time', async ({ page, request }) => {
  const { panel } = await open(page, request, { responsibilities: [{ id: 'r1', agentId: PRIMARY_ASSISTANT_ID, title: 'Watch invoices', goal: 'Check unpaid invoices', state: 'active', revision: 1, nextCheckAt: null, intervalMinutes: 60, maxRuns: 10, runs: 2, activeRunId: null, lastError: null, lastCheckedAt: stamp, lastResult: 'Two invoices are overdue.', createdAt: stamp, updatedAt: stamp }] });
  await panel.getByRole('button', { name: 'Today', exact: true }).click();
  const today = panel.getByRole('region', { name: 'Today' });
  await expect(today).toContainText('No day brief yet');
  await expect(today).toContainText('Nothing is waiting for you.');
  await expect(today).toContainText('Two invoices are overdue.');
  await expect(today).toContainText('Last checked');
  await noOverflow(page);
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  // The brief's own timestamps are used even when its run is outside the 50 most recent runs.
  const brief = outcome({ runId: 'run-brief', title: 'Your day: Tuesday', summary: '9:00 standup; 14:00 conflicts with dentist.', createdAt: '2026-11-01T14:00:00.000Z', updatedAt: '2026-11-01T14:05:00.000Z' });
  await open(page, request, { outcomes: [brief], runs: [], brief: 'run-brief' });
  await panel.getByRole('button', { name: 'Today', exact: true }).click();
  await expect(today.getByRole('article', { name: 'Result: Your day: Tuesday' })).toContainText('14:00 conflicts with dentist.');
  await expect(today).toContainText(new Date('2026-11-01T14:05:00.000Z').toLocaleString());
  await expect(today).toContainText('this brief is not from today');
  await expect(today.getByRole('button', { name: 'Make this a reviewed routine' })).toBeVisible();
});

test('a guided starter reviews its goal, guides missing access, and keeps a failed start', async ({ page, request }) => {
  const bodies: Array<Record<string, unknown>> = []; let starts = 0;
  const { panel } = await open(page, request, { connections: [gmail, calendar] });
  await page.route(/\/v1\/assistant\/starters\/preview$/, route => { bodies.push(route.request().postDataJSON()); return reply(route, { prompt: 'Guided starter: prepare-day — Prepare my day\n\nRead the selected accounts.' }); });
  await page.route(/\/v1\/assistant\/starters$/, route => { if (route.request().method() !== 'POST') return route.fallback(); starts++; bodies.push(route.request().postDataJSON()); return reply(route, { error: 'This workspace computer needs setup.' }, 409); });
  const starters = panel.getByRole('region', { name: 'Guided starters' });
  await expect(starters.getByRole('heading', { name: 'Turn saved material into a brief' })).toBeVisible();
  await expect(starters.getByRole('heading', { name: 'Research and draft with my team' })).toBeVisible();
  await starters.getByRole('button', { name: 'Set up prepare my day' }).click();
  const form = starters.getByRole('form', { name: 'Prepare my day' });
  await expect(form.getByLabel(/calendar@example.test/)).toBeDisabled();
  await expect(form).toContainText('share with your assistant in Connections');
  await form.getByLabel(/me@example.test/).check();
  await form.getByLabel('Day or time window').fill('Tomorrow');
  await form.getByLabel('Email to include').fill('in:inbox newer_than:2d');
  await expect(form.getByRole('button', { name: 'Review the goal' })).toBeDisabled();
  await expect(form).toContainText('Select Google Calendar to continue.');
  await noOverflow(page);
  await form.getByRole('button', { name: 'Open Connections' }).first().click();
  await expect(panel.getByRole('button', { name: 'Connections', exact: true })).toHaveAttribute('aria-current', 'page');
  // Sharing the calendar happens in Connections; reflect that in the fixture and reload.
  calendar.sharedAgentIds = [PRIMARY_ASSISTANT_ID];
  await page.reload();
  await panel.getByRole('region', { name: 'Guided starters' }).getByRole('button', { name: 'Set up prepare my day' }).click();
  const again = panel.getByRole('form', { name: 'Prepare my day' });
  await expect(again.getByLabel('Day or time window')).toHaveValue('Tomorrow');
  await again.getByLabel(/calendar@example.test/).check();
  await again.getByRole('button', { name: 'Review the goal' }).click();
  await expect(again.getByLabel('Generated goal')).toContainText('Read the selected accounts.');
  await shot(page, 'assistant-starter');
  await again.getByRole('button', { name: 'Start this task' }).click();
  await expect(again.getByRole('alert')).toContainText('needs setup. Your choices are still here.');
  await expect(again.getByLabel('Email to include')).toHaveValue('in:inbox newer_than:2d');
  await again.getByRole('button', { name: 'Start this task' }).click();
  await expect.poll(() => starts).toBe(2);
  const [preview, first, second] = bodies;
  expect(first).toMatchObject({ starterId: 'prepare-day', connectionIds: [gmail.id, calendar.id], inputs: { window: 'Tomorrow', inboxQuery: 'in:inbox newer_than:2d' } });
  expect(first.requestId).toBe(preview.requestId);
  expect(second.requestId).toBe(first.requestId);
  calendar.sharedAgentIds = [];
});

test('agent notes are scoped to the selected agent, forget safely, and keep edits on conflict', async ({ page, request }) => {
  const puts: Array<{ agent: string; body: Record<string, unknown> }> = []; let conflict = false;
  const { panel } = await open(page, request, {});
  await page.route(/\/v1\/agents\/[^/]+\/context$/, route => {
    const agent = decodeURIComponent(new URL(route.request().url()).pathname.split('/')[3]);
    if (route.request().method() === 'PUT') { puts.push({ agent, body: route.request().postDataJSON() }); return conflict ? reply(route, { error: 'These notes changed elsewhere (revision abc123).' }, 409) : reply(route, { ok: true, revision: `rev-${puts.length + 1}` }); }
    return reply(route, agent === 'scout' ? { memory: 'Scout uses the staging API.', user: '', revision: 'scout-rev', skills: [] } : agent === PRIMARY_ASSISTANT_ID ? { memory: 'Prefers Sheets.\n§\nRepo is monorepo.', user: 'Call me Jo.', revision: 'rev-1', skills: [] } : { memory: '', user: '', revision: `${agent}-rev`, skills: [] });
  });
  await panel.getByRole('button', { name: 'What it knows', exact: true }).click();
  const memory = panel.getByRole('region', { name: 'What this assistant knows' });
  await expect(memory).toContainText('nothing here is shared automatically');
  await expect(memory.getByLabel('Agent')).toHaveValue(PRIMARY_ASSISTANT_ID);
  await expect(memory).toContainText('Repo is monorepo.');
  await memory.getByRole('button', { name: 'Forget: Repo is monorepo.' }).click();
  await expect(memory.getByRole('status')).toContainText('Forgot one working notes entry');
  expect(puts[0], JSON.stringify(puts)).toEqual({ agent: PRIMARY_ASSISTANT_ID, body: { memory: 'Prefers Sheets.', revision: 'rev-1' } });
  await memory.getByLabel('Agent').selectOption('scout');
  await expect(memory).toContainText('Scout uses the staging API.');
  await expect(memory).not.toContainText('Call me Jo.');
  conflict = true;
  await memory.getByRole('button', { name: 'Edit about you' }).click();
  await memory.getByLabel('About you for Scout').fill('Prefers short replies.');
  await memory.getByRole('button', { name: 'Save notes' }).click();
  await expect(memory.getByRole('alert')).toContainText('changed elsewhere');
  await expect(memory.getByLabel('About you for Scout')).toHaveValue('Prefers short replies.');
  expect(puts[1]).toEqual({ agent: 'scout', body: { user: 'Prefers short replies.', revision: 'scout-rev' } });
  await noOverflow(page);
});

test('starter drafts are scoped to this workspace and person, and Start sends only the reviewed request', async ({ page, request }) => {
  await page.addInitScript(() => { localStorage.setItem('open-harness.starter-draft:prepare-day', JSON.stringify({ connectionIds: ['foreign'], inputs: { window: 'Legacy unscoped' }, requestId: 'legacy-id' })); localStorage.setItem('open-harness.starter-draft:other-workspace:other-person:prepare-day', JSON.stringify({ connectionIds: ['foreign'], inputs: { window: 'Other workspace' }, requestId: 'foreign-id' })); });
  const shared = { ...calendar, sharedAgentIds: [PRIMARY_ASSISTANT_ID] }, bodies: Array<Record<string, unknown>> = []; let release = () => {}, previews = 0;
  const { panel } = await open(page, request, { connections: [gmail, shared] });
  await page.route(/\/v1\/assistant\/starters\/preview$/, async route => { previews++; const body = route.request().postDataJSON(); if (previews === 1) await new Promise<void>(resolve => { release = resolve; }); return reply(route, { prompt: `Goal for ${body.inputs.window}` }); });
  await page.route(/\/v1\/assistant\/starters$/, route => { if (route.request().method() !== 'POST') return route.fallback(); bodies.push(route.request().postDataJSON()); return reply(route, { error: 'Fixture stop.' }, 409); });
  const starters = panel.getByRole('region', { name: 'Guided starters' });
  await starters.getByRole('button', { name: 'Set up prepare my day' }).click();
  const form = starters.getByRole('form', { name: 'Prepare my day' });
  await expect(form.getByLabel('Day or time window')).toHaveValue('');
  await form.getByLabel(/me@example.test/).check(); await form.getByLabel(/calendar@example.test/).check();
  await form.getByLabel('Day or time window').fill('Monday'); await form.getByLabel('Email to include').fill('in:inbox');
  const keys = await page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('open-harness.starter-draft:') && key.endsWith(':prepare-day')));
  expect(keys.filter(key => !['open-harness.starter-draft:prepare-day', 'open-harness.starter-draft:other-workspace:other-person:prepare-day'].includes(key))).toHaveLength(1);
  // While the first preview is pending the inputs are locked; leaving the form makes its late reply stale.
  await form.getByRole('button', { name: 'Review the goal' }).click();
  await expect(form.getByLabel('Day or time window')).toBeDisabled();
  await starters.getByRole('button', { name: 'Close' }).click();
  await starters.getByRole('button', { name: 'Set up prepare my day' }).click();
  release();
  const reopened = starters.getByRole('form', { name: 'Prepare my day' });
  await expect(reopened.getByLabel('Day or time window')).toHaveValue('Monday');
  await page.waitForTimeout(300);
  await expect(reopened.getByLabel('Generated goal')).toHaveCount(0);
  await reopened.getByRole('button', { name: 'Review the goal' }).click();
  await expect(reopened.getByLabel('Generated goal')).toHaveText('Goal for Monday');
  await reopened.getByRole('button', { name: 'Start this task' }).click();
  await expect(reopened.getByRole('alert')).toContainText('Fixture stop.');
  expect(bodies[0]).toMatchObject({ inputs: { window: 'Monday', inboxQuery: 'in:inbox' }, connectionIds: [gmail.id, shared.id] });
  expect(bodies[0].requestId).not.toBe('legacy-id'); expect(bodies[0].requestId).not.toBe('foreign-id');
  // Changing an input after review clears the review; Start is unavailable until the new input is reviewed.
  await reopened.getByLabel('Day or time window').fill('Tuesday');
  await expect(reopened.getByLabel('Generated goal')).toHaveCount(0);
  await expect(reopened.getByRole('button', { name: 'Start this task' })).toHaveCount(0);
  expect(bodies).toHaveLength(1);
});

test('switching agents never shows or saves another agent\'s notes, and only the owner sees them', async ({ page, request }) => {
  const gets: Record<string, () => void> = {}, puts: Array<{ agent: string; body: Record<string, unknown> }> = []; let holdScout = true, holdPut: (() => void) | null = null;
  const { panel } = await open(page, request, {});
  await page.route(/\/v1\/agents\/[^/]+\/context$/, async route => {
    const agent = decodeURIComponent(new URL(route.request().url()).pathname.split('/')[3]);
    if (route.request().method() === 'PUT') { puts.push({ agent, body: route.request().postDataJSON() }); await new Promise<void>(resolve => { holdPut = resolve; }); return reply(route, { ok: true, revision: 'after-put' }); }
    if (agent === 'scout' && holdScout) await new Promise<void>(resolve => { gets.scout = resolve; });
    return reply(route, agent === 'scout' ? { memory: 'Scout uses the staging API.', user: '', revision: 'scout-rev', skills: [] } : { memory: 'Assistant private note.', user: '', revision: `${agent}-rev`, skills: [] });
  });
  await panel.getByRole('button', { name: 'What it knows', exact: true }).click();
  const memory = panel.getByRole('region', { name: 'What this assistant knows' }), select = memory.getByLabel('Agent');
  await expect(memory).toContainText('Assistant private note.');
  await select.selectOption('scout');
  await expect(memory).toContainText('Loading notes for Scout');
  await expect(memory).not.toContainText('Assistant private note.');
  await expect(memory.getByRole('button', { name: /^Forget/ })).toHaveCount(0);
  // A slow reply for the agent the person left must not replace the one now selected.
  await select.selectOption(PRIMARY_ASSISTANT_ID);
  await expect(memory).toContainText('Assistant private note.');
  gets.scout?.(); holdScout = false;
  await page.waitForTimeout(300);
  await expect(memory).toContainText('Assistant private note.');
  await expect(memory).not.toContainText('Scout uses the staging API.');
  await memory.getByRole('button', { name: 'Edit working notes' }).click();
  const notes = memory.getByRole('textbox', { name: /^Working notes for/ });
  await notes.fill('');
  await memory.getByRole('button', { name: 'Save notes' }).click();
  await expect(select).toBeDisabled();
  await expect(notes).toBeDisabled();
  expect(puts).toEqual([{ agent: PRIMARY_ASSISTANT_ID, body: { memory: '', revision: `${PRIMARY_ASSISTANT_ID}-rev` } }]);
  (holdPut as (() => void) | null)?.();
  await expect(select).toBeEnabled();
  await page.unrouteAll({ behavior: 'ignoreErrors' });
  const contextReads: string[] = [];
  await page.route(/\/v1\/agents\/[^/]+\/context$/, route => { contextReads.push(decodeURIComponent(new URL(route.request().url()).pathname.split('/')[3])); return reply(route, { error: 'Only the workspace owner can view notes.' }, 403); });
  await open(page, request, { role: 'operator' });
  await expect(panel.getByRole('button', { name: 'Inbox', exact: false }).first()).toBeVisible();
  await expect(panel.getByRole('button', { name: 'What it knows', exact: true })).toHaveCount(0);
  await expect(panel.getByRole('region', { name: 'What this assistant knows' })).toHaveCount(0);
  // The existing page shell probes selected Atlas context; this panel must not request either agent's notes.
  expect(contextReads.every(agent => agent === 'atlas')).toBe(true);
});
