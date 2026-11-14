import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, request } from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { coordinationSocket } from '../runtime/coordination-socket';

test('coordination crosses a long workspace path and rejects other agents and APIs', { skip: process.platform === 'win32' }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'harness-socket-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const dir = join(root, 'a-long-workspace-name-'.repeat(8), 'managed');
  const socket = await coordinationSocket(dir, 'atlas', (_req, res) => { res.writeHead(200); res.end('allowed'); });
  assert.equal(socket.path, join(dir, 'coord.sock'));
  assert.ok(statSync(socket.path).isSocket());
  assert.equal(statSync(socket.path).mode & 0o777, 0o600);
  assert.equal(statSync(dir).mode & 0o777, 0o700);
  if (process.platform === 'linux') {
    assert.match(socket.socketPath, new RegExp(`^/proc/${process.pid}/fd/\\d+/coord\\.sock$`));
    assert.equal(statSync(dirname(socket.socketPath)).ino, statSync(dir).ino);
  }
  async function call(path: string, agent = 'atlas') {
    return new Promise<number>((resolve, reject) => {
      const req = request({ socketPath: socket.socketPath, path, method: 'POST', headers: { 'X-Open-Harness-Agent': agent } }, res => { res.resume(); res.on('end', () => resolve(res.statusCode!)); });
      req.on('error', reject); req.end();
    });
  }
  try {
    assert.equal(await call('/internal/handoff'), 200);
    for (const path of ['/internal/workspace', '/internal/group-chat', '/internal/review-tool', '/internal/tool-receipt']) {
      assert.equal(await call(path), 200);
      assert.equal(await call(path, 'scout'), 403);
    }
    assert.equal(await call('/internal/review-tool?bypass=1'), 403);
    assert.equal(await call('/internal/api-request'), 200);
    assert.equal(await call('/internal/api-request', 'scout'), 403);
    assert.equal(await call('/internal/schedule', 'scout'), 403);
    assert.equal(await call('/v1/agents/atlas/profile'), 403);
  } finally { await socket.close(); }
  await socket.close(); // shutdown is safe if more than one owner requests it
  assert.equal(existsSync(socket.path), false);
  if (process.platform === 'linux') assert.equal(existsSync(dirname(socket.socketPath)), false);
  else assert.equal(existsSync(dirname(dirname(socket.socketPath))), false);
  assert.equal(existsSync(dir), true);
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
    const inventory = new Promise<string>((resolve, reject) => { child.stdout.once('data', part => resolve(String(part))); child.once('error', reject); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }) + '\n');
    const project = JSON.parse(await inventory).result.tools.find((tool: { name: string }) => tool.name === 'project');
    assert.ok(project);
    assert.equal(project.inputSchema.properties.runStageId, undefined, 'Automatic-start stages must not be offered as agent-editable fields.');
    assert.equal(project.inputSchema.additionalProperties, false);
    assert.equal(project.inputSchema.properties.doneStageId.type, 'string');
  } finally { child.kill(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

// Pinned Hermes counts JSON-RPC errors and isError results as strikes, and three in a row block
// the whole server for about a minute ("unreachable after 3 consecutive failures"). A refusal
// means the coordinator is working, so it must reach the model as an ordinary result.
type Reply = { result: { content: Array<{ text: string }>; isError?: boolean }; error: { code: number } };
test('refusals are ordinary results, outages are isError, and keepalive pings are answered', async () => {
  const server = createServer((req, res) => {
    req.resume(); req.on('end', () => {
      if (req.url === '/internal/task') { res.writeHead(400, { 'Content-Type': 'application/json' }); res.end('{"error":"Missing title. Send it at the top level, next to action.","missing":["title"]}'); return; }
      if (req.url === '/internal/project') { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end('{"error":"Database is locked."}'); return; }
      res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('not json');
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const start = (url: string) => spawn(process.execPath, [join(import.meta.dirname, '..', 'runtime', 'hermes', 'coordination.mjs')], { env: { ...process.env, OPEN_HARNESS_CONTROL_SOCKET: join(tmpdir(), 'no-such-coordination.sock'), OPEN_HARNESS_CONTROL_URL: url, OPEN_HARNESS_AGENT_ID: 'atlas', OPEN_HARNESS_AGENT_TOKEN: 'run-token', OPEN_HARNESS_RUN_ID: 'run-1' }, stdio: ['pipe', 'pipe', 'pipe'] });
  const session = (child: ReturnType<typeof start>) => {
    const replies = new Map<number, (value: Reply) => void>(); let buffer = '';
    child.stdout.on('data', part => { buffer += part; let index; while ((index = buffer.indexOf('\n')) >= 0) { const value = JSON.parse(buffer.slice(0, index)); buffer = buffer.slice(index + 1); replies.get(value.id)?.(value); } });
    let id = 0;
    return (method: string, params?: unknown) => new Promise<Reply>(resolve => { id++; replies.set(id, resolve); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
  };
  const live = start(`http://127.0.0.1:${address.port}`), dead = start('http://127.0.0.1:9');
  try {
    const send = session(live);
    assert.deepEqual((await send('ping')).result, {});
    for (let attempt = 0; attempt < 3; attempt++) {
      const refused = await send('tools/call', { name: 'task', arguments: { action: 'create' } });
      assert.equal(refused.error, undefined); assert.equal(refused.result.isError, undefined);
      const text = JSON.parse(refused.result.content[0].text);
      assert.equal(text.ok, false); assert.deepEqual(text.missing, ['title']);
    }
    const failed = await send('tools/call', { name: 'project', arguments: { action: 'list' } });
    assert.equal(failed.result.isError, true); assert.match(failed.result.content[0].text, /Database is locked/);
    const unreadable = await send('tools/call', { name: 'runs', arguments: { action: 'list' } });
    assert.equal(unreadable.result.isError, true); assert.match(unreadable.result.content[0].text, /not caused by your arguments/);
    assert.equal((await send('tools/call', { name: 'no_such_tool', arguments: {} })).error.code, -32602);
    assert.equal((await send('resources/list')).error.code, -32601);
    const outage = await session(dead)('tools/call', { name: 'task', arguments: { action: 'list' } });
    assert.equal(outage.result.isError, true); assert.match(outage.result.content[0].text, /not reachable/);
  } finally { live.kill(); dead.kill(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

// The test above drives the socket with node's own http.request, and the one below it drives
// coordination.mjs over a URL. Neither exercised coordination.mjs over a socket -- which is how
// every local container agent reaches the coordinator -- and that path was broken outright:
// http.request(options, options, callback) makes node read the second argument as the response
// listener, so each coordination call failed inside the agent with "The listener argument must
// be of type function" and no coordination tool worked at all on the default local setup.
test('socket coordination through the agent-side server reaches the coordinator', { skip: process.platform === 'win32' }, async () => {
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
    env: { ...process.env, OPEN_HARNESS_CONTROL_SOCKET: socket.socketPath, OPEN_HARNESS_AGENT_ID: 'atlas', OPEN_HARNESS_AGENT_TOKEN: 'run-token', OPEN_HARNESS_RUN_ID: 'run-1' },
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
    const apiReply = new Promise<string>((resolve, reject) => { child.stdout.once('data', part => resolve(String(part))); child.once('error', reject); });
    const apiInput = { credentialRef: 'SERVICE_KEY', url: 'https://api.example.test/account', method: 'GET' };
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'api_request', arguments: apiInput } }) + '\n');
    const apiValue = JSON.parse(await apiReply);
    assert.equal(apiValue.error, undefined, JSON.stringify(apiValue.error));
    assert.equal(apiValue.result.content[0].text, '{"runId":"child-1","state":"completed"}');
    assert.equal(received.url, '/internal/api-request');
    assert.equal(received.agent, 'atlas');
    assert.equal(received.authorization, 'Bearer run-token');
    assert.equal(received.run, 'run-1');
    assert.deepEqual(JSON.parse(received.body!), apiInput);
  } finally { child.kill(); await socket.close(); }
});
