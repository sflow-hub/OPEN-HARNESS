// Start this trusted helper in the coordinator-owned agent directory. Its cwd pins each
// source directory while it is visited, including on hosts without Linux /proc/self/fd.
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, opendirSync, readSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

export function editableSource(path, directory = false) {
  if (path.split('/').some(part => !/^[a-zA-Z0-9_-][a-zA-Z0-9_.-]*$/.test(part) || /^(node_modules|dist|coverage|test-results|out|secrets)$/i.test(part))) return false;
  if (directory) return /^(?:components|lib)(?:\/|$)/.test(path) || path === 'app';
  return path === 'README.md' || path === 'app/page.tsx' || path === 'app/globals.css' || /^(components|lib)\/.+\.(?:tsx?|css)$/.test(path);
}

const [candidate, destination] = process.argv.slice(2);
const flags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const same = (a, b) => a.dev === b.dev && a.ino === b.ino;
let count = 0, bytes = 0;
function enter(name, work) {
  const parent = statSync('.'), expected = lstatSync(name);
  if (!expected.isDirectory()) throw Error('The source folder must be an ordinary directory.');
  // Windows pins the current directory and does not support opening directory fds.
  const fd = process.platform === 'win32' ? undefined : openSync(name, flags | constants.O_DIRECTORY);
  try {
    process.chdir(name);
    const before = statSync('.');
    if (!same(before, expected) || (fd !== undefined && !same(before, fstatSync(fd)))) throw Error('The source folder changed while opening it.');
    work();
    const after = statSync('.');
    if (!same(after,before) || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) throw Error('The source folder changed during review. Try again.');
    process.chdir('..');
    if (!same(statSync('.'), parent)) throw Error('The source folder moved during review.');
  } finally { if (fd !== undefined) closeSync(fd); }
}
function capture(to, prefix, depth) {
  if (depth > 32) throw Error('The proposal has too many nested folders.');
  const dir = opendirSync('.'), seen = new Set();
  try {
    for (let entry = dir.readSync(); entry; entry = dir.readSync()) {
      if (++count > 12000) throw Error('The proposal contains too many files or folders.');
      const name = entry.name, key = name.normalize('NFC').toLowerCase();
      if (seen.has(key) || key === '.' || key === '..' || /[\\/:*?"<>|\x00-\x1f\x7f]|[. ]$/.test(name) || /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(name)) throw Error('The proposal contains an ambiguous file name.');
      seen.add(key);
      const info = lstatSync(name), target = join(to, name), path = prefix ? `${prefix}/${name}` : name;
      if (!editableSource(path, info.isDirectory())) throw Error(`This file is outside the editable dashboard source: ${path}`);
      if (info.isDirectory()) { mkdirSync(target, { mode: 0o700 }); enter(name, () => capture(target, path, depth + 1)); continue; }
      if (!info.isFile() || info.nlink !== 1) throw Error('A proposal can contain only ordinary files. Remove links or special files and try again.');
      const fd = openSync(name, flags);
      try {
        const before = fstatSync(fd);
        if (!same(info, before) || !before.isFile() || before.nlink !== 1) throw Error('A proposal file changed while opening it.');
        bytes += before.size;
        if (before.size > 8 * 1024 * 1024 || bytes > 64 * 1024 * 1024) throw Error('The proposal exceeds the local source size limit.');
        const data = Buffer.alloc(before.size);
        let offset = 0;
        while (offset < data.length) { const n = readSync(fd, data, offset, data.length - offset, offset); if (!n) break; offset += n; }
        const after = fstatSync(fd);
        if (offset !== data.length || before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || after.nlink !== 1) throw Error('A proposal file changed during review.');
        writeFileSync(target, data, { mode: 0o600, flag: 'wx' });
      } finally { closeSync(fd); }
    }
  } finally { dir.closeSync(); }
}
if (process.argv[1] && basename(process.argv[1]) === 'capture-local-source.mjs') {
  try { enter('private', () => enter(candidate, () => capture(destination, '', 0))); }
  catch (error) { process.stderr.write(error.message); process.exitCode = 1; }
}
