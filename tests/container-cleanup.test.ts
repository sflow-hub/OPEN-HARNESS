import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { containerStateKey, stopManagedContainers } from '../runtime/hermes';

test('container cleanup stops only the selected workspace and reports failed stops', { skip: process.platform === 'win32' }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'harness-cleanup-'));
  const log = join(root, 'commands.jsonl');
  const originalPath = process.env.PATH, originalMock = process.env.OPEN_HARNESS_MOCK;
  t.after(() => {
    if (originalPath === undefined) delete process.env.PATH; else process.env.PATH = originalPath;
    if (originalMock === undefined) delete process.env.OPEN_HARNESS_MOCK; else process.env.OPEN_HARNESS_MOCK = originalMock;
    rmSync(root, { recursive: true, force: true });
  });
  const key = containerStateKey(join(root, 'selected'));
  writeFileSync(join(root, 'docker'), String.raw`#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\n');
if (args[0] === 'ps') console.log(args.includes('label=open-harness.state=${key}') ? 'owned\nowned-failure' : 'owned\nother-workspace');
if (args.includes('owned-failure')) { console.error('daemon rejected stop'); process.exit(1); }
`, { mode: 0o700 });
  process.env.PATH = `${root}:${originalPath || ''}`;
  delete process.env.OPEN_HARNESS_MOCK;
  const result = await stopManagedContainers(join(root, 'selected'));
  assert.deepEqual(result.stopped, ['owned'], JSON.stringify(result));
  assert.deepEqual(result.failures, ['owned-failure: daemon rejected stop']);
  const calls = readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line) as string[]);
  assert.equal(calls.some(call => call.includes('other-workspace')), false);
  assert.ok(calls[0].includes('label=open-harness.managed=1'));
  process.env.OPEN_HARNESS_MOCK = '1';
  assert.deepEqual(await stopManagedContainers(join(root, 'selected')), { stopped: [], failures: [] });
  assert.equal(readFileSync(log, 'utf8').trim().split('\n').length, calls.length);
});
