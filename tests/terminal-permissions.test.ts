import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { draftProfile, type AgentProfile } from '../lib/agent-profile';
import { TerminalPermissions } from '../runtime/terminal-permissions';
import { ProductError } from '../runtime/product-error';

function profile(revision = 1, tools = ['terminal', 'process_manage'], machine = 'linux-runner'): AgentProfile {
  const value = draftProfile({ id: 'atlas', name: 'Atlas', role: 'Assistant', description: '', tone: 0, instructions: '', memory: [] });
  return { ...value, revision, allowedTools: tools, computer: { ...value.computer, machineId: machine } };
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }

test('terminal consent is explicit for new grants and preserves existing choices', t => {
  const db = new DatabaseSync(':memory:'), permissions = new TerminalPermissions(db, async () => true, () => profile()); t.after(() => { permissions.close(); db.close(); });
  for (const grant of ['terminal', 'process_manage', 'process']) {
    const desired = profile(2, [grant]);
    for (const consent of [undefined, false, 'true', 1, null]) assert.throws(() => permissions.requireConsent(profile(1, []), desired, consent), ProductError);
    assert.doesNotThrow(() => permissions.requireConsent(profile(1, []), desired, true));
    assert.throws(() => permissions.requireConsent(null, desired, undefined), ProductError);
    assert.doesNotThrow(() => permissions.requireConsent(profile(1, [grant]), desired, undefined));
  }
  assert.doesNotThrow(() => permissions.requireConsent(null, profile(1, ['read_file']), undefined));
  assert.doesNotThrow(() => permissions.requireConsent(profile(), profile(2, []), undefined));
  assert.equal(permissions.status('atlas'), null); assert.equal(permissions.pending('atlas'), false);
});

test('removal is durably pending before cleanup starts and only confirmed stop unblocks it', async t => {
  const db = new DatabaseSync(':memory:'), stop = deferred<boolean>(); let calls = 0, changes = 0;
  const before = profile(), saved = profile(2, ['process_manage']);
  const permissions: TerminalPermissions = new TerminalPermissions(db, async snapshot => { calls++; assert.deepEqual(snapshot, before); assert.equal(permissions.pending('atlas'), true); return stop.promise; }, () => saved, () => { changes++; });
  t.after(() => { permissions.close(); db.close(); });
  const state = permissions.revoke(before, saved)!;
  assert.equal(calls, 0); assert.equal(changes, 0); assert.equal(state.state, 'pending'); assert.equal(state.machineId, before.computer.machineId); assert.equal(state.revision, saved.revision); assert.equal(state.confirmedAt, null);
  assert.ok(Date.parse(state.requestedAt)); assert.equal(permissions.pending('atlas'), true);
  const first = permissions.retry(), second = permissions.retry(); await Promise.resolve(); assert.equal(calls, 1);
  stop.resolve(true); await Promise.all([first, second]);
  assert.equal(permissions.pending('atlas'), false); assert.equal(permissions.status('atlas')?.state, 'confirmed'); assert.ok(Date.parse(permissions.status('atlas')!.confirmedAt!));
  await permissions.retry(); assert.equal(calls, 1); assert.equal(changes, 1);
});

test('offline, thrown errors and non-boolean acknowledgments remain pending without exposing errors', async t => {
  const db = new DatabaseSync(':memory:'); let answer: unknown = false, calls = 0;
  const permissions = new TerminalPermissions(db, async () => { calls++; if (answer instanceof Error) throw answer; return answer as boolean; }, () => profile(2, [])); t.after(() => { permissions.close(); db.close(); });
  permissions.revoke(profile(), profile(2, [])); await permissions.retry();
  assert.equal(permissions.pending('atlas'), true);
  answer = new Error('private-token-do-not-return'); await permissions.retry(); assert.equal(permissions.pending('atlas'), true); assert.ok(!JSON.stringify(permissions.status('atlas')).includes('private-token'));
  answer = 'true'; await permissions.retry(); assert.equal(permissions.pending('atlas'), true);
  answer = true; await permissions.retry(); assert.equal(permissions.pending('atlas'), false); assert.equal(calls, 4);
});

test('unrelated profile edits and grants do not create revocations or dispatch cleanup', async t => {
  const db = new DatabaseSync(':memory:'); let calls = 0;
  const permissions = new TerminalPermissions(db, async () => { calls++; return true; }, () => profile()); t.after(() => { permissions.close(); db.close(); });
  assert.equal(permissions.revoke(profile(), { ...profile(2), description: 'Changed text' }), null);
  assert.equal(permissions.revoke(profile(2), profile(3, ['terminal', 'process_manage', 'read_file'])), null);
  assert.equal(permissions.revoke(profile(3, ['read_file']), profile(4, [])), null);
  await permissions.retry(); assert.equal(calls, 0); assert.equal(permissions.status('atlas'), null);
});

test('restart retries the original execution machine even after reassignment or profile deletion', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'harness-terminal-revoke-')), path = join(directory, 'state.db');
  let db = new DatabaseSync(path), permissions = new TerminalPermissions(db, async () => false, () => profile(2, []));
  t.after(() => { permissions.close(); db.close(); rmSync(directory, { recursive: true, force: true }); });
  const before = profile(1, ['terminal'], 'original-linux'); permissions.revoke(before, profile(2, [], 'new-linux')); await permissions.retry(); permissions.close(); db.close();
  db = new DatabaseSync(path); let snapshot: AgentProfile | undefined;
  permissions = new TerminalPermissions(db, async value => { snapshot = value; return true; }, () => null);
  assert.equal(permissions.pending('atlas'), true); await permissions.retry();
  assert.deepEqual(snapshot, before); assert.equal(permissions.status('atlas')?.machineId, 'original-linux'); assert.equal(permissions.pending('atlas'), false);
});

test('older acknowledgments cannot clear a newer revocation and cleanup is serialized per agent', async t => {
  const db = new DatabaseSync(':memory:'), first = deferred<boolean>(), second = deferred<boolean>(); const revisions: number[] = [];
  const permissions = new TerminalPermissions(db, async value => { revisions.push(value.revision); return revisions.length === 1 ? first.promise : second.promise; }, () => profile(3, [])); t.after(() => { permissions.close(); db.close(); });
  const one = profile(), two = profile(2, ['process_manage']), three = profile(3, []);
  permissions.revoke(one, two); const work = permissions.retry(); await Promise.resolve();
  permissions.revoke(two, three); permissions.revoke(two, three);
  assert.equal(permissions.status('atlas')?.revision, 3); assert.deepEqual(revisions, [1]);
  first.resolve(true); await new Promise(resolve => setImmediate(resolve));
  assert.equal(permissions.pending('atlas'), true); assert.equal(permissions.status('atlas')?.revision, 3); assert.deepEqual(revisions, [1, 2]);
  second.resolve(true); await work; assert.equal(permissions.pending('atlas'), false); assert.equal(permissions.status('atlas')?.revision, 3);
});

test('close leaves in-flight cleanup pending for the next coordinator and never touches a closed database', async () => {
  const db = new DatabaseSync(':memory:'), stop = deferred<boolean>(); let calls = 0;
  const permissions = new TerminalPermissions(db, async () => { calls++; return stop.promise; }, () => profile(2, []));
  permissions.revoke(profile(), profile(2, [])); const work = permissions.retry(); await Promise.resolve(); permissions.close();
  assert.equal(permissions.pending('atlas'), true); db.close(); stop.resolve(true); await work; await permissions.retry(); assert.equal(calls, 1);
});

test('revocation identities reject stale or conflicting profile changes', async t => {
  const db = new DatabaseSync(':memory:'), permissions = new TerminalPermissions(db, async () => false, () => profile(2, [])); t.after(() => { permissions.close(); db.close(); });
  assert.throws(() => permissions.revoke(profile(), profile(1, [])), ProductError);
  assert.throws(() => permissions.revoke(profile(), { ...profile(2, []), id: 'scout' }), ProductError);
  permissions.revoke(profile(), profile(2, []));
  assert.throws(() => permissions.revoke(profile(1, ['terminal'], 'other-machine'), profile(2, [])), ProductError);
  await permissions.retry(); assert.equal(permissions.status('atlas')?.machineId, 'linux-runner');
});
