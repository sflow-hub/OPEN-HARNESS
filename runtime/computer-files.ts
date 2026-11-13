import { createHash } from 'node:crypto';
import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readSync, unlinkSync, writeFileSync, type Stats } from 'node:fs';
import { join } from 'node:path';
import type { ComputerConfig } from '../lib/agent-profile';
import { desktopResourcePaths } from './computer-runtime';
import { atomicWorkspaceWrite, readWorkspaceFile, safeWorkspacePath } from './path-safety';

export const DESKTOP_FILE_LIMITS = { fileBytes: 25 * 1024 * 1024, batchBytes: 100 * 1024 * 1024, entries: 100 } as const;
export type DesktopExchangeLease = { ownerId: string; epoch: number; runId?: string };
export type DesktopDownloadReceipt = DesktopExchangeLease & { id: string; name: string; path: string; bytes: number; sha256: string; savedAt: string };
type Record = { version: 1; resourceKey: string; lease: DesktopExchangeLease; observed: { [identity: string]: DesktopExchangeLease } };
const claiming = new Set<string>();
const same = (first: DesktopExchangeLease, second: DesktopExchangeLease) => first.ownerId === second.ownerId && first.epoch === second.epoch && first.runId === second.runId;
function validateLease(agentId: string, lease: DesktopExchangeLease) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(agentId) || lease.ownerId !== agentId || !Number.isSafeInteger(lease.epoch) || lease.epoch < 0 || lease.runId !== undefined && !/^[\w-]{1,100}$/.test(lease.runId)) throw new Error('Desktop file ownership is invalid.');
}
function paths(agentId: string, root: string, computer: ComputerConfig) {
  const desktop = desktopResourcePaths(agentId, root, computer), prefix = `computers/${desktop.key}`;
  return { ...desktop, record: safeWorkspacePath(root, `${prefix}/exchange.json`), downloads: safeWorkspacePath(root, `${prefix}/staging/downloads`), uploads: safeWorkspacePath(root, `${prefix}/staging/uploads`), receipts: safeWorkspacePath(root, `${prefix}/receipts`) };
}
function readRecord(file: string, key: string): Record | null {
  if (!existsSync(file)) return null;
  let value: Record; try { value = JSON.parse(readWorkspaceFile(file).toString('utf8')); } catch { throw new Error('Desktop file ownership is unreadable.'); }
  if (value.version !== 1 || value.resourceKey !== key || !value.lease || !value.observed || typeof value.observed !== 'object' || Array.isArray(value.observed)) throw new Error('Desktop file ownership is invalid.');
  validateLease(value.lease.ownerId, value.lease);
  for (const lease of Object.values(value.observed)) validateLease(value.lease.ownerId, lease);
  return value;
}
function allowedName(name: string) {
  if (!name || Buffer.byteLength(name) > 180 || /^[.]/.test(name) || /[\x00-\x1f\x7f/:\\]/.test(name)) return false;
  try { safeWorkspacePath('/portable-desktop-exchange', name); return true; } catch { return false; }
}
const partial = (name: string) => /\.(?:crdownload|part|tmp)$/i.test(name);
export function validateDesktopUploadName(value: unknown) {
  if (typeof value !== 'string' || !allowedName(value) || partial(value)) throw new Error('Choose one ordinary file name from the agent exchange folder.');
  return value;
}
export function desktopUploadResult(value: { [key: string]: unknown }, expectedName?: string) {
  const name = validateDesktopUploadName(value.name), prefix = '/workspace/exchange/uploads/';
  if (expectedName !== undefined && name !== expectedName || typeof value.path !== 'string' || !value.path.startsWith(prefix) || !/^[a-f0-9]{16}-/.test(value.path.slice(prefix.length)) || value.path.slice(prefix.length + 17) !== name || !Number.isSafeInteger(value.bytes) || Number(value.bytes) < 0 || Number(value.bytes) > DESKTOP_FILE_LIMITS.fileBytes) throw new Error('The browser returned invalid upload details.');
  return { name, path: value.path, bytes: Number(value.bytes) };
}
function entries(path: string) {
  const names = readdirSync(path);
  if (names.length > DESKTOP_FILE_LIMITS.entries) throw new Error('Desktop exchange has too many files. Remove files before continuing.');
  return names.sort();
}
function identity(stat: Stats) { return `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`; }
function observe(path: string, record: Record) {
  const current: Record['observed'] = {};
  for (const name of entries(path)) {
    const stat = lstatSync(join(path, name));
    if (!stat.isFile() || stat.nlink !== 1) continue;
    const id = identity(stat); current[id] = record.observed[id] || record.lease;
  }
  record.observed = current;
}
function readBounded(file: string) {
  const expected = lstatSync(file);
  if (!expected.isFile() || expected.nlink !== 1 || expected.size > DESKTOP_FILE_LIMITS.fileBytes) throw new Error('Desktop exchange accepts regular files up to 25 MiB only.');
  const fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.nlink !== 1 || identity(before) !== identity(expected)) throw new Error('Desktop file changed while opening it.');
    const data = Buffer.alloc(Math.min(before.size + 1, DESKTOP_FILE_LIMITS.fileBytes + 1)); let size = 0;
    while (size < data.length) { const count = readSync(fd, data, size, data.length - size, null); if (!count) break; size += count; }
    const after = fstatSync(fd);
    if (size !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw new Error('Desktop download is still changing.');
    return { data: data.subarray(0, size), stat: after };
  } finally { closeSync(fd); }
}
function saveNew(file: string, data: Buffer) {
  try { writeFileSync(file, data, { flag: 'wx', mode: 0o600 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || !readBounded(file).data.equals(data)) throw error;
  }
}
function publish(agentId: string, root: string, computer: ComputerConfig, record: Record) {
  const p = paths(agentId, root, computer), result: DesktopDownloadReceipt[] = [];
  observe(p.downloads, record); let bytes = 0;
  for (const name of entries(p.downloads)) {
    if (!allowedName(name) || partial(name)) continue;
    const source = join(p.downloads, name); let value;
    try { value = readBounded(source); } catch { continue; }
    if (bytes + value.data.length > DESKTOP_FILE_LIMITS.batchBytes) break;
    const origin = record.observed[identity(value.stat)]; if (!origin || origin.ownerId !== agentId) throw new Error('Desktop download owner changed.');
    const sha256 = createHash('sha256').update(value.data).digest('hex'), id = createHash('sha256').update(JSON.stringify([p.key, origin, identity(value.stat), sha256])).digest('hex').slice(0, 32);
    const nameOnDisk = `${id}-${name}`, privateDirectory = safeWorkspacePath(root, `agents/${agentId}/private/downloads`);
    mkdirSync(privateDirectory, { recursive: true, mode: 0o700 }); mkdirSync(p.receipts, { recursive: true, mode: 0o700 });
    const target = safeWorkspacePath(root, `agents/${agentId}/private/downloads/${nameOnDisk}`), receiptPath = safeWorkspacePath(root, `computers/${p.key}/receipts/${id}.json`);
    saveNew(target, value.data);
    const receipt: DesktopDownloadReceipt = { ...origin, id, name, path: `downloads/${nameOnDisk}`, bytes: value.data.length, sha256, savedAt: new Date().toISOString() };
    if (!existsSync(receiptPath)) atomicWorkspaceWrite(receiptPath, JSON.stringify(receipt));
    const now = lstatSync(source);
    if (identity(now) === identity(value.stat) && now.size === value.stat.size && now.mtimeMs === value.stat.mtimeMs) unlinkSync(source);
    result.push(receipt); bytes += value.data.length;
  }
  observe(p.downloads, record); atomicWorkspaceWrite(p.record, JSON.stringify(record)); return result;
}
function clearStaging(staging: string) {
  // Never follow links or delete any browser/private directory. Bound cleanup before changing it.
  const files: string[] = [], directories: string[] = [];
  const walk = (path: string, depth: number) => {
    if (depth > 3) throw new Error('Desktop staging contains unsupported directories.');
    for (const name of readdirSync(path)) {
      if (files.length + directories.length >= DESKTOP_FILE_LIMITS.entries * 3) throw new Error('Desktop staging needs cleanup before it can change owners.');
      const file = join(path, name), stat = lstatSync(file);
      if (stat.isDirectory()) {
        if (file !== join(staging, 'downloads') && file !== join(staging, 'uploads')) throw new Error('Desktop staging contains unsupported directories.');
        directories.push(file); walk(file, depth + 1);
      } else files.push(file);
    }
  };
  walk(staging, 0);
  for (const file of files) unlinkSync(file);
}
export async function claimDesktopExchange(agentId: string, root: string, computer: ComputerConfig, lease: DesktopExchangeLease, stopBrowser: () => Promise<void>): Promise<{ reset: boolean }> {
  validateLease(agentId, lease); const p = paths(agentId, root, computer);
  if (claiming.has(p.key)) throw new Error('Desktop file ownership is changing.');
  claiming.add(p.key);
  try {
    mkdirSync(p.downloads, { recursive: true, mode: 0o700 }); mkdirSync(p.uploads, { recursive: true, mode: 0o700 });
    const previous = readRecord(p.record, p.key), original = JSON.stringify(previous);
    if (previous && lease.epoch < previous.lease.epoch) throw new Error('Desktop file ownership is stale.');
    const reset = previous ? previous.lease.ownerId !== agentId : readdirSync(p.staging).some(name => !['downloads', 'uploads'].includes(name)) || entries(p.downloads).length > 0 || entries(p.uploads).length > 0;
    if (reset) {
      await stopBrowser();
      if (JSON.stringify(readRecord(p.record, p.key)) !== original) throw new Error('Desktop file ownership changed during browser shutdown.');
      if (previous) publish(previous.lease.ownerId, root, computer, previous);
      clearStaging(p.staging);
    } else if (previous) observe(p.downloads, previous);
    const next: Record = { version: 1, resourceKey: p.key, lease: { ...lease }, observed: reset ? {} : previous?.observed || {} };
    atomicWorkspaceWrite(p.record, JSON.stringify(next)); return { reset };
  } finally { claiming.delete(p.key); }
}
export function publishDesktopDownloads(agentId: string, root: string, computer: ComputerConfig, lease: DesktopExchangeLease): DesktopDownloadReceipt[] {
  validateLease(agentId, lease); const p = paths(agentId, root, computer), record = readRecord(p.record, p.key);
  if (claiming.has(p.key) || !record || !same(record.lease, lease)) throw new Error('Desktop file ownership changed.');
  return publish(agentId, root, computer, record);
}
export function stageDesktopUpload(agentId: string, root: string, computer: ComputerConfig, lease: DesktopExchangeLease, name: string) {
  validateLease(agentId, lease); const p = paths(agentId, root, computer), record = readRecord(p.record, p.key);
  if (claiming.has(p.key) || !record || !same(record.lease, lease)) throw new Error('Desktop file ownership changed.');
  validateDesktopUploadName(name);
  const value = readBounded(safeWorkspacePath(root, `agents/${agentId}/private/exchange/${name}`));
  let total = 0; const existing = entries(p.uploads);
  for (const item of existing) { const stat = lstatSync(join(p.uploads, item)); if (!stat.isFile() || stat.nlink !== 1) throw new Error('Upload staging contains an unsupported file.'); total += stat.size; }
  const destination = `${createHash('sha256').update(value.data).digest('hex').slice(0, 16)}-${name}`;
  if (!existing.includes(destination) && (existing.length >= DESKTOP_FILE_LIMITS.entries || total + value.data.length > DESKTOP_FILE_LIMITS.batchBytes)) throw new Error('Desktop upload staging is full.');
  saveNew(safeWorkspacePath(root, `computers/${p.key}/staging/uploads/${destination}`), value.data);
  return { name, bytes: value.data.length, path: `/workspace/exchange/uploads/${destination}` };
}
