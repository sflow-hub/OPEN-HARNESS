import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SCHEMA_VERSION, SchemaTooNewError, Store } from "../runtime/db";
import { TaskStore } from "../runtime/tasks";

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
