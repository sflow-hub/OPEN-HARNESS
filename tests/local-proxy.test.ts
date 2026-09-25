import test from 'node:test';
import assert from 'node:assert/strict';
import { GET } from '../app/api/local/[...path]/route';

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
