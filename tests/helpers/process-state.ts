import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

// A zombie has exited and cannot execute. Its PID remains visible until its
// parent (or init, for orphaned tool processes) reaps it, which is asynchronous.
export function assertProcessStopped(pid: number) {
  try { process.kill(pid, 0); }
  catch (error) {
    assert.equal((error as NodeJS.ErrnoException).code, 'ESRCH');
    return;
  }
  if (process.platform === 'win32') assert.fail(`Process ${pid} is still running.`);
  const result = spawnSync('ps', ['-p', String(pid), '-o', 'stat='], { encoding: 'utf8', timeout: 5000 });
  assert.ifError(result.error);
  const state = result.stdout.trim();
  // It may have been reaped between kill(0) and ps.
  if (result.status === 1 && !state) return;
  assert.equal(result.status, 0, `Could not inspect process ${pid}: ${result.stderr}`);
  assert.match(state, /^Z/, `Process ${pid} is still running (state ${state}).`);
}
