import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { exportAgentFiles, importAgentFiles, type TransferBundle } from '../runtime/transfer-files';

import { __setSafeFsHook, safeFsMode } from '../runtime/safe-fs';

function bundle(paths: string[]): TransferBundle {
  const files = paths.map(path => ({ path, data: Buffer.from('imported').toString('base64'), checksum: createHash('sha256').update('imported').digest('hex') }));
  return { files, checksum: createHash('sha256').update([...files].sort((a,b) => a.path.localeCompare(b.path)).map(file => `${file.path}:${file.checksum}`).join('\n')).digest('hex') };
}
function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'transfer-test-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const state = join(root, 'state'), outside = join(root, 'outside'); mkdirSync(state); mkdirSync(outside);
  return { state, outside, agent: join(state, 'agents', 'atlas') };
}
function assertNoStaging(state: string) { assert.deepEqual(readdirSync(state).filter(name => name.startsWith('.transfer-')), []); }

test('managed files round trip with private staging and restrictive file permissions', t => {
  const { state, agent } = fixture(t);
  for (const path of ['private/nested/data.txt', 'profile/MEMORY.md', 'profile/USER.md', 'profile/skills/example/SKILL.md']) {
    const target = join(agent, path); mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, path);
  }
  const original = exportAgentFiles(state, 'atlas');
  assert.deepEqual(importAgentFiles(state, 'scout', original), { checksum: original.checksum, files: 4 });
  assert.deepEqual(exportAgentFiles(state, 'scout'), original);
  for (const file of original.files) if (process.platform !== 'win32') assert.equal(lstatSync(join(state, 'agents', 'scout', file.path)).mode & 0o777, 0o600);
  assertNoStaging(state);
});

for (const path of ['private/nested', 'profile/skills', 'private/leaf.txt', 'private', 'profile', '']) {
  test(`rejects symbolic link at ${path || 'agent anchor'}`, t => {
    const { state, outside, agent } = fixture(t), leaf = path === 'private/leaf.txt';
    const outsideFile = join(outside, 'leaf.txt'); writeFileSync(outsideFile, 'original');
    const link = join(agent, path); mkdirSync(dirname(link), { recursive: true });
    symlinkSync(leaf ? outsideFile : outside, link, leaf ? 'file' : process.platform === 'win32' ? 'junction' : 'dir');
    const target = leaf ? path : path === 'profile' ? 'profile/MEMORY.md' : `${path ? path + '/' : 'private/'}new.txt`;
    assert.throws(() => importAgentFiles(state, 'atlas', bundle([target])), /symbolic link/);
    assert.equal(readFileSync(outsideFile, 'utf8'), 'original');
    assert.deepEqual(readdirSync(outside), ['leaf.txt']);
    assertNoStaging(state);
  });
}

for (const invalid of ['file checksum', 'bundle checksum', 'path']) {
  test(`validates all files before writing: bad ${invalid}`, t => {
    const { state, agent } = fixture(t), value = bundle(['private/first.txt', 'private/second.txt']);
    if (invalid === 'file checksum') value.files[1].checksum = 'bad';
    else if (invalid === 'bundle checksum') value.checksum = 'bad';
    else value.files[1].path = '../outside.txt';
    assert.throws(() => importAgentFiles(state, 'atlas', value), /validation failed|invalid managed path/);
    assert.equal(existsSync(agent), false); assert.deepEqual(readdirSync(state), []);
  });
}

test('rejects a non-directory parent and removes staging after commit failure', t => {
  const { state, agent } = fixture(t); mkdirSync(agent, { recursive: true }); writeFileSync(join(agent, 'private'), 'original');
  assert.throws(() => importAgentFiles(state, 'atlas', bundle(['private/file.txt'])), /non-directory|not a directory|non-regular/);
  assert.equal(readFileSync(join(agent, 'private'), 'utf8'), 'original'); assertNoStaging(state);
});


test('export skips symlinked files, directories and allowed roots without reading outside', t => {
  const { state, agent, outside } = fixture(t); mkdirSync(join(agent, 'private'), { recursive: true }); mkdirSync(join(agent, 'profile'));
  writeFileSync(join(outside, 'secret.txt'), 'outside secret'); writeFileSync(join(agent, 'private', 'safe.txt'), 'inside');
  symlinkSync(join(outside, 'secret.txt'), join(agent, 'private', 'link.txt'));
  symlinkSync(outside, join(agent, 'private', 'linked-dir'), process.platform === 'win32' ? 'junction' : 'dir'); symlinkSync(outside, join(agent, 'profile', 'skills'), process.platform === 'win32' ? 'junction' : 'dir');
  symlinkSync(join(outside, 'secret.txt'), join(agent, 'profile', 'MEMORY.md'));
  const value = exportAgentFiles(state, 'atlas');
  assert.deepEqual(value.files.map(file => file.path), ['private/safe.txt']);
  assert.equal(Buffer.from(value.files[0].data, 'base64').toString(), 'inside');
});

test('export of a missing agent is an empty bundle', t => {
  const { state } = fixture(t); assert.deepEqual(exportAgentFiles(state, 'missing'), bundle([]));
});

test('export enforces the directory depth bound', t => {
  const { state, agent } = fixture(t); mkdirSync(join(agent, 'private', ...Array(33).fill('nested')), { recursive: true });
  assert.throws(() => exportAgentFiles(state, 'atlas'), /depth limit/);
});

test('export enforces the remaining 20 MB budget', t => {
  const { state, agent } = fixture(t); mkdirSync(join(agent, 'private'), { recursive: true });
  writeFileSync(join(agent, 'private', 'a'), Buffer.alloc(10_000_000)); writeFileSync(join(agent, 'private', 'b'), Buffer.alloc(10_000_001));
  assert.throws(() => exportAgentFiles(state, 'atlas'), /Managed agent data exceeds the 20 MB transfer limit/);
});

test('import replaces an existing regular file', t => {
  const { state, agent } = fixture(t); mkdirSync(join(agent, 'private'), { recursive: true }); writeFileSync(join(agent, 'private', 'file.txt'), 'original');
  const value = bundle(['private/file.txt']); assert.deepEqual(importAgentFiles(state, 'atlas', value), { checksum: value.checksum, files: 1 });
  assert.equal(readFileSync(join(agent, 'private', 'file.txt'), 'utf8'), 'imported'); assertNoStaging(state);
});

test('import validates every existing parent before committing any file', t => {
  const { state, agent } = fixture(t); mkdirSync(join(agent, 'private'), { recursive: true }); writeFileSync(join(agent, 'private', 'blocked'), 'original');
  assert.throws(() => importAgentFiles(state, 'atlas', bundle(['private/first.txt', 'private/blocked/second.txt'])), /not a directory/);
  assert.equal(existsSync(join(agent, 'private', 'first.txt')), false);
  assert.equal(readFileSync(join(agent, 'private', 'blocked'), 'utf8'), 'original'); assertNoStaging(state);
});

test('import refuses a directory at the leaf', t => {
  const { state, agent } = fixture(t); mkdirSync(join(agent, 'private', 'file.txt'), { recursive: true });
  assert.throws(() => importAgentFiles(state, 'atlas', bundle(['private/file.txt'])), /non-directory|not a directory|non-regular/); assertNoStaging(state);
});

test('import commits into the held parent after a parent swap', { skip: safeFsMode() !== 'fd-relative' }, t => {
  const { state, agent, outside } = fixture(t); mkdirSync(join(agent, 'private', 'dest'), { recursive: true });
  writeFileSync(join(outside, 'file.txt'), 'outside');
  const previous = process.env.OPEN_HARNESS_SAFE_FS_TEST_HOOKS; process.env.OPEN_HARNESS_SAFE_FS_TEST_HOOKS = '1';
  t.after(() => { __setSafeFsHook('beforeRenameCommit', null); if (previous === undefined) delete process.env.OPEN_HARNESS_SAFE_FS_TEST_HOOKS; else process.env.OPEN_HARNESS_SAFE_FS_TEST_HOOKS = previous; });
  let swapped = false;
  __setSafeFsHook('beforeRenameCommit', () => {
    if (swapped) return; swapped = true;
    renameSync(join(agent, 'private', 'dest'), join(agent, 'private', 'held')); symlinkSync(outside, join(agent, 'private', 'dest'));
  });
  importAgentFiles(state, 'atlas', bundle(['private/dest/file.txt']));
  assert.equal(swapped, true); assert.equal(readFileSync(join(agent, 'private', 'held', 'file.txt'), 'utf8'), 'imported');
  assert.equal(readFileSync(join(outside, 'file.txt'), 'utf8'), 'outside'); assert.deepEqual(readdirSync(outside), ['file.txt']); assertNoStaging(state);
});
