import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { exportAgentFiles, importAgentFiles, type TransferBundle } from '../runtime/transfer-files';

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
  for (const file of original.files) assert.equal(lstatSync(join(state, 'agents', 'scout', file.path)).mode & 0o777, 0o600);
  assertNoStaging(state);
});

for (const path of ['private/nested', 'profile/skills', 'private/leaf.txt', 'private', 'profile', '']) {
  test(`rejects symbolic link at ${path || 'agent anchor'}`, t => {
    const { state, outside, agent } = fixture(t), leaf = path === 'private/leaf.txt';
    const outsideFile = join(outside, 'leaf.txt'); writeFileSync(outsideFile, 'original');
    const link = join(agent, path); mkdirSync(dirname(link), { recursive: true });
    symlinkSync(leaf ? outsideFile : outside, link);
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
  assert.throws(() => importAgentFiles(state, 'atlas', bundle(['private/file.txt'])), /non-directory/);
  assert.equal(readFileSync(join(agent, 'private'), 'utf8'), 'original'); assertNoStaging(state);
});
