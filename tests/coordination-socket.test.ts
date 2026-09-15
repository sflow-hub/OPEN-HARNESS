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
