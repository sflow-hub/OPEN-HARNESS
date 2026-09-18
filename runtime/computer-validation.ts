import { accessSync, constants, statSync } from 'node:fs';
import type { AgentProfile, MachineInfo } from '../lib/agent-profile';

type Capabilities = MachineInfo['capabilities'];

export function validateComputerTarget(profile: AgentProfile, capabilities: Capabilities, requiredSecrets: string[] = [], hasSecret: (name: string) => boolean = () => true) {
  const issues: string[] = [];
  if (profile.computer.access === 'private' && !capabilities.container) issues.push('Container execution is unavailable. Install and start Docker, then retry the transfer.');
  if (profile.computer.access === 'direct' && !capabilities.direct) issues.push(capabilities.detail || 'The Hermes host runtime is unavailable. Finish direct-access setup, then retry the transfer.');
  if (profile.computer.desktop === 'existing' && !capabilities.desktop) issues.push('The existing desktop is unavailable. Sign in to a graphical session and grant the runner the requested desktop permissions.');
  if (profile.computer.desktop === 'virtual' && !capabilities.virtualDesktop) issues.push('A private virtual desktop requires a Linux runner with container support.');
  if (profile.computer.access === 'folders') {
    for (const folder of profile.computer.folders) {
      try {
        if (!statSync(folder.path).isDirectory()) throw new Error('not a directory');
        accessSync(folder.path, constants.R_OK | (folder.mode === 'write' ? constants.W_OK : 0));
      } catch {
        issues.push(`${folder.path} is not an accessible ${folder.mode === 'write' ? 'read/write' : 'read-only'} folder on this computer.`);
      }
    }
  }
  for (const name of [...new Set(requiredSecrets.filter(Boolean))]) if (!hasSecret(name)) issues.push(`Credential ${name} is missing on this computer. Add it in Agent settings, then retry the transfer.`);
  if (issues.length) throw new Error(issues.join(' '));
  return { ok: true };
}
