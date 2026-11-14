import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';

export function isEncryptedSecrets(raw: string) {
  try { return JSON.parse(raw)?.format === 'open-harness-secrets'; }
  catch { throw new Error('Credential storage is not readable JSON.'); }
}

export function encryptionKey(path: string, create: boolean) {
  const configured = process.env.OPEN_HARNESS_ENCRYPTION_KEY;
  if (configured) {
    if (!/^[A-Za-z0-9+/]{43}=$/.test(configured)) throw new Error('OPEN_HARNESS_ENCRYPTION_KEY must be a base64-encoded 32-byte key.');
    return Buffer.from(configured, 'base64');
  }
  const keyPath = `${path}.key`;
  if (!existsSync(keyPath)) {
    if (!create) throw new Error('The credential encryption key is missing. Restore the original key; the store has not been changed.');
    writeFileSync(keyPath, randomBytes(32), { mode: 0o600, flag: 'wx' });
  }
  const key = readFileSync(keyPath);
  if (key.length !== 32) throw new Error('The credential encryption key is invalid. Restore the original key.');
  chmodSync(keyPath, 0o600);
  return key;
}

export function sealSecrets(plain: string, key: Buffer) {
  const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from('open-harness-secrets-v1'));
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return JSON.stringify({ format: 'open-harness-secrets', version: 1, nonce: nonce.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: ciphertext.toString('base64') });
}

export function openSecrets(raw: string, key: Buffer) {
  const data = JSON.parse(raw);
  if (data.format !== 'open-harness-secrets' || data.version !== 1) throw new Error('Unsupported encrypted credential format.');
  const nonce = Buffer.from(data.nonce, 'base64'), tag = Buffer.from(data.tag, 'base64');
  if (nonce.length !== 12 || tag.length !== 16) throw new Error('Invalid encrypted credential data.');
  const cipher = createDecipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from('open-harness-secrets-v1')); cipher.setAuthTag(tag);
  return Buffer.concat([cipher.update(Buffer.from(data.ciphertext, 'base64')), cipher.final()]).toString('utf8');
}

export function writeEncryptedSecrets(path: string, plain: string) {
  const existing = existsSync(path) ? readFileSync(path, 'utf8') : undefined, encrypted = existing === undefined ? false : isEncryptedSecrets(existing);
  const key = encryptionKey(path, !encrypted);
  if (encrypted) openSecrets(existing!, key);
  const sealed = sealSecrets(plain, key), temporary = `${path}.${randomBytes(8).toString('hex')}.tmp`;
  try {
    writeFileSync(temporary, sealed, { mode: 0o600, flag: 'wx' });
    if (openSecrets(readFileSync(temporary, 'utf8'), key) !== plain) throw new Error('Credential storage verification failed.');
    renameSync(temporary, path); chmodSync(path, 0o600);
  } finally { if (existsSync(temporary)) unlinkSync(temporary); }
}
