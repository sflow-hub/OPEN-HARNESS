import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { draftProfile, runToolGrants } from '../lib/agent-profile';
import { validateComputerTarget } from '../runtime/computer-validation';

const capabilities = { container: true, direct: true, desktop: true, virtualDesktop: true };
const profile = draftProfile({ id: 'atlas', name: 'Atlas', role: 'Assistant', description: '', tone: 0, instructions: '', memory: [] });

test('destination validation enforces folder grants, capabilities, and machine credentials', () => {
  const folder = mkdtempSync(join(tmpdir(), 'open-harness-folder-'));
  const selected = { ...profile, computer: { ...profile.computer, access: 'folders' as const, folders: [{ id: 'project', path: folder, mode: 'read' as const }] } };
  assert.deepEqual(validateComputerTarget(selected, capabilities, ['MODEL_KEY'], name => name === 'MODEL_KEY'), { ok: true });
  assert.throws(() => validateComputerTarget({ ...selected, computer: { ...selected.computer, folders: [{ id: 'missing', path: join(folder, 'missing'), mode: 'write' }] } }, capabilities), /not an accessible read\/write folder/);
  assert.throws(() => validateComputerTarget(selected, capabilities, ['MISSING_KEY'], () => false), /Credential MISSING_KEY is missing/);
  assert.throws(() => validateComputerTarget({ ...selected, computer: { ...selected.computer, access: 'private', folders: [] } }, { ...capabilities, container: false }), /Docker/);
});

test('no-desktop runs cannot dispatch the computer-use tool', () => {
  const selected = { ...profile, allowedTools: ['computer_use', 'terminal'] };
  assert.deepEqual(runToolGrants(selected), ['terminal']);
  assert.deepEqual(runToolGrants({ ...selected, computer: { ...selected.computer, desktop: 'virtual' } }), ['computer_use', 'terminal']);
});

test('workspace security defaults off, preserves legacy model settings, and shares revisions', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const { Profiles } = await import('../runtime/profiles');
  const db = new DatabaseSync(':memory:');
  try {
    const profiles = new Profiles(db), model = profiles.defaults().model;
    assert.deepEqual(profiles.security(), { allowDirectAccess: false, revision: 0 });
    db.prepare('INSERT INTO workspace_settings VALUES(1,1,?)').run(JSON.stringify(model));
    assert.equal(profiles.security().allowDirectAccess, false);
    assert.throws(() => profiles.setSecurity(true, 1), /Confirm/);
    profiles.setSecurity(true, 1, true);
    assert.deepEqual(profiles.defaults().model, model);
    profiles.setDefaults(model, 2);
    assert.equal(profiles.security().allowDirectAccess, true);
    assert.throws(() => profiles.setSecurity(false, 2), /changed elsewhere/);
    profiles.setSecurity(false, 3);
    assert.throws(() => profiles.checkDirect({ access: 'direct' } as never), /Direct computer access is disabled/);
    assert.throws(() => profiles.save({ ...profile, computer: { ...profile.computer, access: 'direct' } }), (error: unknown) => error instanceof Error && 'status' in error && error.status === 403);
  } finally { db.close(); }
});
