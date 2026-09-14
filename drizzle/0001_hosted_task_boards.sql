CREATE TABLE IF NOT EXISTS task_boards (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0,
  revision INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS task_stages (
  id TEXT PRIMARY KEY,
  board_id TEXT NOT NULL,
  name TEXT NOT NULL,
  category TEXT NOT NULL,
  position REAL NOT NULL,
  FOREIGN KEY(board_id) REFERENCES task_boards(id) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_task_stages_board_position ON task_stages(board_id, position);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY,
  board_id TEXT NOT NULL,
  stage_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  owner_agent_id TEXT,
  priority TEXT NOT NULL DEFAULT 'normal',
  due_at TEXT,
  position REAL NOT NULL,
  archived INTEGER NOT NULL DEFAULT 0,
  revision INTEGER NOT NULL DEFAULT 1,
  collaborators_json TEXT NOT NULL DEFAULT '[]',
  labels_json TEXT NOT NULL DEFAULT '[]',
  checklist_json TEXT NOT NULL DEFAULT '[]',
  comments_json TEXT NOT NULL DEFAULT '[]',
  activity_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(board_id) REFERENCES task_boards(id),
  FOREIGN KEY(stage_id) REFERENCES task_stages(id)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_tasks_board_stage_position ON tasks(board_id, stage_id, position);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_tasks_owner_archived ON tasks(owner_agent_id, archived);
