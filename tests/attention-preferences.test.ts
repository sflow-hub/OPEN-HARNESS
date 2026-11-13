import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AttentionPreferences } from '../runtime/attention-preferences';
import { ProductError } from '../runtime/product-error';

test('new accounts preserve every notification without creating a preference record', t => {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  const preferences = new AttentionPreferences(db);
  assert.deepEqual(preferences.get('alice'), { revision: 0, completionNotifications: true });
  for (const kind of ['approval','input','completed','failed','test']) assert.equal(preferences.allows(kind, 'alice'), true, kind);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM attention_preferences').get()!.count, 0);
});

test('completion preferences are actor scoped and never suppress decisions, failures or tests', t => {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  const preferences = new AttentionPreferences(db);
  assert.deepEqual(preferences.update('alice', { revision: 0, completionNotifications: false }), { revision: 1, completionNotifications: false });
  assert.equal(preferences.allows('completed', 'alice'), false); assert.equal(preferences.allows('completed', 'bob'), true);
  for (const kind of ['approval','input','failed','test','future-urgent-kind']) assert.equal(preferences.allows(kind, 'alice'), true, kind);
  assert.deepEqual(preferences.get('bob'), { revision: 0, completionNotifications: true });
  assert.deepEqual(preferences.update('alice', { revision: 1, completionNotifications: true }), { revision: 2, completionNotifications: true });
  assert.equal(preferences.allows('completed', 'alice'), true);
});

test('stale first and later saves conflict without overwriting saved preferences', t => {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  const first = new AttentionPreferences(db), second = new AttentionPreferences(db);
  const initial = first.get('alice'); second.update('alice', { ...initial, completionNotifications: false });
  assert.throws(() => first.update('alice', initial), (error: unknown) => error instanceof ProductError && error.status === 409 && /revision 1.*draft was kept/.test(error.message));
  const current = first.get('alice'); second.update('alice', { ...current, completionNotifications: true });
  assert.throws(() => first.update('alice', { ...current, completionNotifications: false }), (error: unknown) => error instanceof ProductError && error.status === 409 && /revision 2/.test(error.message));
  assert.deepEqual(first.get('alice'), { revision: 2, completionNotifications: true });
  assert.throws(() => first.update('unknown', { revision: 4, completionNotifications: false }), (error: unknown) => error instanceof ProductError && error.status === 409 && /revision 0/.test(error.message));
  assert.deepEqual(first.get('unknown'), { revision: 0, completionNotifications: true });
});

test('invalid preference values fail without changing the current account or any other account', t => {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  const preferences = new AttentionPreferences(db), saved = preferences.update('alice', { revision: 0, completionNotifications: false });
  for (const completionNotifications of [undefined, null, 'true', 1, {}, []]) assert.throws(() => preferences.update('alice', { revision: 1, completionNotifications }), ProductError);
  for (const revision of [undefined, null, '1', -1, 1.5, Number.MAX_SAFE_INTEGER, NaN]) assert.throws(() => preferences.update('alice', { revision, completionNotifications: true }), ProductError);
  assert.deepEqual(preferences.get('alice'), saved); assert.deepEqual(preferences.get('bob'), { revision: 0, completionNotifications: true });
  assert.throws(() => preferences.get(''), ProductError); assert.throws(() => preferences.update('', { revision: 0, completionNotifications: false }), ProductError);
});

test('preferences and revisions survive reopening while new actors retain the default', t => {
  const directory = mkdtempSync(join(tmpdir(), 'oh-attention-preferences-')), path = join(directory, 'preferences.db');
  let db = new DatabaseSync(path); t.after(() => { db.close(); rmSync(directory, { recursive: true, force: true }); });
  const initial = new AttentionPreferences(db); initial.update('alice', { revision: 0, completionNotifications: false }); initial.update('bob', { revision: 0, completionNotifications: true });
  db.close(); db = new DatabaseSync(path);
  const restored = new AttentionPreferences(db);
  assert.deepEqual(restored.get('alice'), { revision: 1, completionNotifications: false }); assert.deepEqual(restored.get('bob'), { revision: 1, completionNotifications: true });
  assert.equal(restored.allows('completed', 'alice'), false); assert.equal(restored.allows('approval', 'alice'), true); assert.equal(restored.allows('completed', 'new-account'), true);
  assert.deepEqual(restored.update('alice', { revision: 1, completionNotifications: true }), { revision: 2, completionNotifications: true });
});
