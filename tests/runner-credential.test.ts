import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encryptRunnerSecret } from '../lib/runner-crypto';

test('paired runner decrypts a dashboard credential into its local vault', async () => {
  const state = mkdtempSync(join(tmpdir(), 'open-harness-runner-secret-'));
  const cleartext = 'provider-key-kept-off-the-coordinator';
  let publicKey = '', delivered = false, completed: Record<string, unknown> | null = null;
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
    response.setHeader('Content-Type', 'application/json');
    if (request.url === '/v1/runner/pair') { publicKey = body.encryptionPublicKey; response.end(JSON.stringify({ machineId: 'machine-secret-test', token: 'runner-token' })); return; }
    if (request.url === '/v1/runner/heartbeat') { response.end(JSON.stringify({ ok: true })); return; }
    if (request.url === '/v1/runner/commands' && !delivered) {
      const encrypted = await encryptRunnerSecret(publicKey, cleartext); delivered = true;
      assert.doesNotMatch(JSON.stringify(encrypted), /kept-off-the-coordinator/);
      response.end(JSON.stringify({ commands: [{ id: 'store-secret-1', agentId: '', kind: 'store-secret', payload: { name: 'OPENAI_API_KEY', encrypted }, createdAt: new Date().toISOString() }] })); return;
    }
    if (request.url === '/v1/runner/commands/store-secret-1/complete') { completed = body; response.end(JSON.stringify({ ok: true })); return; }
    response.end(JSON.stringify({ commands: [] }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Test server did not bind.');
  const child = spawn(process.execPath, ['runtime/runner.mjs', '--coordinator', `http://127.0.0.1:${address.port}`, '--pairing-code', 'pair-once'], { cwd: join(import.meta.dirname, '..'), env: { ...process.env, OPEN_HARNESS_DISABLE_OS_VAULT: '1', OPEN_HARNESS_RUNNER_STATE_DIR: state }, stdio: 'pipe' });
  try {
    const deadline = Date.now() + 10_000;
    while (!completed && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50));
    assert.ok(completed, 'runner did not confirm credential storage');
    assert.equal((completed as { result?: { stored?: boolean } }).result?.stored, true);
    const vault = JSON.parse(readFileSync(join(state, 'secrets.json'), 'utf8'));
    assert.equal(vault.OPENAI_API_KEY, cleartext);
    assert.equal(JSON.parse(readFileSync(join(state, 'connection.json'), 'utf8')).encryptionPrivateKey.includes(cleartext), false);
  } finally { child.kill('SIGTERM'); await new Promise<void>(resolve => server.close(() => resolve())); }
});
