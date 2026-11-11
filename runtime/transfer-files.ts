import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, normalize, relative, resolve } from 'node:path';
import { listInside, mkdirInside, readInside, renameIntoInside, SafeFsError, statInside } from './safe-fs';

export type TransferBundle = { files: Array<{ path: string; data: string; checksum: string }>; checksum: string };
const allowedRoots = ['private', 'profile/MEMORY.md', 'profile/USER.md', 'profile/skills'];
function digest(data: Buffer | string) { return createHash('sha256').update(data).digest('hex'); }
export function exportAgentFiles(stateRoot: string, agentId: string): TransferBundle {
  const agentRoot = resolve(stateRoot, 'agents', agentId), files: TransferBundle['files'] = []; let total = 0, entries = 0;
  const visit = (rel: string, depth: number) => {
    try {
      const stat = statInside(agentRoot, rel); if (!stat || stat.isSymbolicLink) return;
      if (++entries > 100_000) throw new Error('Managed agent data has too many entries to transfer.');
      if (stat.isDirectory) {
        if (depth > 32) throw new Error('Managed agent data exceeds the transfer depth limit of 32.');
        const children = listInside(agentRoot, rel, { max: 10_001 });
        if (children.length > 10_000) throw new Error('Managed agent directory exceeds the transfer limit of 10000 entries.');
        for (const child of children) visit(`${rel}/${child.name}`, depth + 1);
        return;
      }
      if (!stat.isFile) return;
      const data = readInside(agentRoot, rel, { maxBytes: 20_000_000 - total }) as Buffer; total += data.length;
      files.push({ path: rel, data: data.toString('base64'), checksum: digest(data) });
    } catch (error) {
      if (error instanceof SafeFsError) {
        if (error.code === 'not-found' || error.code === 'symlink' || error.code === 'not-regular') return;
        if (error.code === 'too-large') throw new Error('Managed agent data exceeds the 20 MB transfer limit. Move large project files through an explicitly shared folder.');
      }
      throw error;
    }
  };
  for (const path of allowedRoots) visit(path, 0);
  files.sort((a,b) => a.path.localeCompare(b.path)); return { files, checksum: digest(files.map(file => `${file.path}:${file.checksum}`).join('\n')) };
}
export function importAgentFiles(stateRoot: string, agentId: string, bundle: TransferBundle) {
  const agentRoot = resolve(stateRoot, 'agents', agentId); let total = 0;
  const validated = bundle.files.map(file => {
    const clean = normalize(file.path).replaceAll('\\', '/'); if (clean.startsWith('../') || !allowedRoots.some(root => clean === root || clean.startsWith(root + '/'))) throw new Error('Transfer contains an invalid managed path.');
    const target = resolve(agentRoot, clean); if (!target.startsWith(agentRoot + '/') && target !== agentRoot) throw new Error('Transfer path escaped the agent workspace.');
    const data = Buffer.from(file.data, 'base64'); total += data.length; if (total > 100_000_000 || digest(data) !== file.checksum) throw new Error('Transfer checksum validation failed.');
    return { target, data };
  });
  const checksum = digest([...bundle.files].sort((a,b) => a.path.localeCompare(b.path)).map(file => `${file.path}:${file.checksum}`).join('\n')); if (checksum !== bundle.checksum) throw new Error('Transfer bundle checksum validation failed.');
  const staging = mkdtempSync(join(stateRoot, '.transfer-')); let committed = 0;
  try {
    for (const [index, file] of validated.entries()) writeFileSync(join(staging, String(index)), file.data, { mode: 0o600 });
    mkdirSync(dirname(agentRoot), { recursive: true });
    const anchor = lstatSync(agentRoot, { throwIfNoEntry: false });
    if (anchor?.isSymbolicLink()) throw new Error('Transfer target contains a symbolic link.');
    if (anchor && !anchor.isDirectory()) throw new Error('Transfer target contains a non-directory.');
    if (!anchor) mkdirSync(agentRoot);
    const ensureDirectory = (rel: string) => {
      let stat = statInside(agentRoot, rel);
      if (!stat) {
        try { mkdirInside(agentRoot, rel); }
        catch (error) { if (!(error instanceof SafeFsError) || error.code !== 'conflict') throw error; }
        stat = statInside(agentRoot, rel);
      }
      if (stat?.isSymbolicLink) throw new Error('Transfer target contains a symbolic link.');
      if (!stat?.isDirectory) throw new Error('Transfer target contains a non-directory.');
    };
    for (const [index, file] of validated.entries()) {
      const rel = relative(agentRoot, file.target).replaceAll('\\', '/');
      const parts = rel.split('/'); let parent = '';
      for (const part of parts.slice(0, -1)) { parent = parent ? `${parent}/${part}` : part; ensureDirectory(parent); }
      const leaf = statInside(agentRoot, rel);
      if (leaf?.isSymbolicLink) throw new Error('Transfer target contains a symbolic link.');
      if (leaf?.isDirectory) throw new Error('Transfer target contains a non-directory.');
      // Linux holds the parent walk and rename by fd, so parent swaps cannot redirect writes
      // outside the agent directory. Non-Linux path-fallback retains the pathname race.
      // Commits are per-file: a later failure leaves earlier files committed.
      renameIntoInside(staging, String(index), agentRoot, rel); committed++;
    }
    return { checksum, files: bundle.files.length };
  } catch (error) {
    if (error instanceof SafeFsError) {
      if (error.code === 'symlink') error.message = 'Transfer target contains a symbolic link.';
      else if (error.code === 'invalid-path' || error.code === 'not-regular') error.message = 'Transfer target contains a non-directory.';
    }
    if (error instanceof Error) error.message += ` (${committed} of ${validated.length} files committed)`;
    throw error;
  } finally { rmSync(staging, { recursive: true, force: true }); }
}
