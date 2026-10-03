import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertProcessStopped } from './helpers/process-state';

async function fixture(behaviors: string[], shutdownMs = 4000) {
  const directory = await mkdtemp(join(tmpdir(), 'open-harness-supervisor-'));
  const entries = await Promise.all(behaviors.map(async (behavior, index) => {
    const entry = join(directory, `child-${index}.mjs`);
    await writeFile(entry, `import { writeFileSync } from 'node:fs';\n${behavior}\nconsole.log('READY:${index}:'+process.pid);\nsetInterval(()=>{}, 1000);`);
    return { entry, cwd: directory };
  }));
  const moduleUrl = new URL('../desktop/supervisor.mjs', import.meta.url).href;
  const child = spawn(process.execPath, ['--input-type=module', '-e', `import { supervise } from ${JSON.stringify(moduleUrl)}; process.exitCode = await supervise(${JSON.stringify(entries)}, ${shutdownMs});`], { stdio: 'pipe' });
  const closed = new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  let output = '';
  child.stdout.on('data', chunk => { output += String(chunk); });
  child.stderr.on('data', chunk => { output += String(chunk); });
  const pids = () => [...output.matchAll(/READY:(\d+):(\d+)/g)].sort((a, b) => Number(a[1]) - Number(b[1])).map(match => Number(match[2]));
  const forceStop = () => {
    for (const pid of pids()) { try { process.kill(pid, 'SIGKILL'); } catch {} }
    child.kill('SIGKILL');
  };
  const watchdog = setTimeout(forceStop, 7000);
  const cleanup = async () => {
    clearTimeout(watchdog);
    forceStop();
    await closed;
    await rm(directory, { recursive: true, force: true });
  };
  try {
    for (let attempt = 0; attempt < 200 && pids().length < entries.length; attempt++) {
      assert.equal(child.exitCode, null, output);
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.equal(pids().length, entries.length, output);
  } catch (error) { await cleanup(); throw error; }
  return { child, closed, directory, pids, cleanup };
}

test('supervisor waits for coordinator cleanup before exiting on TERM', { skip: process.platform === 'win32', timeout: 10000 }, async () => {
  const running = await fixture([
    "process.on('SIGTERM', () => { setTimeout(() => { writeFileSync('cleaned', 'done'); process.exit(0); }, 1300); });",
    "process.on('SIGTERM', () => process.exit(0));",
  ]);
  try {
    running.child.kill('SIGTERM');
    assert.equal(await running.closed, 0);
    assert.equal(await readFile(join(running.directory, 'cleaned'), 'utf8'), 'done');
    for (const pid of running.pids()) assertProcessStopped(pid);
  } finally { await running.cleanup(); }
});

test('supervisor force-stops an unresponsive service after its shutdown deadline', { skip: process.platform === 'win32', timeout: 10000 }, async () => {
  const running = await fixture(["process.on('SIGTERM', () => {});"], 150);
  try {
    running.child.kill('SIGTERM');
    assert.equal(await running.closed, 1);
    for (const pid of running.pids()) assertProcessStopped(pid);
  } finally { await running.cleanup(); }
});

test('an unexpected service failure shuts down its peer and waits for cleanup', { skip: process.platform === 'win32', timeout: 10000 }, async () => {
  const running = await fixture([
    "process.on('SIGUSR2', () => process.exit(2));",
    "process.on('SIGTERM', () => { setTimeout(() => { writeFileSync('cleaned', 'done'); process.exit(0); }, 250); });",
  ]);
  try {
    process.kill(running.pids()[0], 'SIGUSR2');
    assert.equal(await running.closed, 2);
    assert.equal(await readFile(join(running.directory, 'cleaned'), 'utf8'), 'done');
    for (const pid of running.pids()) assertProcessStopped(pid);
  } finally { await running.cleanup(); }
});
