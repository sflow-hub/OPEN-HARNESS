# Symlink-safe agent-directory file access

Status: shipped on `main` (targets `0.4.0-beta.x`). Scope: how the coordinator reads, writes,
lists, and deletes inside an agent's managed directories without being redirected by a symlink
the agent planted or swaps in mid-operation. Module: `runtime/safe-fs.ts`; callers in
`runtime/service.ts` and `runtime/transfer-files.ts`.

All claims about current behavior cite `path:line` or a named function.

## Threat

Agent containers mount `private`, `profile`, and `shared` read-write (`runtime/hermes.ts`), so an
agent can plant a symlink and wait for the operator to drive a coordinator file endpoint through
it, or — while a request is in flight — rename a parent directory and drop a symlink in its place
(a TOCTOU parent-swap). A pathname-based check-then-use races that swap. The goal is that no
read, write, or delete the coordinator performs can reach outside the agent or shared directories,
and that a symlink is never followed.

## Anchors (the trust contract)

Every operation takes a trusted `anchor` (and, for transfer commits, a `stagingDir`). The anchor
**and all of its ancestors** must be coordinator-owned directories the agent cannot modify —
`${stateRoot}` and `${stateRoot}/agents/<id>`, which are never bind-mounted into a container. The
fd-relative core pins the anchor and the components below it, but the anchor's own path is
resolved by pathname, so a writable ancestor would reintroduce the race. This is a caller
contract the module cannot verify; the one thing it does enforce is that the anchor is absolute
and already normalized (`assertTrustedAnchor`, `runtime/safe-fs.ts`). The untrusted input is the
relative `rel`, rejected if it is absolute or contains NUL, `.`, `..`, empty, or `\`-escaped
components (`components`).

## Modes

`safeFsMode()` resolves one of three values, also surfaced to the dashboard as `fileSafety` on
`/v1/bootstrap`:

- **`fd-relative`** (Linux). A one-time capability probe (`probe`) fully exercises the primitives
  in a throwaway directory — including a held-fd parent swap and a symlink rejection — and caches
  the result. Each operation opens the anchor with `O_RDONLY | O_DIRECTORY | O_NOFOLLOW`, then
  opens each component through the previously held fd via `/proc/self/fd/<dirfd>/<name>`, which is
  openat-relative to the held inode and survives a rename/symlink swap of that directory. Leaf
  reads and writes use `O_NOFOLLOW` (ELOOP on a symlink) and `O_NONBLOCK` (so a FIFO never blocks;
  ENXIO on a reader-less FIFO write).
- **`path-fallback`** (non-Linux; also selectable by the explicitly enabled test override). Lexical containment
  only (`containedPath`): follows symlinks exactly like the legacy code and stays exposed to the
  parent-swap race. The sole hardening carried over is refusing to delete a symlink.
- **`unsupported`**. A Linux host whose probe failed. `requireMode` throws, and the HTTP layer
  maps the resulting `SafeFsError` to **400** (`safeFsErrorStatus`), so file operations fail
  closed rather than returning a 5xx or silently degrading.

## Operations and callers

Public API: `readInside`, `writeInside`, `unlinkInside`, `listInside`, `mkdirInside`,
`rmrfInside`, `statInside`, `renameIntoInside`. Callers:

- `/v1/files` — read, list, write, delete of `private`/`shared` scopes (`runtime/service.ts`,
  `listFiles`/`workspaceDir`).
- Skill endpoints — `GET`/`PUT`/`DELETE` of `profile/skills/<skill>`; `DELETE` is a recursive
  `rmrfInside`.
- Context endpoints — `MEMORY.md`/`USER.md` reads and the `MEMORY.md` write, plus the skills
  listing (`readContextFile`).
- `/v1/migrate` — profile `MEMORY.md` and shared-file writes.
- Transfers — `exportAgentFiles` walks the allowed roots with `statInside`/`listInside`/
  `readInside`; `importAgentFiles` stages bundle files privately, then commits each with
  `renameIntoInside` into the held destination parent (`runtime/transfer-files.ts`).

Behaviors worth stating: a `DELETE` of a symlink is refused, not followed — though that refusal is
a check-then-unlink on Linux too, for both a single-file `DELETE` and the recursive delete, so a
concurrent replacement between the `lstat` and the `unlink` can remove the replacement name (for
example a just-planted link itself) through the held parent directory, never its outside target;
hard links are allowed
(a hard link is another name for the same inode, read and written as an ordinary file, not a
traversal); listings skip symlinked entries rather than stat through them. The recursive Linux
delete runs a read-only `scanTree` pass that refuses a tree containing any symlink before deleting
a byte, then a post-order `removeTree` pass that re-`lstat`s each child and re-checks directory
identity (dev/ino) before `rmdir`.

## Test hooks

Deterministic race tests need to land a swap at an exact phase. `__setSafeFsHook` installs a
callback for one of five phases (`afterComponentOpen`, `beforeTerminalOp`,
`duringRecursiveDescent`, `betweenReaddirAndLstat`, `beforeRenameCommit`). The hooks are inert and
refuse to register unless `OPEN_HARNESS_SAFE_FS_TEST_HOOKS=1`; the flag is off by default, and
`safeFsMode`'s override (`OPEN_HARNESS_SAFE_FS_MODE`) is likewise ignored without it. Coverage:
`tests/safe-fs.test.ts` (unit, including forced path-fallback), `tests/file-safety.test.ts`
(HTTP, hook-driven and external-process parent swaps), `tests/transfer-files.test.ts`.

## Limitations and pending validation

- **Fallback is unprotected.** `path-fallback` keeps the pathname race; its recursive delete has
  no pre-scan (earlier files are removed before a nested symlink stops it), and its writes can
  hang on a planted FIFO.
- **Residual window in the Linux delete.** Between a child's `lstat` and its `unlink` through the
  held parent, a swap can at most unlink a different entry *inside the held directory* (as a link,
  not followed), never one outside it.
- **Transfer imports are not atomic.** Per-file commits; a later failure leaves earlier files in
  place and the error reports how many of N committed. A filename with a `\` fails the whole
  export rather than skipping that file.
- **Pre-existing gaps.** Skill and `MEMORY.md`/`USER.md` reads are not byte-capped; a large file
  is read whole into memory. File listing reads the entire directory and re-`stat`s each entry
  before trimming to 200. A first concurrent use of a scope can return `409` (`ensureFileDir` is a
  non-atomic stat-then-mkdir). Synchronous filesystem work runs on the event loop. Linux recursive
  deletion and transfer export enforce entry/depth limits, but fallback recursive deletion does
  not; listings read the whole directory before trimming results. Entry/depth checks also do not
  bound the initial whole-directory allocation by `readdirSync`.
- **Unverified.** Not exercised on Node 22.13 (the `engines` minimum; the suite ran on Node 24) or
  inside the coordinator container. Real-Docker validation, a transfer over a real paired runner,
  and the macOS/Windows fallback are pending (no VM approved).

See [`SECURITY.md`](../../SECURITY.md) for the operator-facing summary.
