import test from 'node:test';
import assert from 'node:assert/strict';
import { decryptRunnerSecret, encryptRunnerSecret, generateRunnerKeyPair } from '../lib/runner-crypto';

test('encrypts dashboard credentials exclusively for the paired runner', async () => {
  const runner = await generateRunnerKeyPair();
  const other = await generateRunnerKeyPair();
  const value = `provider-key-${'private-value-'.repeat(80)}`;
  const encrypted = await encryptRunnerSecret(runner.publicKey, value);
  assert.equal(await decryptRunnerSecret(runner.privateKey, encrypted), value);
  assert.doesNotMatch(JSON.stringify(encrypted), /private-value/);
  await assert.rejects(() => decryptRunnerSecret(other.privateKey, encrypted));
});
