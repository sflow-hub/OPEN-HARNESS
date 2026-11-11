// Symlink-safe file operations for agent-writable directories. See the B1 plan: the agent
// owns private/profile/shared as rw mounts, so any check-then-use by pathname races a
// parent rename + symlink swap (TOCTOU). On Linux we resolve each component into a held
// directory fd and perform every operation through /proc/self/fd/<dirfd>/<name>, which is
// openat-relative to the held inode and survives the swap. Off Linux we keep the legacy
// pathname behaviour (lexical containment only); that mode stays exposed to the race and
// callers/docs must say so. A failed Linux probe fails closed.
//
// Trust boundary: `anchor` (and `stagingDir`), AND every one of their ancestors, must be
// trusted coordinator-owned directories the agent cannot modify — e.g. ${root} and
// ${root}/agents/<id>, which are never bind-mounted into an agent container. The fd-relative
// core only pins the anchor and the components *below* it; the anchor's own path is still
// resolved by pathname, so a writable ancestor would reintroduce the swap we are defending
// against. This is a caller contract, not something these functions can verify. The one
// cheap check we do enforce is that `anchor`/`stagingDir` are absolute and already normalised
// (no '.'/'..' and no redundant separators), so a caller cannot smuggle traversal through the
// anchor argument itself.
import { closeSync, constants, fstatSync, ftruncateSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmdirSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync, writeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, resolve, sep } from 'node:path';

export type SafeFsCode = 'symlink' | 'invalid-path' | 'not-found' | 'not-regular' | 'conflict' | 'unsupported' | 'too-large';
export class SafeFsError extends Error { constructor(readonly code: SafeFsCode, message: string) { super(message); this.name = 'SafeFsError'; } }
// not-found 404, conflict 409, too-large 413, everything else a plain 400.
export function safeFsErrorStatus(code: SafeFsCode): number { return code === 'not-found' ? 404 : code === 'conflict' ? 409 : code === 'too-large' ? 413 : 400; }

export type SafeFsMode = 'fd-relative' | 'path-fallback' | 'unsupported';
export type SafeFsEntry = { name: string; size: number; mtimeMs: number; isDirectory: boolean };
export type SafeFsStat = { name: string; size: number; mtimeMs: number; isDirectory: boolean; isFile: boolean; isSymbolicLink: boolean };
type ReadOpts = { encoding?: BufferEncoding; maxBytes: number };
type WriteOpts = { encoding?: BufferEncoding; maxBytes: number; mode?: number };

const { O_RDONLY, O_DIRECTORY, O_NOFOLLOW, O_NONBLOCK, O_WRONLY, O_CREAT } = constants;
const DIR_FLAGS = O_RDONLY | O_DIRECTORY | O_NOFOLLOW; // open a directory without following a symlinked final component

// Translate kernel errno and let any SafeFsError through unchanged; unknown errors surface as-is.
function remap(error: unknown): Error {
  if (error instanceof SafeFsError) return error;
  switch ((error as NodeJS.ErrnoException)?.code) {
    case 'ELOOP': return new SafeFsError('symlink', 'Refusing to follow a symbolic link.');
    case 'ENOENT': return new SafeFsError('not-found', 'No such file or directory.');
    case 'ENOTDIR': return new SafeFsError('invalid-path', 'A path component is not a directory.');
    case 'EISDIR': return new SafeFsError('not-regular', 'Target is a directory, not a regular file.');
    case 'ENXIO': return new SafeFsError('not-regular', 'Not a regular file.'); // O_WRONLY|O_NONBLOCK on a FIFO with no reader
    case 'EWOULDBLOCK': return new SafeFsError('not-regular', 'Not a regular file.'); // non-blocking open would have blocked
    case 'EEXIST': return new SafeFsError('conflict', 'A file or directory already exists at that path.');
    case 'ENOTEMPTY': return new SafeFsError('conflict', 'The directory changed during removal.');
    case 'EXDEV': return new SafeFsError('conflict', 'Cannot move across filesystems; staging must share the destination filesystem.');
    default: return error instanceof Error ? error : new Error(String(error));
  }
}

// rel must be a relative path with no NUL, absolute segment, empty, '.' or '..' component.
// Returns the component list; '' maps to [] (the anchor itself).
function components(rel: string): string[] {
  if (typeof rel !== 'string' || rel.includes('\0') || isAbsolute(rel)) throw new SafeFsError('invalid-path', 'Path must be relative and free of NUL bytes.');
  if (rel === '') return [];
  const parts = rel.split('/');
  for (const part of parts) if (part === '' || part === '.' || part === '..' || part.includes('\\')) throw new SafeFsError('invalid-path', 'Path must not contain empty, relative, or separator-escaped components.');
  return parts;
}

// Cheap guard for the trust-boundary contract (see the module header): the caller must pass an
// absolute, already-normalised directory. This cannot prove the directory is coordinator-owned,
// only that the argument itself carries no traversal.
function assertTrustedAnchor(dir: string): void {
  if (typeof dir !== 'string' || dir.includes('\0') || !isAbsolute(dir) || resolve(dir) !== dir) throw new SafeFsError('invalid-path', 'Anchor must be an absolute, normalized path with no traversal.');
}

// ---- Test-only phase hooks (inert unless OPEN_HARNESS_SAFE_FS_TEST_HOOKS === '1') ----
export type SafeFsHookPhase = 'afterComponentOpen' | 'beforeTerminalOp' | 'duringRecursiveDescent' | 'betweenReaddirAndLstat' | 'beforeRenameCommit';
type SafeFsHook = (info: { phase: SafeFsHookPhase; name?: string }) => void;
const hooks: Partial<Record<SafeFsHookPhase, SafeFsHook>> = {};
function testHooksEnabled(): boolean { return process.env.OPEN_HARNESS_SAFE_FS_TEST_HOOKS === '1'; }
export function __setSafeFsHook(phase: SafeFsHookPhase, fn: SafeFsHook | null): void {
  if (!testHooksEnabled()) throw new SafeFsError('unsupported', 'Safe-fs test hooks are disabled unless OPEN_HARNESS_SAFE_FS_TEST_HOOKS=1.');
  if (fn) hooks[phase] = fn; else delete hooks[phase];
}
function runHook(phase: SafeFsHookPhase, name?: string): void { if (testHooksEnabled()) hooks[phase]?.({ phase, name }); }

const procPath = (fd: number, name: string) => `/proc/self/fd/${fd}/${name}`;
function closeQuietly(fd: number): void { try { closeSync(fd); } catch { /* best effort */ } }

// ---- Capability probe ----
let probeResult: SafeFsMode | undefined;
// A full exercise of the fd-relative primitives in a throwaway directory; any deviation (no
// /proc, swap not contained, symlink not rejected) throws and the probe reports 'unsupported'.
function probe(): SafeFsMode {
  let base: string | null = null;
  try {
    base = mkdtempSync(resolve(tmpdir(), 'oh-safefs-'));
    const outside = resolve(base, 'outside'); mkdirSync(outside); writeFileSync(resolve(outside, 'canary'), 'canary');
    mkdirSync(resolve(base, 'd')); writeFileSync(resolve(base, 'd', 'f'), 'probe', { mode: 0o600 });
    const anchorFd = openSync(base, DIR_FLAGS);
    try {
      const dFd = openSync(procPath(anchorFd, 'd'), DIR_FLAGS);
      try {
        const fFd = openSync(procPath(dFd, 'f'), O_RDONLY | O_NOFOLLOW | O_NONBLOCK);
        try { const st = fstatSync(fFd); if (!st.isFile() || st.size !== 5) throw new Error('probe read failed'); } finally { closeQuietly(fFd); }
        if (!readdirSync(`/proc/self/fd/${dFd}`).includes('f')) throw new Error('probe readdir failed');
        if (!lstatSync(procPath(dFd, 'f')).isFile()) throw new Error('probe lstat failed');
        const wFd = openSync(procPath(dFd, 'g'), O_WRONLY | O_CREAT | O_NOFOLLOW, 0o600);
        try { writeSync(wFd, Buffer.from('x')); } finally { closeQuietly(wFd); }
        mkdirSync(procPath(dFd, 'sub'), { mode: 0o700 });
        const subFd = openSync(procPath(dFd, 'sub'), DIR_FLAGS);
        try { renameSync(procPath(dFd, 'g'), procPath(subFd, 'g')); unlinkSync(procPath(subFd, 'g')); } finally { closeQuietly(subFd); }
        rmdirSync(procPath(dFd, 'sub'));
        // Held-fd parent swap: rename d away and drop a symlink in its place; dFd must still reach the real 'f'.
        renameSync(resolve(base, 'd'), resolve(base, 'moved'));
        symlinkSync(outside, resolve(base, 'd'));
        if (readFileSync(procPath(dFd, 'f'), 'utf8') !== 'probe') throw new Error('held fd did not survive parent swap');
        let rejectedComponent = false;
        try { closeQuietly(openSync(procPath(anchorFd, 'd'), DIR_FLAGS)); } catch { rejectedComponent = true; }
        if (!rejectedComponent) throw new Error('symlinked component was not rejected');
        symlinkSync(resolve(outside, 'canary'), procPath(dFd, 'link'));
        let rejectedLeaf = false;
        try { closeQuietly(openSync(procPath(dFd, 'link'), O_RDONLY | O_NOFOLLOW)); } catch { rejectedLeaf = true; }
        if (!rejectedLeaf) throw new Error('symlinked leaf was not rejected');
      } finally { closeQuietly(dFd); }
    } finally { closeQuietly(anchorFd); }
    return 'fd-relative';
  } catch { return 'unsupported'; }
  finally { if (base) try { rmSync(base, { recursive: true, force: true }); } catch { /* best effort */ } }
}

// The Linux probe result is cached; the mode override is re-read per call so tests can flip it.
export function safeFsMode(): SafeFsMode {
  if (testHooksEnabled()) { const forced = process.env.OPEN_HARNESS_SAFE_FS_MODE; if (forced === 'path') return 'path-fallback'; if (forced === 'unsupported') return 'unsupported'; }
  if (process.platform !== 'linux') return 'path-fallback';
  return probeResult ??= probe();
}
function requireMode(): 'fd-relative' | 'path-fallback' {
  const mode = safeFsMode();
  if (mode === 'unsupported') throw new SafeFsError('unsupported', 'Safe workspace file access is unavailable on this host.');
  return mode;
}

// ---- fd-relative core ----
// Open one directory component through the held parent. O_NOFOLLOW|O_DIRECTORY on a symlinked
// component fails with ELOOP on some kernels and ENOTDIR on others (the link is not a dir); in
// both cases we re-classify by lstat-ing the component through the held parent. A symlink is
// reported as 'symlink'; anything else keeps its original errno mapping. This is classification
// only — the component is refused either way.
function openComponent(parentFd: number, name: string): number {
  try { return openSync(procPath(parentFd, name), DIR_FLAGS); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === 'ELOOP' || code === 'ENOTDIR') {
      const st = lstatSync(procPath(parentFd, name), { throwIfNoEntry: false });
      if (st?.isSymbolicLink()) throw new SafeFsError('symlink', 'Refusing to traverse a symbolic link in the path.');
    }
    throw error;
  }
}
// Open the anchor (no-follow) then each directory component through the previously held fd.
function openChain(anchor: string, dirParts: string[], fds: number[]): number {
  let fd = openSync(anchor, DIR_FLAGS); fds.push(fd); runHook('afterComponentOpen');
  for (const part of dirParts) { fd = openComponent(fd, part); fds.push(fd); runHook('afterComponentOpen', part); }
  return fd;
}
// Hold the leaf's parent by fd, then run the terminal op relative to it.
function withParent<T>(anchor: string, rel: string, fn: (parentFd: number, leaf: string) => T): T {
  const parts = components(rel);
  if (parts.length === 0) throw new SafeFsError('invalid-path', 'Operation requires a target name.');
  const fds: number[] = [];
  try { const parentFd = openChain(anchor, parts.slice(0, -1), fds); const leaf = parts[parts.length - 1]; runHook('beforeTerminalOp', leaf); return fn(parentFd, leaf); }
  finally { for (const fd of fds) closeQuietly(fd); }
}

function readFd(anchor: string, rel: string, opts: ReadOpts): string | Buffer {
  return withParent(anchor, rel, (parentFd, leaf) => {
    const fd = openSync(procPath(parentFd, leaf), O_RDONLY | O_NOFOLLOW | O_NONBLOCK); // ELOOP on a symlink; NONBLOCK so a FIFO leaf never blocks
    try {
      const st = fstatSync(fd);
      if (!st.isFile()) throw new SafeFsError('not-regular', 'Not a regular file.');
      if (st.size > opts.maxBytes) throw new SafeFsError('too-large', `File exceeds the ${opts.maxBytes}-byte limit.`);
      const buf = Buffer.allocUnsafe(st.size); let off = 0;
      while (off < st.size) { const n = readSync(fd, buf, off, st.size - off, off); if (n <= 0) break; off += n; }
      const data = off === st.size ? buf : buf.subarray(0, off);
      return opts.encoding ? data.toString(opts.encoding) : data;
    } finally { closeQuietly(fd); }
  });
}
function writeFd(anchor: string, rel: string, bytes: Buffer, mode: number): void {
  withParent(anchor, rel, (parentFd, leaf) => {
    const fd = openSync(procPath(parentFd, leaf), O_WRONLY | O_CREAT | O_NOFOLLOW | O_NONBLOCK, mode); // NONBLOCK so a FIFO leaf never blocks (ENXIO without a reader); no O_TRUNC: fstat the inode first
    try {
      if (!fstatSync(fd).isFile()) throw new SafeFsError('not-regular', 'Not a regular file.'); // O_NONBLOCK is harmless on the regular file we then write
      ftruncateSync(fd, 0);
      let off = 0; while (off < bytes.length) off += writeSync(fd, bytes, off, bytes.length - off, off);
    } finally { closeQuietly(fd); }
  });
}
function unlinkFd(anchor: string, rel: string): void {
  withParent(anchor, rel, (parentFd, leaf) => {
    const st = lstatSync(procPath(parentFd, leaf)); // lstat through the held parent, never following the leaf
    if (st.isSymbolicLink()) throw new SafeFsError('symlink', 'Refusing to delete a symbolic link.');
    if (!st.isFile()) throw new SafeFsError('not-regular', 'Only regular files can be deleted here.');
    unlinkSync(procPath(parentFd, leaf));
  });
}
function listFd(anchor: string, rel: string, max: number): SafeFsEntry[] {
  const parts = components(rel); const fds: number[] = [];
  try {
    const dirFd = openChain(anchor, parts, fds);
    const names = readdirSync(`/proc/self/fd/${dirFd}`); const out: SafeFsEntry[] = [];
    for (const name of names) {
      if (out.length >= max) break;
      runHook('betweenReaddirAndLstat', name);
      const st = lstatSync(procPath(dirFd, name), { throwIfNoEntry: false }); // metadata through the held parent
      if (!st || st.isSymbolicLink()) continue; // skip vanished entries and never surface symlink targets
      out.push({ name, size: st.size, mtimeMs: st.mtimeMs, isDirectory: st.isDirectory() });
    }
    return out;
  } finally { for (const fd of fds) closeQuietly(fd); }
}
function mkdirFd(anchor: string, rel: string): void { withParent(anchor, rel, (parentFd, leaf) => mkdirSync(procPath(parentFd, leaf), { mode: 0o700 })); }
function statFd(anchor: string, rel: string): SafeFsStat | null {
  return withParent(anchor, rel, (parentFd, leaf) => {
    const st = lstatSync(procPath(parentFd, leaf), { throwIfNoEntry: false });
    if (!st) return null;
    return { name: leaf, size: st.size, mtimeMs: st.mtimeMs, isDirectory: st.isDirectory(), isFile: st.isFile(), isSymbolicLink: st.isSymbolicLink() };
  });
}
type RmLimits = { maxEntries: number; maxDepth: number };
// Read-only first pass: descend the whole tree through held fds and refuse (owner decision 2:
// a recursive remove never unlinks a link) if any entry anywhere is a symbolic link, before a
// single byte is deleted. Also enforces the depth/entry bounds up front.
function scanTree(parentFd: number, name: string, limits: RmLimits, depth: number, count: { n: number }): void {
  if (depth > limits.maxDepth) throw new SafeFsError('too-large', 'Directory tree is too deep to remove.');
  const dirFd = openSync(procPath(parentFd, name), DIR_FLAGS);
  try {
    for (const child of readdirSync(`/proc/self/fd/${dirFd}`)) {
      if (++count.n > limits.maxEntries) throw new SafeFsError('too-large', 'Directory tree has too many entries to remove.');
      const st = lstatSync(procPath(dirFd, child));
      if (st.isSymbolicLink()) throw new SafeFsError('symlink', 'Refusing to remove a tree that contains a symbolic link.');
      if (st.isDirectory()) scanTree(dirFd, child, limits, depth + 1, count);
    }
  } finally { closeQuietly(dirFd); }
}
// Post-order delete pass, run only after scanTree approved the tree. Every child is lstat-ed
// through the held parent immediately before it is touched, so a symlink that appeared after
// the scan (a concurrent replacement) is still refused with 'symlink' and never followed or
// unlinked. Residual window: between that lstat and the unlink the name could be swapped; the
// swap would be unlinked as a link (not followed), so nothing outside the tree is reached — but
// refusal is therefore non-following, not unconditional, under a concurrent replacement. Before
// the rmdir of each directory we re-check identity (the inode we descended via its held fd vs
// the name now resolved through the parent); a dev/ino mismatch means the entry was swapped and
// we refuse with 'conflict' rather than rmdir a stranger.
function removeTree(parentFd: number, name: string, limits: RmLimits, depth: number, count: { n: number }): void {
  if (depth > limits.maxDepth) throw new SafeFsError('too-large', 'Directory tree is too deep to remove.');
  const dirFd = openSync(procPath(parentFd, name), DIR_FLAGS);
  const ident = fstatSync(dirFd);
  try {
    for (const child of readdirSync(`/proc/self/fd/${dirFd}`)) {
      if (++count.n > limits.maxEntries) throw new SafeFsError('too-large', 'Directory tree has too many entries to remove.');
      runHook('duringRecursiveDescent', child);
      const st = lstatSync(procPath(dirFd, child));
      if (st.isSymbolicLink()) throw new SafeFsError('symlink', 'Refusing to remove a symbolic link.');
      if (st.isDirectory()) removeTree(dirFd, child, limits, depth + 1, count); else unlinkSync(procPath(dirFd, child));
    }
  } finally { closeQuietly(dirFd); }
  const now = lstatSync(procPath(parentFd, name), { throwIfNoEntry: false });
  if (!now || now.dev !== ident.dev || now.ino !== ident.ino) throw new SafeFsError('conflict', 'The directory changed during removal.');
  rmdirSync(procPath(parentFd, name));
}
function rmrfFd(anchor: string, rel: string, limits: RmLimits): void {
  withParent(anchor, rel, (parentFd, leaf) => {
    const st = lstatSync(procPath(parentFd, leaf));
    if (st.isSymbolicLink()) throw new SafeFsError('symlink', 'Refusing to remove a symbolic link.');
    if (st.isDirectory()) { scanTree(parentFd, leaf, limits, 0, { n: 0 }); removeTree(parentFd, leaf, limits, 0, { n: 0 }); } else unlinkSync(procPath(parentFd, leaf));
  });
}
function renameFd(stagingDir: string, name: string, anchor: string, rel: string): void {
  if (components(name).length !== 1) throw new SafeFsError('invalid-path', 'Staging name must be a single path component.');
  const parts = components(rel);
  if (parts.length === 0) throw new SafeFsError('invalid-path', 'Rename requires a destination name.');
  const fds: number[] = [];
  try {
    const stagingFd = openSync(stagingDir, DIR_FLAGS); fds.push(stagingFd);
    const destParentFd = openChain(anchor, parts.slice(0, -1), fds); const leaf = parts[parts.length - 1];
    runHook('beforeRenameCommit', leaf);
    renameSync(procPath(stagingFd, name), procPath(destParentFd, leaf)); // EXDEV is remapped to a conflict; we never copy across filesystems
  } finally { for (const fd of fds) closeQuietly(fd); }
}

// ---- path-fallback core (non-Linux) ----
// Lexical containment only: these follow symlinks exactly like the legacy code and stay
// exposed to the parent-swap race. The sole hardening is decision 2 (refuse deleting a link).
function containedPath(anchor: string, rel: string): string {
  const base = resolve(anchor), target = resolve(base, components(rel).join('/') || '.');
  if (target !== base && !target.startsWith(base + sep)) throw new SafeFsError('invalid-path', 'Path escaped the workspace.');
  return target;
}
function readFallback(anchor: string, rel: string, opts: ReadOpts): string | Buffer {
  const target = containedPath(anchor, rel), st = statSync(target);
  if (!st.isFile()) throw new SafeFsError('not-regular', 'Not a regular file.');
  if (st.size > opts.maxBytes) throw new SafeFsError('too-large', `File exceeds the ${opts.maxBytes}-byte limit.`);
  const data = readFileSync(target);
  return opts.encoding ? data.toString(opts.encoding) : data;
}
function unlinkFallback(anchor: string, rel: string): void {
  const target = containedPath(anchor, rel), st = lstatSync(target, { throwIfNoEntry: false });
  if (!st) throw new SafeFsError('not-found', 'No such file.');
  if (st.isSymbolicLink()) throw new SafeFsError('symlink', 'Refusing to delete a symbolic link.');
  if (!st.isFile()) throw new SafeFsError('not-regular', 'Only regular files can be deleted here.');
  unlinkSync(target);
}
function listFallback(anchor: string, rel: string, max: number): SafeFsEntry[] {
  const dir = containedPath(anchor, rel), out: SafeFsEntry[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (out.length >= max) break;
    if (entry.isSymbolicLink()) continue;
    const st = lstatSync(resolve(dir, entry.name), { throwIfNoEntry: false });
    if (!st || st.isSymbolicLink()) continue;
    out.push({ name: entry.name, size: st.size, mtimeMs: st.mtimeMs, isDirectory: st.isDirectory() });
  }
  return out;
}
function statFallback(anchor: string, rel: string): SafeFsStat | null {
  const target = containedPath(anchor, rel), st = lstatSync(target, { throwIfNoEntry: false });
  if (!st) return null;
  return { name: basename(target), size: st.size, mtimeMs: st.mtimeMs, isDirectory: st.isDirectory(), isFile: st.isFile(), isSymbolicLink: st.isSymbolicLink() };
}
// Walk and delete post-order, stopping with 'symlink' when it meets a symbolic link. There is NO
// pre-scan: files and directories removed before that point stay removed. Being pathname-based,
// a concurrent swap between lstat and unlink can still make it unlink a nested symlink or act on a
// swapped parent. Accepted owner decision: the fallback keeps today's (unprotected) behaviour and
// does not protect against the parent-swap race or FIFO hangs (fallback writes use writeFileSync).
function removeTreeFallback(dir: string): void {
  for (const entry of readdirSync(dir)) {
    const full = resolve(dir, entry), st = lstatSync(full);
    if (st.isSymbolicLink()) throw new SafeFsError('symlink', 'Refusing to remove a tree that contains a symbolic link.');
    if (st.isDirectory()) removeTreeFallback(full); else unlinkSync(full);
  }
  rmdirSync(dir);
}
function rmrfFallback(anchor: string, rel: string): void {
  const target = containedPath(anchor, rel), st = lstatSync(target, { throwIfNoEntry: false });
  if (!st) throw new SafeFsError('not-found', 'No such file or directory.');
  if (st.isSymbolicLink()) throw new SafeFsError('symlink', 'Refusing to remove a symbolic link.');
  if (st.isDirectory()) removeTreeFallback(target); else unlinkSync(target);
}
function renameFallback(stagingDir: string, name: string, anchor: string, rel: string): void {
  if (components(name).length !== 1) throw new SafeFsError('invalid-path', 'Staging name must be a single path component.');
  renameSync(resolve(stagingDir, name), containedPath(anchor, rel));
}

// ---- Public API: pick the mode, dispatch, and normalise errors ----
// Every entry point takes an `anchor` (and renameIntoInside a `stagingDir`) that, with all of
// its ancestors, MUST be a trusted coordinator-owned directory the agent cannot modify (see the
// module header for why — e.g. ${root} and ${root}/agents/<id>, which are never bind-mounted).
// `rel` is the only untrusted input and is confined under the anchor. `anchor`/`stagingDir` are
// required to be absolute and normalised; this is the only part of the contract we can check.
/** Read a regular file at `rel` under the trusted `anchor` (see the module header on anchor trust). */
export function readInside(anchor: string, rel: string, opts: ReadOpts): string | Buffer {
  assertTrustedAnchor(anchor); const mode = requireMode();
  try { return mode === 'fd-relative' ? readFd(anchor, rel, opts) : readFallback(anchor, rel, opts); } catch (error) { throw remap(error); }
}
/** Write (truncating) a regular file at `rel` under the trusted `anchor` (see the module header on anchor trust). */
export function writeInside(anchor: string, rel: string, data: string | Buffer, opts: WriteOpts): void {
  assertTrustedAnchor(anchor); const mode = requireMode(), bytes = typeof data === 'string' ? Buffer.from(data, opts.encoding ?? 'utf8') : data;
  if (bytes.length > opts.maxBytes) throw new SafeFsError('too-large', `Content exceeds the ${opts.maxBytes}-byte limit.`);
  try { if (mode === 'fd-relative') writeFd(anchor, rel, bytes, opts.mode ?? 0o600); else writeFileSync(containedPath(anchor, rel), bytes, { mode: opts.mode ?? 0o600 }); } catch (error) { throw remap(error); }
}
/** Delete a single regular file at `rel` under the trusted `anchor`, refusing symlinks (see the module header on anchor trust). */
export function unlinkInside(anchor: string, rel: string): void {
  assertTrustedAnchor(anchor); const mode = requireMode();
  try { if (mode === 'fd-relative') unlinkFd(anchor, rel); else unlinkFallback(anchor, rel); } catch (error) { throw remap(error); }
}
/** List direct children of directory `rel` under the trusted `anchor`, skipping symlinks (see the module header on anchor trust). */
export function listInside(anchor: string, rel: string, opts: { max: number }): SafeFsEntry[] {
  assertTrustedAnchor(anchor); const mode = requireMode();
  try { return mode === 'fd-relative' ? listFd(anchor, rel, opts.max) : listFallback(anchor, rel, opts.max); } catch (error) { throw remap(error); }
}
/** Create one directory level at `rel` under the trusted `anchor` (see the module header on anchor trust). */
export function mkdirInside(anchor: string, rel: string): void {
  assertTrustedAnchor(anchor); const mode = requireMode();
  try { if (mode === 'fd-relative') mkdirFd(anchor, rel); else mkdirSync(containedPath(anchor, rel), { mode: 0o700 }); } catch (error) { throw remap(error); }
}
/** Recursively remove `rel` under the trusted `anchor`, refusing any symlink in the tree (see the module header on anchor trust). */
export function rmrfInside(anchor: string, rel: string, opts: { maxEntries: number; maxDepth: number }): void {
  assertTrustedAnchor(anchor); const mode = requireMode();
  try { if (mode === 'fd-relative') rmrfFd(anchor, rel, opts); else rmrfFallback(anchor, rel); } catch (error) { throw remap(error); }
}
/** lstat-like metadata for `rel` under the trusted `anchor`, or null if absent (see the module header on anchor trust). */
export function statInside(anchor: string, rel: string): SafeFsStat | null {
  assertTrustedAnchor(anchor); const mode = requireMode();
  try { return mode === 'fd-relative' ? statFd(anchor, rel) : statFallback(anchor, rel); } catch (error) { throw remap(error); }
}
/** Move `name` from the trusted `stagingDir` to `rel` under the trusted `anchor`; both dirs and all their ancestors must be trusted (see the module header on anchor trust). */
export function renameIntoInside(stagingDir: string, name: string, anchor: string, rel: string): void {
  assertTrustedAnchor(stagingDir); assertTrustedAnchor(anchor); const mode = requireMode();
  try { if (mode === 'fd-relative') renameFd(stagingDir, name, anchor, rel); else renameFallback(stagingDir, name, anchor, rel); } catch (error) { throw remap(error); }
}
