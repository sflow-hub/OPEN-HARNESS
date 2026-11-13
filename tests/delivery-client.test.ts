import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { ControlClient } from '../lib/control-client';

test('conversation events carry the replay cursor, bounded wait and authenticated cancellation signal', async () => {
  const original = globalThis.fetch, controller = new AbortController();
  globalThis.fetch = (async (input, init) => {
    const url = new URL(String(input)); assert.equal(url.searchParams.get('after'), '17'); assert.equal(url.searchParams.get('wait'), '25000');
    assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer fixture-token');
    assert.ok(init?.signal); controller.abort(); assert.equal(init.signal.aborted, true);
    return Response.json({ events: [], run: { id: 'a' } });
  }) as typeof fetch;
  try { const client = new ControlClient(); client.token = 'fixture-token'; await client.events('a', 17, { waitMs: 100_000, signal: controller.signal }); }
  finally { globalThis.fetch = original; }
});

test('a task notification opens its task in an existing dashboard window', async () => {
  const handlers: Record<string, (event: unknown) => void> = {}, calls: string[] = [];
  let pending: Promise<unknown> = Promise.resolve();
  const opened = { focus: async () => { calls.push('focus'); } };
  const client = { url: 'https://workspace.example/?workspace=current', navigate: async (url: string) => { calls.push(url); return opened; }, focus: async () => { calls.push('old-focus'); } };
  runInNewContext(readFileSync(new URL('../public/open-harness-sw.js', import.meta.url), 'utf8'), { URL, self: { location: { origin: 'https://workspace.example' }, addEventListener: (type: string, handler: (event: unknown) => void) => { handlers[type] = handler; }, clients: { matchAll: async () => [client], openWindow: async (url: string) => { calls.push(`new:${url}`); } } } });
  handlers.notificationclick({ notification: { close() {}, data: { url: '/?run=task-1&workspace=notified' } }, waitUntil(task: Promise<unknown>) { pending = task; } });
  await pending;
  assert.deepEqual(calls, ['https://workspace.example/?run=task-1&workspace=notified', 'focus']);
});

test('web push links carry only valid task and workspace identifiers', async () => {
  const handlers: Record<string, (event: unknown) => void> = {}, links: string[] = [];
  let pending: Promise<unknown> = Promise.resolve();
  runInNewContext(readFileSync(new URL('../public/open-harness-sw.js', import.meta.url), 'utf8'), { URL, self: { location: { origin: 'https://workspace.example' }, addEventListener: (type: string, handler: (event: unknown) => void) => { handlers[type] = handler; }, registration: { showNotification: async (_title: string, options: { data: { url: string } }) => { links.push(options.data.url); } } } });
  for (const workspaceId of ['workspace-123', '../invalid?workspace=other']) {
    handlers.push({ data: { json: () => ({ kind: 'approval', runId: 'task-1', workspaceId }) }, waitUntil(task: Promise<unknown>) { pending = task; } }); await pending;
  }
  assert.deepEqual(links, ['/?run=task-1&workspace=workspace-123', '/?run=task-1']);
});

test('a generic notification focuses the dashboard without discarding its current view', async () => {
  const handlers: Record<string, (event: unknown) => void> = {}, calls: string[] = [];
  let pending: Promise<unknown> = Promise.resolve();
  runInNewContext(readFileSync(new URL('../public/open-harness-sw.js', import.meta.url), 'utf8'), { URL, self: { location: { origin: 'https://workspace.example' }, addEventListener: (type: string, handler: (event: unknown) => void) => { handlers[type] = handler; }, clients: { matchAll: async () => [{ url: 'https://workspace.example/?workspace=current', focus: async () => { calls.push('focus'); }, navigate: async () => { calls.push('navigate'); } }], openWindow: async () => { calls.push('open'); } } } });
  handlers.notificationclick({ notification: { close() {}, data: { url: '/' } }, waitUntil(task: Promise<unknown>) { pending = task; } });
  await pending;
  assert.deepEqual(calls, ['focus']);
});
