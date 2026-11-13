import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_COMPUTER } from '../lib/agent-profile';
import { encryptRunnerSecret, generateRunnerKeyPair } from '../lib/runner-crypto';

test('runner desktop input is encrypted and ephemeral even when delivery fails', async t => {
  const root = mkdtempSync(join(tmpdir(), 'open-harness-ephemeral-desktop-')), encryption = await generateRunnerKeyPair();
  const batches: unknown[][] = [], results = new Map<string, { result?: { ok?: boolean }; error?: string }>();
  let output = '', dropped = 0;
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const match = req.url?.match(/^\/v1\/runner\/desktop\/([^/]+)\/complete$/);
    if (match?.[1] === 'drop') { dropped++; req.socket.destroy(); return; }
    if (match) results.set(match[1], JSON.parse(raw));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(req.method === 'GET' ? { commands: batches.shift() || [] } : { ok: true }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  writeFileSync(join(root, 'connection.json'), JSON.stringify({ coordinator: `http://127.0.0.1:${(server.address() as { port: number }).port}`, machineId: 'fixture', token: 'fixture', encryptionPublicKey: encryption.publicKey, encryptionPrivateKey: encryption.privateKey }), { mode: 0o600 });
  const runner = spawn(process.execPath, ['--import', 'tsx', 'runtime/runner.ts'], { cwd: join(import.meta.dirname, '..'), env: { ...process.env, OPEN_HARNESS_RUNNER_STATE_DIR: root, OPEN_HARNESS_DISABLE_OS_VAULT: '1', OPEN_HARNESS_MOCK: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  runner.stdout.on('data', data => { output += data; }); runner.stderr.on('data', data => { output += data; });
  t.after(async () => { runner.kill('SIGTERM'); if (runner.exitCode === null && runner.signalCode === null) await new Promise(resolve => runner.once('exit', resolve)); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(root, { recursive: true, force: true }); });
  async function until(check: () => boolean) { const end = Date.now() + 10_000; while (!check()) { if (Date.now() > end) throw new Error(`Runner did not deliver: ${output}`); await new Promise(resolve => setTimeout(resolve, 25)); } }
  const profile = { id: 'atlas', computer: { ...DEFAULT_COMPUTER, desktop: 'virtual' } };
  const input = { type: 'text', text: 'sensitive-desktop-password-fixture' };
  const encrypted = await encryptRunnerSecret(encryption.publicKey, JSON.stringify(input));
  const command = (id: string, payload: object) => ({ id, agentId: 'atlas', kind: 'desktop', payload: { profile, expiresAt: Date.now() + 20_000, ...payload } });
  batches.push([command('accepted', { action: 'input', encrypted })]);
  await until(() => results.has('accepted')); assert.equal(results.get('accepted')?.result?.ok, true);
  batches.push([command('plaintext', { action: 'input', input })]);
  await until(() => results.has('plaintext')); assert.ok(results.get('plaintext')?.error);
  batches.push([command('expired', { action: 'input', encrypted, expiresAt: Date.now() - 1 })]);
  await until(() => results.has('expired')); assert.ok(results.get('expired')?.error);
  batches.push([command('missing-deadline', { action: 'input', encrypted, expiresAt: undefined })]);
  await until(() => results.has('missing-deadline')); assert.ok(results.get('missing-deadline')?.error);
  batches.push([command('drop', { action: 'input', encrypted })]); await until(() => dropped >= 2);
  assert.deepEqual(readdirSync(join(root, 'spool')), []);
  for (const name of ['secrets.json', 'connection.json']) assert.equal(readFileSync(join(root, name), 'utf8').includes(input.text), false);
  assert.equal(JSON.stringify([...results.values()]).includes(input.text), false);
  assert.equal(output.includes(input.text), false);
});
