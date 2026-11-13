import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { draftProfile } from '../lib/agent-profile';
import { initialWorkspace } from '../lib/types';
import { prepareProfile } from '../runtime/profile-runtime';
import { Store } from '../runtime/db';
import { Profiles } from '../runtime/profiles';
import { processIdentity, recoverNativeProcess } from '../runtime/process-identity';

test('sandboxed model endpoints reach a configured host service and native profiles are refused', () => {
  const root = mkdtempSync(join(tmpdir(), 'harness-profile-safety-'));
  try {
    const profile = draftProfile(initialWorkspace.agents[0]);
    for (const access of ['private', 'folders'] as const) {
      prepareProfile(root, { ...profile, computer: { ...profile.computer, access } }, { provider: 'local', model: 'local-model', credentialRef: '', baseUrl: 'http://127.0.0.1:11434/v1' }, { environment: () => ({}) }, 'token', 'run');
      const config = JSON.parse(readFileSync(join(root, 'agents', profile.id, 'profile', 'config.yaml'), 'utf8'));
      assert.equal(config.model.base_url, 'http://host.docker.internal:11434/v1');
      assert.equal(config.tools.tool_search.enabled, 'off');
    }
    assert.throws(() => prepareProfile(root, { ...profile, computer: { ...profile.computer, access: 'direct' } }, profile.model, { environment: () => ({}) }, 'token', 'run'), /not sandboxed and is disabled/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('agent-planted profile temporary links cannot overwrite host files during the next run', () => {
  const root = mkdtempSync(join(tmpdir(), 'harness-profile-links-'));
  try {
    const profile = draftProfile(initialWorkspace.agents[0]);
    const prepare = () => prepareProfile(root, profile, { provider: 'mock', model: 'mock', credentialRef: 'MODEL_KEY', baseUrl: '' }, { environment: () => ({ MODEL_KEY: 'only-this-agent' }) }, 'token', 'run');
    prepare();
    const home = join(root, 'agents', profile.id, 'profile');
    for (const name of ['config.yaml', 'SOUL.md', '.env']) {
      const outside = join(root, `${name}.host`);
      writeFileSync(outside, 'Host data must survive.', { mode: 0o644 });
      symlinkSync(outside, join(home, `${name}.tmp`));
    }
    prepare();
    for (const name of ['config.yaml', 'SOUL.md', '.env']) {
      assert.equal(readFileSync(join(root, `${name}.host`), 'utf8'), 'Host data must survive.');
      if (process.platform !== 'win32') assert.equal(statSync(join(home, name)).mode & 0o777, 0o600);
    }
    assert.match(readFileSync(join(home, '.env'), 'utf8'), /only-this-agent/);
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


test('legacy conversion stages a safe remote target without changing the source before verification', () => {
  const store = new Store(':memory:'), profiles = new Profiles(store.db);
  try {
    const saved = profiles.save(draftProfile(initialWorkspace.agents[0]));
    const legacy = { ...saved, computer: { ...saved.computer, access: 'direct' as const, desktop: 'existing' as const } };
    store.db.prepare('UPDATE agent_profiles SET json=? WHERE id=?').run(JSON.stringify(legacy), saved.id);
    const target = { ...legacy, computer: { ...saved.computer, machineId: 'linux-runner', desktop: 'virtual' as const } };
    const staged = profiles.save(target, true);
    assert.equal(staged.computer.access, 'direct');
    assert.equal(staged.computer.machineId, 'local');
    assert.equal(staged.revision, saved.revision + 1);
    assert.throws(() => profiles.save({ ...legacy, revision: staged.revision }, true), /not sandboxed and is disabled/);
    const completed = profiles.applyTransferredProfile({ ...target, revision: staged.revision });
    assert.equal(completed.computer.access, 'private');
    assert.equal(completed.computer.desktop, 'virtual');
    assert.equal(completed.computer.machineId, 'linux-runner');
  } finally { store.db.close(); }
});
