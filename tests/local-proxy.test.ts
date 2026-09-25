import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { GET, POST } from '../app/api/local/[...path]/route';

test('paired deployments deny browser bootstrap for every Host and remote-access setting', async () => {
  const previousDisable = process.env.OPEN_HARNESS_DISABLE_BROWSER_BOOTSTRAP;
  const previousAllow = process.env.OPEN_HARNESS_ALLOW_REMOTE_DASHBOARD;
  const previousFetch = globalThis.fetch;
  let forwarded = 0;
  globalThis.fetch = async () => { forwarded++; return Response.json({ token: 'must-not-be-exposed' }); };
  try {
    process.env.OPEN_HARNESS_DISABLE_BROWSER_BOOTSTRAP = '1';
    for (const remoteAllowed of ['0', '1']) {
      process.env.OPEN_HARNESS_ALLOW_REMOTE_DASHBOARD = remoteAllowed;
      for (const host of ['localhost:3000', '127.0.0.1:3000', '[::1]:3000', 'agents.example.com']) {
        const response = await GET(new Request('http://open-harness:3000/api/local/v1/bootstrap', { headers: { host } }), { params: Promise.resolve({ path: ['v1', 'bootstrap'] }) });
        assert.equal(response.status, 403);
        assert.doesNotMatch(await response.text(), /must-not-be-exposed/);
      }
    }
    assert.equal(forwarded, 0);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousDisable === undefined) delete process.env.OPEN_HARNESS_DISABLE_BROWSER_BOOTSTRAP; else process.env.OPEN_HARNESS_DISABLE_BROWSER_BOOTSTRAP = previousDisable;
    if (previousAllow === undefined) delete process.env.OPEN_HARNESS_ALLOW_REMOTE_DASHBOARD; else process.env.OPEN_HARNESS_ALLOW_REMOTE_DASHBOARD = previousAllow;
  }
});

test('paired deployments continue forwarding authenticated device requests', async () => {
  const previousDisable = process.env.OPEN_HARNESS_DISABLE_BROWSER_BOOTSTRAP;
  const previousFetch = globalThis.fetch;
  try {
    process.env.OPEN_HARNESS_DISABLE_BROWSER_BOOTSTRAP = '1';
    globalThis.fetch = async (url, init) => {
      assert.match(String(url), /\/v1\/device\/session$/);
      const headers = new Headers(init?.headers);
      assert.equal(headers.get('authorization'), 'Bearer device-test-token');
      assert.equal(headers.get('x-open-harness-machine'), 'device-test');
      return Response.json({ token: 'device-test-token', machineId: 'device-test' });
    };
    const response = await GET(new Request('http://localhost:3000/api/local/v1/device/session', { headers: { authorization: 'Bearer device-test-token', 'x-open-harness-machine': 'device-test' } }), { params: Promise.resolve({ path: ['v1', 'device', 'session'] }) });
    assert.equal(response.status, 200);
    const session = await response.json() as { machineId: string };
    assert.equal(session.machineId, 'device-test');
  } finally {
    globalThis.fetch = previousFetch;
    if (previousDisable === undefined) delete process.env.OPEN_HARNESS_DISABLE_BROWSER_BOOTSTRAP; else process.env.OPEN_HARNESS_DISABLE_BROWSER_BOOTSTRAP = previousDisable;
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
