import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { safeWorkspacePath } from './path-safety';

export type TransferBundle = { files: Array<{ path: string; data: string; checksum: string }>; checksum: string };
const memoryFiles = ['profile/MEMORY.md', 'profile/USER.md', 'profile/memories/MEMORY.md', 'profile/memories/USER.md'];
const allowedRoots = ['private', ...memoryFiles, 'profile/skills'];
function digest(data: Buffer | string) { return createHash('sha256').update(data).digest('hex'); }
export function exportAgentFiles(stateRoot: string, agentId: string): TransferBundle {
  const agentRoot = safeWorkspacePath(stateRoot, `agents/${agentId}`), files: TransferBundle['files'] = []; let total = 0;
  const visit = (path: string) => {
    if (!existsSync(path)) return; const stat = lstatSync(path); if (stat.isSymbolicLink()) return;
    safeWorkspacePath(stateRoot, relative(stateRoot, path));
    if (stat.isDirectory()) { for (const name of readdirSync(path)) visit(join(path, name)); return; }
    if (!stat.isFile()) return; const data = readFileSync(path); total += data.length; if (total > 20_000_000) throw new Error('Managed agent data exceeds the 20 MB transfer limit. Move large project files through an explicitly shared folder.');
    files.push({ path: relative(agentRoot, path).replaceAll('\\', '/'), data: Buffer.from(data).toString('base64'), checksum: digest(data) });
  };
  for (const path of allowedRoots) visit(join(agentRoot, path));
  files.sort((a,b) => a.path.localeCompare(b.path)); return { files, checksum: digest(files.map(file => `${file.path}:${file.checksum}`).join('\n')) };
}
export function importAgentFiles(stateRoot: string, agentId: string, bundle: TransferBundle) {
  safeWorkspacePath(stateRoot, `agents/${agentId}`); let total = 0;
  const seen = new Set<string>();
  // Validate the entire bundle before replacing any destination files. In
  // particular, a bad final checksum must not leave a partly imported profile.
  const files = bundle.files.map(file => {
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
  const checksum = digest([...bundle.files].sort((a,b) => a.path.localeCompare(b.path)).map(file => `${file.path}:${file.checksum}`).join('\n'));
  if (checksum !== bundle.checksum) throw new Error('Transfer bundle checksum validation failed.');
  for (const file of files) {
    safeWorkspacePath(stateRoot, file.name);
    mkdirSync(dirname(file.target), { recursive: true });
    writeFileSync(safeWorkspacePath(stateRoot, file.name), file.data, { mode: 0o600 });
  }
  return { checksum, files: bundle.files.length };
}
