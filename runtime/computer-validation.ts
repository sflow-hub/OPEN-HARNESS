import { accessSync, constants, existsSync, lstatSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import type { AgentProfile, MachineInfo } from '../lib/agent-profile';
import { isSandboxedComputer, UNSANDBOXED_COMPUTER_MESSAGE, type ComputerConfig } from '../lib/agent-profile';
import { validateFolderExport } from './host-folders';

type Capabilities = MachineInfo['capabilities'];

export function assertSandboxedComputer(computer?: ComputerConfig) {
  if (computer && !isSandboxedComputer(computer)) throw new Error(UNSANDBOXED_COMPUTER_MESSAGE);
}

export function sharedFolderSource(value: string, mode: 'read' | 'write' = 'read') {
  const source = resolve(value);
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

export function validateComputerTarget(profile: AgentProfile, capabilities: Capabilities, requiredSecrets: string[] = [], hasSecret: (name: string) => boolean = () => true) {
  assertSandboxedComputer(profile.computer);
  const issues: string[] = [];
  if (profile.computer.access !== 'direct' && !capabilities.container) issues.push('Container execution is unavailable. Install and start Docker, then retry the transfer.');
  if (profile.computer.desktop === 'virtual' && !capabilities.virtualDesktop) issues.push('A private virtual desktop requires a Linux runner with container support.');
  if (profile.computer.access === 'folders') {
    for (const folder of profile.computer.folders) {
      try {
        accessSync(sharedFolderSource(folder.path, folder.mode), constants.R_OK | (folder.mode === 'write' ? constants.W_OK : 0));
      } catch (error) {
        issues.push(`${folder.path} is not an accessible ${folder.mode === 'write' ? 'read/write' : 'read-only'} folder on this computer.${process.env.OPEN_HARNESS_DEPLOYMENT === 'compose' && error instanceof Error ? ` ${error.message}` : ''}`);
      }
    }
  }
  for (const name of [...new Set(requiredSecrets.filter(Boolean))]) if (!hasSecret(name)) issues.push(`Credential ${name} is missing on this computer. Add it in Agent settings, then retry the transfer.`);
  if (issues.length) throw new Error(issues.join(' '));
  return { ok: true };
}
