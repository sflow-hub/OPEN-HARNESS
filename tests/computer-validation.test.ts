import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { draftProfile, runToolGrants } from '../lib/agent-profile';
import { validateProfile } from '../runtime/profiles';
import { ensureContainer } from '../runtime/hermes';
import { nativeRuntimeProbe } from '../runtime/profile-runtime';
import { sharedFolderSource, validateComputerTarget } from '../runtime/computer-validation';

const capabilities = { container: true, direct: true, desktop: true, virtualDesktop: true };
const profile = draftProfile({ id: 'atlas', name: 'Atlas', role: 'Assistant', description: '', tone: 0, instructions: '', memory: [] });

test('destination validation enforces folder grants, capabilities, and machine credentials', t => {
  const folder = realpathSync(mkdtempSync(join(tmpdir(), 'open-harness-folder-')));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const selected = { ...profile, computer: { ...profile.computer, access: 'folders' as const, folders: [{ id: 'project', path: folder, mode: 'read' as const }] } };
  assert.deepEqual(validateComputerTarget(selected, capabilities, ['MODEL_KEY'], name => name === 'MODEL_KEY'), { ok: true });
  assert.throws(() => validateComputerTarget({ ...selected, computer: { ...selected.computer, folders: [{ id: 'missing', path: join(folder, 'missing'), mode: 'write' }] } }, capabilities), /not an accessible read\/write folder/);
  assert.throws(() => validateComputerTarget(selected, capabilities, ['MISSING_KEY'], () => false), /Credential MISSING_KEY is missing/);
  assert.throws(() => validateComputerTarget(selected, { ...capabilities, container: false }), /Docker/);
  assert.throws(() => validateComputerTarget({ ...selected, computer: { ...selected.computer, access: 'private', folders: [] } }, { ...capabilities, container: false }), /Docker/);
});

test('folder mounts reject links in the selected path and its parents', t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'harness-mount-links-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'actual/child'), { recursive: true });
  symlinkSync(join(root, 'actual'), join(root, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(sharedFolderSource(join(root, 'actual/child')), join(root, 'actual/child'));
  for (const path of [join(root, 'link'), join(root, 'link/child')]) assert.throws(() => sharedFolderSource(path), /symbolic links/);
});

test('no-desktop runs cannot dispatch the computer-use tool', () => {
  const selected = { ...profile, allowedTools: ['computer_use', 'terminal'] };
  assert.deepEqual(runToolGrants(selected), ['terminal']);
  assert.deepEqual(runToolGrants({ ...selected, computer: { ...selected.computer, desktop: 'virtual' } }), ['computer_use', 'terminal']);
});

test('legacy native access is refused before execution regardless of advertised capabilities', () => {
  for (const computer of [{ ...profile.computer, access: 'direct' as const }, { ...profile.computer, desktop: 'existing' as const }]) {
    const legacy = { ...profile, allowedTools: ['computer_use', 'terminal'], computer };
    assert.throws(() => validateProfile(legacy), /not sandboxed and is disabled/);
    assert.throws(() => validateComputerTarget(legacy, capabilities), /not sandboxed and is disabled/);
    assert.throws(() => ensureContainer('atlas', '/unused', computer), /not sandboxed and is disabled/);
    assert.deepEqual(runToolGrants(legacy), ['terminal']);
  }
  assert.throws(() => nativeRuntimeProbe('/unused', { action: 'mcp', command: 'must-never-run' }), /not sandboxed and is disabled/);
});
