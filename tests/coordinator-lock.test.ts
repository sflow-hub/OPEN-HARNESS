import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { acquireCoordinatorLock } from '../runtime/coordinator-lock';

const childSource = `
import { acquireCoordinatorLock } from ${JSON.stringify(new URL('../runtime/coordinator-lock.ts', import.meta.url).href)};
try {
  const release = acquireCoordinatorLock(process.argv[1]);
  process.on('message', () => { release(); release(); process.exit(0); });
  process.send({ acquired: true });
} catch (error) {
  process.send({ acquired: false, error: error.message }, () => process.exit(2));
}
`;
function contender(state: string) {
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', childSource, state], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  let output = '';
  child.stdout!.on('data', data => output += data);
  child.stderr!.on('data', data => output += data);
  const exited = new Promise<number | null>(resolve => child.once('close', resolve));
  const ready = new Promise<{ acquired: boolean; error?: string }>((resolve, reject) => {
    child.once('message', message => resolve(message as { acquired: boolean; error?: string }));
    child.once('error', reject);
    child.once('exit', code => reject(new Error(`Lock child exited ${code}: ${output}`)));
  });
  return { child, ready, exited, async stop() { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); await exited; } };
}
function fixture(t: TestContext) {
  const state = mkdtempSync(join(tmpdir(), 'harness-owner-'));
  const children: ReturnType<typeof contender>[] = [], releases: (() => void)[] = [];
  t.after(async () => {
    await Promise.all(children.map(child => child.stop()));
    for (const release of releases) release();
    rmSync(state, { recursive: true, force: true });
  });
  return {
    state,
    child(path = state) { const child = contender(path); children.push(child); return child; },
    lock(path = state) { const release = acquireCoordinatorLock(path); releases.push(release); return release; },
  };
}

test('state ownership refuses a second process until the owner releases', { timeout: 15_000 }, async t => {
  const f = fixture(t), owner = f.child();
  assert.deepEqual(await owner.ready, { acquired: true });
  if (process.platform !== 'win32') assert.equal(statSync(join(f.state, 'coordinator.lock.db')).mode & 0o777, 0o600);
  const refused = f.child();
  const result = await refused.ready;
  assert.equal(result.acquired, false);
  assert.match(result.error!, /^Another coordinator already owns this state directory:/);
  assert.equal(await refused.exited, 2);
  owner.child.send('release'); assert.equal(await owner.exited, 0);
  const next = f.child();
  assert.deepEqual(await next.ready, { acquired: true });
});

test('forced owner termination releases state ownership without deleting its lock file', { timeout: 15_000 }, async t => {
  const f = fixture(t), owner = f.child();
  assert.deepEqual(await owner.ready, { acquired: true });
  await owner.stop();
  assert.ok(statSync(join(f.state, 'coordinator.lock.db')).isFile());
  const next = f.child();
  assert.deepEqual(await next.ready, { acquired: true });
});

test('failed acquisition in the same process preserves ownership and separate states remain independent', { timeout: 15_000 }, async t => {
  const f = fixture(t), otherState = join(f.state, 'other'); mkdirSync(otherState);
  const release = f.lock(); f.lock(otherState);
  assert.throws(() => acquireCoordinatorLock(f.state), /Another coordinator already owns this state directory/);
  const refused = f.child();
  assert.equal((await refused.ready).acquired, false);
  assert.equal(await refused.exited, 2);
  release(); release();
  const next = f.child();
  assert.deepEqual(await next.ready, { acquired: true });
});

test('invalid lock database preserves the underlying error and file', async t => {
  const f = fixture(t), path = join(f.state, 'coordinator.lock.db');
  writeFileSync(path, 'invalid sqlite contents');
  assert.throws(() => acquireCoordinatorLock(f.state), /file is not a database/);
  assert.equal(readFileSync(path, 'utf8'), 'invalid sqlite contents');
});
