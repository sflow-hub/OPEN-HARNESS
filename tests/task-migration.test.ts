import test from "node:test";
import assert from "node:assert/strict";
import { Store } from "../runtime/db";
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
