import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { assertProcessStopped } from './helpers/process-state';

test('stopped-process assertion rejects a live process but accepts an unreaped Unix child', { skip: process.platform === 'win32', timeout: 10_000 }, async t => {
  // Keep the parent alive without waitpid so the exited child remains a real
  // zombie on both Linux and macOS, independent of init's reaping behavior.
  const parent = spawn('python3', ['-u', '-c', `
import os, sys
child = os.fork()
if child == 0:
    os._exit(0)
print(child, flush=True)
sys.stdin.readline()
os.waitpid(child, 0)
`], { stdio: ['pipe', 'pipe', 'pipe'] });
  const closed = new Promise<void>(resolve => parent.once('close', () => resolve()));
  parent.stderr.resume();
  t.after(async () => {
    parent.stdin.end();
    const force = setTimeout(() => parent.kill('SIGKILL'), 3000);
    await closed; clearTimeout(force);
  });
  const pid = Number(await new Promise<string>((resolve, reject) => {
    parent.once('error', reject);
    parent.stdout.once('data', data => resolve(String(data).trim()));
  }));
  assert.ok(pid > 0);
  assert.throws(() => assertProcessStopped(parent.pid!), /still running/);
  const deadline = Date.now() + 5000;
  let state = '';
  do {
    state = spawnSync('ps', ['-p', String(pid), '-o', 'stat='], { encoding: 'utf8' }).stdout.trim();
    if (state.startsWith('Z')) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  } while (Date.now() < deadline);
  assert.match(state, /^Z/, 'Fixture child must exit without being reaped.');
  assertProcessStopped(pid);
  parent.stdin.end(); await closed;
  assertProcessStopped(pid);
});
