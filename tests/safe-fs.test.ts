import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { __setSafeFsHook, listInside, mkdirInside, readInside, renameIntoInside, rmrfInside, safeFsErrorStatus, safeFsMode, statInside, unlinkInside, writeInside, SafeFsError, type SafeFsHookPhase } from '../runtime/safe-fs';

const notLinux = process.platform !== 'linux';
const fdOnly = { skip: notLinux ? 'fd-relative safe-fs is Linux-only' : false };
const PHASES: SafeFsHookPhase[] = ['afterComponentOpen', 'beforeTerminalOp', 'duringRecursiveDescent', 'betweenReaddirAndLstat', 'beforeRenameCommit'];
const isSafeFs = (code: SafeFsError['code']) => (e: unknown): e is SafeFsError => e instanceof SafeFsError && e.code === code;

function tmp(t: TestContext) { const root = mkdtempSync(join(tmpdir(), 'safe-fs-')); t.after(() => rmSync(root, { recursive: true, force: true })); return root; }
// The hook flag lives on the shared process env; enable it for one test and strip every hook
// (plus the flag) afterwards so no phase leaks into the next test.
function enableHooks(t: TestContext) {
  process.env.OPEN_HARNESS_SAFE_FS_TEST_HOOKS = '1';
  t.after(() => { for (const phase of PHASES) __setSafeFsHook(phase, null); delete process.env.OPEN_HARNESS_SAFE_FS_TEST_HOOKS; });
}
function once(fn: () => void) { let done = false; return () => { if (done) return; done = true; fn(); }; }
// Fire `fn` (at most once) only when the hook reports the given component name, so the swap lands
// after that directory is already held by fd — never on the anchor open (name undefined).
function onName(target: string, fn: () => void) { const run = once(fn); return ({ name }: { name?: string }) => { if (name === target) run(); }; }
// Rename a validated directory away and drop a symlink to an outside dir in its place.
function swap(parent: string, name: string, outside: string) { renameSync(join(parent, name), join(parent, `${name}.moved`)); symlinkSync(outside, join(parent, name)); }
// anchor/sub/leaf.txt ('inside') plus an outside dir whose files share the names of the inside
// targets (leaf.txt, file.txt) and carry 'OUTSIDE', so a leak surfaces as OUTSIDE content or a
// changed/removed outside file; canary.txt is the untouched-existence probe.
function scene(t: TestContext) {
  const root = tmp(t), anchor = join(root, 'anchor'), outside = join(root, 'outside');
  mkdirSync(join(anchor, 'sub'), { recursive: true }); writeFileSync(join(anchor, 'sub', 'leaf.txt'), 'inside');
  mkdirSync(outside);
  writeFileSync(join(outside, 'canary.txt'), 'canary');
  writeFileSync(join(outside, 'leaf.txt'), 'OUTSIDE');
  writeFileSync(join(outside, 'file.txt'), 'OUTSIDE');
  return { root, anchor, outside };
}
const canaryIntact = (outside: string) => assert.equal(readFileSync(join(outside, 'canary.txt'), 'utf8'), 'canary');
// Every outside file still exists with its original content: nothing leaked out of the anchor.
function outsideIntact(outside: string) {
  canaryIntact(outside);
  assert.equal(readFileSync(join(outside, 'leaf.txt'), 'utf8'), 'OUTSIDE');
  assert.equal(readFileSync(join(outside, 'file.txt'), 'utf8'), 'OUTSIDE');
}

// ---- Deterministic race tests: a hook swaps the held 'sub' dir for a symlink to `outside`,
// after 'sub' is already held. Because the fd survives the swap, each op must reach the real
// (moved) inside target and never the identically-named file in `outside`. ----
for (const phase of ['afterComponentOpen', 'beforeTerminalOp'] as const) {
  const holdName = phase === 'afterComponentOpen' ? 'sub' : 'leaf.txt'; // when 'sub' is guaranteed held
  test(`read survives a parent swap at ${phase}`, fdOnly, t => {
    enableHooks(t); const { anchor, outside } = scene(t);
    __setSafeFsHook(phase, onName(holdName, () => swap(anchor, 'sub', outside)));
    let result: string | Buffer | null = null, threw: unknown = null;
    try { result = readInside(anchor, 'sub/leaf.txt', { encoding: 'utf8', maxBytes: 1000 }); } catch (e) { threw = e; }
    assert.ok(result === 'inside' || threw instanceof SafeFsError, 'read returns the original inside content or refuses');
    outsideIntact(outside);
    if (typeof result === 'string') assert.notEqual(result, 'OUTSIDE'); // never the outside leaf
  });
  test(`write never reaches the outside at ${phase}`, fdOnly, t => {
    enableHooks(t); const { anchor, outside } = scene(t);
    __setSafeFsHook(phase, onName(holdName, () => swap(anchor, 'sub', outside)));
    let threw: unknown = null;
    try { writeInside(anchor, 'sub/leaf.txt', 'OVERWRITE', { maxBytes: 1000 }); } catch (e) { threw = e; }
    outsideIntact(outside); // the outside leaf.txt keeps its OUTSIDE content
    if (!threw) assert.equal(readFileSync(join(anchor, 'sub.moved', 'leaf.txt'), 'utf8'), 'OVERWRITE'); // landed in the held original dir
  });
  test(`unlink never deletes outside files at ${phase}`, fdOnly, t => {
    enableHooks(t); const { anchor, outside } = scene(t);
    __setSafeFsHook(phase, onName(holdName, () => swap(anchor, 'sub', outside)));
    let threw: unknown = null;
    try { unlinkInside(anchor, 'sub/leaf.txt'); } catch (e) { threw = e; }
    outsideIntact(outside); // outside leaf.txt still present with OUTSIDE content
    if (!threw) assert.ok(!existsSync(join(anchor, 'sub.moved', 'leaf.txt')), 'only the inside leaf was removed');
  });
}

test('list never surfaces a child swapped to a symlink between readdir and lstat', fdOnly, t => {
  enableHooks(t); const { anchor, outside } = scene(t);
  __setSafeFsHook('betweenReaddirAndLstat', once(() => { unlinkSync(join(anchor, 'sub', 'leaf.txt')); symlinkSync(join(outside, 'canary.txt'), join(anchor, 'sub', 'leaf.txt')); }));
  const entries = listInside(anchor, 'sub', { max: 50 });
  assert.ok(!entries.some(e => e.name.includes('canary')));
  assert.ok(!entries.some(e => e.name === 'leaf.txt'), 'the entry turned symlink is skipped');
  canaryIntact(outside);
});

test('rmrf refuses when a subdir is swapped to a symlink mid-descent, touching nothing outside', fdOnly, t => {
  enableHooks(t); const { anchor, outside } = scene(t);
  mkdirSync(join(anchor, 'tree', 'branch'), { recursive: true });
  writeFileSync(join(anchor, 'tree', 'branch', 'a.txt'), 'a'); writeFileSync(join(anchor, 'tree', 'b.txt'), 'b');
  // The scan passes (no symlink yet); the swap lands during the delete pass, once 'branch' is reached.
  __setSafeFsHook('duringRecursiveDescent', onName('branch', () => swap(join(anchor, 'tree'), 'branch', outside)));
  assert.throws(() => rmrfInside(anchor, 'tree', { maxEntries: 100, maxDepth: 10 }), isSafeFs('symlink'));
  outsideIntact(outside);
  assert.ok(existsSync(join(anchor, 'tree', 'branch.moved', 'a.txt')), 'the real branch was renamed aside, not followed');
});

test('renameIntoInside never escapes via a dest parent swapped before commit', fdOnly, t => {
  enableHooks(t); const { root, anchor, outside } = scene(t);
  const staging = join(root, 'staging'); mkdirSync(staging); writeFileSync(join(staging, '0'), 'payload');
  mkdirSync(join(anchor, 'dest'));
  __setSafeFsHook('beforeRenameCommit', onName('file.txt', () => swap(anchor, 'dest', outside)));
  let threw: unknown = null;
  try { renameIntoInside(staging, '0', anchor, 'dest/file.txt'); } catch (e) { threw = e; }
  outsideIntact(outside); // the outside file.txt keeps its OUTSIDE content; nothing moved out
  if (!threw) assert.equal(readFileSync(join(anchor, 'dest.moved', 'file.txt'), 'utf8'), 'payload');
});

// ---- Static containment cases ----
test('refuses a symlinked path component', fdOnly, t => {
  const root = tmp(t), anchor = join(root, 'anchor'), outside = join(root, 'outside');
  mkdirSync(anchor); mkdirSync(outside); writeFileSync(join(outside, 'secret.txt'), 'secret');
  symlinkSync(outside, join(anchor, 'sub'));
  assert.throws(() => readInside(anchor, 'sub/secret.txt', { encoding: 'utf8', maxBytes: 100 }), isSafeFs('symlink'));
  assert.equal(readFileSync(join(outside, 'secret.txt'), 'utf8'), 'secret');
});

test('refuses reading or writing a symlinked leaf', fdOnly, t => {
  const root = tmp(t), anchor = join(root, 'anchor'), outside = join(root, 'outside');
  mkdirSync(anchor); mkdirSync(outside); writeFileSync(join(outside, 'target.txt'), 'orig');
  symlinkSync(join(outside, 'target.txt'), join(anchor, 'link.txt'));
  assert.throws(() => readInside(anchor, 'link.txt', { encoding: 'utf8', maxBytes: 100 }), isSafeFs('symlink'));
  assert.throws(() => writeInside(anchor, 'link.txt', 'x', { maxBytes: 100 }), isSafeFs('symlink'));
  assert.equal(readFileSync(join(outside, 'target.txt'), 'utf8'), 'orig');
});

test('refuses deleting a symlink, leaving the link and its target intact', fdOnly, t => {
  const root = tmp(t), anchor = join(root, 'anchor'), outside = join(root, 'outside');
  mkdirSync(anchor); mkdirSync(outside); writeFileSync(join(outside, 'target.txt'), 'orig');
  symlinkSync(join(outside, 'target.txt'), join(anchor, 'link.txt'));
  assert.throws(() => unlinkInside(anchor, 'link.txt'), isSafeFs('symlink'));
  assert.throws(() => rmrfInside(anchor, 'link.txt', { maxEntries: 10, maxDepth: 5 }), isSafeFs('symlink'));
  assert.ok(lstatSync(join(anchor, 'link.txt')).isSymbolicLink());
  assert.equal(readFileSync(join(outside, 'target.txt'), 'utf8'), 'orig');
});

test('refuses a dangling symlink leaf', fdOnly, t => {
  const root = tmp(t), anchor = join(root, 'anchor'); mkdirSync(anchor);
  symlinkSync(join(root, 'nope'), join(anchor, 'dangling'));
  assert.throws(() => readInside(anchor, 'dangling', { encoding: 'utf8', maxBytes: 100 }), isSafeFs('symlink'));
});

test('refuses reading or writing a FIFO leaf without blocking', fdOnly, t => {
  const root = tmp(t), anchor = join(root, 'anchor'); mkdirSync(anchor);
  const made = spawnSync('mkfifo', [join(anchor, 'pipe')]);
  if (made.error || made.status !== 0) { t.skip('mkfifo unavailable'); return; }
  // Both must return promptly: the read open uses O_NONBLOCK, the write open O_WRONLY|O_NONBLOCK
  // (ENXIO on a reader-less FIFO) rather than blocking for a peer. node:test fails the run if either hangs.
  assert.throws(() => readInside(anchor, 'pipe', { encoding: 'utf8', maxBytes: 100 }), isSafeFs('not-regular'));
  assert.throws(() => writeInside(anchor, 'pipe', 'x', { maxBytes: 100 }), isSafeFs('not-regular'));
  assert.ok(lstatSync(join(anchor, 'pipe')).isFIFO(), 'the FIFO is left untouched');
});

test('refuses reading or deleting a directory as a file', fdOnly, t => {
  const root = tmp(t), anchor = join(root, 'anchor'); mkdirSync(join(anchor, 'd'), { recursive: true });
  assert.throws(() => readInside(anchor, 'd', { encoding: 'utf8', maxBytes: 100 }), isSafeFs('not-regular'));
  assert.throws(() => unlinkInside(anchor, 'd'), isSafeFs('not-regular'));
});

for (const bad of ['../escape', '/abs/path', 'a/../b', 'a//b', 'a b', '']) {
  test(`rejects invalid relative path ${JSON.stringify(bad)}`, fdOnly, t => {
    const root = tmp(t), anchor = join(root, 'anchor'); mkdirSync(anchor);
    assert.throws(() => readInside(anchor, bad, { encoding: 'utf8', maxBytes: 100 }), isSafeFs('invalid-path'));
  });
}

test('enforces maxBytes on read and write', fdOnly, t => {
  const root = tmp(t), anchor = join(root, 'anchor'); mkdirSync(anchor);
  writeFileSync(join(anchor, 'big.txt'), '0123456789');
  assert.throws(() => readInside(anchor, 'big.txt', { encoding: 'utf8', maxBytes: 5 }), isSafeFs('too-large'));
  assert.equal(readInside(anchor, 'big.txt', { encoding: 'utf8', maxBytes: 100 }), '0123456789');
  assert.throws(() => writeInside(anchor, 'x.txt', 'toolong', { maxBytes: 3 }), isSafeFs('too-large'));
  assert.ok(!existsSync(join(anchor, 'x.txt')));
});

test('list respects max and skips symlinks', fdOnly, t => {
  const root = tmp(t), anchor = join(root, 'anchor'), outside = join(root, 'outside');
  mkdirSync(anchor); mkdirSync(outside); writeFileSync(join(outside, 'secret.txt'), 's');
  for (const n of ['a.txt', 'b.txt', 'c.txt']) writeFileSync(join(anchor, n), 'x');
  mkdirSync(join(anchor, 'dir')); symlinkSync(join(outside, 'secret.txt'), join(anchor, 'link.txt'));
  assert.equal(listInside(anchor, '', { max: 2 }).length, 2);
  const all = listInside(anchor, '', { max: 100 });
  assert.ok(!all.some(e => e.name === 'link.txt'));
  assert.ok(all.some(e => e.name === 'dir' && e.isDirectory));
});

test('rmrf removes a tree and enforces entry and depth bounds', fdOnly, t => {
  const root = tmp(t), anchor = join(root, 'anchor'); mkdirSync(anchor);
  const makeTree = (name: string) => { mkdirSync(join(anchor, name, 'a'), { recursive: true }); writeFileSync(join(anchor, name, 'a', 'f'), 'f'); writeFileSync(join(anchor, name, 'g'), 'g'); };
  makeTree('t1'); makeTree('t2'); makeTree('t3');
  assert.throws(() => rmrfInside(anchor, 't1', { maxEntries: 1, maxDepth: 10 }), isSafeFs('too-large'));
  assert.throws(() => rmrfInside(anchor, 't2', { maxEntries: 100, maxDepth: 0 }), isSafeFs('too-large'));
  rmrfInside(anchor, 't3', { maxEntries: 100, maxDepth: 10 });
  assert.ok(!existsSync(join(anchor, 't3')));
});

test('rmrf refuses a tree holding a nested symlink and leaves the whole tree and target intact', fdOnly, t => {
  const root = tmp(t), anchor = join(root, 'anchor'), outside = join(root, 'outside');
  mkdirSync(join(anchor, 'tree', 'a'), { recursive: true }); mkdirSync(outside); writeFileSync(join(outside, 'target.txt'), 'orig');
  writeFileSync(join(anchor, 'tree', 'a', 'f.txt'), 'f'); writeFileSync(join(anchor, 'tree', 'g.txt'), 'g');
  symlinkSync(join(outside, 'target.txt'), join(anchor, 'tree', 'a', 'link.txt')); // link nested two levels down
  // The read-only scan must refuse before any deletion, so even g.txt survives.
  assert.throws(() => rmrfInside(anchor, 'tree', { maxEntries: 100, maxDepth: 10 }), isSafeFs('symlink'));
  assert.ok(existsSync(join(anchor, 'tree', 'g.txt')) && existsSync(join(anchor, 'tree', 'a', 'f.txt')), 'nothing was deleted before the refusal');
  assert.ok(lstatSync(join(anchor, 'tree', 'a', 'link.txt')).isSymbolicLink());
  assert.equal(readFileSync(join(outside, 'target.txt'), 'utf8'), 'orig');
});

test('mkdir creates one level, refuses existing and a missing parent', fdOnly, t => {
  const root = tmp(t), anchor = join(root, 'anchor'); mkdirSync(anchor);
  mkdirInside(anchor, 'child');
  assert.ok(statSync(join(anchor, 'child')).isDirectory());
  assert.throws(() => mkdirInside(anchor, 'child'), isSafeFs('conflict'));
  assert.throws(() => mkdirInside(anchor, 'a/b/c'), isSafeFs('not-found'));
});

test('stat returns lstat-like info or null', fdOnly, t => {
  const root = tmp(t), anchor = join(root, 'anchor'); mkdirSync(anchor);
  writeFileSync(join(anchor, 'f.txt'), 'hello');
  const st = statInside(anchor, 'f.txt');
  assert.ok(st && st.isFile && st.size === 5 && !st.isDirectory);
  assert.equal(statInside(anchor, 'missing.txt'), null);
});

test('write/read/unlink round trip with a mode-0600 file and no leftover bytes on overwrite', fdOnly, t => {
  const root = tmp(t), anchor = join(root, 'anchor'); mkdirSync(anchor);
  writeInside(anchor, 'note.txt', 'hello world', { maxBytes: 1000 });
  assert.equal(lstatSync(join(anchor, 'note.txt')).mode & 0o777, 0o600);
  assert.equal(readInside(anchor, 'note.txt', { encoding: 'utf8', maxBytes: 1000 }), 'hello world');
  writeInside(anchor, 'note.txt', 'hi', { maxBytes: 1000 }); // shorter: proves truncation, not a partial overwrite
  assert.equal(readInside(anchor, 'note.txt', { encoding: 'utf8', maxBytes: 1000 }), 'hi');
  const buf = readInside(anchor, 'note.txt', { maxBytes: 1000 });
  assert.ok(Buffer.isBuffer(buf) && buf.toString() === 'hi');
  unlinkInside(anchor, 'note.txt');
  assert.ok(!existsSync(join(anchor, 'note.txt')));
});

test('operations close every descriptor, including on failure paths', fdOnly, t => {
  const root = tmp(t), anchor = join(root, 'anchor'), outside = join(root, 'outside');
  mkdirSync(anchor); mkdirSync(outside);
  writeFileSync(join(anchor, 'f.txt'), 'data'); symlinkSync(join(root, 'nope'), join(anchor, 'dangling'));
  symlinkSync(outside, join(anchor, 'badcomp')); // a symlinked component so the fd chain fails partway
  const staging = join(root, 'staging'); mkdirSync(staging);
  safeFsMode(); // run the one-time probe before measuring
  const count = () => readdirSync('/proc/self/fd').length;
  const before = count();
  for (let i = 0; i < 50; i++) {
    try { readInside(anchor, 'f.txt', { encoding: 'utf8', maxBytes: 100 }); } catch { /* n/a */ }
    try { writeInside(anchor, `w${i}.txt`, 'x', { maxBytes: 100 }); } catch { /* n/a */ }
    try { listInside(anchor, '', { max: 100 }); } catch { /* n/a */ }
    try { statInside(anchor, 'f.txt'); } catch { /* n/a */ }
    try { readInside(anchor, 'dangling', { encoding: 'utf8', maxBytes: 100 }); } catch { /* ELOOP */ }
    try { readInside(anchor, 'missing', { encoding: 'utf8', maxBytes: 100 }); } catch { /* ENOENT */ }
    // rmrf of a real tree, a rename from staging, and two operations that fail on a symlinked component.
    mkdirSync(join(anchor, `tree${i}`, 'a'), { recursive: true }); writeFileSync(join(anchor, `tree${i}`, 'a', 'f'), 'x');
    try { rmrfInside(anchor, `tree${i}`, { maxEntries: 100, maxDepth: 10 }); } catch { /* n/a */ }
    writeFileSync(join(staging, String(i)), 'p');
    try { renameIntoInside(staging, String(i), anchor, `moved${i}.txt`); } catch { /* n/a */ }
    try { readInside(anchor, 'badcomp/secret', { encoding: 'utf8', maxBytes: 100 }); } catch { /* partial chain */ }
    try { rmrfInside(anchor, 'badcomp/x', { maxEntries: 10, maxDepth: 5 }); } catch { /* partial chain */ }
    try { unlinkInside(anchor, `w${i}.txt`); } catch { /* n/a */ }
  }
  const after = count();
  assert.ok(after <= before, `fd count grew from ${before} to ${after}`);
});

// ---- Error-to-status mapping ----
test('maps error codes to HTTP status', () => {
  assert.equal(safeFsErrorStatus('not-found'), 404);
  assert.equal(safeFsErrorStatus('conflict'), 409);
  assert.equal(safeFsErrorStatus('too-large'), 413);
  for (const code of ['symlink', 'invalid-path', 'not-regular', 'unsupported'] as const) assert.equal(safeFsErrorStatus(code), 400);
});

// ---- Default-off: a hook registered while the flag was on must not fire once it is off ----
test('hooks and the mode override are inert without the env flag', t => {
  const root = tmp(t), anchor = join(root, 'anchor'); mkdirSync(anchor); writeFileSync(join(anchor, 'f.txt'), 'data');
  // Register a would-be-destructive hook WITH the flag, then drop the flag before any operation.
  process.env.OPEN_HARNESS_SAFE_FS_TEST_HOOKS = '1';
  let fired = false;
  __setSafeFsHook('beforeTerminalOp', () => { fired = true; });
  delete process.env.OPEN_HARNESS_SAFE_FS_TEST_HOOKS;
  t.after(() => { process.env.OPEN_HARNESS_SAFE_FS_TEST_HOOKS = '1'; __setSafeFsHook('beforeTerminalOp', null); delete process.env.OPEN_HARNESS_SAFE_FS_TEST_HOOKS; delete process.env.OPEN_HARNESS_SAFE_FS_MODE; });
  assert.equal(readInside(anchor, 'f.txt', { encoding: 'utf8', maxBytes: 100 }), 'data'); // proves the hook path ran
  assert.equal(fired, false, 'the previously-registered hook stays dormant while the flag is off');
  // With the flag off, mutating the hook table is itself refused, and the mode override is ignored.
  assert.throws(() => __setSafeFsHook('beforeTerminalOp', () => { throw new Error('must never run'); }), isSafeFs('unsupported'));
  process.env.OPEN_HARNESS_SAFE_FS_MODE = 'path';
  if (!notLinux) assert.equal(safeFsMode(), 'fd-relative'); // override ignored while the flag is off
});

// ---- Forced path-fallback (exposed-to-race legacy behaviour), testable on Linux via the flag ----
test('forced path-fallback round trips and still refuses deleting a symlink', t => {
  process.env.OPEN_HARNESS_SAFE_FS_TEST_HOOKS = '1';
  process.env.OPEN_HARNESS_SAFE_FS_MODE = 'path';
  t.after(() => { delete process.env.OPEN_HARNESS_SAFE_FS_MODE; delete process.env.OPEN_HARNESS_SAFE_FS_TEST_HOOKS; });
  assert.equal(safeFsMode(), 'path-fallback');
  const root = tmp(t), anchor = join(root, 'anchor'), outside = join(root, 'outside'); mkdirSync(anchor); mkdirSync(outside);
  writeInside(anchor, 'n.txt', 'hello', { maxBytes: 100 });
  assert.equal(readInside(anchor, 'n.txt', { encoding: 'utf8', maxBytes: 100 }), 'hello');
  assert.deepEqual(listInside(anchor, '', { max: 100 }).map(e => e.name), ['n.txt']);
  unlinkInside(anchor, 'n.txt');
  assert.ok(!existsSync(join(anchor, 'n.txt')));
  writeFileSync(join(outside, 't.txt'), 'orig'); symlinkSync(join(outside, 't.txt'), join(anchor, 'link.txt'));
  assert.throws(() => unlinkInside(anchor, 'link.txt'), isSafeFs('symlink'));
  assert.ok(lstatSync(join(anchor, 'link.txt')).isSymbolicLink());
  assert.equal(readFileSync(join(outside, 't.txt'), 'utf8'), 'orig');
});

test('forced path-fallback rmrf refuses a tree holding a nested symlink', t => {
  process.env.OPEN_HARNESS_SAFE_FS_TEST_HOOKS = '1';
  process.env.OPEN_HARNESS_SAFE_FS_MODE = 'path';
  t.after(() => { delete process.env.OPEN_HARNESS_SAFE_FS_MODE; delete process.env.OPEN_HARNESS_SAFE_FS_TEST_HOOKS; });
  assert.equal(safeFsMode(), 'path-fallback');
  const root = tmp(t), anchor = join(root, 'anchor'), outside = join(root, 'outside');
  mkdirSync(join(anchor, 'tree', 'a'), { recursive: true }); mkdirSync(outside); writeFileSync(join(outside, 'target.txt'), 'orig');
  writeFileSync(join(anchor, 'tree', 'g.txt'), 'g'); symlinkSync(join(outside, 'target.txt'), join(anchor, 'tree', 'a', 'link.txt'));
  // The fallback walk refuses a nested link instead of rmSync-recursive deleting it.
  assert.throws(() => rmrfInside(anchor, 'tree', { maxEntries: 100, maxDepth: 10 }), isSafeFs('symlink'));
  assert.ok(lstatSync(join(anchor, 'tree', 'a', 'link.txt')).isSymbolicLink());
  assert.equal(readFileSync(join(outside, 'target.txt'), 'utf8'), 'orig');
});

test('path fallback refuses static parent and leaf links without touching their targets', t => {
  enableHooks(t); process.env.OPEN_HARNESS_SAFE_FS_MODE = 'path';
  t.after(() => { delete process.env.OPEN_HARNESS_SAFE_FS_MODE; });
  const { anchor, outside } = scene(t);
  symlinkSync(outside, join(anchor, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  symlinkSync(join(outside, 'leaf.txt'), join(anchor, 'leaf.txt'));
  for (const rel of ['linked/leaf.txt', 'leaf.txt']) {
    assert.throws(() => readInside(anchor, rel, { maxBytes: 100 }), isSafeFs('symlink'));
    assert.throws(() => writeInside(anchor, rel, 'overwrite', { maxBytes: 100 }), isSafeFs('symlink'));
  }
  outsideIntact(outside);
  assert.equal(statInside(anchor, 'leaf.txt')?.isSymbolicLink, true);
});

test('path fallback pre-scans removal limits and exclusive writes preserve existing content', t => {
  enableHooks(t); process.env.OPEN_HARNESS_SAFE_FS_MODE = 'path';
  t.after(() => { delete process.env.OPEN_HARNESS_SAFE_FS_MODE; });
  const root = tmp(t), anchor = join(root, 'anchor'); mkdirSync(join(anchor, 'tree'), { recursive: true });
  writeFileSync(join(anchor, 'tree', 'a'), 'a'); writeFileSync(join(anchor, 'tree', 'b'), 'b');
  assert.throws(() => rmrfInside(anchor, 'tree', { maxEntries: 1, maxDepth: 1 }), isSafeFs('too-large'));
  assert.deepEqual(readdirSync(join(anchor, 'tree')), ['a', 'b']);
  assert.throws(() => writeInside(anchor, 'tree/a', 'changed', { maxBytes: 100, exclusive: true }), isSafeFs('conflict'));
  assert.equal(readFileSync(join(anchor, 'tree', 'a'), 'utf8'), 'a');
});

test('path fallback refuses FIFO reads and writes without blocking', { skip: process.platform === 'win32' }, t => {
  const root = tmp(t), anchor = join(root, 'anchor'); mkdirSync(anchor);
  assert.equal(spawnSync('mkfifo', [join(anchor, 'pipe')]).status, 0);
  const script = `import { readInside, writeInside } from ${JSON.stringify(new URL('../runtime/safe-fs.ts', import.meta.url).href)}; import assert from 'node:assert/strict'; for (const action of [() => readInside(process.argv[1], 'pipe', {maxBytes:100}), () => writeInside(process.argv[1], 'pipe', 'x', {maxBytes:100})]) assert.throws(action, e => e.code === 'not-regular');`;
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script, anchor], { encoding: 'utf8', timeout: 10_000, env: { ...process.env, OPEN_HARNESS_SAFE_FS_TEST_HOOKS: '1', OPEN_HARNESS_SAFE_FS_MODE: 'path' } });
  assert.ifError(result.error); assert.equal(result.status, 0, result.stderr);
});
