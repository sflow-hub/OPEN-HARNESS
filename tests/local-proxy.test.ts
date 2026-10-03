import test from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import assert from "node:assert/strict";
import { GET as health } from "../app/api/health/route";
import { GET, POST, GET as proxyGet } from "../app/api/local/[...path]/route";

test("health reports only coordinator reachability", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async input => { assert.ok(String(input).endsWith('/v1/ready')); return Response.json({ ok: true, token: "must-not-leak", secrets: ["also-private"] }); };
    const ready = await health();
    assert.equal(ready.status, 200);
    assert.deepEqual(await ready.json(), { ok: true });

    globalThis.fetch = async () => Response.json({ pairingRequired: true }, { status: 401 });
    assert.equal((await health()).status, 503, 'Health must use its own public endpoint, not an authentication failure.');

    globalThis.fetch = async () => { throw new Error("offline"); };
    const unavailable = await health();
    assert.equal(unavailable.status, 503);
    assert.deepEqual(await unavailable.json(), { ok: false });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("remote bootstrap stays closed unless the proxy trust switch is explicit", async () => {
  const originalFetch = globalThis.fetch;
  const originalTrust = process.env.OPEN_HARNESS_ALLOW_REMOTE_DASHBOARD;
  const context = { params: Promise.resolve({ path: ["v1", "bootstrap"] }) };
  try {
    delete process.env.OPEN_HARNESS_ALLOW_REMOTE_DASHBOARD;
    const denied = await proxyGet(new Request("https://agents.example.com/api/local/v1/bootstrap", { headers: { Host: "agents.example.com" } }), context);
    assert.equal(denied.status, 403);

    globalThis.fetch = async () => Response.json({ token: "test-token" });
    const local = await proxyGet(new Request("http://localhost:3000/api/local/v1/bootstrap", { headers: { Host: "localhost:3000" } }), context);
    assert.equal(local.status, 200);

    process.env.OPEN_HARNESS_ALLOW_REMOTE_DASHBOARD = "1";
    const trusted = await proxyGet(new Request("https://agents.example.com/api/local/v1/bootstrap", { headers: { Host: "agents.example.com" } }), context);
    assert.equal(trusted.status, 200);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalTrust === undefined) delete process.env.OPEN_HARNESS_ALLOW_REMOTE_DASHBOARD;
    else process.env.OPEN_HARNESS_ALLOW_REMOTE_DASHBOARD = originalTrust;
  }
});

test("the dashboard proxy forwards only coordinator paths and no hosted dispatch header", async () => {
  const originalFetch = globalThis.fetch;
  try {
    const blocked = await proxyGet(new Request("http://localhost:3000/api/local/etc/passwd", { headers: { Host: "localhost:3000" } }), { params: Promise.resolve({ path: ["etc", "passwd"] }) });
    assert.equal(blocked.status, 404);

    let forwarded = new Headers();
    globalThis.fetch = async (_input, init) => { forwarded = new Headers(init?.headers); return Response.json({ ok: true }); };
    await proxyGet(new Request("http://localhost:3000/api/local/v1/runs", { headers: { Host: "localhost:3000", Authorization: "Bearer token", "OAI-Sites-Authorization": "Bearer dispatch" } }), { params: Promise.resolve({ path: ["v1", "runs"] }) });
    assert.equal(forwarded.get("authorization"), "Bearer token");
    assert.equal(forwarded.get("oai-sites-authorization"), null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('runtime setup forwards delayed responses, errors and cancellation over native HTTP only for the setup POST', { timeout: 10_000 }, async () => {
  const previousUrl = process.env.OPEN_HARNESS_INTERNAL_CONTROL_URL;
  const previousFetch = globalThis.fetch;
  let releaseSuccess!: () => void, signalReceived!: () => void, signalCancelled!: () => void, signalClosed!: () => void;
  const successGate = new Promise<void>(resolve => { releaseSuccess = resolve; });
  const received = new Promise<void>(resolve => { signalReceived = resolve; });
  const cancelling = new Promise<void>(resolve => { signalCancelled = resolve; });
  const cancelled = new Promise<void>(resolve => { signalClosed = resolve; });
  const requests: { url: string; method: string; headers: Record<string, string | string[] | undefined>; body: string }[] = [];
  const server = createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += String(chunk);
    requests.push({ url: request.url || '', method: request.method || '', headers: request.headers, body });
    if (request.url?.endsWith('?case=cancel')) { response.once('close', signalClosed); signalCancelled(); return; }
    if (request.url?.endsWith('?case=disconnect')) { response.destroy(); return; }
    if (request.url?.endsWith('?case=success')) { signalReceived(); await successGate; }
    response.writeHead(request.url?.endsWith('?case=error') ? 503 : 200, { 'Content-Type': 'application/json', 'X-Upstream-Private': 'not-forwarded' });
    response.end(JSON.stringify(request.url?.endsWith('?case=error') ? { error: 'Build failed' } : { executionReady: true }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  let normalFetches = 0;
  const invoke = (scenario: string, signal?: AbortSignal) => POST(new Request(`http://localhost:3000/api/local/v1/onboarding/action?case=${scenario}`, {
    method: 'POST', signal, headers: { authorization: 'Bearer paired-setup-token', 'x-open-harness-machine': 'paired-setup-device', 'Content-Type': 'application/json', cookie: 'not-forwarded', 'x-unlisted-header': 'not-forwarded' }, body: JSON.stringify({ action: 'prepare-runtime' }),
  }), { params: Promise.resolve({ path: ['v1', 'onboarding', 'action'] }) });
  try {
    process.env.OPEN_HARNESS_INTERNAL_CONTROL_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    globalThis.fetch = async () => { normalFetches++; return Response.json({ ordinaryFetch: true }); };
    let settled = false;
    const delayed = invoke('success').then(response => { settled = true; return response; });
    await received;
    assert.equal(settled, false, 'Setup must wait for delayed upstream headers.');
    releaseSuccess();
    const success = await delayed;
    assert.equal(success.status, 200);
    assert.deepEqual(await success.json(), { executionReady: true });
    assert.equal(success.headers.get('cache-control'), 'no-store');
    assert.equal(success.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(success.headers.get('x-upstream-private'), null);
    assert.equal(requests[0].url, '/v1/onboarding/action?case=success');
    assert.equal(requests[0].method, 'POST');
    assert.equal(requests[0].headers.authorization, 'Bearer paired-setup-token');
    assert.equal(requests[0].headers['x-open-harness-machine'], 'paired-setup-device');
    assert.equal(requests[0].headers.cookie, undefined);
    assert.equal(requests[0].headers['x-unlisted-header'], undefined);
    assert.deepEqual(JSON.parse(requests[0].body), { action: 'prepare-runtime' });
    const failed = await invoke('error');
    assert.equal(failed.status, 503);
    assert.deepEqual(await failed.json(), { error: 'Build failed' });
    assert.equal((await invoke('disconnect')).status, 502);
    const controller = new AbortController();
    const pending = invoke('cancel', controller.signal);
    await cancelling;
    controller.abort();
    assert.equal((await pending).status, 502);
    await cancelled;
    assert.equal(normalFetches, 0);
    const ordinary = await GET(new Request('http://localhost:3000/api/local/v1/onboarding/action'), { params: Promise.resolve({ path: ['v1', 'onboarding', 'action'] }) });
    assert.deepEqual(await ordinary.json(), { ordinaryFetch: true });
    const otherPost = await POST(new Request('http://localhost:3000/api/local/v1/onboarding/model-test', { method: 'POST', body: '{}' }), { params: Promise.resolve({ path: ['v1', 'onboarding', 'model-test'] }) });
    assert.deepEqual(await otherPost.json(), { ordinaryFetch: true });
    assert.equal(normalFetches, 2);
  } finally {
    releaseSuccess();
    globalThis.fetch = previousFetch;
    if (previousUrl === undefined) delete process.env.OPEN_HARNESS_INTERNAL_CONTROL_URL; else process.env.OPEN_HARNESS_INTERNAL_CONTROL_URL = previousUrl;
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
