export type RunnerKeyPair = { publicKey: string; privateKey: string };
export type EncryptedRunnerSecret = { version: 1; key: string; iv: string; data: string };

function base64(bytes: Uint8Array) {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  return btoa(binary);
}

function bytes(value: string) {
  const binary = atob(value), output = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) output[index] = binary.charCodeAt(index);
  return output;
}

export async function generateRunnerKeyPair(): Promise<RunnerKeyPair> {
  const pair = await crypto.subtle.generateKey({ name: 'RSA-OAEP', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' }, true, ['encrypt', 'decrypt']);
  return { publicKey: JSON.stringify(await crypto.subtle.exportKey('jwk', pair.publicKey)), privateKey: JSON.stringify(await crypto.subtle.exportKey('jwk', pair.privateKey)) };
}

export async function encryptRunnerSecret(publicKey: string, value: string): Promise<EncryptedRunnerSecret> {
  const rsa = await crypto.subtle.importKey('jwk', JSON.parse(publicKey), { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['encrypt']);
  const aes = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, true, ['encrypt', 'decrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aes, new TextEncoder().encode(value));
  const rawKey = await crypto.subtle.exportKey('raw', aes);
  const wrapped = await crypto.subtle.encrypt({ name: 'RSA-OAEP' }, rsa, rawKey);
  return { version: 1, key: base64(new Uint8Array(wrapped)), iv: base64(iv), data: base64(new Uint8Array(data)) };
}

export async function decryptRunnerSecret(privateKey: string, payload: EncryptedRunnerSecret) {
  if (payload.version !== 1) throw new Error('Unsupported encrypted credential version.');
  const rsa = await crypto.subtle.importKey('jwk', JSON.parse(privateKey), { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['decrypt']);
  const rawKey = await crypto.subtle.decrypt({ name: 'RSA-OAEP' }, rsa, bytes(payload.key));
  const aes = await crypto.subtle.importKey('raw', rawKey, { name: 'AES-GCM' }, false, ['decrypt']);
  const clear = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: bytes(payload.iv) }, aes, bytes(payload.data));
  return new TextDecoder().decode(clear);
}
