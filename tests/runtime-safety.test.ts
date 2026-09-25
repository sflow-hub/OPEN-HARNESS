import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { draftProfile } from '../lib/agent-profile';
import { initialWorkspace } from '../lib/types';
import { prepareProfile } from '../runtime/profile-runtime';
import { validateProfile } from '../runtime/profiles';
import { processIdentity, recoverNativeProcess } from '../runtime/process-identity';

test('container model endpoints reach the host while direct model endpoints stay local', () => {
  const root = mkdtempSync(join(tmpdir(), 'harness-profile-safety-'));
  try {
    const profile = draftProfile(initialWorkspace.agents[0]);
    for (const access of ['private', 'direct'] as const) {
      prepareProfile(root, { ...profile, computer: { ...profile.computer, access } }, { provider: 'local', model: 'local-model', credentialRef: '', baseUrl: 'http://127.0.0.1:11434/v1' }, { environment: () => ({}) }, 'token', 'run');
      const config = JSON.parse(readFileSync(join(root, 'agents', profile.id, 'profile', 'config.yaml'), 'utf8'));
      assert.equal(config.model.base_url, access === 'direct' ? 'http://127.0.0.1:11434/v1' : 'http://host.docker.internal:11434/v1');
      assert.equal(config.tools.tool_search.enabled, 'off');
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('restart cleanup stops the recorded process group and never signals a reused PID', { skip: process.platform === 'win32' }, async () => {
  const child = spawn(process.execPath, ['-e', "console.log('ready'); setInterval(() => {}, 1000)"], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
  const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
  try {
    await new Promise(resolve => child.stdout.once('data', resolve));
    assert.ok(child.pid);
    const identity = processIdentity(child.pid); assert.ok(identity);
    await recoverNativeProcess(child.pid, 'a different process creation time');
    assert.equal(processIdentity(child.pid), identity);
    await recoverNativeProcess(child.pid, identity);
    await exited;
    assert.equal(processIdentity(child.pid), null);
  } finally { if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; } }
});


test('connector names cannot shadow coordination or collide after Hermes canonicalization', () => {
  const profile = draftProfile(initialWorkspace.agents[0]);
  const connector = (name: string) => ({ id: name, name, command: 'node', args: [], secretRef: '', enabled: true });
  for (const names of [['open-harness'], ['open'], ['foo-bar', 'foo_bar'], ['foo', 'foo_bar']]) {
    assert.throws(() => validateProfile({ ...profile, connectors: names.map(connector) }), /distinct|prefix/);
  }
  assert.equal(validateProfile({ ...profile, connectors: ['research', 'files'].map(connector) }).connectors.length, 2);
});
