import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, normalize, relative, resolve } from 'node:path';

export type TransferBundle = { files: Array<{ path: string; data: string; checksum: string }>; checksum: string };
const allowedRoots = ['private', 'profile/MEMORY.md', 'profile/USER.md', 'profile/skills'];
function digest(data: Buffer | string) { return createHash('sha256').update(data).digest('hex'); }
export function exportAgentFiles(stateRoot: string, agentId: string): TransferBundle {
  const agentRoot = resolve(stateRoot, 'agents', agentId), files: TransferBundle['files'] = []; let total = 0;
  const visit = (path: string) => {
    if (!existsSync(path)) return; const stat = lstatSync(path); if (stat.isSymbolicLink()) return;
    if (stat.isDirectory()) { for (const name of readdirSync(path)) visit(join(path, name)); return; }
    if (!stat.isFile()) return; const data = readFileSync(path); total += data.length; if (total > 20_000_000) throw new Error('Managed agent data exceeds the 20 MB transfer limit. Move large project files through an explicitly shared folder.');
    files.push({ path: relative(agentRoot, path).replaceAll('\\', '/'), data: Buffer.from(data).toString('base64'), checksum: digest(data) });
  };
  for (const path of allowedRoots) visit(join(agentRoot, path));
  files.sort((a,b) => a.path.localeCompare(b.path)); return { files, checksum: digest(files.map(file => `${file.path}:${file.checksum}`).join('\n')) };
}
export function importAgentFiles(stateRoot: string, agentId: string, bundle: TransferBundle) {
  const agentRoot = resolve(stateRoot, 'agents', agentId); let total = 0;
  for (const file of bundle.files) {
    const clean = normalize(file.path).replaceAll('\\', '/'); if (clean.startsWith('../') || !allowedRoots.some(root => clean === root || clean.startsWith(root + '/'))) throw new Error('Transfer contains an invalid managed path.');
    const target = resolve(agentRoot, clean); if (!target.startsWith(agentRoot + '/') && target !== agentRoot) throw new Error('Transfer path escaped the agent workspace.');
    const data = Buffer.from(file.data, 'base64'); total += data.length; if (total > 100_000_000 || digest(data) !== file.checksum) throw new Error('Transfer checksum validation failed.'); mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, data, { mode: 0o600 });
  }
  const checksum = digest([...bundle.files].sort((a,b) => a.path.localeCompare(b.path)).map(file => `${file.path}:${file.checksum}`).join('\n')); if (checksum !== bundle.checksum) throw new Error('Transfer bundle checksum validation failed.'); return { checksum, files: bundle.files.length };
}
