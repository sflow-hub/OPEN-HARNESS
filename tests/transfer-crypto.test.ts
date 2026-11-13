import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { encryptRunnerSecret, generateRunnerKeyPair } from '../lib/runner-crypto';
import { openAgentTransfer, sealAgentTransfer, validateSealedTransfer, type TransferBinding } from '../runtime/transfer-crypto';
import type { TransferBundle } from '../runtime/transfer-files';

const keys = generateRunnerKeyPair(), binding: TransferBinding = { transferId: 'move-one', agentId: 'atlas', sourceMachineId: 'source-runner', destinationMachineId: 'destination-runner' };
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
function bundle(): TransferBundle {
  const files = [{ path: 'private/report.txt', data: Buffer.from('private report fixture').toString('base64'), checksum: hash('private report fixture') }], browserFiles = [{ path: 'Default/Cookies', data: Buffer.from('private cookie fixture').toString('base64'), checksum: hash('private cookie fixture') }];
  const browser = { version: 1 as const, files: browserFiles, checksum: hash(browserFiles.map(file => `${file.path}:${file.checksum}`).join('\n')) };
  return { files, browser, checksum: hash(files.map(file => `${file.path}:${file.checksum}`).join('\n') + `\n@desktop-browser-v1:${browser.checksum}`) };
}
test('whole transfer bundles persist only as destination-bound ciphertext and open with verified contents', async () => {
  const pair = await keys, original = bundle(), sealed = await sealAgentTransfer(original, binding, pair.publicKey), serialized = JSON.stringify(sealed);
  for (const secret of ['private report fixture', 'private cookie fixture', original.files[0].data, original.browser!.files[0].data, 'Default/Cookies', 'private/report.txt']) assert.ok(!serialized.includes(secret));
  assert.equal(sealed.files, 2); assert.equal(sealed.checksum, original.checksum); assert.deepEqual(validateSealedTransfer(JSON.parse(serialized), binding), sealed);
  assert.deepEqual(await openAgentTransfer(sealed, binding, pair.privateKey), original);
  const other = await generateRunnerKeyPair(); await assert.rejects(openAgentTransfer(sealed, binding, other.privateKey), /encrypted agent transfer is invalid/);
});
test('transfer envelopes reject plaintext, extra fields, every changed binding, altered metadata and ciphertext', async () => {
  const pair = await keys, sealed = await sealAgentTransfer(bundle(), binding, pair.publicKey);
  assert.throws(() => validateSealedTransfer(bundle(), binding)); assert.throws(() => validateSealedTransfer({ ...sealed, bundle: bundle() }, binding));
  for (const key of Object.keys(binding) as Array<keyof TransferBinding>) assert.throws(() => validateSealedTransfer({ ...sealed, [key]: 'another' }, binding));
  for (const changed of [{ ...sealed, checksum: 'f'.repeat(64) }, { ...sealed, files: 1 }, { ...sealed, encrypted: { ...sealed.encrypted, data: (sealed.encrypted.data[0] === 'A' ? 'B' : 'A') + sealed.encrypted.data.slice(1) } }]) await assert.rejects(openAgentTransfer(changed, binding, pair.privateKey));
  assert.throws(() => validateSealedTransfer({ ...sealed, encrypted: { ...sealed.encrypted, data: 'not encrypted plaintext!!' } }, binding));
  assert.throws(() => validateSealedTransfer({ ...sealed, encrypted: { ...sealed.encrypted, extra: 'plaintext' } }, binding));
});
test('authenticated inner bindings and actual file hashes must match before any restore', async () => {
  const pair = await keys, original = bundle(), sealed = await sealAgentTransfer(original, binding, pair.publicKey);
  const inner = { version: 1, purpose: sealed.purpose, ...binding, checksum: sealed.checksum, files: sealed.files, bundle: original };
  for (const changed of [{ ...inner, version: 2 }, { ...inner, purpose: 'another-purpose' }, ...Object.keys(binding).map(key => ({ ...inner, [key]: 'another' })), { ...inner, bundle: { ...original, files: [{ ...original.files[0], data: Buffer.from('changed file').toString('base64') }] } }]) {
    const encrypted = await encryptRunnerSecret(pair.publicKey, JSON.stringify(changed)); await assert.rejects(openAgentTransfer({ ...sealed, encrypted }, binding, pair.privateKey));
  }
  const invalid = bundle(); invalid.browser!.files[0].data = Buffer.from('changed cookie').toString('base64'); await assert.rejects(sealAgentTransfer(invalid, binding, pair.publicKey));
});
