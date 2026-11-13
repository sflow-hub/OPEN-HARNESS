import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { TERMINAL_HELPER } from '../runtime/terminal-helper';

const python = process.platform === 'win32' ? false : spawnSync('python3', ['-c', 'import pty, fcntl'], { timeout: 5000, stdio: 'ignore' }).status === 0;
// The helper runs inside Linux containers; Darwin has different zombie-group signaling semantics.
test('fixed Python helper creates a PTY, resizes it, transports Unicode and exits on input EOF', { skip: !python || process.platform !== 'linux', timeout: 15000 }, async t => {
  const cwd = mkdtempSync(join(tmpdir(), 'open-harness-pty-'));
  // Only the test working directory differs; production always uses the container shared workspace.
  const child = spawn('python3', ['-u', '-c', TERMINAL_HELPER.replace("os.chdir('/workspace/shared')", `os.chdir(${JSON.stringify(cwd)})`)], { stdio: ['pipe', 'pipe', 'pipe'] });
  t.after(() => { child.kill('SIGKILL'); rmSync(cwd, { recursive: true, force: true }); });
  let pending = '', output = '', stderr = ''; const frames: Array<{ type: string; data?: string; code?: number }> = [];
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.stdout.on('data', chunk => { pending += chunk; let index: number; while ((index = pending.indexOf('\n')) >= 0) { const item = JSON.parse(pending.slice(0, index)); pending = pending.slice(index + 1); frames.push(item); if (item.type === 'output') output += Buffer.from(item.data, 'base64').toString('utf8'); } });
  const send = (value: unknown) => child.stdin.write(JSON.stringify(value) + '\n');
  const input = (data: string) => send({ type: 'input', data: Buffer.from(data).toString('base64') });
  send({ type: 'resize', rows: 37, cols: 111 });
  input("printf '\\120\\124\\131\\137\\117\\113\\n'; stty size; printf '\\342\\230\\203\\n'\r");
  const deadline = Date.now() + 5000;
  while ((!output.includes('PTY_OK\r\n') || !output.includes('37 111\r\n') || !output.includes('☃')) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(output.includes('PTY_OK\r\n'), stderr || output); assert.ok(output.includes('37 111\r\n'), output); assert.ok(output.includes('☃'), output);
  const closed = once(child, 'close'); child.stdin.end(); const [code] = await closed;
  assert.equal(code, 0, stderr); assert.equal(frames.at(-1)?.type, 'exit'); assert.equal(typeof frames.at(-1)?.code, 'number');
});

test('terminal cleanup retains its child identity until group signaling finishes and rejects permission failures', { skip: !python }, () => {
  const cleanup = TERMINAL_HELPER.split('finally:\n')[1].replace(/^    /gm, '');
  const result = spawnSync('python3', ['-c', `
import errno, itertools, os, signal, time
from unittest.mock import patch
pid, master = 9182, 7
for scenario in ('exited', 'running', 'missing', 'denied', 'denied-kill'):
    calls, frames = [], []
    def killpg(group, kind):
        assert group == pid
        assert 'reaped' not in calls, 'Signaling after reaping can target a reused process group'
        calls.append(kind)
        if scenario == 'missing': raise ProcessLookupError(errno.ESRCH, 'Gone')
        if scenario == 'denied' or scenario == 'denied-kill' and kind == signal.SIGKILL: raise PermissionError(errno.EPERM, 'Cannot confirm group cleanup')
    def waitid(kind, child, options):
        assert child == pid and options & os.WNOWAIT
        return None if scenario == 'running' else object()
    def waitpid(child, options):
        assert child == pid and options == 0
        assert calls[-1] == signal.SIGKILL, 'The child must pin its PID until the final group signal'
        calls.append('reaped')
        return pid, 0
    clock = itertools.count(0, .6)
    emit = frames.append
    with patch.object(os, 'close'), patch.object(os, 'killpg', killpg), patch.object(os, 'waitid', waitid, create=True), patch.object(os, 'waitpid', waitpid), patch.object(time, 'monotonic', lambda: next(clock)), patch.object(time, 'sleep'):
        try:
            exec(${JSON.stringify(cleanup)})
        except PermissionError:
            assert scenario.startswith('denied')
        else:
            assert not scenario.startswith('denied'), 'Permission failures must not report successful cleanup'
    if scenario.startswith('denied'):
        assert not frames and 'reaped' not in calls
    else:
        assert frames == [{'type': 'exit', 'code': 0}]
        assert calls[-1] == 'reaped'
`], { encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 0, result.stderr);
});
