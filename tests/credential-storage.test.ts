import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Credentials } from '../runtime/credentials';
import { SecretStore } from '../runtime/secrets';
import { modelForCredential } from '../lib/credentials';

test('upgrades the old credential table without changing keys, references, or metadata', () => {
  const directory = mkdtempSync(join(tmpdir(), 'credential-migration-'));
  const previous = process.env.OPEN_HARNESS_DISABLE_OS_VAULT;
  process.env.OPEN_HARNESS_DISABLE_OS_VAULT = '1';
  const db = new DatabaseSync(':memory:');
  try {
    const secrets = new SecretStore(join(directory, 'secrets.json'));
    secrets.set('EXISTING_KEY', 'existing-secret');
    secrets.set('OPENAI_API_KEY', 'legacy-secret');
    const legacyRef = 'L'.repeat(81);
    secrets.set(legacyRef, 'long-ref-secret');
    db.exec("CREATE TABLE credentials(ref TEXT PRIMARY KEY, label TEXT NOT NULL, provider TEXT NOT NULL DEFAULT '', fingerprint TEXT NOT NULL DEFAULT '', length INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_used_at TEXT)");
    db.prepare('INSERT INTO credentials VALUES(?,?,?,?,?,?,?,?)').run('EXISTING_KEY', 'Existing key', 'openai', 'old-fingerprint', 15, 'created', 'updated', 'used');
    const migrated = new Credentials(db, secrets);
    assert.deepEqual({ ...migrated.row('EXISTING_KEY') }, { ref: 'EXISTING_KEY', label: 'Existing key', provider: 'openai', fingerprint: 'old-fingerprint', length: 15, created_at: 'created', updated_at: 'updated', last_used_at: 'used', model: '', base_url: '' });
    assert.equal(secrets.environment().EXISTING_KEY, 'existing-secret');
    assert.equal(migrated.row('OPENAI_API_KEY').provider, 'openai');
    assert.equal(migrated.relabel(legacyRef, { label: 'Long legacy ref' }).label, 'Long legacy ref');
    migrated.relabel('EXISTING_KEY', { model: 'chosen', baseUrl: 'https://example.com/v1' });
    assert.equal(new Credentials(db, secrets).row('EXISTING_KEY').model, 'chosen');
    assert.equal(migrated.create({ label: 'New key', provider: 'openai', model: 'new-model', value: 'new-secret' }).model, 'new-model');
  } finally {
    db.close(); rmSync(directory, { recursive: true, force: true });
    if (previous === undefined) delete process.env.OPEN_HARNESS_DISABLE_OS_VAULT; else process.env.OPEN_HARNESS_DISABLE_OS_VAULT = previous;
  }
});

test('a provider credential drops old custom endpoints while generic keys retain explicit connections', () => {
  const current = { provider: 'openai', model: 'private-model', baseUrl: 'https://private.example/v1', credentialRef: 'OLD_KEY' };
  assert.deepEqual(modelForCredential(current, { ref: 'PUBLIC_KEY', provider: 'openai', model: 'public-model', baseUrl: '' }), { provider: 'openai', model: 'public-model', baseUrl: '', credentialRef: 'PUBLIC_KEY' });
  assert.deepEqual(modelForCredential(current, { ref: 'GENERIC_KEY', provider: '', model: '', baseUrl: '' }), { ...current, credentialRef: 'GENERIC_KEY' });
});
