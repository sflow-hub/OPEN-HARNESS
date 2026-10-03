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
    assert.match(failed.result.stderr, /download refused/);
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
