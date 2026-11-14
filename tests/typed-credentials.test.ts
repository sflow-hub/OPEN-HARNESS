import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, networkInterfaces } from 'node:os';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import dns from 'node:dns/promises';
import https from 'node:https';
import { syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { SecretStore, SecretsUnavailableError } from '../runtime/secrets';
import { Credentials } from '../runtime/credentials';
import { CredentialOAuth } from '../runtime/credential-oauth';
import { credentialApi } from '../runtime/credential-api';
import { addressKind, credentialHttp, redactCredential, type CredentialTransport } from '../runtime/credential-http';
import { API_TOOL, bindingSecretName, draftProfile } from '../lib/agent-profile';
import { validateProfile } from '../runtime/profiles';
import { prepareProfile } from '../runtime/profile-runtime';
import { generateRunnerKeyPair, encryptRunnerSecret, decryptRunnerSecret } from '../lib/runner-crypto';

function store(t: import('node:test').TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'typed-credentials-')), file = join(directory, 'secrets.json');
  const previous = process.env.OPEN_HARNESS_DISABLE_OS_VAULT; process.env.OPEN_HARNESS_DISABLE_OS_VAULT = '1';
  const db = new DatabaseSync(':memory:'), secrets = new SecretStore(file), credentials = new Credentials(db, secrets);
  t.after(() => { db.close(); rmSync(directory, { recursive: true, force: true }); if (previous === undefined) delete process.env.OPEN_HARNESS_DISABLE_OS_VAULT; else process.env.OPEN_HARNESS_DISABLE_OS_VAULT = previous; });
  return { directory, file, db, secrets, credentials };
}

test('encrypted storage migrates plaintext, preserves identity, and fails without modifying unreadable data', t => {
  const { file, secrets } = store(t), token = secrets.token;
  writeFileSync(file, JSON.stringify({ controlToken: token, LEGACY_KEY: 'legacy-sensitive-value' }));
  const migrated = new SecretStore(file);
  assert.equal(migrated.token, token); assert.equal(migrated.environment().LEGACY_KEY, 'legacy-sensitive-value');
  const encrypted = readFileSync(file, 'utf8'); assert.ok(!encrypted.includes('legacy-sensitive-value')); assert.ok(!encrypted.includes(token));
  const wrong = process.env.OPEN_HARNESS_ENCRYPTION_KEY; process.env.OPEN_HARNESS_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
  try { assert.throws(() => new SecretStore(file), SecretsUnavailableError); assert.equal(readFileSync(file, 'utf8'), encrypted); }
  finally { if (wrong === undefined) delete process.env.OPEN_HARNESS_ENCRYPTION_KEY; else process.env.OPEN_HARNESS_ENCRYPTION_KEY = wrong; }
  unlinkSync(`${file}.key`); assert.throws(() => new SecretStore(file), /key is missing/); assert.equal(readFileSync(file, 'utf8'), encrypted);
  assert.throws(() => migrated.set('LEGACY_KEY', 'replacement'), /key is missing/); assert.equal(readFileSync(file, 'utf8'), encrypted); assert.equal(migrated.environment().LEGACY_KEY, 'legacy-sensitive-value');
});

test('corrupt encrypted and structured storage remains unchanged on startup and writes', t => {
  const { file, secrets } = store(t);
  secrets.set('SERVICE_KEY', 'original-private-key');
  const corrupted = JSON.parse(readFileSync(file, 'utf8')); corrupted.tag = Buffer.alloc(16).toString('base64');
  const bytes = JSON.stringify(corrupted); writeFileSync(file, bytes);
  assert.throws(() => new SecretStore(file), SecretsUnavailableError);
  assert.throws(() => secrets.set('SERVICE_KEY', 'replacement-private-key'));
  assert.equal(readFileSync(file, 'utf8'), bytes); assert.equal(secrets.environment().SERVICE_KEY, 'original-private-key');
  for (const plain of ['', '{"SERVICE_KEY":"original-private-key"', JSON.stringify({ controlToken: secrets.token, 'credential:SERVICE_KEY': 'invalid JSON' }), JSON.stringify({ controlToken: secrets.token, 'credential:SERVICE_KEY': '["wrong shape"]' })]) {
    writeFileSync(file, plain); assert.throws(() => new SecretStore(file), error => error instanceof SecretsUnavailableError && !error.message.includes('original-private-key')); assert.equal(readFileSync(file, 'utf8'), plain);
  }
});

test('typed edits preserve omitted secrets and never put structured values in metadata, SQLite, or the environment', t => {
  const { credentials, secrets, db, file } = store(t);
  const row = credentials.create({ label: 'Production account', type: 'basic', fields: { username: 'secret-user', password: 'secret-password' }, config: { testUrl: 'https://api.example.test/me' } });
  assert.deepEqual(secrets.names(), []); assert.deepEqual(secrets.environment(), {});
  credentials.relabel(row.ref, { label: 'Renamed account', fields: { password: 'replacement-secret' } });
  assert.equal(credentials.fields(row.ref).username, 'secret-user'); assert.equal(credentials.fields(row.ref).password, 'replacement-secret');
  const metadata = credentials.metadata(credentials.row(row.ref)); assert.deepEqual(metadata.fieldPresence, { username: true, password: true });
  for (const secret of ['secret-user', 'secret-password', 'replacement-secret']) {
    assert.ok(!JSON.stringify(metadata).includes(secret)); assert.ok(!JSON.stringify(db.prepare('SELECT * FROM credentials').all()).includes(secret)); assert.ok(!readFileSync(file, 'utf8').includes(secret));
  }
  assert.throws(() => credentials.relabel(row.ref, { type: 'bearer' }), /change its type/);
  assert.throws(() => credentials.create({ label: 'Renamed account', type: 'bearer', fields: { token: 'other-token' } }), /already uses/);
  assert.throws(() => credentials.create({ label: 'Bad fields', type: 'bearer', config: { token: 'secret' }, fields: { token: 'token' } }), /Unknown/);
  assert.throws(() => credentials.create({ label: 'Bad headers', type: 'headers', fields: { headers: '{"Host":"attacker.test"}' } }), /Invalid/);
  assert.throws(() => credentials.create({ label: 'Bad URL', type: 'bearer', fields: { token: 'token' }, config: { testUrl: 'https://user:password@api.example.test/' } }), /without embedded/);
});

async function fixture(t: import('node:test').TestContext) {
  const requests: Array<{ url: string; headers: import('node:http').IncomingHttpHeaders; body: URLSearchParams }> = [];
  let challenge = '', tokenNumber = 0, refreshNumber = 0, fail = false;
  const server = createServer(async (request, response) => {
    let body = ''; for await (const part of request) body += part;
    const params = new URLSearchParams(body); requests.push({ url: request.url || '', headers: request.headers, body: params });
    response.setHeader('Content-Type', 'application/json');
    if (request.url === '/token') {
      if (fail) { response.writeHead(400).end('{"error":"invalid_grant"}'); return; }
      if (params.get('grant_type') === 'authorization_code') assert.equal(createHash('sha256').update(params.get('code_verifier') || '').digest('base64url'), challenge);
      if (params.get('grant_type') === 'refresh_token') refreshNumber++;
      response.end(JSON.stringify({ access_token: `access-token-${++tokenNumber}`, refresh_token: `refresh-token-${tokenNumber}`, token_type: 'Bearer', expires_in: 3600 }));
    } else response.end(JSON.stringify({ authorization: request.headers.authorization || request.headers['x-api-key'], ok: true }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const transport: CredentialTransport = async (url, options) => {
    const response = await fetch(`http://127.0.0.1:${address.port}${url.pathname}${url.search}`, { method: options.method, headers: options.headers, body: options.body });
    return { status: response.status, body: await response.text(), contentType: response.headers.get('content-type') || '' };
  };
  return { transport, requests, challenge: (value: string) => { challenge = value; }, refreshes: () => refreshNumber, fail: () => { fail = true; } };
}

test('OAuth code flow verifies PKCE, consumes state once, refreshes once concurrently, and requires reconnection after failure', async t => {
  const { credentials } = store(t), api = await fixture(t), oauth = new CredentialOAuth(credentials, api.transport);
  const row = credentials.create({ label: 'Browser OAuth', type: 'oauth2', config: { authorizationUrl: 'https://identity.example.test/authorize', tokenUrl: 'https://identity.example.test/token', clientId: 'app-id', scopes: 'read write' }, fields: { clientSecret: 'private-client-secret' } });
  const callback = `http://127.0.0.1:4317/v1/credentials/${row.ref}/oauth/callback`, connection = await oauth.connect(row.ref, 'browser-session', callback);
  assert.ok('authorizationUrl' in connection); const authorize = new URL(connection.authorizationUrl!); api.challenge(authorize.searchParams.get('code_challenge')!);
  assert.ok(!connection.authorizationUrl!.includes('private-client-secret'));
  await oauth.callback(row.ref, new URLSearchParams({ state: authorize.searchParams.get('state')!, code: 'one-use-code' }), callback);
  assert.equal(credentials.present(row.ref), true);
  await assert.rejects(oauth.callback(row.ref, new URLSearchParams({ state: authorize.searchParams.get('state')!, code: 'one-use-code' }), callback), /already used/);
  credentials.updateFields(row.ref, { expiresAt: '1' });
  await Promise.all([oauth.ready(row.ref), oauth.ready(row.ref), oauth.ready(row.ref)]);
  assert.equal(api.refreshes(), 1); assert.equal(credentials.fields(row.ref).refreshToken, 'refresh-token-2');
  credentials.updateFields(row.ref, { expiresAt: '1' }); api.fail();
  await assert.rejects(oauth.ready(row.ref), /reconnect/); assert.equal(credentials.row(row.ref).connection_status, 'needs-reconnection');
  oauth.disconnect(row.ref); assert.equal(credentials.fields(row.ref).accessToken, ''); assert.equal(credentials.present(row.ref), false);
});

test('OAuth outages leave the credential retryable instead of requiring reconnection', async t => {
  const { credentials } = store(t), api = await fixture(t);
  let outage: 'throw' | number | null = 'throw';
  const oauth = new CredentialOAuth(credentials, async (url, options) => { if (outage === 'throw') throw new Error('timed out'); if (outage) return { status: outage, body: '<html>busy</html>', contentType: 'text/html' }; return api.transport(url, options); });
  const row = credentials.create({ label: 'Flaky OAuth', type: 'oauth2', config: { grantType: 'client_credentials', tokenUrl: 'https://identity.example.test/token', clientId: 'server-app' }, fields: { clientSecret: 'server-client-secret' } });
  for (const failure of ['throw', 503, 429] as const) {
    outage = failure;
    await assert.rejects(oauth.ready(row.ref), /unavailable/); assert.equal(credentials.row(row.ref).connection_status, 'failed');
  }
  outage = null; await oauth.ready(row.ref);
  assert.equal(credentials.row(row.ref).connection_status, 'connected'); assert.equal(credentials.fields(row.ref).accessToken, 'access-token-1');
});

test('OAuth cancellation, configuration changes, and mismatched callbacks do not exchange tokens', async t => {
  const { credentials } = store(t), api = await fixture(t), oauth = new CredentialOAuth(credentials, api.transport);
  const row = credentials.create({ label: 'Cancelled OAuth', type: 'oauth2', config: { authorizationUrl: 'https://identity.example.test/authorize', tokenUrl: 'https://identity.example.test/token', clientId: 'app-id', clientAuth: 'none' } });
  const connect = async () => { const result = await oauth.connect(row.ref, 'session', 'http://127.0.0.1/callback'); return new URL(result.authorizationUrl!).searchParams.get('state')!; };
  await assert.rejects(oauth.callback(row.ref, new URLSearchParams({ state: await connect(), error: 'access_denied' }), 'http://127.0.0.1/callback'), /cancelled/);
  await assert.rejects(oauth.callback(row.ref, new URLSearchParams({ state: await connect(), code: 'code' }), 'http://127.0.0.1/wrong'), /expired/);
  const state = await connect(); credentials.relabel(row.ref, { config: { scopes: 'changed' } });
  await assert.rejects(oauth.callback(row.ref, new URLSearchParams({ state, code: 'code' }), 'http://127.0.0.1/callback'), /expired/);
  const secretState = await connect(); credentials.relabel(row.ref, { fields: { clientSecret: 'changed-secret' } });
  await assert.rejects(oauth.callback(row.ref, new URLSearchParams({ state: secretState, code: 'code' }), 'http://127.0.0.1/callback'), /expired/);
  const expiredState = await connect(), now = Date.now(); t.mock.method(Date, 'now', () => now + 11 * 60_000);
  await assert.rejects(oauth.callback(row.ref, new URLSearchParams({ state: expiredState, code: 'code' }), 'http://127.0.0.1/callback'), /expired/);
  assert.equal(api.requests.length, 0);
});

test('client credentials and API authentication resolve on the server and redact echoed secrets', async t => {
  const { credentials } = store(t), api = await fixture(t), oauth = new CredentialOAuth(credentials, api.transport);
  const row = credentials.create({ label: 'Server OAuth', type: 'oauth2', config: { grantType: 'client_credentials', tokenUrl: 'https://identity.example.test/token', clientId: 'server-app', clientAuth: 'basic' }, fields: { clientSecret: 'server-client-secret' } });
  await oauth.connect(row.ref, 'session', 'unused'); assert.equal(api.requests[0].body.get('grant_type'), 'client_credentials');
  const grant = { credentialRef: row.ref, allowedOrigins: ['https://api.example.test'], allowedMethods: ['GET'] };
  const result = await credentialApi(credentials, oauth, grant, { credentialRef: row.ref, url: 'https://api.example.test/account' }, api.transport);
  assert.ok(result.body.includes('[redacted]')); assert.ok(!result.body.includes('access-token'));
  const echoed = await credentialApi(credentials, oauth, grant, { credentialRef: row.ref, url: 'https://api.example.test/account' }, async () => ({ status: 200, contentType: credentials.fields(row.ref).accessToken, body: '' }));
  assert.equal(echoed.contentType, '[redacted]');
  await assert.rejects(credentialApi(credentials, oauth, grant, { credentialRef: row.ref, url: 'https://other.example.test/account' }, api.transport), /not granted/);
  await assert.rejects(credentialApi(credentials, oauth, grant, { credentialRef: row.ref, url: 'https://api.example.test/account', method: 'POST' }, api.transport), /not granted/);
  await assert.rejects(credentialApi(credentials, oauth, grant, { credentialRef: row.ref, url: 'https://api.example.test/account', headers: { Authorization: 'override' } }, api.transport), /not allowed/);
  const key = credentials.create({ label: 'Query key', type: 'api-key', fields: { value: 'query-private-key' }, config: { placement: 'query', parameterName: 'api_key' } });
  await assert.rejects(credentialApi(credentials, oauth, { ...grant, credentialRef: key.ref }, { credentialRef: key.ref, url: 'https://api.example.test/account?api_key=override' }, api.transport), /override/);
  let attempts = 0;
  await assert.rejects(credentialApi(credentials, oauth, { ...grant, allowedMethods: ['POST'] }, { credentialRef: row.ref, url: 'https://api.example.test/account', method: 'POST', body: { message: 'send once' } }, async () => { attempts++; throw new Error(credentials.fields(row.ref).accessToken); }), /\[redacted\]/);
  assert.equal(attempts, 1);
  const escapedSecret = 'secret"with\\escapes';
  assert.equal(redactCredential(JSON.stringify({ key: escapedSecret, query: encodeURIComponent(escapedSecret) }), { value: escapedSecret }), '{"key":"[redacted]","query":"[redacted]"}');
});

test('destination checks refuse metadata, loopback, insecure transport, and oversized requests', async () => {
  for (const address of ['127.0.0.1', '169.254.169.254', '::1', '0:0:0:0:0:0:0:1', '::ffff:127.0.0.1', '::ffff:7f00:1', '::127.0.0.1', '0.0.0.0']) assert.equal(addressKind(address), 'blocked');
  assert.equal(addressKind('10.1.2.3'), 'private'); assert.equal(addressKind('8.8.8.8'), 'public');
  await assert.rejects(credentialHttp(new URL('http://api.example.test/'), { method: 'GET', headers: {} }), /HTTPS/);
  await assert.rejects(credentialHttp(new URL('https://127.0.0.1/'), { method: 'GET', headers: {}, allowPrivate: true }), /not allowed/);
  await assert.rejects(credentialHttp(new URL('https://api.example.test/'), { method: 'POST', headers: {}, body: 'x'.repeat(1_000_001) }), /1 MB/);
});

test('HTTPS transport pins DNS, refuses redirects, bounds responses and aborts timed-out requests', async t => {
  let scenario = 'success', requests = 0;
  const controllers: AbortController[] = [];
  t.mock.method(dns, 'lookup', async () => [{ address: '8.8.8.8', family: 4 }]);
  t.mock.method(AbortSignal, 'timeout', (milliseconds: number) => { assert.equal(milliseconds, 30_000); const controller = new AbortController(); controllers.push(controller); return controller.signal; });
  t.mock.method(https, 'request', ((...args: unknown[]) => {
    requests++;
    const options = args[1] as { signal: AbortSignal; lookup: (host: string, options: { all?: boolean }, callback: (error: Error | null, address: string | Array<{ address: string; family: number }>, family?: number) => void) => void };
    options.lookup('api.example.test', {}, (error, address, family) => { assert.equal(error, null); assert.equal(address, '8.8.8.8'); assert.equal(family, 4); });
    options.lookup('api.example.test', { all: true }, (error: Error | null, addresses: unknown) => { assert.equal(error, null); assert.deepEqual(addresses, [{ address: '8.8.8.8', family: 4 }]); });
    const receive = args[2] as (response: unknown) => void, request = new EventEmitter();
    options.signal.addEventListener('abort', () => request.emit('error', new Error('timeout')), { once: true });
    Object.assign(request, { end: () => setImmediate(() => {
      if (scenario === 'timeout') { controllers.at(-1)!.abort(); return; }
      const response = Object.assign(new PassThrough(), { statusCode: scenario === 'redirect' ? 302 : 200, headers: { 'content-type': 'text/plain' } });
      receive(response); if (!response.destroyed) response.end(scenario === 'large' ? Buffer.alloc(1_000_001) : 'bounded response');
    }) });
    return request as import('node:http').ClientRequest;
  }) as typeof https.request);
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const call = () => credentialHttp(new URL('https://api.example.test/'), { method: 'GET', headers: {} });
  assert.equal((await call()).body, 'bounded response');
  scenario = 'redirect'; await assert.rejects(call(), /redirects/);
  scenario = 'large'; await assert.rejects(call(), /responses are limited/);
  scenario = 'timeout'; await assert.rejects(call(), /timed out/);
  assert.equal(requests, 4);
  t.mock.method(dns, 'lookup', async () => [{ address: '8.8.8.8', family: 4 }, { address: '169.254.169.254', family: 4 }]); syncBuiltinESMExports();
  await assert.rejects(call(), /not allowed/); assert.equal(requests, 4);
});

test('real HTTPS hostname requests work with Node automatic address-family selection', async t => {
  const address = Object.values(networkInterfaces()).flat().find(item => item?.family === 'IPv4' && !item.internal && addressKind(item.address) !== 'blocked')?.address;
  if (!address) { t.skip('Requires a non-loopback local IPv4 interface.'); return; }
  try { execFileSync('openssl', ['version'], { stdio: 'ignore' }); }
  catch { t.skip('Requires openssl to generate a disposable TLS certificate.'); return; }
  const directory = mkdtempSync(join(tmpdir(), 'credential-tls-')), keyPath = join(directory, 'key.pem'), certPath = join(directory, 'cert.pem');
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyPath, '-out', certPath, '-days', '1', '-subj', '/CN=api.example.test', '-addext', 'subjectAltName=DNS:api.example.test'], { stdio: 'ignore', timeout: 10_000 });
  let received = 0;
  const server = https.createServer({ key: readFileSync(keyPath), cert: readFileSync(certPath) }, (request, response) => {
    assert.equal(request.headers.authorization, 'Bearer disposable-fixture-only');
    received++; response.end('PINNED_TLS_729');
  });
  await new Promise<void>(resolve => server.listen(0, address, resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const binding = server.address(); assert.ok(binding && typeof binding !== 'string');
  const originalCa = https.globalAgent.options.ca;
  https.globalAgent.options.ca = readFileSync(certPath);
  t.mock.method(dns, 'lookup', async () => [{ address, family: 4 }]); syncBuiltinESMExports();
  t.after(() => { https.globalAgent.options.ca = originalCa; t.mock.restoreAll(); syncBuiltinESMExports(); });
  const response = await credentialHttp(new URL(`https://api.example.test:${binding.port}/account`), { method: 'GET', headers: { Authorization: 'Bearer disposable-fixture-only' }, allowPrivate: true });
  assert.equal(response.status, 200); assert.equal(response.body, 'PINNED_TLS_729'); assert.equal(received, 1);
});

test('MCP mappings compile only selected fields and survive encrypted runner delivery', async t => {
  const { directory } = store(t), profile = draftProfile({ id: 'mapped', name: 'Mapped', role: 'Assistant', description: '', tone: 0, instructions: '', memory: [] });
  const binding = { credentialRef: 'SERVICE_KEY', field: 'token', env: 'VENDOR_TOKEN' }, name = bindingSecretName(binding), secret = 'mapped-private-token';
  profile.connectors = [{ id: 'mapped-server', name: 'vendor', command: 'npx', args: ['server'], secretRef: '', enabled: true, credentialBindings: [binding] }];
  profile.credentialGrants = [{ credentialRef: 'SERVICE_KEY', allowedOrigins: ['https://api.example.test'], allowedMethods: ['GET'] }];
  profile.allowedTools.push(API_TOOL); const checked = validateProfile(profile);
  const keys = await generateRunnerKeyPair(), sealed = await encryptRunnerSecret(keys.publicKey, secret);
  assert.ok(!JSON.stringify(sealed).includes(secret)); const delivered = await decryptRunnerSecret(keys.privateKey, sealed);
  prepareProfile(directory, checked, { provider: 'local', model: 'mock', credentialRef: '', baseUrl: '' }, { environment: () => ({ [name]: delivered, UNSELECTED: 'do-not-deliver' }) }, 'agent-token', 'run-id');
  const home = join(directory, 'agents/mapped/profile'), config = readFileSync(join(home, 'config.yaml'), 'utf8'), env = readFileSync(join(home, '.env'), 'utf8');
  assert.ok(!config.includes(secret)); assert.ok(config.includes('VENDOR_TOKEN')); assert.ok(env.includes(secret)); assert.ok(!env.includes('do-not-deliver'));
  assert.throws(() => validateProfile({ ...profile, credentialGrants: [{ ...profile.credentialGrants![0], allowedOrigins: ['https://api.example.test/path'] }] }), /exact HTTPS origins/);
  // What the textarea produces after Enter, a pasted trailing slash, or an untouched new grant.
  const typed = validateProfile({ ...profile, credentialGrants: [{ ...profile.credentialGrants![0], allowedOrigins: [' https://API.example.test/', '', 'https://other.example.test\r', ''] }, { credentialRef: '', allowedOrigins: [''], allowedMethods: ['GET'] }] });
  assert.deepEqual(typed.credentialGrants, [{ credentialRef: 'SERVICE_KEY', allowedOrigins: ['https://api.example.test', 'https://other.example.test'], allowedMethods: ['GET'], allowPrivateNetwork: false }]);
  assert.throws(() => validateProfile({ ...profile, credentialGrants: [{ credentialRef: '', allowedOrigins: ['https://api.example.test'], allowedMethods: ['GET'] }] }), /Choose a credential/);
  assert.throws(() => validateProfile({ ...profile, credentialGrants: [{ ...profile.credentialGrants![0], allowedOrigins: ['', ' '] }] }), /between 1 and 30/);
});
