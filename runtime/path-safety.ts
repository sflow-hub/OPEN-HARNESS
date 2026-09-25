import { lstatSync } from 'node:fs';
import path from 'node:path';

type PathFlavor = Pick<typeof path, 'resolve' | 'relative' | 'isAbsolute' | 'sep'>;

// Transfer names are portable: a backslash must not become an escape when a bundle
// produced on Unix is restored on Windows. Reject traversal before normalizing it.
export function resolveContainedPath(root: string, name: string, paths: PathFlavor = path) {
  if (!name || name.includes('\0') || name.includes(':') || path.posix.isAbsolute(name) || path.win32.isAbsolute(name)) throw new Error('Invalid workspace path.');
  const parts = name.replaceAll('\\', '/').split('/');
  if (parts.some(part => !part || part === '.' || part === '..')) throw new Error('Invalid workspace path.');
  // Win32 strips trailing dots/spaces and treats device names specially even
  // below an ordinary directory. Portable names must retain their literal meaning.
  if (parts.some(part => /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part))) throw new Error('Invalid portable workspace path.');
  const target = paths.resolve(root, parts.join(paths.sep));
  const relative = paths.relative(paths.resolve(root), target);
  if (!relative || relative === '..' || relative.startsWith(`..${paths.sep}`) || paths.isAbsolute(relative)) throw new Error('Path escaped the workspace.');
  return target;
}

// The configured state root is trusted; everything beneath it may have been
// created by an agent. lstat also sees dangling links that existsSync would miss.
export function safeWorkspacePath(root: string, name: string) {
  const target = resolveContainedPath(root, name);
  const parts = path.relative(path.resolve(root), target).split(path.sep);
  let current = path.resolve(root);
  for (let index = 0; index < parts.length; index += 1) {
    current = path.join(current, parts[index]);
    let stat;
    try { stat = lstatSync(current); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') break;
      throw error;
    }
    if (stat.isSymbolicLink()) throw new Error('Workspace paths cannot contain symbolic links.');
    if (index < parts.length - 1 && !stat.isDirectory()) throw new Error('Workspace parent is not a directory.');
  }
  return target;
}
