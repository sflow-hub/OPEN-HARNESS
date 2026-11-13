import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

type PathFlavor = Pick<typeof path, 'resolve' | 'relative' | 'isAbsolute' | 'sep'>;

// Agent-writable directories may contain planted links, including predictable
// temporary names. Exclusively create a fresh inode and replace the destination.
export function atomicWorkspaceWrite(target: string, data: string | Buffer) {
  const temporary = `${target}.${randomUUID()}.tmp`;
  try { writeFileSync(temporary, data, { mode: 0o600, flag: 'wx' }); renameSync(temporary, target); }
  finally { rmSync(temporary, { force: true }); }
}

// File previews can race a running agent replacing a shared file. Validate the
// opened inode as well as the path, and never block on a substituted FIFO.
export function readWorkspaceFile(target: string) {
  const expected = lstatSync(target);
  if (!expected.isFile()) throw new Error('Workspace path must be a regular file.');
  const fd = openSync(target, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
  try {
    const actual = fstatSync(fd);
    if (!actual.isFile() || actual.dev !== expected.dev || actual.ino !== expected.ino) throw new Error('Workspace file changed while opening it. Try again.');
    return readFileSync(fd);
  } finally { closeSync(fd); }
}

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
