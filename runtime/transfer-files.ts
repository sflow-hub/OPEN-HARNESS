import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import type { ComputerConfig } from '../lib/agent-profile';
import { atomicWorkspaceWrite, readWorkspaceFile, safeWorkspacePath } from './path-safety';
import { desktopResourcePaths, migrateBrowser, runningDesktopContainer, stopAgentComputer } from './computer-runtime';
import { runningAgentContainer } from './hermes';
import { assertSandboxedComputer } from './computer-validation';

type TransferFile = { path: string; data: string; checksum: string };
export type TransferBundle = { files: TransferFile[]; checksum: string; browser?: { version: 1; files: TransferFile[]; checksum: string } };
export const AGENT_TRANSFER_CLEAR_LIMIT = 80_000_000;
export const AGENT_TRANSFER_WIRE_LIMIT = 112 * 1024 * 1024;
const browserBytes = 50_000_000, maxEntries = 10000, legacyPrefix = 'private/.config/chromium/';
const volatileBrowser = new Set(['SingletonLock','SingletonSocket','SingletonCookie','DevToolsActivePort','Cache','Code Cache','GPUCache','DawnCache','GrShaderCache','ShaderCache','GraphiteDawnCache','BrowserMetrics','Crashpad','Crash Reports']);
const memoryFiles = ['profile/MEMORY.md', 'profile/USER.md', 'profile/memories/MEMORY.md', 'profile/memories/USER.md'];
const allowedRoots = ['private', ...memoryFiles, 'profile/skills'];
function digest(data: Buffer | string) { return createHash('sha256').update(data).digest('hex'); }
function manifest(files: TransferFile[]) { return [...files].sort((a,b) => a.path.localeCompare(b.path)).map(file => `${file.path}:${file.checksum}`).join('\n'); }
function bundleDigest(bundle: Pick<TransferBundle, 'files' | 'browser'>) { return digest(manifest(bundle.files) + (bundle.browser ? `\n@desktop-browser-v1:${bundle.browser.checksum}` : '')); }
function exportFiles(stateRoot: string, agentId: string, omitLegacy = false): TransferBundle {
  const agentRoot = safeWorkspacePath(stateRoot, `agents/${agentId}`), files: TransferBundle['files'] = []; let total = 0;
  const visit = (path: string) => {
    if (omitLegacy && relative(agentRoot, path).replaceAll('\\', '/') === 'private/.config/chromium') return;
    if (!existsSync(path)) return; const stat = lstatSync(path); if (stat.isSymbolicLink()) return;
    safeWorkspacePath(stateRoot, relative(stateRoot, path));
    if (stat.isDirectory()) { for (const name of readdirSync(path)) visit(join(path, name)); return; }
    if (!stat.isFile()) return; const data = readFileSync(path); total += data.length; if (total > 20_000_000) throw new Error('Managed agent data exceeds the 20 MB transfer limit. Move large project files through an explicitly shared folder.');
    files.push({ path: relative(agentRoot, path).replaceAll('\\', '/'), data: Buffer.from(data).toString('base64'), checksum: digest(data) });
  };
  for (const path of allowedRoots) visit(join(agentRoot, path));
  files.sort((a,b) => a.path.localeCompare(b.path)); return { files, checksum: digest(files.map(file => `${file.path}:${file.checksum}`).join('\n')) };
}
export function exportAgentFiles(stateRoot: string, agentId: string): TransferBundle { return exportFiles(stateRoot, agentId); }
function validateBundle(stateRoot: string, agentId: string, bundle: TransferBundle) {
  if (!bundle || !Array.isArray(bundle.files) || bundle.files.length > maxEntries || typeof bundle.checksum !== 'string') throw new Error('Invalid transfer bundle.');
  safeWorkspacePath(stateRoot, `agents/${agentId}`); let total = 0;
  const seen = new Set<string>();
  // Validate the entire bundle before replacing any destination files. In
  // particular, a bad final checksum must not leave a partly imported profile.
  const files = bundle.files.map(file => {
    if (!file || typeof file.path !== 'string' || file.path.length > 1024 || typeof file.data !== 'string' || typeof file.checksum !== 'string') throw new Error('Invalid transfer file.');
    const clean = file.path.replaceAll('\\', '/');
    if (!(clean.startsWith('private/') || memoryFiles.includes(clean) || clean.startsWith('profile/skills/'))) throw new Error('Transfer contains an invalid managed path.');
    const name = `agents/${agentId}/${clean}`, target = safeWorkspacePath(stateRoot, name);
    const key = process.platform === 'win32' ? target.toLowerCase() : target;
    if (seen.has(key)) throw new Error('Transfer contains duplicate managed paths.');
    seen.add(key);
    const data = Buffer.from(file.data, 'base64'); total += data.length;
    if (total > 100_000_000 || digest(data) !== file.checksum) throw new Error('Transfer checksum validation failed.');
    return { name, target, data };
  });
  let browser: Array<{ path: string; data: Buffer }> | undefined;
  if (bundle.browser) {
    if (bundle.browser.version !== 1 || !Array.isArray(bundle.browser.files) || bundle.browser.files.length + files.length > maxEntries || typeof bundle.browser.checksum !== 'string' || total > browserBytes) throw new Error('Invalid browser transfer bundle.');
    const names = new Set<string>();
    browser = bundle.browser.files.map(file => {
      if (!file || typeof file.path !== 'string' || file.path.length > 1024 || typeof file.data !== 'string' || typeof file.checksum !== 'string') throw new Error('Invalid browser transfer file.');
      const target = safeWorkspacePath(stateRoot, `browser-transfer-validation/${file.path}`), key = process.platform === 'win32' ? target.toLowerCase() : target;
      if (names.has(key) || file.path.includes('\\') || file.path.split('/').some(part => volatileBrowser.has(part))) throw new Error('Browser transfer contains duplicate or transient paths.'); names.add(key);
      const data = Buffer.from(file.data, 'base64'); total += data.length;
      if (total > browserBytes || digest(data) !== file.checksum) throw new Error('Browser transfer checksum or size validation failed.');
      return { path: file.path, data };
    });
    if (digest(manifest(bundle.browser.files)) !== bundle.browser.checksum) throw new Error('Browser transfer checksum validation failed.');
  }
  const checksum = bundleDigest(bundle);
  if (checksum !== bundle.checksum) throw new Error('Transfer bundle checksum validation failed.');
  return { files, browser, checksum };
}
function writeManagedFiles(stateRoot: string, files: ReturnType<typeof validateBundle>['files']) {
  for (const file of files) {
    safeWorkspacePath(stateRoot, file.name);
    mkdirSync(dirname(file.target), { recursive: true });
    writeFileSync(safeWorkspacePath(stateRoot, file.name), file.data, { mode: 0o600 });
  }
}
export function importAgentFiles(stateRoot: string, agentId: string, bundle: TransferBundle) {
  if (bundle?.browser) throw new Error('This transfer contains a private browser. Import it through the stopped computer transfer API.');
  const { files, checksum } = validateBundle(stateRoot, agentId, bundle); writeManagedFiles(stateRoot, files);
  return { checksum, files: bundle.files.length };
}

function transferComputer(computer: ComputerConfig): ComputerConfig {
  assertSandboxedComputer(computer);
  if (computer.browserSessionTeamId) throw new Error('Leave shared browser access before moving this agent. Team browser accounts are never copied into individual transfers.');
  // A disabled desktop can still have saved sessions from when it was enabled.
  return { ...computer, desktop: 'virtual' };
}
async function stopped(stateRoot: string, agentId: string, computer: ComputerConfig) {
  await stopAgentComputer(agentId, stateRoot, computer);
  if (process.env.OPEN_HARNESS_MOCK !== '1' && (await runningAgentContainer(agentId, stateRoot) || await runningDesktopContainer(agentId, stateRoot, computer))) throw new Error('The agent computer must be confirmed stopped before its browser can move.');
}
export async function exportAgentTransfer(stateRoot: string, agentId: string, computer: ComputerConfig): Promise<TransferBundle> {
  const target = transferComputer(computer); await stopped(stateRoot, agentId, target);
  const bundle = exportFiles(stateRoot, agentId, true), paths = desktopResourcePaths(agentId, stateRoot, target);
  const legacy = safeWorkspacePath(stateRoot, `agents/${agentId}/private/.config/chromium`), source = existsSync(paths.browser) ? paths.browser : existsSync(legacy) ? legacy : null;
  if (!source) return bundle;
  if (!lstatSync(source).isDirectory()) throw new Error('The saved browser profile is not a directory.');
  const files: TransferFile[] = []; let total = bundle.files.reduce((sum, file) => sum + Buffer.byteLength(file.data, 'base64'), 0);
  const visit = (path: string, depth: number) => {
    if (depth > 30) throw new Error('The saved browser contains too many nested directories.');
    const name = relative(source, path).replaceAll('\\', '/'); if (name.split('/').some(part => volatileBrowser.has(part))) return;
    safeWorkspacePath(stateRoot, relative(stateRoot, path)); const stat = lstatSync(path);
    if (stat.isDirectory()) { for (const entry of readdirSync(path)) visit(join(path, entry), depth + 1); return; }
    if (!stat.isFile() || stat.nlink !== 1) throw new Error('The saved browser contains a link or special file. It has not been transferred.');
    if (stat.size + total > browserBytes || files.length + bundle.files.length >= maxEntries || name.length > 1024) throw new Error('Managed files and saved browser data exceed the 50 MB transfer limit. Source data was preserved.');
    const data = readWorkspaceFile(path), after = lstatSync(path); if (data.length !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) throw new Error('The saved browser changed during transfer. Confirm it has stopped.');
    total += data.length; files.push({ path: name, data: data.toString('base64'), checksum: digest(data) });
  };
  visit(source, 0); files.sort((a,b) => a.path.localeCompare(b.path)); bundle.browser = { version: 1, files, checksum: digest(manifest(files)) }; bundle.checksum = bundleDigest(bundle);
  if (Buffer.byteLength(JSON.stringify(bundle)) > AGENT_TRANSFER_CLEAR_LIMIT) throw new Error('The saved browser transfer is too large. Source data was preserved.');
  return bundle;
}
export async function importAgentTransfer(stateRoot: string, agentId: string, bundle: TransferBundle, computer: ComputerConfig) {
  const target = transferComputer(computer), validated = validateBundle(stateRoot, agentId, bundle);
  let browser = validated.browser;
  if (!browser) {
    const legacy = bundle.files.filter(file => file.path.replaceAll('\\', '/').startsWith(legacyPrefix));
    if (legacy.length) browser = legacy.filter(file => !file.path.replaceAll('\\', '/').split('/').some(part => volatileBrowser.has(part))).map(file => ({ path: file.path.replaceAll('\\', '/').slice(legacyPrefix.length), data: Buffer.from(file.data, 'base64') }));
  }
  await stopped(stateRoot, agentId, target);
  if (!browser) { writeManagedFiles(stateRoot, validated.files); return { checksum: validated.checksum, files: bundle.files.length }; }
  const paths = desktopResourcePaths(agentId, stateRoot, target), temporary = safeWorkspacePath(stateRoot, `computers/${paths.key}/transfer-${randomUUID()}`), backup = safeWorkspacePath(stateRoot, `computers/${paths.key}/before-transfer-${randomUUID()}`);
  if (existsSync(paths.migration) || existsSync(safeWorkspacePath(stateRoot, `agents/${agentId}/private/.config/chromium`))) await migrateBrowser(agentId, stateRoot, target);
  const oldMigration = existsSync(paths.migration) ? readWorkspaceFile(paths.migration) : null;
  let replaced = false, preserved = false;
  try {
    mkdirSync(temporary, { recursive: true, mode: 0o700 });
    for (const file of browser) { const path = safeWorkspacePath(temporary, file.path); mkdirSync(dirname(path), { recursive: true, mode: 0o700 }); writeFileSync(path, file.data, { mode: 0o600, flag: 'wx' }); }
    writeManagedFiles(stateRoot, validated.files.filter(file => !relative(safeWorkspacePath(stateRoot, `agents/${agentId}`), file.target).replaceAll('\\', '/').startsWith(legacyPrefix)));
    safeWorkspacePath(stateRoot, relative(stateRoot, paths.browser)); mkdirSync(dirname(paths.browser), { recursive: true, mode: 0o700 });
    // A crash between directory renames must fail closed instead of migrating a stale legacy browser.
    atomicWorkspaceWrite(paths.migration, JSON.stringify({ version: 0, resourceKey: paths.key, source: 'agent-transfer-incomplete', backup: existsSync(paths.browser) ? relative(stateRoot, backup) : null, staged: relative(stateRoot, temporary), previousMigration: oldMigration ? JSON.parse(oldMigration.toString('utf8')) : null }));
    if (existsSync(paths.browser)) { if (!lstatSync(paths.browser).isDirectory()) throw new Error('The destination browser profile is not a directory.'); renameSync(paths.browser, backup); preserved = true; }
    renameSync(temporary, paths.browser); replaced = true;
    atomicWorkspaceWrite(paths.migration, JSON.stringify({ version: 2, resourceKey: paths.key, source: 'agent-transfer', archive: oldMigration ? JSON.parse(oldMigration.toString('utf8')).archive || null : null, backup: preserved ? relative(stateRoot, backup) : null, migratedAt: new Date().toISOString() }));
  } catch (error) {
    if (replaced) rmSync(paths.browser, { recursive: true, force: true });
    if (preserved) renameSync(backup, paths.browser);
    if (oldMigration) atomicWorkspaceWrite(paths.migration, oldMigration); else rmSync(paths.migration, { force: true });
    throw error;
  } finally { rmSync(temporary, { recursive: true, force: true }); }
  return { checksum: validated.checksum, files: bundle.files.length, browserFiles: browser.length };
}
