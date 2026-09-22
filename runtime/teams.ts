import type { DatabaseSync } from "node:sqlite";
import { normalizeTeamInput, type Team, type TeamInput } from "../lib/team";

type Row = Record<string, unknown>;

export class TeamError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

export class TeamStore {
  constructor(readonly db: DatabaseSync) {
    db.exec(`
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
    `);
  }

  private map(row: Row): Team {
    const members = this.db.prepare("SELECT agent_id FROM team_members WHERE team_id=? ORDER BY created_at,agent_id").all(String(row.id)) as Array<{ agent_id: string }>;
    return {
      id: String(row.id), revision: Number(row.revision), name: String(row.name), description: String(row.description || ""),
      color: String(row.color) as Team["color"], icon: String(row.icon) as Team["icon"],
      memberAgentIds: members.map(member => member.agent_id), retiredAt: row.retired_at ? String(row.retired_at) : null,
      createdAt: String(row.created_at), updatedAt: String(row.updated_at),
    };
  }

  list(includeRetired = false): Team[] {
    return (this.db.prepare(`SELECT * FROM teams ${includeRetired ? "" : "WHERE retired_at IS NULL"} ORDER BY lower(name),created_at`).all() as Row[]).map(row => this.map(row));
  }

  get(teamId: string, includeRetired = false): Team | null {
    const row = this.db.prepare(`SELECT * FROM teams WHERE id=? ${includeRetired ? "" : "AND retired_at IS NULL"}`).get(teamId) as Row | undefined;
    return row ? this.map(row) : null;
  }

  private validated(input: Partial<TeamInput>, current?: Team) {
    let value: ReturnType<typeof normalizeTeamInput>;
    try { value = normalizeTeamInput(input); }
    catch (error) { throw new TeamError(error instanceof Error ? error.message : "Invalid team."); }
    const duplicate = this.db.prepare("SELECT id FROM teams WHERE retired_at IS NULL AND lower(name)=lower(?) AND id<>?").get(value.name, current?.id || "") as Row | undefined;
    if (duplicate) throw new TeamError("An active team already uses that name.", 409);
    for (const agentId of value.memberAgentIds) if (!this.db.prepare("SELECT 1 FROM agent_profiles WHERE id=?").get(agentId)) throw new TeamError(`Agent ${agentId} does not exist.`);
    return value;
  }

  private replaceMembers(teamId: string, next: string[], prior: string[] = []) {
    const removed = prior.filter(agentId => !next.includes(agentId));
    for (const agentId of removed) {
      const blocker = this.db.prepare(`SELECT tasks.id FROM tasks LEFT JOIN task_collaborators ON task_collaborators.task_id=tasks.id
        WHERE tasks.team_id=? AND tasks.archived=0 AND (tasks.owner_agent_id=? OR task_collaborators.agent_id=?) LIMIT 1`).get(teamId, agentId, agentId);
      if (blocker) throw new TeamError("Reassign or archive this member's team tasks before removing them.", 409);
    }
    this.db.prepare("DELETE FROM team_members WHERE team_id=?").run(teamId);
    const createdAt = new Date().toISOString();
    for (const agentId of next) this.db.prepare("INSERT INTO team_members(team_id,agent_id,created_at) VALUES(?,?,?)").run(teamId, agentId, createdAt);
  }

  create(input: Partial<TeamInput>): Team {
    const value = this.validated(input), id = crypto.randomUUID(), now = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("INSERT INTO teams(id,revision,name,description,color,icon,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)").run(id, 1, value.name, value.description, value.color, value.icon, now, now);
      this.replaceMembers(id, value.memberAgentIds);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    return this.get(id)!;
  }

  import(input: Partial<Team> & Partial<TeamInput>): Team {
    const existing = input.id ? this.get(input.id) : null;
    if (existing) return this.update(existing.id, { ...input, revision: existing.revision });
    const byName = this.list().find(team => team.name.localeCompare(String(input.name || ""), undefined, { sensitivity: "accent" }) === 0);
    if (byName) return this.update(byName.id, { ...input, revision: byName.revision });
    const value = this.validated(input), teamId = typeof input.id === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(input.id) ? input.id : crypto.randomUUID();
    const now = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("INSERT INTO teams(id,revision,name,description,color,icon,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)").run(teamId, 1, value.name, value.description, value.color, value.icon, now, now);
      this.replaceMembers(teamId, value.memberAgentIds);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    return this.get(teamId)!;
  }

  update(teamId: string, input: Partial<TeamInput>): Team {
    const current = this.get(teamId);
    if (!current) throw new TeamError("Team not found.", 404);
    if (!Number.isInteger(input.revision) || input.revision !== current.revision) throw new TeamError("This team changed elsewhere. Reload it before saving.", 409);
    const value = this.validated(input, current), now = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.replaceMembers(teamId, value.memberAgentIds, current.memberAgentIds);
      this.db.prepare("UPDATE teams SET revision=revision+1,name=?,description=?,color=?,icon=?,updated_at=? WHERE id=? AND retired_at IS NULL").run(value.name, value.description, value.color, value.icon, now, teamId);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    return this.get(teamId)!;
  }

  retire(teamId: string): Team {
    const current = this.get(teamId);
    if (!current) throw new TeamError("Team not found.", 404);
    if (this.db.prepare("SELECT 1 FROM tasks WHERE team_id=? AND archived=0 LIMIT 1").get(teamId)) throw new TeamError("Reassign or archive this team's tasks before deleting it.", 409);
    const now = new Date().toISOString();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db.prepare("DELETE FROM team_members WHERE team_id=?").run(teamId);
      this.db.prepare("UPDATE teams SET revision=revision+1,retired_at=?,updated_at=? WHERE id=?").run(now, now, teamId);
      this.db.exec("COMMIT");
    } catch (error) { this.db.exec("ROLLBACK"); throw error; }
    return this.get(teamId, true)!;
  }

  isMember(teamId: string, agentId: string) {
    return Boolean(this.db.prepare("SELECT 1 FROM team_members JOIN teams ON teams.id=team_members.team_id WHERE team_members.team_id=? AND team_members.agent_id=? AND teams.retired_at IS NULL").get(teamId, agentId));
  }

  sharesActiveTeam(sourceAgentId: string, targetAgentId: string) {
    return Boolean(this.db.prepare(`SELECT 1 FROM team_members source JOIN team_members target ON target.team_id=source.team_id
      JOIN teams ON teams.id=source.team_id WHERE source.agent_id=? AND target.agent_id=? AND teams.retired_at IS NULL LIMIT 1`).get(sourceAgentId, targetAgentId));
  }

  validateAssignment(teamId: string | null, ownerAgentId: string | null, collaboratorAgentIds: string[], allowLegacyUnscoped = false) {
    const collaborators = [...new Set(collaboratorAgentIds)].filter(agentId => agentId !== ownerAgentId);
    if (!teamId) {
      if (collaborators.length && !allowLegacyUnscoped) throw new TeamError("Choose a team before adding collaborators.");
      return { teamId: null, ownerAgentId, collaboratorAgentIds: collaborators };
    }
    const team = this.get(teamId);
    if (!team) throw new TeamError("Choose an active team.");
    for (const agentId of [ownerAgentId, ...collaborators].filter(Boolean) as string[]) {
      if (!team.memberAgentIds.includes(agentId)) throw new TeamError("Task owners and collaborators must belong to the selected team.");
    }
    return { teamId, ownerAgentId, collaboratorAgentIds: collaborators };
  }
}
