import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test, { type TestContext } from 'node:test';
import { LocalImprovements } from '../runtime/local-improvements';

function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'local-improvements-')), source = join(root, 'source'), state = join(root, 'state');
  mkdirSync(join(source, 'app'), { recursive: true }); mkdirSync(state);
  writeFileSync(join(source, 'app/page.tsx'), 'current title\nuntouched draft\n');
  writeFileSync(join(source, 'app/globals.css'), 'body {}\n');
  writeFileSync(join(source, '.env'), 'operator-secret');
  writeFileSync(join(source, 'open-harness-source.json'), JSON.stringify({ files: ['app/page.tsx', 'app/globals.css'] }));
  const db = new DatabaseSync(join(state, 'test.db')), store = new LocalImprovements(db, state, source);
  t.after(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
  function request() { const id = randomUUID(), { agentPath } = store.create(id, 'atlas'); return { id, candidate: join(state, 'agents/atlas/private', basename(agentPath)) }; }
  return { root, state, source, store, request, db };
}

test('an extracted source archive supports a frozen diff, activation, restart and undo while retaining original edits', t => {
  const { source, state, store, request, db } = fixture(t), a = request();
  assert.equal(existsSync(join(a.candidate,'.env')), false);
  const initial = store.activePath();
  assert.notEqual(statSync(join(initial, 'app/page.tsx')).ino, statSync(join(a.candidate, 'app/page.tsx')).ino);
  writeFileSync(join(a.candidate, 'app/page.tsx'), 'revised title\nuntouched draft\n');
  const review = store.freeze(a.id);
  assert.deepEqual(review.changes.map(v => [v.path,v.kind]), [['app/page.tsx','modified']]);
  assert.match(review.changes[0].diff, /-current title\n\+revised title/);
  writeFileSync(join(a.candidate, 'app/page.tsx'), 'edited after freeze');
  assert.equal(store.freeze(a.id).changes[0].diff, review.changes[0].diff);
  store.apply(a.id); assert.equal(store.activeRevision(), a.id);
  const reopened = new LocalImprovements(db, state, source);
  assert.equal(readFileSync(join(reopened.activePath(),'app/page.tsx'),'utf8'), 'revised title\nuntouched draft\n');
  assert.equal(readFileSync(join(source,'app/page.tsx'),'utf8'), 'current title\nuntouched draft\n');
  assert.equal(reopened.apply(a.id).state, 'applied');
  assert.equal(reopened.undo(a.id).state, 'undone'); assert.equal(reopened.undo(a.id).state, 'undone');
  assert.equal(reopened.activeRevision(), null); assert.equal(reopened.activePath(), initial);
});

test('stale reviews are refused, and undo follows the active history', t => {
  const { store, request } = fixture(t), a = request(), b = request();
  for (const change of [a,b]) { writeFileSync(join(change.candidate, 'app/page.tsx'), change.id); store.freeze(change.id); }
  store.apply(a.id);
  assert.throws(() => store.apply(b.id), /changed since this request/);
  const c = request(); writeFileSync(join(c.candidate, 'app/globals.css'), 'p {}'); store.freeze(c.id); store.apply(c.id);
  assert.throws(() => store.undo(a.id), /most recent/); assert.equal(store.activeRevision(), c.id);
  store.undo(c.id); assert.equal(store.activeRevision(), a.id); store.undo(a.id);
});

test('rejected links and out-of-scope paths never appear as deletions and can be corrected and retried', t => {
  const { source, store, request } = fixture(t), a = request(), original = join(a.candidate, 'app/page.tsx');
  rmSync(original); symlinkSync(join(source,'.env'), original);
  assert.throws(() => store.freeze(a.id), /ordinary files/); assert.equal(store.get(a.id).state, 'editing');
  rmSync(original); linkSync(join(source,'.env'), original);
  assert.throws(() => store.freeze(a.id), /ordinary files/);
  rmSync(original); writeFileSync(original, 'corrected'); writeFileSync(join(a.candidate,'.env'), 'private');
  assert.throws(() => store.freeze(a.id), /outside the editable/);
  rmSync(join(a.candidate,'.env')); rmSync(join(a.candidate,'app/globals.css')); mkdirSync(join(a.candidate,'components')); writeFileSync(join(a.candidate,'components/title.tsx'),'export default "Hi";');
  assert.deepEqual(store.freeze(a.id).changes.map(c => c.kind), ['deleted','modified','added']);
});

test('refuses empty or externally changed revisions while preserving the active source', t => {
  const { store, request } = fixture(t), a = request(); store.freeze(a.id);
  assert.throws(() => store.apply(a.id), /did not change/);
  const b = request(); writeFileSync(join(b.candidate,'app/page.tsx'),'a change'); store.freeze(b.id);
  writeFileSync(join(store.activePath(), 'app/globals.css'), 'new operator change');
  assert.throws(() => store.apply(b.id), /outside this request/); assert.equal(store.activeRevision(), null);
  assert.equal(readFileSync(join(store.activePath(), 'app/globals.css'), 'utf8'), 'new operator change');
});

test('rejects an archive manifest that names private data or nonportable paths', t => {
  const { source, store, request } = fixture(t);
  for (const path of ['.env', '.git/config', '../app/secrets.ts', 'components/node_modules/x.ts', 'lib/.env.ts', 'app/Page.tsx']) {
    writeFileSync(join(source, 'open-harness-source.json'), JSON.stringify({ files: ['app/page.tsx', path] }));
    assert.throws(request); assert.deepEqual(store.list(), []);
  }
});

test('a different installed dashboard retires the active override and all old previews, including after a downgrade', t => {
  const { source, state, store, request, db } = fixture(t), a = request(), b = request();
  for (const proposal of [a,b]) { writeFileSync(join(proposal.candidate,'app/page.tsx'), proposal.id); store.freeze(proposal.id); }
  store.apply(a.id);
  writeFileSync(join(source,'app/page.tsx'), 'new distribution');
  const upgraded = new LocalImprovements(db,state,source);
  assert.equal(upgraded.activeRevision(), null);
  assert.equal(readFileSync(join(upgraded.activePath(),'app/page.tsx'),'utf8'), 'new distribution');
  assert.throws(() => upgraded.apply(a.id), /installed dashboard source changed/);
  assert.throws(() => upgraded.apply(b.id), /installed dashboard source changed/);
  assert.equal(upgraded.list().length, 2);
  writeFileSync(join(source,'app/page.tsx'), 'current title\nuntouched draft\n');
  assert.throws(() => new LocalImprovements(db,state,source).apply(b.id), /installed dashboard source changed/);
});

test('a restore repairs a missing seed and retains the nearest fully undoable revision', t => {
  const { source, state, store, request, db } = fixture(t), seed = store.activePath(), a = request();
  writeFileSync(join(a.candidate,'app/page.tsx'), a.id); store.freeze(a.id); store.apply(a.id);
  const b = request(); writeFileSync(join(b.candidate,'app/page.tsx'), b.id); store.freeze(b.id); store.apply(b.id);
  rmSync(store.activePath(), { recursive: true }); rmSync(seed, {recursive:true});
  const restored = new LocalImprovements(db,state,source);
  assert.equal(restored.activeRevision(), a.id);
  assert.equal(readFileSync(join(restored.activePath(),'app/page.tsx'),'utf8'), a.id);
  assert.throws(() => restored.apply(b.id), /different local dashboard/);
  restored.undo(a.id); assert.equal(restored.activeRevision(), null);
  assert.equal(readFileSync(join(restored.activePath(),'app/page.tsx'),'utf8'), 'current title\nuntouched draft\n');
});

test('the ordinary dashboard does not need installed sources on a fresh or restored machine', t => {
  const { source, state, store, request, db } = fixture(t);
  const broken = new LocalImprovements(db,state,join(source,'absent'));
  assert.equal(broken.activeRevision(), null); assert.deepEqual(broken.list(), []);
  const a = request(); writeFileSync(join(a.candidate,'app/page.tsx'), a.id); store.freeze(a.id); store.apply(a.id);
  assert.equal(broken.activeRevision(), null);
  assert.throws(()=>broken.apply(a.id), /matching Open Harness source package/);
});

test('a failed enclosing request cannot restore an old active override behind the startup check', t => {
  const { source, state, store, request, db } = fixture(t), a = request();
  writeFileSync(join(a.candidate, 'app/page.tsx'), 'old edition'); store.freeze(a.id); store.apply(a.id);
  writeFileSync(join(source, 'app/page.tsx'), 'new edition');
  const upgraded = new LocalImprovements(db,state,source);
  db.exec('SAVEPOINT user_request'); upgraded.create(randomUUID(), 'atlas'); db.exec('ROLLBACK TO user_request; RELEASE user_request');
  assert.equal(upgraded.activeRevision(), null);
  assert.throws(() => upgraded.apply(a.id), /installed dashboard source changed/);
});
