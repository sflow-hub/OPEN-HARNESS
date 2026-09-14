import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
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
