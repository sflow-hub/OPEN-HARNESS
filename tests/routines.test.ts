import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../runtime/db';
import { nextCron, nextRoutine, normalizeRoutine, ROUTINES_PER_AGENT, saveRoutine, tickRoutines } from '../runtime/routines';

const now = new Date('2026-01-01T00:00:00Z');
const input = { agentId: 'atlas', name: 'Report', prompt: 'Write report', timezone: 'America/Denver', intervalMinutes: 60 };
function fixture() {
  const store = new Store(':memory:');
  store.upsertAgent({ id: 'atlas', name: 'Atlas', role: '', instructions: '' });
  return store.db;
}

test('routine validation is shared, bounded, finite, and checks agents and zones', () => {
  const db = fixture();
  try {
    for (const patch of [{ name: '' }, { name: null }, { name: {} }, { prompt: '  ' }, { prompt: 42 }, { agentId: 'missing' }, { intervalMinutes: NaN }, { intervalMinutes: Infinity }, { intervalMinutes: -Infinity }, { timezone: 'invalid/zone' }, { timezone: '+03:00' }, { scheduleKind: 'other' }, { scheduleKind: 'cron' }, { scheduleKind: 'cron', cronExpression: '60 * * * *' }]) {
      assert.throws(() => normalizeRoutine(db, { ...input, ...patch }));
    }
    assert.throws(() => normalizeRoutine(db, { agentId: 'atlas' }));
    assert.equal(normalizeRoutine(db, { ...input, intervalMinutes: -5 }).interval_minutes, 1);
    assert.equal(normalizeRoutine(db, { ...input, intervalMinutes: 9999999 }).interval_minutes, 525600);
    assert.equal(normalizeRoutine(db, { ...input, intervalMinutes: 1.6 }).interval_minutes, 2);
    assert.equal(normalizeRoutine(db, { ...input, name: 'x'.repeat(300), prompt: 'x'.repeat(21000) }).name.length, 200);
    assert.equal(normalizeRoutine(db, { ...input, prompt: 'x'.repeat(21000) }).prompt.length, 20000);
    assert.equal(normalizeRoutine(db, { ...input, timezone: 'bad' }, undefined, true).timezone, Intl.DateTimeFormat().resolvedOptions().timeZone);
    assert.equal(normalizeRoutine(db, input, undefined, true).timezone, 'America/Denver');
    const created = saveRoutine(db, input, now);
    assert.equal(created.nextRunAt, '2026-01-01T01:00:00.000Z');
    const updated = saveRoutine(db, { scheduleKind: 'cron', cronExpression: '0 9 * * *', timezone: 'Asia/Tokyo' }, now, created);
    assert.equal(updated.nextRunAt, '2026-01-02T00:00:00.000Z');
  } finally { db.close(); }
});

test('creation and agent reassignment enforce the cap, including internal creation', () => {
  const db = fixture();
  try {
    for (let index = 0; index < ROUTINES_PER_AGENT; index++) saveRoutine(db, input, now);
    assert.throws(() => saveRoutine(db, input, now), /at most 50/);
    assert.throws(() => saveRoutine(db, input, now, undefined, true), /at most 50/);
    db.prepare("INSERT INTO agents SELECT 'other',name,role,instructions,config_json,updated_at FROM agents WHERE id='atlas'").run();
    const other = saveRoutine(db, { ...input, agentId: 'other' }, now);
    assert.throws(() => saveRoutine(db, { agentId: 'atlas' }, now, other), /at most 50/);
    const first = db.prepare('SELECT * FROM schedules WHERE agent_id=? LIMIT 1').get('atlas') as typeof other;
    assert.doesNotThrow(() => saveRoutine(db, { name: 'Edited' }, now, first));
  } finally { db.close(); }
});

test('cron supports lists, ranges, steps, Sunday 7, and traditional day OR semantics', () => {
  const next = (cron: string, date: string) => nextCron(cron, 'Asia/Tokyo', new Date(date)).toISOString();
  assert.equal(next('*/15 9-10 * * *', '2026-01-01T00:00:00Z'), '2026-01-01T00:15:00.000Z');
  assert.equal(next('5,35 9 * * *', '2026-01-01T00:06:00Z'), '2026-01-01T00:35:00.000Z');
  assert.equal(next('0 9 * * 7', '2026-01-01T00:00:00Z'), '2026-01-04T00:00:00.000Z');
  assert.equal(next('0 9 2 * 1', '2026-01-01T00:00:00Z'), '2026-01-02T00:00:00.000Z');
  for (const cron of ['* * * *', '* * * * * *', '*/0 * * * *', '* 24 * * *', '* * 0 * *', '* * * 13 *', '* * * * 8', '1,,2 * * * *', '20-10 * * * *']) assert.throws(() => next(cron, now.toISOString()));
  assert.throws(() => next('0 0 31 2 *', now.toISOString()), /no occurrence/);
});

test('Denver spring-forward gaps run at the next valid instant once', () => {
  assert.equal(nextCron('30 2 * * *', 'America/Denver', new Date('2026-03-08T08:59:00Z')).toISOString(), '2026-03-08T09:00:00.000Z');
  assert.equal(nextCron('30 2 * * *', 'America/Denver', new Date('2026-03-08T09:00:00Z')).toISOString(), '2026-03-09T08:30:00.000Z');
  assert.equal(nextCron('0,30 2 * * *', 'America/Denver', new Date('2026-03-08T09:00:00Z')).toISOString(), '2026-03-09T08:00:00.000Z');
});

test('Denver fall-back folds choose only the first copy of a local slot', () => {
  assert.equal(nextCron('30 1 * * *', 'America/Denver', new Date('2026-11-01T06:00:00Z')).toISOString(), '2026-11-01T07:30:00.000Z');
  for (const time of ['2026-11-01T07:30:00Z', '2026-11-01T08:00:00Z', '2026-11-01T08:30:00Z']) {
    assert.equal(nextCron('30 1 * * *', 'America/Denver', new Date(time)).toISOString(), '2026-11-02T08:30:00.000Z');
  }
});

test('interval compatibility and run_once catch-up use the original due slot without bursts', () => {
  const db = fixture();
  try {
    const interval = saveRoutine(db, input, now);
    const cron = saveRoutine(db, { ...input, scheduleKind: 'cron', cronExpression: '0 9 * * *' }, now);
    const resumed = new Date('2026-01-10T17:00:00Z');
    let count = 0;
    const dispatch = () => ({ id: `run-${++count}` });
    tickRoutines(db, resumed, dispatch);
    tickRoutines(db, resumed, dispatch);
    assert.equal(count, 2);
    const history = db.prepare('SELECT * FROM schedule_runs ORDER BY schedule_id').all() as { schedule_id: string; scheduled_for: string }[];
    assert.equal(history.find(row => row.schedule_id === interval.id)?.scheduled_for, interval.next_run_at);
    assert.equal(history.find(row => row.schedule_id === cron.id)?.scheduled_for, cron.next_run_at);
    const rows = db.prepare('SELECT next_run_at,last_run_at FROM schedules').all() as { next_run_at: string; last_run_at: string }[];
    assert.ok(rows.every(row => row.next_run_at > resumed.toISOString() && row.last_run_at === resumed.toISOString()));
    assert.equal(nextRoutine(interval, resumed).toISOString(), '2026-01-10T18:00:00.000Z');
    // Simulate a persisted history row whose schedule advancement was interrupted.
    db.prepare('UPDATE schedules SET next_run_at=? WHERE id=?').run(interval.next_run_at, interval.id);
    tickRoutines(db, resumed, dispatch);
    assert.equal(count, 2);
    assert.equal((db.prepare('SELECT next_run_at FROM schedules WHERE id=?').get(interval.id) as { next_run_at: string }).next_run_at, '2026-01-10T18:00:00.000Z');
  } finally { db.close(); }
});

test('failed dispatch advances the next slot without changing last_run_at', () => {
  const db = fixture();
  try {
    const routine = saveRoutine(db, input, now);
    let failures = 0;
    tickRoutines(db, new Date(routine.next_run_at), () => { throw new Error('Queue full'); }, () => { failures++; });
    const row = db.prepare('SELECT * FROM schedules').get() as { last_run_at: string | null; next_run_at: string };
    assert.equal(failures, 1);
    assert.equal(row.last_run_at, null);
    assert.equal(row.next_run_at, '2026-01-01T02:00:00.000Z');
    assert.equal(db.prepare('SELECT * FROM schedule_runs').all().length, 0);
  } finally { db.close(); }
});

test('old schedules migrate additively and old rows still run', () => {
  const dir = mkdtempSync(join(tmpdir(), 'routine-migration-')), path = join(dir, 'state.db');
  const old = new DatabaseSync(path);
  old.exec(`CREATE TABLE schedules (id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, name TEXT NOT NULL, prompt TEXT NOT NULL, interval_minutes INTEGER NOT NULL, timezone TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1, next_run_at TEXT NOT NULL, last_run_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    INSERT INTO schedules VALUES('old','atlas','Report','Write report',60,'UTC',1,'2026-01-01T00:00:00.000Z',NULL,'2025-01-01','2025-01-01');`);
  old.close();
  const store = new Store(path);
  try {
    const row = store.db.prepare('SELECT * FROM schedules').get() as Record<string, unknown>;
    assert.equal(row.schedule_kind, 'interval'); assert.equal(row.cron_expression, null); assert.equal(row.misfire_policy, 'run_once');
    let count = 0;
    tickRoutines(store.db, now, () => ({ id: `run-${++count}` }));
    assert.equal(count, 1);
    assert.equal((store.db.prepare('SELECT next_run_at FROM schedules').get() as { next_run_at: string }).next_run_at, '2026-01-01T01:00:00.000Z');
  } finally { store.db.close(); rmSync(dir, { recursive: true, force: true }); }
});
