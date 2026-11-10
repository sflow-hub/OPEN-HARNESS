import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { TERMINAL_HELPER } from '../runtime/terminal-helper';

const python = process.platform === 'win32' ? false : spawnSync('python3', ['-c', 'import pty, fcntl'], { timeout: 5000, stdio: 'ignore' }).status === 0;
test('fixed Python helper creates a PTY, resizes it, transports Unicode and exits on input EOF', { skip: !python, timeout: 15000 }, async t => {
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
