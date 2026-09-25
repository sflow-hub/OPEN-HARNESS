import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, openSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { coordinationSocket } from '../runtime/coordination-socket';

test('coordination crosses a long workspace path and rejects other agents and APIs', async () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'harness-socket-')), 'a-long-workspace-name-'.repeat(8), 'managed');
  const socket = await coordinationSocket(dir, 'atlas', (_req, res) => { res.writeHead(200); res.end('allowed'); });
  const fd = openSync(dir, 'r');
  async function call(path: string, agent = 'atlas') {
    return new Promise<number>((resolve, reject) => {
      const req = request({ socketPath: `/proc/self/fd/${fd}/coord.sock`, path, method: 'POST', headers: { 'X-Open-Harness-Agent': agent } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode!)); });
      req.on('error', reject); req.end();
    });
  }
  try {
    assert.equal(await call('/internal/handoff'), 200);
    assert.equal(await call('/internal/schedule', 'scout'), 403);
    assert.equal(await call('/v1/agents/atlas/profile'), 403);
  } finally { closeSync(fd); await socket.close(); }
});

test('http coordination preserves the coordinator base path and the agent token', async () => {
  let received: { url?: string; agent?: string; authorization?: string } = {};
  const server = createServer((req, res) => { received = { url: req.url, agent: String(req.headers['x-open-harness-agent'] || ''), authorization: String(req.headers.authorization || '') }; req.resume(); req.on('end', () => { res.writeHead(201, { 'Content-Type': 'application/json' }); res.end('{"id":"routine-1"}'); }); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const child = spawn(process.execPath, [join(import.meta.dirname, '..', 'runtime', 'hermes', 'coordination.mjs')], { env: { ...process.env, OPEN_HARNESS_CONTROL_URL: `http://127.0.0.1:${address.port}/api/local`, OPEN_HARNESS_AGENT_ID: 'atlas', OPEN_HARNESS_AGENT_TOKEN: 'run-token', OPEN_HARNESS_RUN_ID: 'run-1' }, stdio: ['pipe', 'pipe', 'pipe'] });
  try {
    const reply = new Promise<string>((resolve, reject) => { child.stdout.once('data', part => resolve(String(part))); child.once('error', reject); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'create_open_harness_routine', arguments: { name: 'Daily', prompt: 'Review', intervalMinutes: 60 } } }) + '\n');
    const value = JSON.parse(await reply); assert.equal(value.result.content[0].text, '{"id":"routine-1"}');
    assert.equal(received.url, '/api/local/internal/schedule'); assert.equal(received.agent, 'atlas'); assert.equal(received.authorization, 'Bearer run-token');
  } finally { child.kill(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

// The test above drives the socket with node's own http.request, and the one below it drives
// coordination.mjs over a URL. Neither exercised coordination.mjs over a socket -- which is how
// every local container agent reaches the coordinator -- and that path was broken outright:
// http.request(options, options, callback) makes node read the second argument as the response
// listener, so each coordination call failed inside the agent with "The listener argument must
// be of type function" and no coordination tool worked at all on the default local setup.
test('socket coordination through the agent-side server reaches the coordinator', async () => {
  const dir = join(mkdtempSync(join(tmpdir(), 'harness-socket-call-')), 'managed');
  let received: { url?: string; agent?: string; authorization?: string; run?: string; body?: string } = {};
  const socket = await coordinationSocket(dir, 'atlas', (req, res) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      received = { url: req.url, agent: String(req.headers['x-open-harness-agent'] || ''), authorization: String(req.headers.authorization || ''), run: String(req.headers['x-open-harness-run'] || ''), body };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"runId":"child-1","state":"completed"}');
    });
  });
  // A separate process cannot borrow this one's /proc/self/fd handle, and it does not need to:
  // in a container the socket is /run/open-harness/coord.sock, well inside the 108-byte limit.
  const child = spawn(process.execPath, [join(import.meta.dirname, '..', 'runtime', 'hermes', 'coordination.mjs')], {
    env: { ...process.env, OPEN_HARNESS_CONTROL_SOCKET: join(dir, 'coord.sock'), OPEN_HARNESS_AGENT_ID: 'atlas', OPEN_HARNESS_AGENT_TOKEN: 'run-token', OPEN_HARNESS_RUN_ID: 'run-1' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  try {
    const reply = new Promise<string>((resolve, reject) => { child.stdout.once('data', part => resolve(String(part))); child.once('error', reject); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'delegate_named_agent', arguments: { agentId: 'scout', prompt: 'Write the file' } } }) + '\n');
    const value = JSON.parse(await reply);
    assert.equal(value.error, undefined, JSON.stringify(value.error));
    assert.equal(value.result.content[0].text, '{"runId":"child-1","state":"completed"}');
    assert.equal(received.url, '/internal/handoff');
    assert.equal(received.agent, 'atlas');
    assert.equal(received.authorization, 'Bearer run-token');
    assert.equal(received.run, 'run-1');
    assert.deepEqual(JSON.parse(received.body!), { agentId: 'scout', prompt: 'Write the file' });
  } finally { child.kill(); await socket.close(); }
});
