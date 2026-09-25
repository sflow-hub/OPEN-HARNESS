import test from 'node:test';
import assert from 'node:assert/strict';
import { ControlClient } from '../lib/control-client';

function stubFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const original = globalThis.fetch;
  const calls: Array<{ url: string; authorization: string }> = [];
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, authorization: String(new Headers(init?.headers).get('authorization') || '') });
    return handler(url, init);
  }) as typeof globalThis.fetch;
  return { calls, restore: () => { globalThis.fetch = original; } };
}
const ok = (body: unknown) => Response.json(body);

test('bootstrap reads its body once and keeps the token', async () => {
  const stub = stubFetch(() => ok({ token: 'control-token', mode: 'live' }));
  try {
    const client = new ControlClient();
    const status = await client.bootstrap();
    assert.equal(status.token, 'control-token');
    assert.equal(client.token, 'control-token');
  } finally { stub.restore(); }
});

test('a rejected token is recovered once instead of stranding every later call', async () => {
  let issued = 'first-token';
  const stub = stubFetch((url, init) => {
    if (url.endsWith('/v1/bootstrap')) { issued = 'second-token'; return ok({ token: issued, mode: 'live' }); }
    const sent = String(new Headers(init?.headers).get('authorization') || '');
    return sent === `Bearer ${issued}` ? ok({ runs: [] }) : Response.json({ error: 'Invalid local control token.' }, { status: 401 });
  });
  try {
    const client = new ControlClient();
    client.token = 'stale-token';
    assert.deepEqual(await client.request('/v1/runs'), { runs: [] });
    assert.equal(client.token, 'second-token');
    // The retry happens once: the original call, a bootstrap, then the same call again.
    assert.deepEqual(stub.calls.map(call => call.url.replace(/^https?:\/\/[^/]+/, '')), ['/v1/runs', '/v1/bootstrap', '/v1/runs']);
  } finally { stub.restore(); }
});

test('a 401 that survives re-bootstrap is reported, not retried forever', async () => {
  const stub = stubFetch(url => url.endsWith('/v1/bootstrap') ? ok({ token: 'fresh', mode: 'live' }) : Response.json({ error: 'Invalid local control token.' }, { status: 401 }));
  try {
    const client = new ControlClient();
    client.token = 'stale';
    await assert.rejects(client.request('/v1/runs'), /Invalid local control token/);
    assert.equal(stub.calls.length, 3);
  } finally { stub.restore(); }
});

test('a reply that is not JSON names the real problem', async () => {
  const stub = stubFetch(() => new Response('<html>502 Bad Gateway</html>', { status: 502, headers: { 'content-type': 'text/html' } }));
  try {
    const client = new ControlClient();
    client.token = 'token';
    await assert.rejects(client.request('/v1/runs'), /returned HTTP 502/);
  } finally { stub.restore(); }
});

test('an empty body is not a parse error', async () => {
  const stub = stubFetch(() => new Response('', { status: 200 }));
  try {
    const client = new ControlClient();
    client.token = 'token';
    assert.deepEqual(await client.request('/v1/runs/x/stop', { method: 'POST' }), {});
  } finally { stub.restore(); }
});

test('every request carries a deadline so a silent coordinator cannot hang the page', async () => {
  let signal: AbortSignal | undefined;
  const stub = stubFetch((_url, init) => { signal = init?.signal ?? undefined; return ok({ ok: true }); });
  try {
    const client = new ControlClient();
    client.token = 'token';
    await client.request('/v1/health');
    assert.ok(signal, 'no abort signal was attached');
    assert.equal(signal.aborted, false);
  } finally { stub.restore(); }
});
