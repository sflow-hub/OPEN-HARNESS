import { readFileSync } from 'node:fs';
import { posix } from 'node:path';
import type { MachineInfo } from '../lib/agent-profile';

export function parseHostFolderMounts(mountinfo: string): NonNullable<MachineInfo['folderExports']> {
  const mounts = new Map<string, 'read' | 'write'>();
  for (const line of mountinfo.split('\n')) {
    const fields = line.split(' '), path = fields[4]?.replace(/\\(040|011|012|134)/g, (_, octal: string) => String.fromCharCode(parseInt(octal, 8)));
    if (!path?.startsWith('/host-folders/') || !fields.includes('-') || !fields[5]) continue;
    mounts.set(path, fields[5].split(',').includes('ro') ? 'read' : 'write');
  }
  return [...mounts].map(([path, mode]) => ({ path, mode })).sort((a, b) => b.path.length - a.path.length);
}

export function hostFolderExports() {
  if (process.env.OPEN_HARNESS_DEPLOYMENT !== 'compose') return undefined;
  try { return parseHostFolderMounts(readFileSync('/proc/self/mountinfo', 'utf8')); }
  catch { return []; }
}

export function validateFolderExport(path: string, mode: 'read' | 'write', exports = hostFolderExports()) {
  if (!exports) return;
  const resolved = posix.resolve(path);
  // An agent can replace a writable descendant after validation. An outer bind
  // mount root keeps its identity until the operator changes the Compose stack.
  const grant = exports.find(folder => resolved === folder.path);
  if (!grant) throw new Error('This exact folder has not been shared with Open Harness. Add it to both services in your host-folder Compose override, then select its /host-folders/ path. To select a subfolder, export that subfolder separately.');
  if (mode === 'write' && grant.mode === 'read') throw new Error(`This folder is shared read-only with Open Harness: ${grant.path}. Choose read-only access for this agent.`);
}
