import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { adoptBootstrapCredentials, Credentials } from '../runtime/credentials';
import type { SecretStore } from '../runtime/secrets';

function vault(initial: Record<string, string> = {}) {
  const values = { ...initial }, writes: string[] = [];
  const secrets = { token: 'test-control-token', backend: 'test', names: () => Object.keys(values), has: (name: string) => Boolean(values[name]), environment: () => ({ ...values }), set: (name: string, value: string) => { values[name] = value; writes.push(name); } };
  return { values, writes, secrets };
}

test('coordinator bootstrap adopts only the four documented nonempty keys and keeps saved values', () => {
  const saved = vault({ OPENAI_API_KEY: 'saved-openai', OPENROUTER_API_KEY: '', unrelated: 'keep' });
  const environment = { XAI_API_KEY: 'bootstrap-xai', OPENAI_API_KEY: 'replacement', OPENROUTER_API_KEY: 'replacement-empty', MODEL_API_KEY: 'bootstrap-model', controlToken: 'must-not-import', BACKUP_RECOVERY_KEY: 'must-not-import', OTHER_API_KEY: 'must-not-import' };
  adoptBootstrapCredentials(saved.secrets, environment);
  assert.deepEqual(saved.values, { OPENAI_API_KEY: 'saved-openai', OPENROUTER_API_KEY: '', unrelated: 'keep', XAI_API_KEY: 'bootstrap-xai', MODEL_API_KEY: 'bootstrap-model' });
  adoptBootstrapCredentials(saved.secrets, { ...environment, XAI_API_KEY: 'changed-environment' });
  assert.deepEqual(saved.writes, ['XAI_API_KEY', 'MODEL_API_KEY']);
  const empty = vault(); adoptBootstrapCredentials(empty.secrets, { XAI_API_KEY: '', OPENAI_API_KEY: ' \n\t', OPENROUTER_API_KEY: undefined });
  assert.deepEqual(empty.writes, []);
});

test('bootstrapped keys become manageable credential metadata without exposing their values', () => {
  const db = new DatabaseSync(':memory:'), saved = vault();
  try {
    adoptBootstrapCredentials(saved.secrets, { XAI_API_KEY: 'bootstrap-secret-value', OPENAI_API_KEY: 'openai-secret-value', OPENROUTER_API_KEY: 'router-secret-value', MODEL_API_KEY: 'custom-secret-value' });
    const credentials = new Credentials(db, saved.secrets as SecretStore), rows = credentials.rows();
    assert.deepEqual(rows.map(row => row.ref).sort(), ['MODEL_API_KEY', 'OPENAI_API_KEY', 'OPENROUTER_API_KEY', 'XAI_API_KEY']);
    assert.equal(credentials.row('XAI_API_KEY').provider, 'xai');
    assert.equal(credentials.present('XAI_API_KEY'), true);
    for (const value of Object.values(saved.values)) assert.equal(JSON.stringify(rows).includes(value), false);
  } finally { db.close(); }
});
