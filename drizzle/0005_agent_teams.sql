CREATE TABLE IF NOT EXISTS teams (
  id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL DEFAULT 1,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  color TEXT NOT NULL,
  icon TEXT NOT NULL,
  retired_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_hosted_teams_active_name ON teams(retired_at,name);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS team_members (
  team_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY(team_id,agent_id),
  FOREIGN KEY(team_id) REFERENCES teams(id) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_hosted_team_members_agent ON team_members(agent_id,team_id);
--> statement-breakpoint
ALTER TABLE tasks ADD COLUMN team_id TEXT;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_tasks_team_archived ON tasks(team_id,archived);
