import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { draftProfile, type ModelChoice } from '../lib/agent-profile';
import { COMPOSE_LOCAL_MODEL_MESSAGE, modelEndpointIssue, testModelConnection } from '../runtime/model-validation';
import { containerBaseUrl, prepareProfile } from '../runtime/profile-runtime';

function environment(t: TestContext, deployment?: string) {
  const before = { OPEN_HARNESS_DEPLOYMENT: process.env.OPEN_HARNESS_DEPLOYMENT, OPEN_HARNESS_MOCK: process.env.OPEN_HARNESS_MOCK };
  t.after(() => { for (const [name, value] of Object.entries(before)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; } });
  if (deployment === undefined) delete process.env.OPEN_HARNESS_DEPLOYMENT; else process.env.OPEN_HARNESS_DEPLOYMENT = deployment;
  process.env.OPEN_HARNESS_MOCK = '0';
}
const model = (baseUrl: string): ModelChoice => ({ provider: 'custom', model: 'fixture-model', credentialRef: '', baseUrl });
const localEndpoints = [
  'http://localhost:11434/v1', 'http://LOCALHOST.:11434/v1', 'http://models.localhost:11434/v1',
  'http://127.0.0.1:11434/v1', 'http://127.123.45.67:11434/v1', 'http://127.1:11434/v1',
  'http://2130706433:11434/v1', 'http://0x7f000001:11434/v1', 'http://0177.0.0.1:11434/v1',
  'http://[::1]:11434/v1', 'http://[0:0:0:0:0:0:0:1]:11434/v1', 'http://[::ffff:127.1.2.3]:11434/v1',
  'http://0.0.0.0:11434/v1', 'http://[::]:11434/v1', 'http://[::ffff:0.0.0.0]:11434/v1',
  'http://host.docker.internal:11434/v1', 'http://HOST.DOCKER.INTERNAL.:11434/v1', 'http://gateway.docker.internal:11434/v1',
];

test('Compose refuses host-local model addresses before making any provider request', async t => {
  environment(t, 'compose');
  const fetch = t.mock.method(globalThis, 'fetch', () => { throw new Error('A blocked model address must not be contacted.'); });
  for (const endpoint of localEndpoints) {
    assert.equal(modelEndpointIssue(endpoint), COMPOSE_LOCAL_MODEL_MESSAGE, endpoint);
    assert.deepEqual(await testModelConnection(model(endpoint), 'private-fixture-key'), { ok: false, message: COMPOSE_LOCAL_MODEL_MESSAGE }, endpoint);
  }
  assert.equal(fetch.mock.callCount(), 0);
  assert.match(COMPOSE_LOCAL_MODEL_MESSAGE, /reachable from both the coordinator and agent containers/);
});

test('Compose profile preparation and URL translation reject the same endpoints before writing credentials', t => {
  environment(t, 'compose');
  const root = mkdtempSync(join(tmpdir(), 'open-harness-model-guard-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const profile = draftProfile({ id: 'model-guard', name: 'Model guard', role: 'Assistant', description: '', tone: 0, instructions: '', memory: [] });
  let secretReads = 0;
  for (const endpoint of localEndpoints) {
    assert.throws(() => containerBaseUrl(endpoint), { message: COMPOSE_LOCAL_MODEL_MESSAGE });
    assert.throws(() => prepareProfile(root, profile, model(endpoint), { environment: () => { secretReads++; return { MODEL_KEY: 'private-fixture-key' }; } }, 'agent-token', 'test-run'), { message: COMPOSE_LOCAL_MODEL_MESSAGE });
  }
  assert.equal(secretReads, 0); assert.deepEqual(readdirSync(root), []);
});

test('Compose keeps explicitly network-addressed model validation and cloud provider endpoints', async t => {
  environment(t, 'compose');
  for (const endpoint of ['https://model.example.test/v1', 'http://192.168.50.20:11434/v1', 'http://10.0.0.12:11434/v1', 'http://[fd00::12]:11434/v1']) assert.equal(modelEndpointIssue(endpoint), null);
  const requests: Array<{ url: string; options?: RequestInit }> = [];
  t.mock.method(globalThis, 'fetch', async (url: string | URL | Request, options?: RequestInit) => {
    requests.push({ url: String(url), options });
    return Response.json(String(url).endsWith('/models') ? { data: [{ id: 'fixture-model' }] } : { choices: [{ message: { content: 'OK' } }] });
  });
  const result = await testModelConnection(model('https://model.example.test/v1'), 'fixture-key');
  assert.equal(result.ok, true);
  assert.deepEqual(requests.map(request => request.url), ['https://model.example.test/v1/models', 'https://model.example.test/v1/chat/completions']);
  assert.ok(requests.every(request => request.options?.redirect === 'error' && new Headers(request.options.headers).get('authorization') === 'Bearer fixture-key'));
  requests.length = 0;
  assert.equal((await testModelConnection({ provider: 'openai', model: 'fixture-model', credentialRef: '', baseUrl: '' }, 'fixture-key')).ok, true);
  assert.deepEqual(requests.map(request => request.url), ['https://api.openai.com/v1/models', 'https://api.openai.com/v1/chat/completions']);
});

test('native and remote-runner validation still supports an explicitly configured local provider', async t => {
  environment(t);
  for (const endpoint of localEndpoints) assert.equal(modelEndpointIssue(endpoint), null);
  assert.equal(containerBaseUrl('http://127.0.0.1:11434/v1'), 'http://host.docker.internal:11434/v1');
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`); request.resume();
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(request.url === '/v1/models' ? { data: [{ id: 'fixture-model' }] } : { choices: [{ message: { content: 'OK' } }] }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  assert.equal((await testModelConnection(model(`http://127.0.0.1:${address.port}/v1`), '')).ok, true);
  assert.deepEqual(requests, ['GET /v1/models', 'POST /v1/chat/completions']);
});
