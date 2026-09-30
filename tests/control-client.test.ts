import test from 'node:test';
import assert from 'node:assert/strict';
import { ControlClient, PairingRequiredError } from '../lib/control-client';

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

// Browser pairing: the Docker-backed install refuses an unpaired browser's bootstrap with
// 401 + pairingRequired and hands the operator token only to a one-use code. The client
// keeps that token per coordinator base and never retries without credentials.
function withStorage<T>(run: (store: Map<string, string>) => Promise<T>) {
  const store = new Map<string, string>();
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => { store.set(key, value); }, removeItem: (key: string) => { store.delete(key); } } });
  return run(store).finally(() => { if (previous) Object.defineProperty(globalThis, 'localStorage', previous); else delete (globalThis as { localStorage?: unknown }).localStorage; });
}
const PAIR_KEY = 'open-harness.pair.v1:http://127.0.0.1:4317';
const refused = () => Response.json({ error: 'Open Open Harness with its launcher to connect this browser.', pairingRequired: true }, { status: 401 });

test('an unpaired bootstrap is a typed refusal with no unauthenticated retry', () => withStorage(async store => {
  const stub = stubFetch(() => refused());
  try {
    const client = new ControlClient();
    await assert.rejects(client.bootstrap(), (error: unknown) => error instanceof PairingRequiredError && /launcher/.test(error.message));
    assert.equal(stub.calls.length, 1);
    assert.equal(stub.calls[0].authorization, '', 'a browser with nothing stored sends no credential');
    assert.equal(store.size, 0);
  } finally { stub.restore(); }
}));

test('pairing exchanges the code on this coordinator only, keeps the token, and later bootstraps present it', () => withStorage(async store => {
  const stub = stubFetch((url, init) => {
    if (url.endsWith('/v1/browser/pair')) {
      assert.equal(init?.method, 'POST');
      assert.deepEqual(JSON.parse(String(init?.body)), { code: 'one-use-code' });
      return ok({ token: 'paired-token', mode: 'live' });
    }
    if (url.endsWith('/v1/bootstrap')) return String(new Headers(init?.headers).get('authorization') || '') === 'Bearer paired-token' ? ok({ token: 'paired-token', mode: 'live' }) : refused();
    return ok({});
  });
  try {
    const client = new ControlClient();
    const status = await client.pair('one-use-code');
    assert.equal(status.token, 'paired-token');
    assert.equal(client.token, 'paired-token');
    assert.equal(store.get(PAIR_KEY), 'paired-token', 'stored under the coordinator base, for reopening');
    const again = new ControlClient();
    assert.equal((await again.bootstrap()).token, 'paired-token');
    assert.equal(stub.calls.at(-1)?.authorization, 'Bearer paired-token');
    assert.ok(stub.calls.every(call => call.url.startsWith('http://127.0.0.1:4317/')), 'the code never leaves this base');
  } finally { stub.restore(); }
}));

test('a browser whose storage is unavailable still bootstraps with the token pairing just gave it, until the coordinator refuses it', async () => {
  // Private windows and blocked site data make localStorage throw; the token from pair()
  // then lives only in this client, for this coordinator, and is dropped on a refusal.
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get() { throw new Error('Access to storage is denied.'); } });
  let accepted = 'paired-token';
  const stub = stubFetch((url, init) => {
    if (url.endsWith('/v1/browser/pair')) return ok({ token: 'paired-token', mode: 'live' });
    if (url.endsWith('/v1/bootstrap')) return String(new Headers(init?.headers).get('authorization') || '') === `Bearer ${accepted}` ? ok({ token: accepted, mode: 'live' }) : refused();
    return ok({});
  });
  try {
    const client = new ControlClient();
    await client.pair('one-use-code');
    assert.equal((await client.bootstrap()).token, 'paired-token');
    assert.equal(stub.calls.at(-1)?.authorization, 'Bearer paired-token', 'presented from memory, storage being unusable');
    // A fresh client (a reload) has nothing: no storage, no memory — the plain refusal, no header.
    await assert.rejects(new ControlClient().bootstrap(), PairingRequiredError);
    assert.equal(stub.calls.at(-1)?.authorization, '');
    // The coordinator stops accepting the token (new data folder): the memory goes with it.
    accepted = 'rotated-token';
    await assert.rejects(client.bootstrap(), PairingRequiredError);
    assert.equal(stub.calls.at(-1)?.authorization, 'Bearer paired-token');
    await assert.rejects(client.bootstrap(), PairingRequiredError);
    assert.equal(stub.calls.at(-1)?.authorization, '', 'nothing is retried with a token the coordinator refused');
  } finally {
    stub.restore();
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous); else delete (globalThis as { localStorage?: unknown }).localStorage;
  }
});

test('a bootstrap that was in flight when a pairing completed cannot clear or replace the token that pairing produced', () => withStorage(async store => {
  // The plain visit's bare bootstrap is slow; a link pasted meanwhile pairs the browser. When
  // the old answer (401, no token) finally lands it must not wipe the new token — and an old
  // successful answer must not put an older token back either.
  let releaseBare: (response: Response) => void = () => {};
  const stub = stubFetch((url, init) => {
    if (url.endsWith('/v1/browser/pair')) return ok({ token: 'paired-token', mode: 'live' });
    if (url.endsWith('/v1/bootstrap')) {
      const sent = String(new Headers(init?.headers).get('authorization') || '');
      if (sent === 'Bearer paired-token') return ok({ token: 'paired-token', mode: 'live' });
      return new Promise<Response>(resolve => { releaseBare = resolve; });
    }
    return ok({});
  });
  try {
    const client = new ControlClient();
    const stale = client.bootstrap();
    stale.catch(() => {});
    await client.pair('one-use-code');
    assert.equal(store.get(PAIR_KEY), 'paired-token');
    releaseBare(refused());
    await assert.rejects(stale, error => !(error instanceof PairingRequiredError) && /newer browser pairing/.test((error as Error).message));
    assert.equal(store.get(PAIR_KEY), 'paired-token', 'the late refusal cleared nothing');
    assert.equal(client.token, 'paired-token');
    assert.equal((await client.bootstrap()).token, 'paired-token');
    assert.equal(stub.calls.at(-1)?.authorization, 'Bearer paired-token');
    // The same for a late success carrying an older token (a source dashboard's bare answer).
    store.clear();
    const other = new ControlClient();
    const early = other.bootstrap();
    await other.pair('one-use-code');
    releaseBare(ok({ token: 'older-token', mode: 'live' }));
    assert.equal((await early).token, 'older-token', 'the answer itself is still returned');
    assert.equal(other.token, 'paired-token', 'but it does not replace the paired token');
    assert.equal(store.get(PAIR_KEY), 'paired-token');
  } finally { stub.restore(); }
}));

test('a used or expired code is reported with the coordinator’s words and stores nothing', () => withStorage(async store => {
  const stub = stubFetch(() => Response.json({ error: 'This browser connection link is invalid or expired. Open Open Harness with its launcher to get a new link.', pairingRequired: true }, { status: 401 }));
  try {
    await assert.rejects(new ControlClient().pair('stale-code'), /invalid or expired/);
    assert.equal(store.size, 0);
  } finally { stub.restore(); }
}));

test('a stored token the coordinator no longer accepts is dropped and the refusal surfaces through request()', () => withStorage(async store => {
  store.set(PAIR_KEY, 'old-token');
  const stub = stubFetch(url => url.endsWith('/v1/bootstrap') ? refused() : Response.json({ error: 'Invalid local control token.' }, { status: 401 }));
  try {
    const client = new ControlClient();
    client.token = 'old-token';
    await assert.rejects(client.request('/v1/runs'), (error: unknown) => error instanceof PairingRequiredError);
    assert.equal(store.has(PAIR_KEY), false);
    // The one re-bootstrap carried the stored token; nothing was tried without it.
    assert.deepEqual(stub.calls.map(call => [call.url.replace(/^https?:\/\/[^/]+/, ''), call.authorization]), [['/v1/runs', 'Bearer old-token'], ['/v1/bootstrap', 'Bearer old-token']]);
  } finally { stub.restore(); }
}));

test('a plain source dashboard is unchanged: no stored token, no header, and nothing stored afterwards', () => withStorage(async store => {
  const stub = stubFetch(() => ok({ token: 'dev-token', mode: 'live' }));
  try {
    assert.equal((await new ControlClient().bootstrap()).token, 'dev-token');
    assert.equal(stub.calls[0].authorization, '');
    assert.equal(store.size, 0);
  } finally { stub.restore(); }
}));
