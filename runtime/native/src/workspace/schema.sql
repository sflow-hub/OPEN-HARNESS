CREATE TABLE IF NOT EXISTS teams (
  id TEXT PRIMARY KEY, revision INTEGER NOT NULL DEFAULT 1, name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '', color TEXT NOT NULL, icon TEXT NOT NULL,
  retired_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_teams_active_name ON teams(retired_at,name);
CREATE TABLE IF NOT EXISTS team_members (
  team_id TEXT NOT NULL, agent_id TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY(team_id,agent_id), FOREIGN KEY(team_id) REFERENCES teams(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_team_members_agent ON team_members(agent_id,team_id);

CREATE TABLE IF NOT EXISTS task_boards (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0,
  revision INTEGER NOT NULL DEFAULT 1, settings_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '', color TEXT NOT NULL DEFAULT 'sage', position REAL NOT NULL DEFAULT 0, default_owner_agent_id TEXT
);
CREATE TABLE IF NOT EXISTS task_stages (
  id TEXT PRIMARY KEY, board_id TEXT NOT NULL, name TEXT NOT NULL, category TEXT NOT NULL,
  position REAL NOT NULL, FOREIGN KEY(board_id) REFERENCES task_boards(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_task_stages_board_position ON task_stages(board_id,position);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY, board_id TEXT NOT NULL, stage_id TEXT NOT NULL, title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '', team_id TEXT, owner_agent_id TEXT, priority TEXT NOT NULL DEFAULT 'normal',
  due_at TEXT, position REAL NOT NULL, archived INTEGER NOT NULL DEFAULT 0,
  revision INTEGER NOT NULL DEFAULT 1, active_run_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  FOREIGN KEY(board_id) REFERENCES task_boards(id), FOREIGN KEY(stage_id) REFERENCES task_stages(id)
);
CREATE INDEX IF NOT EXISTS idx_tasks_board_stage_position ON tasks(board_id,stage_id,position);
CREATE INDEX IF NOT EXISTS idx_tasks_owner_archived ON tasks(owner_agent_id,archived);
CREATE TABLE IF NOT EXISTS task_collaborators (
  task_id TEXT NOT NULL, agent_id TEXT NOT NULL, PRIMARY KEY(task_id,agent_id),
  FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_task_collaborators_agent ON task_collaborators(agent_id);
CREATE TABLE IF NOT EXISTS task_labels (
  task_id TEXT NOT NULL, label TEXT NOT NULL, PRIMARY KEY(task_id,label),
  FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS task_checklist (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL, text TEXT NOT NULL, done INTEGER NOT NULL DEFAULT 0,
  position REAL NOT NULL, FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS task_comments (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL, body TEXT NOT NULL, author TEXT NOT NULL DEFAULT 'you', created_at TEXT NOT NULL,
  FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS task_activity (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL, type TEXT NOT NULL, detail TEXT NOT NULL, created_at TEXT NOT NULL,
  FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS task_runs (
  task_id TEXT NOT NULL, run_id TEXT NOT NULL UNIQUE, attempt INTEGER NOT NULL,
  instructions_snapshot TEXT NOT NULL, checklist_snapshot TEXT NOT NULL, idempotency_key TEXT NOT NULL UNIQUE,
  started_at TEXT NOT NULL, output TEXT NOT NULL DEFAULT '', stop_reason TEXT, PRIMARY KEY(task_id,run_id),
  FOREIGN KEY(task_id) REFERENCES tasks(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_task_runs_task_attempt ON task_runs(task_id,attempt);
