import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { editableSource } from './capture-local-source.mjs';
import { safeWorkspacePath } from './path-safety';
import { ProductError } from './product-error';
import { renameIntoInside } from './safe-fs';

type Change = { path: string; kind: 'added' | 'modified' | 'deleted'; diff: string };
export type Improvement = { id: string; agentId: string; state: 'editing' | 'review' | 'applied' | 'undone'; changes: Change[]; createdAt: string; updatedAt: string };
type RecordRow = { generation: string; id: string; agent: string; candidate: string; state: Improvement['state']; base: string | null; frozen: string | null; digest: string | null; changes: string; created: string; updated: string };
type SourceState = { generation: string; seed: string; digest: string; active: string | null };
const utf8 = new TextDecoder('utf8', { fatal: true, ignoreBOM: true });
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const fileLimit = 8 * 1024 * 1024, treeLimit = 64 * 1024 * 1024;
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const conflict = (message: string) => new ProductError(message, 409);

function readTree(root: string) {
  if (!lstatSync(root, { throwIfNoEntry: false })?.isDirectory()) throw conflict('This saved dashboard source is unavailable on this installation.');
  const files = new Map<string, Buffer>(); let total = 0;
  function walk(dir: string) {
    for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
      const path = dir ? `${dir}/${entry.name}` : entry.name;
      if (!editableSource(path, entry.isDirectory())) throw conflict(`Unexpected file in the local source: ${path}.`);
      if (entry.isDirectory()) { walk(path); continue; }
      const target = join(root, path), stat = lstatSync(target);
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > fileLimit || (total += stat.size) > treeLimit || files.size >= 12000) throw conflict('The local source contains a link, special file, or too much data.');
      const bytes = readFileSync(target); try { utf8.decode(bytes); } catch { throw conflict(`Use UTF-8 source text for ${path}.`); }
      if (bytes.includes(0)) throw conflict(`Binary changes are not supported for ${path}.`);
      files.set(path, bytes);
    }
  }
  walk(''); return files;
}
function treeDigest(files: Map<string, Buffer>) {
  const fingerprint = createHash('sha256');
  for (const path of [...files.keys()].sort()) fingerprint.update(path).update('\0').update(hash(files.get(path)!)).update('\n');
  return fingerprint.digest('hex');
}

// Include every changed line, grouping nearby edits with their context. A bounded lookahead
// keeps large repeated-line inputs linear in size. A distant match falls back to replacement.
function textDiff(path: string, before?: Buffer, after?: Buffer) {
  const lines = (data?: Buffer) => data?.toString('utf8').match(/[^\n]*\n|[^\n]+$/g) || [];
  let lineCount = 0;
  for (const data of [before, after]) if (data) for (const byte of data) if (byte === 10 && ++lineCount > 40000) throw new ProductError('Split this change into smaller files so its diff can be reviewed.', 413);
  const old = lines(before), next = lines(after), rows: { sign: string; line: string; a: number; b: number }[] = [];
  let a = 0, b = 0;
  const emit = (sign: string) => { rows.push({ sign, line: sign === '+' ? next[b] : old[a], a, b }); if (sign !== '+') a++; if (sign !== '-') b++; };
  while (a < old.length || b < next.length) {
    if (a < old.length && b < next.length && old[a] === next[b]) { emit(' '); continue; }
    let distance = 1;
    for (; distance <= 16; distance++) {
      if (a + distance < old.length && b < next.length && old[a + distance] === next[b]) { for (let n = 0; n < distance; n++) emit('-'); break; }
      if (b + distance < next.length && a < old.length && next[b + distance] === old[a]) { for (let n = 0; n < distance; n++) emit('+'); break; }
    }
    if (distance > 16) { if (a < old.length) emit('-'); if (b < next.length) emit('+'); }
  }
  const groups: [number, number][] = [];
  for (let i = 0; i < rows.length; i++) if (rows[i].sign !== ' ') {
    const start = Math.max(0, i - 3), end = Math.min(rows.length, i + 4), last = groups.at(-1);
    if (last && start <= last[1]) last[1] = end; else groups.push([start, end]);
  }
  const out = [`--- ${before ? 'a/' + path : '/dev/null'}\n+++ ${after ? 'b/' + path : '/dev/null'}\n`];
  for (const [start, end] of groups) {
    const group = rows.slice(start, end), source = group.filter(r => r.sign !== '+').length, target = group.filter(r => r.sign !== '-').length;
    out.push(`@@ -${group[0].a + (source ? 1 : 0)},${source} +${group[0].b + (target ? 1 : 0)},${target} @@\n`);
    for (const row of group) out.push(row.sign, row.line, row.line.endsWith('\n') ? '' : '\n\\ No newline at end of file\n');
  }
  return out.join('');
}
function compare(base: Map<string, Buffer>, next: Map<string, Buffer>) {
  const changes: Change[] = []; let size = 0;
  for (const path of [...new Set([...base.keys(), ...next.keys()])].sort()) {
    const before = base.get(path), after = next.get(path);
    if (before && after && before.equals(after)) continue;
    if ((before?.length || 0) + (after?.length || 0) > 2 * 1024 * 1024) throw new ProductError('Change a smaller source file so the whole change can be reviewed.', 413);
    const diff = textDiff(path, before, after); size += Buffer.byteLength(diff);
    if (size > 512 * 1024 || changes.length >= 100) throw new ProductError('This change is too large to review in one request. Ask for a smaller change.', 413);
    changes.push({ path, kind: !before ? 'added' : !after ? 'deleted' : 'modified', diff });
  }
  return changes;
}

export class LocalImprovements {
  private readonly versions: string;
  private readonly root: string;
  private readonly source: string;
  private checkedInstallation = '';
  private retryInstallationAt = 0;
  constructor(private db: DatabaseSync, stateRoot: string, sourceRoot: string) {
    this.root = resolve(stateRoot); this.source = resolve(sourceRoot); this.versions = join(this.root, 'local-improvements', 'versions');
    db.exec(`CREATE TABLE IF NOT EXISTS local_source_state(singleton INTEGER PRIMARY KEY CHECK(singleton=1),seed TEXT NOT NULL,digest TEXT NOT NULL,active TEXT);
      CREATE TABLE IF NOT EXISTS local_source_improvements(id TEXT PRIMARY KEY,agent TEXT NOT NULL,candidate TEXT NOT NULL,state TEXT NOT NULL,base TEXT,frozen TEXT,digest TEXT,changes TEXT NOT NULL,created TEXT NOT NULL,updated TEXT NOT NULL);`);
    for (const table of ['local_source_state','local_source_improvements']) if (!db.prepare(`PRAGMA table_info(${table})`).all().some(column => column.name === 'generation')) db.exec(`ALTER TABLE ${table} ADD COLUMN generation TEXT NOT NULL DEFAULT ''`);
    db.exec("UPDATE local_source_state SET generation=hex(randomblob(16)) WHERE generation=''; UPDATE local_source_improvements SET generation=COALESCE((SELECT generation FROM local_source_state WHERE singleton=1),'') WHERE generation=''");
  }
  private state() { return this.db.prepare('SELECT seed,digest,active,generation FROM local_source_state WHERE singleton=1').get() as SourceState | undefined; }
  private row(id: string) {
    const row = this.db.prepare('SELECT * FROM local_source_improvements WHERE id=?').get(id) as RecordRow | undefined;
    if (!row) throw new ProductError('This local improvement could not be found.', 404);
    return row;
  }
  private info(row: RecordRow): Improvement { return { id: row.id, agentId: row.agent, state: row.state, changes: JSON.parse(row.changes), createdAt: row.created, updatedAt: row.updated }; }
  get(id: string) { return this.info(this.row(id)); }
  list() { return (this.db.prepare('SELECT * FROM local_source_improvements ORDER BY created DESC,rowid DESC').all() as RecordRow[]).map(row => this.info(row)); }
  private stateKey(state: SourceState) { return JSON.stringify([state.generation, state.seed, state.active]); }
  activeRevision() {
    const prior = this.state();
    if (!prior?.active || this.stateKey(prior) === this.checkedInstallation) return prior?.active ?? null;
    if (Date.now() < this.retryInstallationAt) return null;
    try { return this.seed().active; }
    catch { this.retryInstallationAt = Date.now() + 30000; return null; }
  }
  private stage() { mkdirSync(this.versions, { recursive: true, mode: 0o700 }); return mkdtempSync(join(this.versions, 'source-')); }
  private distribution() {
    const manifest = join(this.source, 'open-harness-source.json'); let paths: unknown;
    if (existsSync(manifest)) paths = JSON.parse(readFileSync(manifest, 'utf8')).files;
    else {
      if (!existsSync(join(this.source,'.git'))) throw conflict('Install the matching Open Harness source package to start a local improvement.');
      const result = spawnSync('git', ['ls-files', '-z', '--', 'app/page.tsx', 'app/globals.css', 'components', 'lib'], { cwd: this.source, encoding: 'utf8', timeout: 10000 });
      if (result.status !== 0) throw conflict('The local dashboard source could not be discovered. Use the matching source package.');
      paths = result.stdout.split('\0').filter(Boolean).filter(path => editableSource(path));
    }
    if (!Array.isArray(paths) || !paths.includes('app/page.tsx') || paths.length > 12000) throw conflict('The dashboard source manifest is missing or incomplete.');
    const files = new Map<string, Buffer>(), seen = new Set<string>(); let total = 0;
    for (const path of paths) {
      if (typeof path !== 'string' || !editableSource(path) || seen.has(path.toLowerCase())) throw conflict('The dashboard source manifest contains an unexpected or duplicate path.');
      seen.add(path.toLowerCase()); const input = safeWorkspacePath(this.source, path), st = lstatSync(input);
      if (!st.isFile() || st.nlink !== 1 || st.size > fileLimit || (total += st.size) > treeLimit) throw conflict('The dashboard source must contain only ordinary source files.');
      files.set(path, readFileSync(input));
    }
    return files;
  }
  private recoverActive(state: SourceState) {
    const chain: RecordRow[] = [], seen = new Set<string>(); let id = state.active;
    while (id) {
      if (seen.has(id)) return null;
      seen.add(id); const row = this.db.prepare('SELECT * FROM local_source_improvements WHERE id=?').get(id) as RecordRow | undefined;
      if (!row || row.generation !== state.generation || row.state !== 'applied') return null;
      chain.push(row); id = row.base;
    }
    let last: string | null = null;
    for (const row of chain.reverse()) {
      if (!row.frozen || !/^source-[a-zA-Z0-9]{6}$/.test(row.frozen)) break;
      try { if (treeDigest(readTree(join(this.versions, row.frozen))) !== row.digest) break; }
      catch { break; }
      last = row.id;
    }
    return last;
  }
  private seed() {
    const prior = this.state(); if (prior && this.stateKey(prior) === this.checkedInstallation) return prior;
    const files = this.distribution(), digest = treeDigest(files), same = prior?.digest === digest;
    const generation = same ? prior.generation : randomUUID();
    let seed = same && /^source-[a-zA-Z0-9]{6}$/.test(prior.seed) ? prior.seed : null;
    let staged: string | null = null;
    try {
      if (!seed || !lstatSync(join(this.versions, seed), { throwIfNoEntry: false })?.isDirectory()) {
        staged = this.stage();
        for (const [path, data] of files) {
          const output = join(staged, path); mkdirSync(dirname(output), { recursive: true, mode: 0o700 }); writeFileSync(output, data, { flag: 'wx', mode: 0o600 });
        }
        seed = staged.slice(this.versions.length + 1);
      }
      // A restored database can outlive some version directories. Keep only the chain
      // whose snapshots are present and can be undone all the way back to this release.
      const active = same ? this.recoverActive(prior) : null;
      this.db.prepare(`INSERT INTO local_source_state(singleton,seed,digest,active,generation) VALUES(1,?,?,?,?)
        ON CONFLICT(singleton) DO UPDATE SET seed=excluded.seed,digest=excluded.digest,active=excluded.active,generation=excluded.generation`).run(seed,digest,active,generation);
      const checked = { seed, digest, active, generation };
      this.checkedInstallation = this.stateKey(checked); this.retryInstallationAt = 0;
      return checked;
    } catch (error) { if (staged) rmSync(staged, { recursive: true, force: true }); throw error; }
  }
  private requireGeneration(row: RecordRow, state: SourceState) {
    if (row.generation !== state.generation) throw conflict('The installed dashboard source changed. Start a new improvement for this version.');
  }
  private version(id: string | null) {
    const state = this.seed(), row = id && this.row(id);
    const folder = row ? row.frozen : state.seed, digest = row ? row.digest : state.digest;
    if (!folder || !digest) throw conflict('Finish reviewing this improvement first.');
    if (!/^source-[a-zA-Z0-9]{6}$/.test(folder) || !/^[0-9a-f]{64}$/.test(digest)) throw conflict('This saved dashboard revision is invalid.');
    if (row) this.requireGeneration(row, state);
    const path = join(this.versions, folder);
    if (!lstatSync(path, {throwIfNoEntry:false})?.isDirectory()) throw conflict('This saved source is unavailable on this installation. Start a new improvement.');
    return { path, digest };
  }
  private verified(id: string | null) {
    const version = this.version(id), files = readTree(version.path);
    if (treeDigest(files) !== version.digest) throw conflict('The saved source changed outside this request. Your files have been preserved.');
    return files;
  }
  activePath() { const state = this.seed(); return this.version(state.active).path; }
  basePath(id: string) { const row = this.row(id); this.requireGeneration(row, this.seed()); return this.version(row.base).path; }
  previewPath(id: string) { const row = this.row(id); if (!row.frozen) throw conflict('Review the agent’s changes before opening a preview.'); return this.version(id).path; }
  create(id: string, agentId: string) {
    if (!uuid.test(id) || !/^[A-Za-z0-9_-]{1,100}$/.test(agentId)) throw new ProductError('Choose a valid improvement and agent.');
    const existing = this.db.prepare('SELECT agent,candidate FROM local_source_improvements WHERE id=?').get(id);
    if (existing) {
      if (existing.agent !== agentId) throw conflict('This improvement already belongs to another agent.');
      return { id, agentPath: `/workspace/private/${existing.candidate}` };
    }
    const state = this.seed(), base = state.active; this.verified(base);
    const agentRoot = safeWorkspacePath(this.root, `agents/${agentId}`);
    mkdirSync(safeWorkspacePath(agentRoot,'private'), { recursive: true, mode: 0o700 });
    // A process can stop after publishing the directory and before recording it in SQLite.
    // A retry always stages a distinct candidate; it never overwrites that previous directory.
    const name = `improvement-${id}-${randomUUID()}`, agentPath = `/workspace/private/${name}`;
    const staging = this.stage();
    try {
      cpSync(this.version(base).path, staging, { recursive: true });
      renameIntoInside(this.versions, staging.slice(this.versions.length + 1), agentRoot, `private/${name}`);
      const stamp = new Date().toISOString();
      this.db.prepare("INSERT INTO local_source_improvements(id,agent,candidate,state,base,frozen,digest,changes,created,updated,generation) VALUES(?,?,?,'editing',?,NULL,NULL,'[]',?,?,?)").run(id, agentId, name, base, stamp, stamp, state.generation);
    } finally { rmSync(staging, { force: true, recursive: true }); }
    return { id, agentPath };
  }
  freeze(id: string) {
    const row = this.row(id); this.requireGeneration(row, this.seed()); if (row.state !== 'editing') return this.info(row);
    if (!uuid.test(row.id) || !row.candidate.startsWith(`improvement-${row.id}-`) || !uuid.test(row.candidate.slice(`improvement-${row.id}-`.length))) throw conflict('This saved candidate is invalid.');
    const base = this.verified(row.base), target = this.stage();
    try {
      const child = spawnSync(process.execPath, [join(import.meta.dirname, 'capture-local-source.mjs'), row.candidate, target], { cwd: safeWorkspacePath(this.root, `agents/${row.agent}`), env: { NODE_ENV: 'production' }, encoding: 'utf8', timeout: 30000, maxBuffer: 8192 });
      if (child.status !== 0) throw conflict(child.stderr?.trim() || 'The proposed source could not be captured. Try again.');
      const files = readTree(target), changes = compare(base, files), stamp = new Date().toISOString();
      const saved = this.db.prepare("UPDATE local_source_improvements SET frozen=?,digest=?,changes=?,updated=?,state='review' WHERE id=? AND state='editing'").run(target.slice(this.versions.length + 1), treeDigest(files), JSON.stringify(changes), stamp, id);
      if (!saved.changes) throw conflict('This proposal was reviewed elsewhere. Open it again.');
    } catch (error) { rmSync(target, { recursive: true, force: true }); throw error; }
    return this.get(id);
  }
  apply(id: string) { return this.activate(id, false); }
  undo(id: string) { return this.activate(id, true); }
  private activate(id: string, undo: boolean) {
    const installation = this.seed();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.row(id), state = this.state()!, desired = undo ? 'undone' : 'applied';
      this.requireGeneration(row, installation);
      if (!undo && row.state === 'applied' && state.active !== id) throw conflict('A different local dashboard is active. Start a new improvement from it.');
      if (row.state !== desired) {
        if (undo ? row.state !== 'applied' || state.active !== id : row.state !== 'review' || state.active !== row.base) throw conflict(undo ? 'Undo the most recent local improvement first.' : 'The local dashboard has changed since this request. Start a new improvement to review it against the current version.');
        if (row.changes === '[]') throw conflict('The agent did not change any dashboard source files.');
        this.verified(row.base); this.verified(id);
        this.db.prepare('UPDATE local_source_state SET active=? WHERE singleton=1').run(undo ? row.base : id);
        this.db.prepare('UPDATE local_source_improvements SET state=?,updated=? WHERE id=?').run(desired, new Date().toISOString(), id);
      }
      this.db.exec('COMMIT');
      this.checkedInstallation = this.stateKey(this.state()!);
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return this.get(id);
  }
}
