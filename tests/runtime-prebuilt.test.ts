import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { RUNTIME_CONTRACT } from '../runtime/readiness';

test('release setup pulls the pinned runtime and refuses failures without a source-build fallback', { skip: process.platform === 'win32' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'oh-prebuilt-')), log = join(root, 'docker.jsonl');
  const ref = `registry.example/open-harness-hermes@sha256:${'a'.repeat(64)}`;
  writeFileSync(join(root, 'docker'), `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FIXTURE_LOG, JSON.stringify(args) + '\\n');
if (args[0] === 'version') console.log('29.8.1');
else if (args[0] === 'pull') { if (process.env.FIXTURE_PULL_FAIL === '1') { console.error('download refused'); process.exit(1); } }
else if (args[0] === 'image') console.log(process.env.FIXTURE_CONTRACT);
else { console.error('unexpected Docker operation'); process.exit(2); }
`, { mode: 0o700 });
  const run = (extra: Record<string, string> = {}) => {
    writeFileSync(log, '');
    const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `import { prepareRuntime } from './runtime/readiness.ts'; await prepareRuntime();`], {
      cwd: join(import.meta.dirname, '..'), encoding: 'utf8', timeout: 20_000,
      env: { ...process.env, PATH: `${root}:${process.env.PATH}`, OPEN_HARNESS_HERMES_IMAGE: ref, OPEN_HARNESS_HERMES_PULL: '1', FIXTURE_LOG: log, FIXTURE_CONTRACT: String(RUNTIME_CONTRACT), ...extra },
    });
    const calls = readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as string[]);
    assert.ok(!calls.some(args => args[0] === 'build'), 'A release must never silently rebuild from other source.');
    return { result, calls };
  };
  try {
    const ready = run();
    assert.equal(ready.result.status, 0, ready.result.stderr);
    assert.deepEqual(ready.calls.find(args => args[0] === 'pull'), ['pull', ref]);
    assert.ok(ready.calls.some(args => args[0] === 'image'), 'Downloaded runtime contract is checked before success.');
    const failed = run({ FIXTURE_PULL_FAIL: '1' });
    assert.notEqual(failed.result.status, 0);
    assert.match(failed.result.stderr, /could not download a required file/);
    assert.ok(!failed.calls.some(args => args[0] === 'image'));
    const stale = run({ FIXTURE_CONTRACT: String(RUNTIME_CONTRACT - 1) });
    assert.notEqual(stale.result.status, 0);
    assert.match(stale.result.stderr, /does not match this Open Harness release/);
    const floating = run({ OPEN_HARNESS_HERMES_IMAGE: 'registry.example/hermes:latest' });
    assert.notEqual(floating.result.status, 0);
    assert.match(floating.result.stderr, /missing its pinned agent image/);
    assert.equal(floating.calls.length, 0, 'Invalid release references fail before Docker is touched.');
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('CLI streams Docker output and browser preparation reports bounded failure details and the correct deadline', { skip: process.platform === 'win32' }, () => {
  const root = mkdtempSync(join(tmpdir(), 'oh-build-progress-'));
  writeFileSync(join(root, 'docker'), `#!${process.execPath}
const action = process.argv[2];
if (action === 'version') { console.log('29.8.1'); }
else if (action === 'build' || action === 'pull') {
  console.log('#37 [7/9] installing runtime dependencies');
  console.error('Failed to fetch https://private.example/download?token=test-only-sensitive');
  if (process.env.FIXTURE_HANG) setInterval(() => {}, 1000);
  else process.exitCode = 17;
} else process.exitCode = 2;
`, { mode: 0o700 });
  const env = { ...process.env, OPEN_HARNESS_MOCK: '0', OPEN_HARNESS_HERMES_PULL: '0', OPEN_HARNESS_STATE_DIR: root, PATH: root + ':' + process.env.PATH };
  const options = { cwd: join(import.meta.dirname, '..'), encoding: 'utf8' as const, timeout: 15_000, env };
  try {
    const cli = spawnSync(process.execPath, ['--import', 'tsx', 'runtime/cli.ts', 'setup'], options);
    assert.equal(cli.status, 1);
    assert.match(cli.stdout, /#37 \[7\/9\]/);
    assert.match(cli.stderr, /Failed to fetch/);
    assert.match(cli.stderr, /Docker build stopped with exit code 17/);
    // Shorten only the long child-process timer in this subprocess.
    const prepare = `import { prepareRuntime } from './runtime/readiness.ts';
      const timer = globalThis.setTimeout;
      globalThis.setTimeout = (fn, delay, ...args) => timer(fn, delay >= 45 * 60000 ? 800 : delay, ...args);
      try { await prepareRuntime(); } catch (e) { console.error(e.message); process.exitCode = 1; }`;
    for (const [mode, minutes] of [['build', 90], ['pull', 45]] as const) {
      const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', prepare], { ...options, env: {
        ...env, FIXTURE_HANG: '1', OPEN_HARNESS_HERMES_PULL: mode === 'pull' ? '1' : '0', OPEN_HARNESS_HERMES_IMAGE: 'example.test/runtime@sha256:' + 'a'.repeat(64),
      } });
      assert.equal(result.status, 1, String(result.error || result.stderr));
      assert.match(result.stderr, new RegExp(`Docker ${mode} did not finish within ${minutes} minutes`));
      assert.match(result.stderr, /Last reported Docker step: 37/);
      assert.match(result.stderr, /could not download a required file/);
      assert.doesNotMatch(result.stderr, /private\.example|test-only-sensitive|installing runtime dependencies/);
      assert.equal(result.stdout, '');
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
