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
    assert.equal(await call('/internal/schedule', 'scout'), 403);
    assert.equal(await call('/v1/agents/atlas/profile'), 403);
  } finally { await socket.close(); }
  await socket.close(); // shutdown is safe if more than one owner requests it
  assert.equal(existsSync(socket.path), false);
  if (process.platform === 'linux') assert.equal(existsSync(dirname(socket.socketPath)), false);
  else assert.equal(existsSync(dirname(dirname(socket.socketPath))), false);
  assert.equal(existsSync(dir), true);
});

test('hosted coordination preserves the coordinator base path and dispatch credential', async () => {
  let received: { url?: string; sites?: string } = {};
  const server = createServer((req, res) => { received = { url: req.url, sites: String(req.headers['oai-sites-authorization'] || '') }; req.resume(); req.on('end', () => { res.writeHead(201, { 'Content-Type': 'application/json' }); res.end('{"id":"routine-1"}'); }); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const child = spawn(process.execPath, [join(import.meta.dirname, '..', 'runtime', 'hermes', 'coordination.mjs')], { env: { ...process.env, OPEN_HARNESS_CONTROL_URL: `http://127.0.0.1:${address.port}/api/control`, OPEN_HARNESS_AGENT_ID: 'atlas', OPEN_HARNESS_AGENT_TOKEN: 'run-token', OPEN_HARNESS_RUN_ID: 'run-1', OPEN_HARNESS_SITES_TOKEN: 'dispatch-token' }, stdio: ['pipe', 'pipe', 'pipe'] });
  try {
    const reply = new Promise<string>((resolve, reject) => { child.stdout.once('data', part => resolve(String(part))); child.once('error', reject); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'create_open_harness_routine', arguments: { name: 'Daily', prompt: 'Review', intervalMinutes: 60 } } }) + '\n');
    const value = JSON.parse(await reply); assert.equal(value.result.content[0].text, '{"id":"routine-1"}');
    assert.equal(received.url, '/api/control/internal/schedule'); assert.equal(received.sites, 'Bearer dispatch-token');
  } finally { child.kill(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('the MCP subprocess dispatches tools over the private coordination socket', { skip: process.platform === 'win32', timeout: 5_000 }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'harness-mcp-socket-'));
  const socket = await coordinationSocket(join(root, 'long-workspace-name-'.repeat(8), 'managed'), 'atlas', (req, res) => {
    assert.equal(req.url, '/internal/task');
    assert.equal(req.headers.authorization, 'Bearer run-token');
    assert.equal(req.headers['x-open-harness-run'], 'run-1');
    req.resume(); req.on('end', () => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"boards":[],"tasks":[]}'); });
  });
  const child = spawn(process.execPath, [join(import.meta.dirname, '..', 'runtime', 'hermes', 'coordination.mjs')], {
    env: { NODE_ENV: 'test', OPEN_HARNESS_CONTROL_SOCKET: socket.socketPath, OPEN_HARNESS_AGENT_ID: 'atlas', OPEN_HARNESS_AGENT_TOKEN: 'run-token', OPEN_HARNESS_RUN_ID: 'run-1' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(async () => { child.kill(); await socket.close(); rmSync(root, { recursive: true, force: true }); });
  const reply = new Promise<string>((resolve, reject) => { child.stdout.once('data', part => resolve(String(part))); child.once('error', reject); });
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'task', arguments: { action: 'list' } } }) + '\n');
  const value = JSON.parse(await reply);
  assert.equal(value.error, undefined);
  assert.deepEqual(JSON.parse(value.result.content[0].text), { boards: [], tasks: [] });
});
