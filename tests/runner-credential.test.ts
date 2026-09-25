import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encryptRunnerSecret } from '../lib/runner-crypto';

// A generous budget: these loops only need to outlast a slow or loaded machine, and
// `npm test --test-timeout` is the real backstop. Fixed iteration counts gave them four
// seconds, which a busy runner could exceed while the coordinator was working correctly.
const POLL_BUDGET_MS = 30_000;

test('paired runner decrypts a dashboard credential into its local vault', async () => {
  const state = mkdtempSync(join(tmpdir(), 'open-harness-runner-secret-'));
  const cleartext = 'provider-key-kept-off-the-coordinator';
  // A wedged Docker daemon (socket present, never answers) must not delay pairing or command
  // pickup: this fake `docker` blocks forever like the real CLI would, so the assertion below
  // fails on the old synchronous capabilities() and passes on the fixed async one.
  let binDir = '';
  if (process.platform !== 'win32') {
    binDir = join(state, 'bin'); mkdirSync(binDir, { recursive: true });
    writeFileSync(join(binDir, 'docker'), '#!/bin/sh\nexec sleep 30\n', { mode: 0o755 }); chmodSync(join(binDir, 'docker'), 0o755);
  }
  let publicKey = '', delivered = false, completed: Record<string, unknown> | null = null, pairedAt = 0, firstPollAt = 0;
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
    response.setHeader('Content-Type', 'application/json');
    if (request.url === '/v1/runner/pair') { publicKey = body.encryptionPublicKey; pairedAt = Date.now(); response.end(JSON.stringify({ machineId: 'machine-secret-test', token: 'runner-token' })); return; }
    if (request.url === '/v1/runner/heartbeat') { response.end(JSON.stringify({ ok: true })); return; }
    if (request.url === '/v1/runner/commands') {
      if (!firstPollAt) firstPollAt = Date.now();
      if (!delivered) {
        const encrypted = await encryptRunnerSecret(publicKey, cleartext); delivered = true;
        assert.doesNotMatch(JSON.stringify(encrypted), /kept-off-the-coordinator/);
        response.end(JSON.stringify({ commands: [{ id: 'store-secret-1', agentId: '', kind: 'store-secret', payload: { name: 'OPENAI_API_KEY', encrypted }, createdAt: new Date().toISOString() }] })); return;
      }
    }
    if (request.url === '/v1/runner/commands/store-secret-1/complete') { completed = body; response.end(JSON.stringify({ ok: true })); return; }
    response.end(JSON.stringify({ commands: [] }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Test server did not bind.');
  const child = spawn(process.execPath, ['runtime/runner.mjs', '--coordinator', `http://127.0.0.1:${address.port}`, '--pairing-code', 'pair-once'], { cwd: join(import.meta.dirname, '..'), env: { ...process.env, ...(binDir ? { PATH: `${binDir}:${process.env.PATH || ''}` } : {}), OPEN_HARNESS_DISABLE_OS_VAULT: '1', OPEN_HARNESS_RUNNER_STATE_DIR: state }, stdio: 'pipe' });
  try {
    const deadline = Date.now() + POLL_BUDGET_MS;
    while (!completed && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
    assert.ok(completed, 'runner did not confirm credential storage');
    assert.equal((completed as { result?: { stored?: boolean } }).result?.stored, true);
    if (binDir) assert.ok(firstPollAt - pairedAt < 3_000, `runner blocked on host probes before polling (${firstPollAt - pairedAt}ms)`);
    const vault = JSON.parse(readFileSync(join(state, 'secrets.json'), 'utf8'));
    assert.equal(vault.OPENAI_API_KEY, cleartext);
    assert.equal(JSON.parse(readFileSync(join(state, 'connection.json'), 'utf8')).encryptionPrivateKey.includes(cleartext), false);
  } finally { child.kill('SIGTERM'); await new Promise<void>(resolve => server.close(() => resolve())); }
});
