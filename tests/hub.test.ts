import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePairingCode, pairDevice, parsePairingLink, validateHubUrl } from '../lib/hub';

test('hub addresses must be encrypted unless they cannot leave the device', () => {
  assert.equal(validateHubUrl('https://agents.example.com/'), 'https://agents.example.com');
  assert.equal(validateHubUrl('  https://agents.example.com/api/local  '), 'https://agents.example.com/api/local');
  // Loopback is how an emulator reaches a coordinator on the development host.
  assert.equal(validateHubUrl('http://127.0.0.1:4317'), 'http://127.0.0.1:4317');
  assert.throws(() => validateHubUrl('http://agents.example.com'), /HTTPS/);
  assert.throws(() => validateHubUrl('not a url'), /valid web address/);
  assert.throws(() => validateHubUrl(''), /Enter the address/);
});

test('pairing links carry the hub and code, and reject anything else', () => {
  const link = parsePairingLink('openharness://pair?hub=https%3A%2F%2Fagents.example.com&code=K4M27QRT9XBV');
  assert.deepEqual(link, { hubUrl: 'https://agents.example.com', code: 'K4M27QRT9XBV' });
  assert.equal(parsePairingLink('openharness://pair?hub=https://agents.example.com')?.code, undefined);
  assert.equal(parsePairingLink('https://evil.example.com/pair?hub=x&code=y'), null);
  assert.equal(parsePairingLink(''), null);
  assert.equal(parsePairingLink('openharness://pair?hub=http%3A%2F%2Fagents.example.com&code=ABC'), null, 'a link may not downgrade the hub to plain HTTP');
});

test('pairing codes survive being read off a screen and typed', () => {
  // The alphabet excludes I, L, O and U precisely so these substitutions are unambiguous.
  assert.equal(normalizePairingCode('k4m2 7qrt 9xbv'), 'K4M27QRT9XBV');
  assert.equal(normalizePairingCode('IL0O-U'), '1100V');
  assert.equal(normalizePairingCode('  '), '');
});

test('pairing sends the phone capability set and keeps the private key on the device', async () => {
  let seen: { url: string; body: Record<string, unknown>; headers: Record<string, string> } | null = null;
  const fetchImpl = (async (url: string, init: RequestInit) => {
    seen = { url: String(url), body: JSON.parse(String(init.body)), headers: init.headers as Record<string, string> };
    return { ok: true, status: 201, json: async () => ({ machineId: 'machine-1', token: 'secret-token', machine: { name: 'My phone' } }) };
  }) as unknown as typeof fetch;

  const credential = await pairDevice({ hubUrl: 'https://agents.example.com', code: 'k4m2 7qrt 9xbv', name: 'My phone', platform: 'ios', fetchImpl });

  const request = seen as unknown as { url: string; body: Record<string, unknown>; headers: Record<string, string> };
  assert.equal(request.url, 'https://agents.example.com/v1/runner/pair');
  assert.equal(request.body.code, 'K4M27QRT9XBV', 'the typed code is normalized before it is sent');
  assert.deepEqual(request.body.capabilities, { container: false, direct: false, desktop: false, virtualDesktop: false, mobile: true, detail: 'Companion dashboard only; agents run on a connected computer.' });
  assert.ok(String(request.body.encryptionPublicKey).includes('"kty":"RSA"'));
  // The hub encrypts model credentials to the public half and never sees the private half.
  assert.ok(credential.encryptionPrivateKey.includes('"d":'));
  assert.equal(String(request.body.encryptionPublicKey).includes('"d":'), false);
  assert.equal(credential.machineId, 'machine-1');
  assert.equal(credential.token, 'secret-token');
});

test('a used or expired code explains what to do instead of showing a status number', async () => {
  const fetchImpl = (async () => ({ ok: false, status: 410, json: async () => ({ error: 'This pairing code is invalid, expired, or already used.' }) })) as unknown as typeof fetch;
  await assert.rejects(
    pairDevice({ hubUrl: 'https://agents.example.com', code: 'K4M27QRT9XBV', name: 'Phone', platform: 'ios', fetchImpl }),
    /expired or was already used\. Create a new one/,
  );
});

test('a hosted hub token rides along on the pairing request', async () => {
  let headers: Record<string, string> = {};
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    headers = init.headers as Record<string, string>;
    return { ok: true, status: 201, json: async () => ({ machineId: 'm', token: 't', machine: {} }) };
  }) as unknown as typeof fetch;
  const credential = await pairDevice({ hubUrl: 'https://site.example.com/api/control', code: 'ABCDEFGH1234', sitesToken: 'sites-token', name: 'Phone', platform: 'android', fetchImpl });
  assert.equal(headers['OAI-Sites-Authorization'], 'Bearer sites-token');
  assert.equal(credential.sitesToken, 'sites-token');
});
