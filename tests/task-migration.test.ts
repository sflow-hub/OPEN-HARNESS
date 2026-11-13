import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SCHEMA_VERSION, SchemaTooNewError, Store } from "../runtime/db";
import { TaskStore } from "../runtime/tasks";
import { Profiles } from "../runtime/profiles";
import { saveRoutine } from "../runtime/routines";

test("adds team scope before indexing an existing tasks table", () => {
  const store = new Store(":memory:");
  store.db.exec(`
    CREATE TABLE task_boards (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0,
      revision INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE task_stages (
      id TEXT PRIMARY KEY, board_id TEXT NOT NULL, name TEXT NOT NULL, category TEXT NOT NULL,
      position REAL NOT NULL
    );
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY, board_id TEXT NOT NULL, stage_id TEXT NOT NULL, title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '', owner_agent_id TEXT, priority TEXT NOT NULL DEFAULT 'normal',
      due_at TEXT, position REAL NOT NULL, archived INTEGER NOT NULL DEFAULT 0,
      revision INTEGER NOT NULL DEFAULT 1, active_run_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
  `);

  assert.doesNotThrow(() => new TaskStore(store.db));
  const columns = store.db.prepare("PRAGMA table_info(tasks)").all() as Array<{ name: string }>;
  const indexes = store.db.prepare("PRAGMA index_list(tasks)").all() as Array<{ name: string }>;
  assert.ok(columns.some(column => column.name === "team_id"));
  assert.ok(indexes.some(index => index.name === "idx_tasks_team_archived"));
});

test("stamps the schema version, upgrades a 0.3.0 file in place, and refuses a newer one", () => {
  const file = join(mkdtempSync(join(tmpdir(), "harness-schema-")), "state.db");

  // A 0.3.0 data folder: the tables of that release, no user_version, and real rows to
  // notice losing. Board settings, run output, comment authors and team scope came later.
  const legacy = new DatabaseSync(file);
  legacy.exec(`
    CREATE TABLE task_boards (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0,
      revision INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE task_stages (
      id TEXT PRIMARY KEY, board_id TEXT NOT NULL, name TEXT NOT NULL, category TEXT NOT NULL, position REAL NOT NULL
    );
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY, board_id TEXT NOT NULL, stage_id TEXT NOT NULL, title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '', owner_agent_id TEXT, priority TEXT NOT NULL DEFAULT 'normal',
      due_at TEXT, position REAL NOT NULL, archived INTEGER NOT NULL DEFAULT 0,
      revision INTEGER NOT NULL DEFAULT 1, active_run_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    INSERT INTO task_boards VALUES('board-1','Delivery',0,1,'2026-09-01T00:00:00.000Z','2026-09-01T00:00:00.000Z');
    INSERT INTO task_stages VALUES('stage-1','board-1','Doing','active',1000);
    INSERT INTO tasks VALUES('task-1','board-1','stage-1','Ship the beta','',NULL,'normal',NULL,1000,0,1,NULL,'2026-09-01T00:00:00.000Z','2026-09-01T00:00:00.000Z');
  `);
  legacy.close();

  const store = new Store(file);
  assert.equal(Number((store.db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version), SCHEMA_VERSION);
  new TaskStore(store.db);
  const columns = (store.db.prepare("PRAGMA table_info(task_boards)").all() as Array<{ name: string }>).map(column => column.name);
  for (const added of ["settings_json", "description", "color", "position", "default_owner_agent_id"]) assert.ok(columns.includes(added), `missing ${added}`);
  // The upgrade is in place: the operator's board and task are still there, and the board
  // that predates ordering is given a rank rather than left at zero.
  const board = store.db.prepare("SELECT name,position FROM task_boards WHERE id='board-1'").get() as { name: string; position: number };
  assert.equal(board.name, "Delivery");
  assert.ok(board.position > 0);
  assert.equal((store.db.prepare("SELECT title FROM tasks WHERE id='task-1'").get() as { title: string }).title, "Ship the beta");
  store.db.close();

  // Reopening is a no-op, and a file from a newer release is refused with its data intact.
  const reopened = new Store(file);
  assert.equal((reopened.db.prepare("SELECT COUNT(*) n FROM tasks").get() as { n: number }).n, 1);
  reopened.db.exec(`PRAGMA user_version=${SCHEMA_VERSION + 1}`);
  reopened.db.close();
  assert.throws(() => new Store(file), SchemaTooNewError);
  const survived = new DatabaseSync(file);
  assert.equal((survived.prepare("SELECT COUNT(*) n FROM tasks").get() as { n: number }).n, 1);
  survived.close();
});

test('cron semantics advance the schema beyond interval-only readers and preserve the pre-upgrade database', () => {
  const dir = mkdtempSync(join(tmpdir(), 'harness-cron-schema-')), file = join(dir, 'state.db');
  try {
    const old = new DatabaseSync(file);
    old.exec(`PRAGMA user_version=4;
      CREATE TABLE schedules(id TEXT PRIMARY KEY,agent_id TEXT NOT NULL,name TEXT NOT NULL,prompt TEXT NOT NULL,interval_minutes INTEGER NOT NULL,timezone TEXT NOT NULL,enabled INTEGER NOT NULL DEFAULT 1,next_run_at TEXT NOT NULL,last_run_at TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
      INSERT INTO schedules VALUES('interval','atlas','Existing','Keep this task',30,'UTC',1,'2026-11-14T00:30:00.000Z',NULL,'old','old');`);
    old.close();
    assert.ok(SCHEMA_VERSION >= 5, 'schema 4 readers ignore cron metadata and must refuse the upgraded database');
    const upgraded = new Store(file);
    try {
      assert.equal(upgraded.db.prepare('PRAGMA user_version').get()!.user_version, SCHEMA_VERSION);
      const interval = upgraded.db.prepare("SELECT * FROM schedules WHERE id='interval'").get()!;
      assert.equal(interval.schedule_kind, 'interval'); assert.equal(interval.interval_minutes, 30); assert.equal(interval.next_run_at, '2026-11-14T00:30:00.000Z');
      new Profiles(upgraded.db).create({ id: 'atlas', name: 'Atlas' });
      const cron = saveRoutine(upgraded.db, { agentId: 'atlas', name: 'Daily', prompt: 'Daily task', scheduleKind: 'cron', cronExpression: '0 9 * * *', timezone: 'UTC' }, new Date('2026-11-14T00:00:00Z'));
      assert.equal(cron.next_run_at, '2026-11-14T09:00:00.000Z');
    } finally { upgraded.db.close(); }
    const backups = readdirSync(dir).filter(name => name.endsWith('.backup')); assert.equal(backups.length, 1);
    const backup = new DatabaseSync(join(dir, backups[0]), { readOnly: true });
    try { assert.equal(backup.prepare('PRAGMA user_version').get()!.user_version, 4); assert.equal(backup.prepare('SELECT COUNT(*) n FROM schedules').get()!.n, 1); assert.ok(!backup.prepare('PRAGMA table_info(schedules)').all().some(row => row.name === 'schedule_kind')); } finally { backup.close(); }
    const reopened = new Store(file);
    try { assert.equal(reopened.db.prepare("SELECT cron_expression FROM schedules WHERE schedule_kind='cron'").get()!.cron_expression, '0 9 * * *'); } finally { reopened.db.close(); }
    assert.equal(readdirSync(dir).filter(name => name.endsWith('.backup')).length, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
