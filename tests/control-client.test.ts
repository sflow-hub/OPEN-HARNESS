import test from 'node:test';
import assert from 'node:assert/strict';
import { ControlClient } from '../lib/control-client';
import type { DeviceCredential } from '../lib/hub';

const credential: DeviceCredential = {
  hubUrl: 'https://agents.example.com',
  machineId: 'machine-7',
  token: 'device-token',
  encryptionPublicKey: '{}',
  encryptionPrivateKey: '{}',
  name: 'My phone',
  pairedAt: new Date().toISOString(),
};

function recorder(response: unknown, status = 200) {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const fetchImpl = (async (url: string, init: RequestInit = {}) => {
    calls.push({ url: String(url), headers: (init.headers || {}) as Record<string, string> });
    return { ok: status < 400, status, json: async () => response };
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

test('a paired phone addresses its own hub and identifies itself as that machine', async () => {
  const { calls, fetchImpl } = recorder({ runs: [] });
  const client = new ControlClient();
  client.useDevice(credential, fetchImpl);

  await client.request('/v1/runs');

  assert.equal(calls[0].url, 'https://agents.example.com/v1/runs');
  assert.equal(calls[0].headers.Authorization, 'Bearer device-token');
  assert.equal(calls[0].headers['X-Open-Harness-Machine'], 'machine-7');
  assert.equal(client.pairedMachineId, 'machine-7');
});

test('a phone asks for its own session rather than the master control token', async () => {
  const { calls, fetchImpl } = recorder({ token: '', version: '0.3.0', machine: { id: 'machine-7', kind: 'device' } });
  const client = new ControlClient();
  client.useDevice(credential, fetchImpl);

  const status = await client.bootstrap();

  assert.equal(calls[0].url, 'https://agents.example.com/v1/device/session');
  assert.equal(status.token, '', 'the master token never reaches a phone');
  assert.equal(client.token, '', 'and nothing stashes one locally either');
});

test('an unpaired phone is told to reconnect instead of seeing a bare 401', async () => {
  const { fetchImpl } = recorder({ error: 'Pair this phone again to reconnect it.' }, 401);
  const client = new ControlClient();
  client.useDevice(credential, fetchImpl);
  await assert.rejects(client.bootstrap(), /no longer paired/);
});

test('a hosted hub token is attached to every request, not just pairing', async () => {
  const { calls, fetchImpl } = recorder({ agents: [] });
  const client = new ControlClient();
  client.useDevice({ ...credential, sitesToken: 'sites-token' }, fetchImpl);
  await client.request('/v1/agents');
  assert.equal(calls[0].headers['OAI-Sites-Authorization'], 'Bearer sites-token');
});

test('clearing the pairing stops the phone addressing that hub', async () => {
  const { calls, fetchImpl } = recorder({ ok: true });
  const client = new ControlClient();
  client.useDevice(credential, fetchImpl);
  client.useDevice(null);
  await client.request('/v1/health').catch(() => {});
  assert.equal(calls[0].url.startsWith('https://agents.example.com'), false);
  assert.equal(client.pairedMachineId, '');
});
