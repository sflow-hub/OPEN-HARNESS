import { createHash } from 'node:crypto';
import { decryptRunnerSecret, encryptRunnerSecret, type EncryptedRunnerSecret } from '../lib/runner-crypto';
import { AGENT_TRANSFER_CLEAR_LIMIT, AGENT_TRANSFER_WIRE_LIMIT, type TransferBundle } from './transfer-files';

export type TransferBinding = { transferId: string; agentId: string; sourceMachineId: string; destinationMachineId: string };
export type SealedAgentTransfer = TransferBinding & { version: 1; purpose: 'open-harness-agent-transfer'; checksum: string; files: number; encrypted: EncryptedRunnerSecret };
const purpose = 'open-harness-agent-transfer', bindingKeys = ['transferId', 'agentId', 'sourceMachineId', 'destinationMachineId'] as const;
const hash = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');
const failure = () => new Error('The encrypted agent transfer is invalid or belongs to another move. Source data was preserved.');
function record(value: unknown): value is Record<string, unknown> { return Boolean(value && typeof value === 'object' && !Array.isArray(value)); }
function base64(value: string) { const padding = value.indexOf('='); return value.length % 4 === 0 && !/[^A-Za-z0-9+/=]/.test(value) && (padding < 0 || padding >= value.length - 2 && /^={1,2}$/.test(value.slice(padding))); }
function bindingValid(value: unknown, expected: TransferBinding) {
  return record(value) && bindingKeys.every(key => typeof expected[key] === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,199}$/.test(expected[key]) && value[key] === expected[key]);
}
function integrity(value: unknown) {
  if (!record(value) || !Array.isArray(value.files) || typeof value.checksum !== 'string' || !/^[a-f0-9]{64}$/.test(value.checksum) || value.files.length > 10000) throw failure();
  let total = 0, count = 0;
  const manifest = (files: unknown[]) => files.map(file => {
    if (!record(file) || typeof file.path !== 'string' || file.path.length > 1024 || typeof file.data !== 'string' || typeof file.checksum !== 'string' || !/^[a-f0-9]{64}$/.test(file.checksum)) throw failure();
    if (++count > 10000 || file.data.length > AGENT_TRANSFER_CLEAR_LIMIT) throw failure();
    const bytes = Buffer.from(file.data, 'base64'); total += bytes.length;
    if (total > 50_000_000 || bytes.toString('base64') !== file.data || hash(bytes) !== file.checksum) throw failure();
    return { path: file.path, checksum: file.checksum };
  }).sort((a,b) => a.path.localeCompare(b.path)).map(file => `${file.path}:${file.checksum}`).join('\n');
  const files = manifest(value.files); let browser = '';
  if (value.browser !== undefined) {
    if (!record(value.browser) || value.browser.version !== 1 || !Array.isArray(value.browser.files) || typeof value.browser.checksum !== 'string') throw failure();
    browser = hash(manifest(value.browser.files)); if (browser !== value.browser.checksum) throw failure();
  }
  const checksum = hash(files + (value.browser !== undefined ? `\n@desktop-browser-v1:${browser}` : ''));
  if (checksum !== value.checksum) throw failure();
  return { checksum, files: count };
}
export function validateSealedTransfer(value: unknown, binding: TransferBinding): SealedAgentTransfer {
  if (!record(value) || value.version !== 1 || value.purpose !== purpose || !bindingValid(value, binding) || Object.keys(value).some(key => !['version','purpose',...bindingKeys,'checksum','files','encrypted'].includes(key)) || typeof value.checksum !== 'string' || !/^[a-f0-9]{64}$/.test(value.checksum) || !Number.isSafeInteger(value.files) || Number(value.files) < 0 || Number(value.files) > 10000) throw failure();
  const encrypted = value.encrypted;
  if (!record(encrypted) || Object.keys(encrypted).some(key => !['version','key','iv','data'].includes(key)) || encrypted.version !== 1 || typeof encrypted.key !== 'string' || encrypted.key.length !== 344 || typeof encrypted.iv !== 'string' || encrypted.iv.length !== 16 || typeof encrypted.data !== 'string' || encrypted.data.length < 24 || encrypted.data.length > AGENT_TRANSFER_WIRE_LIMIT - 4096) throw failure();
  if (!base64(encrypted.key) || !base64(encrypted.iv) || !base64(encrypted.data)) throw failure();
  if (Buffer.byteLength(JSON.stringify(value)) > AGENT_TRANSFER_WIRE_LIMIT) throw failure();
  return value as SealedAgentTransfer;
}
export async function sealAgentTransfer(bundle: TransferBundle, binding: TransferBinding, publicKey: string): Promise<SealedAgentTransfer> {
  if (!bindingValid(binding, binding)) throw failure();
  const metadata = integrity(bundle), clear = JSON.stringify({ version: 1, purpose, ...binding, ...metadata, bundle });
  if (Buffer.byteLength(clear) > AGENT_TRANSFER_CLEAR_LIMIT) throw failure();
  try { return validateSealedTransfer({ version: 1, purpose, ...binding, ...metadata, encrypted: await encryptRunnerSecret(publicKey, clear) }, binding); }
  catch { throw failure(); }
}
export async function openAgentTransfer(value: unknown, binding: TransferBinding, privateKey: string): Promise<TransferBundle> {
  const sealed = validateSealedTransfer(value, binding);
  try {
    const clear = await decryptRunnerSecret(privateKey, sealed.encrypted); if (Buffer.byteLength(clear) > AGENT_TRANSFER_CLEAR_LIMIT) throw failure();
    const decoded = JSON.parse(clear);
    if (!record(decoded) || decoded.version !== 1 || decoded.purpose !== purpose || !bindingValid(decoded, binding)) throw failure();
    const metadata = integrity(decoded.bundle);
    if (metadata.checksum !== sealed.checksum || metadata.files !== sealed.files || decoded.checksum !== metadata.checksum || decoded.files !== metadata.files) throw failure();
    return decoded.bundle as TransferBundle;
  } catch { throw failure(); }
}
