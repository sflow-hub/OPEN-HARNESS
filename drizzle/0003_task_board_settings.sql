ALTER TABLE task_boards ADD COLUMN settings_json TEXT NOT NULL DEFAULT '{}';
--> statement-breakpoint
ALTER TABLE tasks ADD COLUMN active_run_id TEXT;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS task_runs (
  task_id TEXT NOT NULL,
  run_id TEXT NOT NULL UNIQUE,
  attempt INTEGER NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  started_at TEXT NOT NULL,
  PRIMARY KEY(task_id, run_id)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_task_runs_task_attempt ON task_runs(task_id, attempt);
