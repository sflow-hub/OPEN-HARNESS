import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { profileMemory } from '../runtime/profile-memory';
import { prepareProfile } from '../runtime/profile-runtime';
import { agentContext } from '../runtime/agent-context';
import { DEFAULT_MODEL, draftProfile } from '../lib/agent-profile';

test('preparing the next run adopts legacy notes without losing newer or deliberately empty Hermes files', t => {
  const root = mkdtempSync(join(tmpdir(), 'harness-memory-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const home = join(root, 'agents', 'atlas', 'profile');
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, 'MEMORY.md'), 'Older dashboard memory.');
  writeFileSync(join(home, 'USER.md'), 'Older user memory.');
  const profile = draftProfile({ id: 'atlas', name: 'Atlas', role: 'Assistant', description: '', tone: 0, instructions: 'Help.', memory: [] });
  prepareProfile(root, profile, DEFAULT_MODEL, { environment: () => ({}) }, '', 'first');
  assert.equal(readFileSync(join(home, 'memories', 'MEMORY.md'), 'utf8'), 'Older dashboard memory.');
  assert.equal(readFileSync(join(home, 'memories', 'USER.md'), 'utf8'), 'Older user memory.');
  writeFileSync(join(home, 'memories', 'MEMORY.md'), 'Newer runtime memory.');
  writeFileSync(join(home, 'memories', 'USER.md'), '');
  prepareProfile(root, profile, DEFAULT_MODEL, { environment: () => ({}) }, '', 'second');
  assert.equal(readFileSync(join(home, 'memories', 'MEMORY.md'), 'utf8'), 'Newer runtime memory.');
  assert.equal(readFileSync(join(home, 'memories', 'USER.md'), 'utf8'), '');
  assert.equal(readFileSync(join(home, 'MEMORY.md'), 'utf8'), 'Older dashboard memory.');
});

test('memory and skill operations refuse managed-path symlinks and malformed identifiers', t => {
  const root = mkdtempSync(join(tmpdir(), 'harness-memory-path-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const outside = join(root, 'outside'), home = join(root, 'agents', 'atlas', 'profile');
  mkdirSync(outside); mkdirSync(home, { recursive: true });
  symlinkSync(outside, join(home, 'memories'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => profileMemory(root, 'atlas'), /symbolic links/);
  assert.equal(existsSync(join(outside, 'MEMORY.md')), false);
  symlinkSync(outside, join(home, 'skills'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => agentContext(root, 'atlas', { operation: 'put-skill', name: 'reporter', content: 'outside' }), /symbolic links/);
  assert.throws(() => agentContext(root, '../atlas', { operation: 'set-memory', memory: 'escape' }), /Invalid agent ID/);
  assert.throws(() => agentContext(root, 'fresh', { operation: 'put-skill', name: '../escape', content: 'escape' }), /Invalid skill name/);
});
