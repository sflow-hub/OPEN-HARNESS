import { createHash, randomUUID } from 'node:crypto';
import { cp, mkdir, open, rename } from 'node:fs/promises';
import { constants, existsSync, lstatSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import type { ComputerConfig } from '../lib/agent-profile';
import { assertSandboxedComputer } from './computer-validation';
import { commandAsync } from './commands';
import { containerStateKey, imageContractAsync, MANAGED_LABEL, runtimeImageIdentity, STATE_LABEL, stateSharingAsync, stopAgentContainers } from './hermes';
import { HERMES_IMAGE } from './readiness';
import { atomicWorkspaceWrite, readWorkspaceFile, safeWorkspacePath } from './path-safety';
import { withContainerAdmission } from './container-admission';

const ROLE_LABEL = 'open-harness.role', RESOURCE_LABEL = 'open-harness.computer';
const locks = new Set(['SingletonLock', 'SingletonSocket', 'SingletonCookie']);
type Inspection = { Id: string; State: { Running: boolean }; Config: { Labels?: Record<string, string> }; Mounts?: Array<{ Source: string; Destination: string }> };
const pending = new Map<string, Promise<string>>();

function validate(agentId: string, computer: ComputerConfig) {
  assertSandboxedComputer(computer);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(agentId) || computer.desktop !== 'virtual') throw new Error('Choose an agent with a private desktop.');
  if (computer.browserSessionTeamId && !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(computer.browserSessionTeamId)) throw new Error('Shared browser configuration is invalid.');
}
export function desktopResourceKey(agentId: string, stateRoot: string, computer: ComputerConfig) {
  validate(agentId, computer);
  return createHash('sha256').update(JSON.stringify([containerStateKey(stateRoot), computer.machineId, computer.browserSessionTeamId ? 'team' : 'agent', computer.browserSessionTeamId || agentId])).digest('hex').slice(0, 32);
}
export function desktopResourcePaths(agentId: string, stateRoot: string, computer: ComputerConfig) {
  const key = desktopResourceKey(agentId, stateRoot, computer), base = safeWorkspacePath(stateRoot, `computers/${key}`);
  return { key, name: `open-harness-desktop-${key}`, base, home: safeWorkspacePath(stateRoot, `computers/${key}/home`), browser: safeWorkspacePath(stateRoot, `computers/${key}/home/.config/chromium`), staging: safeWorkspacePath(stateRoot, `computers/${key}/staging`), backup: safeWorkspacePath(stateRoot, `computers/${key}/legacy-browser-backup`), archive: safeWorkspacePath(stateRoot, `computers/${key}/legacy-browser-source`), migration: safeWorkspacePath(stateRoot, `computers/${key}/migration.json`) };
}
function signature(key: string, image: string) { return createHash('sha256').update(JSON.stringify({ role: 'desktop-v1', key, image })).digest('hex').slice(0, 24); }
function owned(value: Inspection, stateRoot: string, key: string) {
  const labels = value.Config.Labels || {};
  return labels[MANAGED_LABEL] === '1' && labels[STATE_LABEL] === containerStateKey(stateRoot) && labels[ROLE_LABEL] === 'desktop' && labels[RESOURCE_LABEL] === key;
}
async function inspect(id: string): Promise<Inspection | null> {
  const result = await commandAsync('docker', ['inspect', '-f', '{{json .}}', id], 10000);
  if (result.status !== 0) { if (/No such (?:object|container)/i.test(result.stderr)) return null; throw new Error('Docker could not inspect this private desktop. Check the computer connection.'); }
  let value: Inspection; try { value = JSON.parse(result.stdout); } catch { throw new Error('Docker returned invalid private desktop details.'); }
  if (!value?.Id || typeof value.State?.Running !== 'boolean' || !value.Config) throw new Error('Docker returned incomplete private desktop details.');
  return value;
}
function legacyBrowser(agentId: string, stateRoot: string, computer: ComputerConfig) {
  const path = computer.browserSessionTeamId ? `browser-sessions/${createHash('sha256').update(JSON.stringify([computer.browserSessionTeamId, computer.machineId])).digest('hex').slice(0, 32)}` : `agents/${agentId}/private/.config/chromium`;
  return safeWorkspacePath(stateRoot, path);
}
async function assertLegacyIdle(source: string, stateRoot: string) {
  if (process.env.OPEN_HARNESS_MOCK === '1') return;
  const listed = await commandAsync('docker', ['ps', '-q', '--filter', `label=${MANAGED_LABEL}=1`, '--filter', `label=${STATE_LABEL}=${containerStateKey(stateRoot)}`], 10000);
  if (listed.status !== 0) throw new Error('Docker could not confirm the old browser is idle. Stop its agent before migrating the desktop.');
  for (const id of listed.stdout.trim().split(/\s+/).filter(Boolean)) {
    const value = await inspect(id); if (!value?.State.Running) continue;
    if (value.Mounts?.some(mount => { const path = relative(resolve(mount.Source), resolve(source)); return path === '' || path !== '..' && !path.startsWith(`..${sep}`) && !path.startsWith(sep); })) throw new Error('Stop agents using the old browser before migrating the private desktop. Its browser profile has not been changed.');
  }
}
function checkBrowserTree(path: string) {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || stat.isFile() && stat.nlink !== 1 || !stat.isDirectory() && !stat.isFile()) throw new Error('The saved browser profile contains an unsupported link or special file. It has not been migrated.');
  if (stat.isDirectory()) for (const name of readdirSync(path)) if (!locks.has(name)) checkBrowserTree(join(path, name));
}
async function copyBrowser(source: string, target: string) {
  if (!lstatSync(source).isDirectory()) throw new Error('The saved browser profile is not a directory. It has not been migrated.');
  checkBrowserTree(source);
  await cp(source, target, { recursive: true, dereference: false, force: false, errorOnExist: true, filter: path => !locks.has(path.split(sep).at(-1) || '') });
  checkBrowserTree(target);
}
async function browserFingerprint(path: string) {
  checkBrowserTree(path); const digest = createHash('sha256');
  const visit = async (directory: string) => {
    for (const name of readdirSync(directory).sort()) {
      if (locks.has(name)) continue;
      const file = join(directory, name), info = lstatSync(file); digest.update(JSON.stringify([relative(path, file), info.isDirectory() ? 'directory' : 'file']));
      if (info.isDirectory()) await visit(file);
      else { const content = createHash('sha256'), handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW || 0)); try { for await (const chunk of handle.createReadStream()) content.update(chunk); } finally { await handle.close(); } digest.update(content.digest()); }
    }
  };
  await visit(path); return digest.digest('hex');
}
export async function migrateBrowser(agentId: string, stateRoot: string, computer: ComputerConfig) {
  const paths = desktopResourcePaths(agentId, stateRoot, computer);
  if (existsSync(paths.migration)) {
    let saved; try { saved = JSON.parse(readWorkspaceFile(paths.migration).toString('utf8')); } catch { throw new Error('The private desktop migration record is unreadable. Restore it before starting the computer.'); }
    if (![1,2].includes(saved.version) || saved.resourceKey !== paths.key || !existsSync(paths.browser) || !lstatSync(paths.browser).isDirectory()) throw new Error('The private desktop migration is incomplete. Restore its browser backup before starting the computer.');
    if (saved.version === 2) return;
    const source = legacyBrowser(agentId, stateRoot, computer), recordedSource = relative(stateRoot, source);
    if (saved.source === recordedSource && existsSync(source)) {
      await assertLegacyIdle(source, stateRoot);
      if (saved.backup !== relative(stateRoot, paths.backup) || !existsSync(paths.backup) || existsSync(paths.archive) || await browserFingerprint(source) !== await browserFingerprint(paths.backup)) throw new Error('The old browser folder changed after migration. Keep both copies and resolve its migration record before starting the computer. No agent files were removed.');
      atomicWorkspaceWrite(paths.migration, JSON.stringify({version:0,resourceKey:paths.key,source:recordedSource,archive:relative(stateRoot,paths.archive),backup:saved.backup,previousMigration:saved}));
      await rename(source, paths.archive);
      saved.archive = relative(stateRoot, paths.archive);
    } else if (saved.source === 'agent-transfer' && existsSync(source) || saved.source !== null && saved.source !== 'agent-transfer' && saved.source !== recordedSource) throw new Error('The old browser migration source is ambiguous. Restore its migration record before starting the computer.');
    atomicWorkspaceWrite(paths.migration, JSON.stringify({...saved,version:2}));
    return;
  }
  const source = legacyBrowser(agentId, stateRoot, computer);
  if (existsSync(paths.browser) || existsSync(paths.backup) || existsSync(paths.archive)) throw new Error('The private desktop migration is incomplete. Preserve its browser copies and restore the migration record before starting the computer.');
  const hasSource = existsSync(source);
  if (hasSource) { await assertLegacyIdle(source, stateRoot); checkBrowserTree(source); if (!lstatSync(source).isDirectory()) throw new Error('The saved browser profile is not a directory. It has not been migrated.'); }
  await mkdir(dirname(paths.browser), { recursive: true, mode: 0o700 });
  const temporary = safeWorkspacePath(stateRoot, `computers/${paths.key}/migration-${randomUUID()}`);
  try {
    const record = {resourceKey:paths.key,source:hasSource?relative(stateRoot,source):null,archive:hasSource?relative(stateRoot,paths.archive):null,backup:hasSource?relative(stateRoot,paths.backup):null};
    atomicWorkspaceWrite(paths.migration, JSON.stringify({version:0,...record}));
    if (hasSource) { await rename(source, paths.archive); await copyBrowser(paths.archive, temporary); await rename(temporary, paths.backup); await copyBrowser(paths.backup, temporary); await rename(temporary, paths.browser); }
    else await mkdir(paths.browser, { recursive: true, mode: 0o700 });
    atomicWorkspaceWrite(paths.migration, JSON.stringify({version:2,...record,migratedAt:new Date().toISOString()}));
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}

export function desktopContainerArguments(agentId: string, stateRoot: string, computer: ComputerConfig, imageId: string) {
  const paths = desktopResourcePaths(agentId, stateRoot, computer);
  // A shared service must not restart when a different member has different task limits.
  return ['--name', paths.name, '--label', `${MANAGED_LABEL}=1`, '--label', `${STATE_LABEL}=${containerStateKey(stateRoot)}`, '--label', `${ROLE_LABEL}=desktop`, '--label', `${RESOURCE_LABEL}=${paths.key}`, '--label', `open-harness.config=${signature(paths.key, imageId)}`,
    '--security-opt', 'no-new-privileges', '--cap-drop', 'ALL', '--pids-limit', '256', '--memory', '1024m', '--cpus', '1', '--user', `${process.getuid?.() || 1000}:${process.getgid?.() || 1000}`,
    '-e', 'OPEN_HARNESS_RUNTIME_ROLE=desktop', '-e', 'OPEN_HARNESS_VIRTUAL_DESKTOP=1', '-e', 'DISPLAY=:99', '-e', 'HOME=/workspace/desktop', '-e', 'HERMES_HOME=/workspace/desktop/.hermes', '-e', 'AGENT_BROWSER_PROFILE=/workspace/desktop/.config/chromium', '-e', 'OPEN_HARNESS_DOWNLOAD_DIR=/workspace/exchange/downloads',
    '--workdir', '/workspace/desktop', '-v', `${paths.home}:/workspace/desktop`, '-v', `${paths.staging}:/workspace/exchange`, HERMES_IMAGE];
}
export function ensureDesktopContainerAsync(agentId: string, stateRoot: string, computer: ComputerConfig): Promise<string> {
  return withContainerAdmission(stateRoot, () => startDesktopContainer(agentId, stateRoot, computer));
}
async function startDesktopContainer(agentId: string, stateRoot: string, computer: ComputerConfig): Promise<string> {
  const paths = desktopResourcePaths(agentId, stateRoot, computer);
  if (process.env.OPEN_HARNESS_MOCK === '1') return `mock-desktop-${paths.key}`;
  const existing = pending.get(paths.key); if (existing) return existing;
  const operation = (async () => {
    const shared = await stateSharingAsync(stateRoot); if (!shared.ok) throw new Error(shared.detail);
    if (await imageContractAsync() !== 'current') throw new Error('Update the pinned runtime before opening the continuous private desktop.');
    const image = await runtimeImageIdentity();
    let value = await inspect(paths.name);
    if (value && !owned(value, stateRoot, paths.key)) throw new Error('The private desktop container belongs to another workspace. It has not been changed.');
    if (value && value.Config.Labels?.['open-harness.config'] !== signature(paths.key, image)) {
      if (value.State.Running) throw new Error('The private desktop needs a runtime update. Stop the computer before replacing its live browser.');
      const removed = await commandAsync('docker', ['rm', value.Id], 20000); if (removed.status !== 0) throw new Error('Docker could not replace the stopped private desktop.'); value = null;
    }
    await migrateBrowser(agentId, stateRoot, computer);
    if (value?.State.Running) return value.Id;
    await mkdir(paths.staging, { recursive: true, mode: 0o700 });
    if (value) {
      const started = await commandAsync('docker', ['start', value.Id], 20000); if (started.status !== 0) throw new Error('The private desktop could not start. Check Docker.');
    } else {
      const started = await commandAsync('docker', ['run', '-d', '--restart', 'unless-stopped', ...desktopContainerArguments(agentId, stateRoot, computer, image)], 30000);
      if (started.status !== 0) throw new Error('The private desktop could not be created. Check Docker and its available memory.');
    }
    const ready = await inspect(value?.Id || paths.name);
    if (!ready?.State.Running || !owned(ready, stateRoot, paths.key)) throw new Error('Docker did not confirm the private desktop started.');
    return ready.Id;
  })();
  pending.set(paths.key, operation);
  try { return await operation; } finally { if (pending.get(paths.key) === operation) pending.delete(paths.key); }
}
export async function runningDesktopContainer(agentId: string, stateRoot: string, computer: ComputerConfig) {
  const paths = desktopResourcePaths(agentId, stateRoot, computer);
  if (process.env.OPEN_HARNESS_MOCK === '1') return `mock-desktop-${paths.key}`;
  const value = await inspect(paths.name);
  if (value && !owned(value, stateRoot, paths.key)) throw new Error('The private desktop container belongs to another workspace.');
  return value?.State.Running ? value.Id : null;
}
export async function stopDesktopContainer(agentId: string, stateRoot: string, computer: ComputerConfig) {
  const paths = desktopResourcePaths(agentId, stateRoot, computer);
  if (process.env.OPEN_HARNESS_MOCK === '1') return;
  const value = await inspect(paths.name); if (!value) return;
  if (!owned(value, stateRoot, paths.key)) throw new Error('The private desktop container belongs to another workspace. It has not been stopped.');
  if (!value.State.Running) return;
  const closed = await commandAsync('docker', ['exec', value.Id, 'python', '/opt/open-harness/browser_shutdown.py'], 12000);
  if (closed.status !== 0) throw new Error('The private browser could not close normally. Check it for a confirmation before moving this agent; its profile has not been transferred.');
  const stopped = await commandAsync('docker', ['stop', '--time', '8', value.Id], 15000);
  if (stopped.status !== 0 || (await inspect(value.Id))?.State.Running) throw new Error('Docker could not confirm the private desktop stopped.');
}
export async function stopAgentComputer(agentId: string, stateRoot: string, computer: ComputerConfig) {
  await stopAgentContainers(agentId, stateRoot);
  if (computer.desktop === 'virtual') await stopDesktopContainer(agentId, stateRoot, computer);
}
