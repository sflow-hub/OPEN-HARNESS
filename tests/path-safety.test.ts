import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs, { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readWorkspaceFile, resolveContainedPath, safeWorkspacePath } from '../runtime/path-safety';
import { exportAgentFiles, importAgentFiles, type TransferBundle } from '../runtime/transfer-files';

const digest = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');
function bundle(entries: Array<[string, string]>): TransferBundle {
  const files = entries.map(([name, content]) => ({ path: name, data: Buffer.from(content).toString('base64'), checksum: digest(content) }));
  return { files, checksum: digest([...files].sort((a, b) => a.path.localeCompare(b.path)).map(file => `${file.path}:${file.checksum}`).join('\n')) };
}
function fixture(t: { after: (cleanup: () => void) => void }) {
  const root = mkdtempSync(path.join(tmpdir(), 'open-harness-path-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test('file previews reject a symlink swapped in after path validation', t => {
  const root = fixture(t), target = path.join(root, 'preview.txt'), outside = path.join(root, 'host-secret');
  writeFileSync(target, 'shared content'); writeFileSync(outside, 'must never reach the preview');
  assert.equal(readWorkspaceFile(target).toString(), 'shared content');
  const open = fs.openSync;
  const replacement = t.mock.method(fs, 'openSync', (file: fs.PathLike, flags: string | number, mode?: fs.Mode) => {
    if (file === target) { fs.unlinkSync(target); symlinkSync(outside, target); }
    return open(file, flags, mode);
  });
  syncBuiltinESMExports();
  try { assert.throws(() => readWorkspaceFile(target)); }
  finally { replacement.mock.restore(); syncBuiltinESMExports(); }
});

test('portable containment resolves ordinary Windows, UNC and Unix names', () => {
  assert.equal(resolveContainedPath('C:\\Harness\\state', 'agents/atlas/private/report.md', path.win32), 'C:\\Harness\\state\\agents\\atlas\\private\\report.md');
  assert.equal(resolveContainedPath('C:\\Harness\\state\\', 'agents\\atlas\\private\\report.md', path.win32), 'C:\\Harness\\state\\agents\\atlas\\private\\report.md');
  assert.equal(resolveContainedPath('\\\\server\\share\\state', 'shared/report.md', path.win32), '\\\\server\\share\\state\\shared\\report.md');
  assert.equal(resolveContainedPath('/state', 'shared/report.md', path.posix), '/state/shared/report.md');
});

test('rejects traversal and absolute paths before normalization on every platform', () => {
  const names = ['', '.', '..', '../state-other/file', 'private/../profile/MEMORY.md', 'private/./file', 'private\\..\\file', 'private//file', '/tmp/file', '\\outside', 'C:\\outside', 'C:outside', '\\\\server\\share\\file', 'private/file:stream', 'private/file\0', 'private/.. /outside', 'private/file.', 'private/CON', 'private/NUL.txt', 'private/COM1.txt'];
  for (const flavor of [path.posix, path.win32]) {
    const root = flavor === path.win32 ? 'C:\\state' : '/state';
    for (const name of names) assert.throws(() => resolveContainedPath(root, name, flavor), name);
  }
});

test('filesystem containment accepts new directories but rejects existing and dangling symlinks', t => {
  const root = fixture(t), state = path.join(root, 'state'), outside = path.join(root, 'outside');
  mkdirSync(state); mkdirSync(outside);
  assert.equal(safeWorkspacePath(state, 'shared/new/report.md'), path.join(state, 'shared/new/report.md'));
  symlinkSync(outside, path.join(state, 'shared'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => safeWorkspacePath(state, 'shared/report.md'), /symbolic links/);
  symlinkSync(path.join(outside, 'missing.md'), path.join(state, 'dangling.md'));
  assert.throws(() => safeWorkspacePath(state, 'dangling.md'), /symbolic links/);
  writeFileSync(path.join(state, 'file.md'), 'ordinary file');
  assert.throws(() => safeWorkspacePath(state, 'file.md/child'), /not a directory/);
});

test('transfers restore private files, memory, user notes and nested skills', t => {
  const root = fixture(t), source = path.join(root, 'source'), destination = path.join(root, 'destination');
  const original = bundle([['private/report.md', 'report'], ['profile/MEMORY.md', 'legacy memory'], ['profile/USER.md', 'legacy user'], ['profile/memories/MEMORY.md', 'runtime memory'], ['profile/memories/USER.md', 'runtime user'], ['profile/skills/writer/SKILL.md', 'skill']]);
  assert.deepEqual(importAgentFiles(source, 'atlas', original), { checksum: original.checksum, files: 6 });
  const exported = exportAgentFiles(source, 'atlas');
  assert.equal(exported.checksum, original.checksum);
  importAgentFiles(destination, 'atlas', exported);
  assert.equal(readFileSync(path.join(destination, 'agents/atlas/profile/skills/writer/SKILL.md'), 'utf8'), 'skill');
  assert.equal(readFileSync(path.join(destination, 'agents/atlas/private/report.md'), 'utf8'), 'report');
  assert.equal(readFileSync(path.join(destination, 'agents/atlas/profile/memories/MEMORY.md'), 'utf8'), 'runtime memory');
  assert.equal(readFileSync(path.join(destination, 'agents/atlas/profile/memories/USER.md'), 'utf8'), 'runtime user');
});

test('invalid entries or checksums reject the entire import before overwriting files', t => {
  const root = fixture(t), file = path.join(root, 'agents/atlas/private/report.md');
  mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, 'original');
  for (const name of ['private/../profile/MEMORY.md', 'private\\..\\profile\\MEMORY.md', 'private/../../../../outside.md', 'profile/MEMORY.md/child', 'profile/memories/.env', 'profile/memories/MEMORY.md/child', 'profile/.env', 'private']) {
    assert.throws(() => importAgentFiles(root, 'atlas', bundle([['private/report.md', 'changed'], [name, 'invalid']])));
    assert.equal(readFileSync(file, 'utf8'), 'original');
  }
  const invalidChecksum = bundle([['private/report.md', 'changed']]); invalidChecksum.checksum = 'invalid';
  assert.throws(() => importAgentFiles(root, 'atlas', invalidChecksum), /bundle checksum/);
  const invalidFile = bundle([['private/report.md', 'changed'], ['private/new.md', 'new']]); invalidFile.files[1].checksum = 'invalid';
  assert.throws(() => importAgentFiles(root, 'atlas', invalidFile), /checksum/);
  assert.equal(readFileSync(file, 'utf8'), 'original');
  assert.equal(existsSync(path.join(root, 'agents/atlas/private/new.md')), false);
  assert.throws(() => importAgentFiles(root, '../outside', bundle([['private/file.md', 'escape']])));
});

test('imports cannot overwrite an external file through destination symlinks', t => {
  const root = fixture(t), state = path.join(root, 'state'), outside = path.join(root, 'outside');
  const target = path.join(outside, 'report.md'); mkdirSync(outside); writeFileSync(target, 'preserve me');
  const privateDir = path.join(state, 'agents/atlas/private'); mkdirSync(privateDir, { recursive: true });
  symlinkSync(target, path.join(privateDir, 'report.md'));
  assert.throws(() => importAgentFiles(state, 'atlas', bundle([['private/report.md', 'overwritten']])), /symbolic links/);
  assert.equal(readFileSync(target, 'utf8'), 'preserve me');
  symlinkSync(path.join(outside, 'new.md'), path.join(privateDir, 'new.md'));
  assert.throws(() => importAgentFiles(state, 'atlas', bundle([['private/new.md', 'created']])), /symbolic links/);
  assert.equal(existsSync(path.join(outside, 'new.md')), false);
  symlinkSync(outside, path.join(state, 'agents/atlas/profile'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => importAgentFiles(state, 'atlas', bundle([['profile/MEMORY.md', 'outside']])), /symbolic links/);
  assert.equal(existsSync(path.join(outside, 'MEMORY.md')), false);
});

test('exports skip linked files and refuse a linked profile parent', t => {
  const root = fixture(t), state = path.join(root, 'state'), outside = path.join(root, 'outside');
  mkdirSync(outside); writeFileSync(path.join(outside, 'MEMORY.md'), 'not managed');
  const privateDir = path.join(state, 'agents/atlas/private'); mkdirSync(privateDir, { recursive: true });
  symlinkSync(path.join(outside, 'MEMORY.md'), path.join(privateDir, 'secret.md'));
  assert.equal(exportAgentFiles(state, 'atlas').files.length, 0);
  symlinkSync(outside, path.join(state, 'agents/atlas/profile'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => exportAgentFiles(state, 'atlas'), /symbolic links/);
});

test('imports reject duplicate destinations including mixed separators', t => {
  const root = fixture(t);
  assert.throws(() => importAgentFiles(root, 'atlas', bundle([['private/report.md', 'one'], ['private\\report.md', 'two']])), /duplicate/);
  assert.equal(existsSync(path.join(root, 'agents/atlas/private/report.md')), false);
});
