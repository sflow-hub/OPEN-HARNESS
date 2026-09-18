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
