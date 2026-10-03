import { createHash, randomBytes } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const BROWSER_PAIRING_MESSAGE = 'Open Open Harness with its launcher to connect this browser. The launcher creates a new one-use connection link.';
export const BROWSER_PAIRING_INVALID = 'This browser connection link is invalid or expired. Open Open Harness with its launcher to get a new link.';
const MAX_TTL_SECONDS = 600;
const hash = (code: string) => createHash('sha256').update(code).digest('hex');
type PairingRecord = { version: 1; issuedAt: number; expiresAt: number };

function directory(stateRoot: string, create: boolean) {
  const dir = join(resolve(stateRoot), '.browser-pairing');
  if (create) {
    mkdirSync(resolve(stateRoot), { recursive: true, mode: 0o700 });
    try { mkdirSync(dir, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  }
  const info = lstatSync(dir);
  if (!info.isDirectory() || info.isSymbolicLink() || (process.getuid && (info.uid !== process.getuid() || (info.mode & 0o077)))) throw new Error('The browser connection directory must be a private directory owned by the coordinator user.');
  return dir;
}

function record(path: string): PairingRecord | null {
  let fd: number | undefined;
  try {
    if (!lstatSync(path).isFile()) return null;
    fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0));
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > 512 || info.nlink !== 1 || (process.getuid && (info.uid !== process.getuid() || (info.mode & 0o077)))) return null;
    const value = JSON.parse(readFileSync(fd, 'utf8')) as PairingRecord;
    return value?.version === 1 && Number.isSafeInteger(value.issuedAt) && Number.isSafeInteger(value.expiresAt) && value.expiresAt > value.issuedAt && value.expiresAt - value.issuedAt <= MAX_TTL_SECONDS * 1000 ? value : null;
  } catch { return null; }
  finally { if (fd !== undefined) closeSync(fd); }
}

export function issueBrowserPairing(stateRoot: string, ttlSeconds = 300, now = Date.now()) {
  if (!Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > MAX_TTL_SECONDS) throw new Error('Browser connection expiry must be between 1 and 600 seconds.');
  const dir = directory(stateRoot, true);
  for (const name of readdirSync(dir)) {
    if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
    const path = join(dir, name), previous = record(path);
    if (previous && previous.expiresAt <= now) { try { unlinkSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; } }
  }
  const code = randomBytes(32).toString('base64url'), expiresAt = now + ttlSeconds * 1000;
  writeFileSync(join(dir, `${hash(code)}.json`), JSON.stringify({ version: 1, issuedAt: now, expiresAt }), { flag: 'wx', mode: 0o600 });
  return { code, expiresAt: new Date(expiresAt).toISOString() };
}

export function consumeBrowserPairing(stateRoot: string, code: unknown, now = Date.now()): boolean {
  if (typeof code !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(code)) return false;
  try {
    const path = join(directory(stateRoot, false), `${hash(code)}.json`), saved = record(path);
    if (!saved || saved.issuedAt > now || saved.expiresAt <= now) return false;
    // Only one caller can unlink this record, even across coordinator processes.
    // Consume before returning the operator token; a crash requires a fresh link.
    unlinkSync(path);
    return true;
  } catch { return false; }
}
