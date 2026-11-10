import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';

const repository = resolve(import.meta.dirname, '..');

test('the downloadable runner starts outside the checkout without installed packages', async t => {
  const root = await mkdtemp(join(tmpdir(), 'oh-packaged-runner-')); t.after(() => rm(root, { recursive: true, force: true }));
  await cp(join(repository, 'runtime/runner.mjs'), join(root, 'runner.mjs'));
  const state = join(root, 'state'); await mkdir(state);
  await writeFile(join(state, 'connection.json'), JSON.stringify({ coordinator: 'https://coordinator.invalid', machineId: 'isolated-runner', token: 'fixture', encryptionPublicKey: 'fixture', encryptionPrivateKey: 'fixture' }), { mode: 0o600 });
  const result = spawnSync(process.execPath, [join(root, 'runner.mjs'), '--once', '1'], { cwd: root, encoding: 'utf8', timeout: 15000, env: { ...process.env, NODE_PATH: '', OPEN_HARNESS_DISABLE_OS_VAULT: '1', OPEN_HARNESS_RUNNER_STATE_DIR: state } });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  assert.match(result.stdout, /Paired isolated-runner\./);
});

test('the control-plane image supplies every source dependency before bundling', async t => {
  const root = await mkdtemp(join(tmpdir(), 'oh-control-plane-build-')); t.after(() => rm(root, { recursive: true, force: true }));
  const builder = (await readFile(join(repository, 'Dockerfile.control-plane'), 'utf8')).split(/^FROM /m)[1];
  for (const match of builder.matchAll(/^COPY ([^\n]+)$/gm)) {
    const parts = match[1].trim().split(/\s+/), destination = parts.pop()!;
    for (const source of parts) {
      const target = resolve(root, destination, destination.endsWith('/') ? basename(source) : '');
      await mkdir(dirname(target), { recursive: true });
      await cp(join(repository, source), target, { recursive: true });
    }
  }
  await build({ entryPoints: [join(root, 'control-plane/server.ts')], outfile: join(root, 'server.mjs'), bundle: true, platform: 'node', format: 'esm', target: 'node22', packages: 'external', logLevel: 'silent' });
});
