import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { safeWorkspacePath } from './path-safety';
import { mkdirInside, readInside, SafeFsError, statInside, writeInside } from './safe-fs';
import { validId } from './profiles';

// Hermes loads these files from HERMES_HOME/memories at each session start.
// Older dashboards saved them one directory higher. Adopt legacy notes only
// when Hermes has no file, including preserving an intentionally empty file.
export function profileMemory(root: string, agentId: string) {
  const anchor = safeWorkspacePath(root, `agents/${validId(agentId)}`);
  mkdirSync(anchor, { recursive: true, mode: 0o700 });
  for (const rel of ['profile', 'profile/memories']) {
    let stat = statInside(anchor, rel);
    if (!stat) { try { mkdirInside(anchor, rel); } catch (error) { if (!(error instanceof SafeFsError) || error.code !== 'conflict') throw error; } stat = statInside(anchor, rel); }
    if (stat?.isSymbolicLink) throw new SafeFsError('symlink', 'Workspace paths cannot contain symbolic links.');
    if (!stat?.isDirectory) throw new SafeFsError('invalid-path', 'Workspace parent is not a directory.');
  }
  const paths = { memory: '', user: '' };
  for (const [key, file] of [['memory', 'MEMORY.md'], ['user', 'USER.md']] as const) {
    const target = `profile/memories/${file}`, legacy = `profile/${file}`;
    const current = statInside(anchor, target), previous = statInside(anchor, legacy);
    if (current?.isSymbolicLink || previous?.isSymbolicLink) throw new SafeFsError('symlink', 'Workspace paths cannot contain symbolic links.');
    if (!current && previous) {
      try { writeInside(anchor, target, readInside(anchor, legacy, { maxBytes: 200_000 }), { exclusive: true, maxBytes: 200_000 }); }
      catch (error) { if (!(error instanceof SafeFsError) || error.code !== 'conflict') throw error; }
    }
    // Keep the original as a backup; it must never overwrite newer runtime notes.
    paths[key] = join(anchor, target);
  }
  return paths;
}
