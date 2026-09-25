/* eslint-disable @typescript-eslint/no-explicit-any */
// Pairing a phone to a coordinator ("the hub"), and the credential that results.
//
// This mirrors the authenticated part of computer pairing and deliberately reuses the same
// enrollment endpoint and key exchange. The issued device credential is dashboard-only; the
// coordinator rejects it on runner command routes.
import { generateRunnerKeyPair } from './runner-crypto';

export type DeviceCredential = {
  hubUrl: string;
  machineId: string;
  token: string;
  sitesToken?: string;
  encryptionPublicKey: string;
  encryptionPrivateKey: string;
  name: string;
  pairedAt: string;
};

export type PairingLink = { hubUrl: string; code: string; sitesToken?: string };

const LOOPBACK = ['localhost', '127.0.0.1', '::1'];

// The same rule the runner enforces before it will save a coordinator address. Plain HTTP is
// tolerable only when it cannot leave the machine, which on a phone means a development
// emulator reaching the host through a forwarded port.
export function validateHubUrl(input: string) {
  const trimmed = String(input || '').trim().replace(/\/$/, '');
  if (!trimmed) throw new Error('Enter the address of your Open Harness coordinator.');
  let url: URL;
  try { url = new URL(trimmed); } catch { throw new Error('That is not a valid web address. It should look like https://agents.example.com.'); }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && LOOPBACK.includes(url.hostname))) {
    throw new Error('The hub address must use HTTPS so your work is encrypted on the way there.');
  }
  return trimmed;
}

// The desktop shows a code to type and a link to scan. Both carry the same two facts.
export function parsePairingLink(input: string): PairingLink | null {
  const raw = String(input || '').trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== 'openharness:') return null;
    const hub = url.searchParams.get('hub') || '';
    const code = url.searchParams.get('code') || '';
    if (!hub || !code) return null;
    const sites = url.searchParams.get('sites') || '';
    return { hubUrl: validateHubUrl(hub), code, ...(sites ? { sitesToken: sites } : {}) };
  } catch { return null; }
}

export function normalizePairingCode(input: string) {
  // Typed on a phone keyboard: forgive spacing and case, and fix the substitutions people
  // make when reading a code aloud. The alphabet deliberately excludes I, L, O and U.
  return String(input || '').toUpperCase().replace(/[^0-9A-Z]/g, '')
    .replaceAll('I', '1').replaceAll('L', '1').replaceAll('O', '0').replaceAll('U', 'V');
}

export async function pairDevice(input: {
  hubUrl: string;
  code: string;
  sitesToken?: string;
  name: string;
  platform: string;
  arch?: string;
  fetchImpl?: typeof fetch;
}): Promise<DeviceCredential> {
  const hubUrl = validateHubUrl(input.hubUrl);
  const code = normalizePairingCode(input.code);
  if (!code) throw new Error('Enter the pairing code shown on your computer.');
  const request = input.fetchImpl || globalThis.fetch.bind(globalThis);
  // The private half never leaves this device. The hub encrypts model credentials to the
  // public half, so it stores ciphertext it cannot read.
  const encryption = await generateRunnerKeyPair();
  const response = await request(`${hubUrl}/v1/runner/pair`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(input.sitesToken ? { 'OAI-Sites-Authorization': `Bearer ${input.sitesToken}` } : {}) },
    body: JSON.stringify({
      code,
      name: input.name,
      platform: input.platform,
      arch: input.arch || 'unknown',
      capabilities: { container: false, direct: false, desktop: false, virtualDesktop: false, mobile: true, detail: 'Companion dashboard only; agents run on a connected computer.' },
      encryptionPublicKey: encryption.publicKey,
    }),
  });
  const value = await response.json().catch(() => ({})) as any;
  if (!response.ok) {
    if (response.status === 410) throw new Error('That code has expired or was already used. Create a new one on your computer.');
    if (response.status === 404) throw new Error('No Open Harness coordinator answered at that address. Check the address and try again.');
    throw new Error(value.error || `The coordinator returned HTTP ${response.status}.`);
  }
  if (!value.token || !value.machineId) throw new Error('The coordinator did not return a credential for this phone.');
  return {
    hubUrl,
    machineId: String(value.machineId),
    token: String(value.token),
    ...(input.sitesToken ? { sitesToken: input.sitesToken } : {}),
    encryptionPublicKey: encryption.publicKey,
    encryptionPrivateKey: encryption.privateKey,
    name: String(value.machine?.name || input.name),
    pairedAt: new Date().toISOString(),
  };
}

export function devicePlatform(): { platform: string; name: string } {
  if (typeof navigator === 'undefined') return { platform: 'unknown', name: 'Phone' };
  const agent = navigator.userAgent || '';
  if (/android/i.test(agent)) return { platform: 'android', name: 'Android phone' };
  if (/iphone|ipad|ipod/i.test(agent) || (/Mac/.test(agent) && 'ontouchend' in document)) return { platform: 'ios', name: 'iPhone' };
  return { platform: 'unknown', name: 'Phone' };
}
