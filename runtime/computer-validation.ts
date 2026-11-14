import { accessSync, constants, existsSync, lstatSync, readdirSync, readFileSync, realpathSync, type Dirent } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { AgentProfile, MachineInfo } from '../lib/agent-profile';
import { isSandboxedComputer, UNSANDBOXED_COMPUTER_MESSAGE, type ComputerConfig } from '../lib/agent-profile';
import { validateFolderExport } from './host-folders';

type Capabilities = MachineInfo['capabilities'];

export function assertSandboxedComputer(computer?: ComputerConfig) {
  if (computer && !isSandboxedComputer(computer)) throw new Error(UNSANDBOXED_COMPUTER_MESSAGE);
}

function within(parent: string, child: string) { const path = relative(parent, child); return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path)); }
function bothSpellings(path: string) { const resolved = resolve(path); try { return [...new Set([resolved, realpathSync(resolved)])]; } catch { return [resolved]; } }
function dockerSocketDirs() {
  const host = process.env.DOCKER_HOST || '';
  const sockets = ['/var/run/docker.sock', '/run/docker.sock', ...(process.getuid ? [`/run/user/${process.getuid()}/docker.sock`] : []), ...(process.env.XDG_RUNTIME_DIR ? [`${process.env.XDG_RUNTIME_DIR}/docker.sock`] : []), join(homedir(), '.docker/desktop/docker.sock'), join(homedir(), '.docker/run/docker.sock')];
  const addEndpoint = (endpoint: string) => {
    if (!endpoint.startsWith('unix://')) return;
    const socket = endpoint.slice('unix://'.length);
    if (!isAbsolute(socket)) throw new Error('Docker has an invalid socket path. Repair its endpoint settings before sharing folders.');
    sockets.push(socket);
  };
  addEndpoint(host);
  const configRoot = resolve(process.env.DOCKER_CONFIG || join(homedir(), '.docker'));
  const readJson = (path: string) => {
    try { const value = JSON.parse(readFileSync(path, 'utf8')); if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Docker metadata.'); return value; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw new Error('Docker endpoint settings could not be read. Repair them before sharing folders.'); }
  };
  const config = readJson(join(configRoot, 'config.json'));
  const activeContext = process.env.DOCKER_CONTEXT || (host ? 'default' : config?.currentContext || 'default');
  let foundActive = activeContext === 'default';
  // Context sockets can live anywhere. Protect every known endpoint, and reread metadata
  // on admission so changing the active context cannot bypass a previously saved grant.
  let entries: Dirent[];
  try { entries = readdirSync(join(configRoot, 'contexts/meta'), { withFileTypes: true }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Docker contexts could not be read. Repair them before sharing folders.'); entries = []; }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const context = readJson(join(configRoot, 'contexts/meta', entry.name, 'meta.json'));
    if (!context || typeof context.Name !== 'string') throw new Error('Docker context endpoints could not be read. Repair them before sharing folders.');
    // Inactive plugin contexts may have no Docker engine endpoint at all.
    if (context.Endpoints?.docker === undefined) continue;
    if (typeof context.Endpoints.docker?.Host !== 'string') throw new Error('Docker context endpoints could not be read. Repair them before sharing folders.');
    addEndpoint(context.Endpoints.docker.Host);
    if (context.Name === activeContext) foundActive = true;
  }
  if (!foundActive) throw new Error('The active Docker context could not be resolved. Repair it before sharing folders.');
  // The socket itself can be a link, not just its parent directory.
  return sockets.flatMap(socket => bothSpellings(socket).flatMap(path => bothSpellings(dirname(path))));
}
// The operator is trusted, but one mistyped grant would hand an agent every credential, every
// other agent's private folder, or control of Docker itself. These are refused outright.
export function assertGrantAllowed(value: string, stateRoot: string) {
  const source = resolve(value), refuse = (reason: string) => { throw new Error(`Open Harness never shares ${value} with agents because ${reason}. Choose a more specific folder.`); };
  if (dirname(source) === source) refuse('it is the whole disk');
  if (bothSpellings(homedir()).some(home => within(source, home))) refuse('it contains your home folder');
  if (bothSpellings(stateRoot).some(state => within(source, state) || within(state, source))) refuse('it holds Open Harness data, credentials, and other agents’ private folders');
  if (dockerSocketDirs().some(dir => within(source, dir))) refuse('it contains the Docker control socket');
}

export function sharedFolderSource(value: string, mode: 'read' | 'write', stateRoot: string) {
  const source = resolve(value);
  assertGrantAllowed(source, stateRoot);
  validateFolderExport(source, mode);
  if (!existsSync(source)) throw new Error(`Shared folder does not exist on this computer: ${value}`);
  // A granted parent can contain an agent-controlled link. Never let a later
  // container start reinterpret that link as a grant to another host directory.
  for (let current = source; ; current = dirname(current)) {
    const info = lstatSync(current);
    if (info.isSymbolicLink()) throw new Error(`Shared folders cannot contain symbolic links. Select the real folder path: ${value}`);
    if (current === source && !info.isDirectory()) throw new Error(`Shared folder is not a directory: ${value}`);
    if (dirname(current) === current) break;
  }
  return source;
}

export function validateComputerTarget(profile: AgentProfile, capabilities: Capabilities, stateRoot: string, requiredSecrets: string[] = [], hasSecret: (name: string) => boolean = () => true) {
  assertSandboxedComputer(profile.computer);
  const issues: string[] = [];
  if (profile.computer.access !== 'direct' && !capabilities.container) issues.push('Container execution is unavailable. Install and start Docker, then retry the transfer.');
  if (profile.computer.desktop === 'virtual' && !capabilities.virtualDesktop) issues.push('A private virtual desktop requires a Linux runner with container support.');
  if (profile.computer.access === 'folders') {
    for (const folder of profile.computer.folders) {
      try {
        accessSync(sharedFolderSource(folder.path, folder.mode, stateRoot), constants.R_OK | (folder.mode === 'write' ? constants.W_OK : 0));
      } catch (error) {
        issues.push(`${folder.path} is not an accessible ${folder.mode === 'write' ? 'read/write' : 'read-only'} folder on this computer.${process.env.OPEN_HARNESS_DEPLOYMENT === 'compose' && error instanceof Error ? ` ${error.message}` : ''}`);
      }
    }
  }
  for (const name of [...new Set(requiredSecrets.filter(Boolean))]) if (!hasSecret(name)) issues.push(`Credential ${name} is missing on this computer. Add it in Agent settings, then retry the transfer.`);
  if (issues.length) throw new Error(issues.join(' '));
  return { ok: true };
}
