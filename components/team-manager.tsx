"use client";

import { useMemo, useState } from "react";
import { BriefcaseBusiness, Check, Code2, Compass, FlaskConical, LoaderCircle, PenTool, Plus, Rocket, Search, Shield, Trash2, Users, X } from "lucide-react";
import type { ControlClient } from "../lib/control-client";
import { TEAM_COLORS, TEAM_ICONS, type Team, type TeamColor, type TeamIcon } from "../lib/team";
import type { Agent } from "../lib/types";

const ICONS = { people: Users, rocket: Rocket, briefcase: BriefcaseBusiness, flask: FlaskConical, writing: PenTool, code: Code2, compass: Compass, shield: Shield } as const;
type Draft = { id?: string; revision?: number; name: string; description: string; color: TeamColor; icon: TeamIcon; memberAgentIds: string[] };
const emptyDraft = (): Draft => ({ name: "", description: "", color: "sage", icon: "people", memberAgentIds: [] });

export function TeamMark({ team, size = 18 }: { team: Pick<Team, "color" | "icon">; size?: number }) {
  const Icon = ICONS[team.icon] || Users;
  return <span className={`team-mark tone-${TEAM_COLORS.indexOf(team.color)}`}><Icon size={size} /></span>;
}

export function TeamBadge({ team }: { team: Team }) {
  return <span className={`team-badge tone-${TEAM_COLORS.indexOf(team.color)}`}><TeamMark team={team} size={11} />{team.name}</span>;
}

export default function TeamManager({ agents, teams, client, onChanged }: { agents: Agent[]; teams: Team[]; client: ControlClient; onChanged: (teams: Team[]) => void }) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [search, setSearch] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const agentsById = useMemo(() => new Map(agents.map(agent => [agent.id, agent])), [agents]);
  const assigned = new Set(teams.flatMap(team => team.memberAgentIds));
  const unassigned = agents.filter(agent => !assigned.has(agent.id));
  const refresh = async () => { const result = await client.request<{ teams: Team[] }>("/v1/teams?includeRetired=1"); onChanged(result.teams); };
  const open = (team?: Team) => { setDraft(team ? { id: team.id, revision: team.revision, name: team.name, description: team.description, color: team.color, icon: team.icon, memberAgentIds: [...team.memberAgentIds] } : emptyDraft()); setSearch(""); setError(""); };
  const save = async () => {
    if (!draft || !draft.name.trim()) return;
    setBusy(true); setError("");
    try {
      await client.request(draft.id ? `/v1/teams/${encodeURIComponent(draft.id)}` : "/v1/teams", { method: draft.id ? "PUT" : "POST", body: JSON.stringify(draft) });
      await refresh(); setDraft(null);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not save this team."); }
    finally { setBusy(false); }
  };
  const remove = async () => {
    if (!draft?.id || !confirm(`Delete ${draft.name}? Archived task history will keep its team label.`)) return;
    setBusy(true); setError("");
    try { await client.request(`/v1/teams/${encodeURIComponent(draft.id)}`, { method: "DELETE" }); await refresh(); setDraft(null); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not delete this team."); }
    finally { setBusy(false); }
  };
  const visibleAgents = agents.filter(agent => !search || `${agent.name} ${agent.role}`.toLowerCase().includes(search.toLowerCase()));

  return <section className="teams-content">
    <div className="teams-heading"><div><div className="eyebrow">AGENT GROUPS</div><h1>Teams</h1><p>Organize agents and give collaborative work a clear boundary.</p></div><button className="light-button" onClick={() => open()}><Plus size={14} /> Create team</button></div>
    {error && !draft && <div className="task-error" role="alert">{error}</div>}
    <div className="team-grid">
      {teams.map(team => { const members = team.memberAgentIds.map(id => agentsById.get(id)).filter(Boolean) as Agent[]; return <article className={`team-card tone-${TEAM_COLORS.indexOf(team.color)}`} key={team.id}>
        <button className="team-card-main" onClick={() => open(team)} aria-label={`Manage ${team.name}`}><TeamMark team={team} size={22} /><div><h2>{team.name}</h2><p>{team.description || "No description yet."}</p></div><span className="team-count">{members.length} member{members.length === 1 ? "" : "s"}</span></button>
        <div className="team-avatar-row">{members.slice(0, 6).map(agent => <span className={`task-avatar tone-${agent.tone % 6}`} title={agent.name} key={agent.id}>{agent.name[0]}</span>)}{members.length > 6 && <small>+{members.length - 6}</small>}{!members.length && <small>No agents assigned</small>}</div>
      </article>; })}
      <article className="team-card unassigned-team"><div className="team-card-main"><span className="team-mark unassigned"><Users size={22} /></span><div><h2>Unassigned</h2><p>Agents that are available for solo work.</p></div><span className="team-count">{unassigned.length}</span></div><div className="team-avatar-row">{unassigned.slice(0, 6).map(agent => <span className={`task-avatar tone-${agent.tone % 6}`} title={agent.name} key={agent.id}>{agent.name[0]}</span>)}{!unassigned.length && <small>Every agent is on a team</small>}</div></article>
    </div>
    {!teams.length && <div className="team-empty"><Users size={28} /><h2>Create your first team</h2><p>Agents can join more than one team, and agents you do not assign remain available for solo work.</p><button onClick={() => open()}><Plus size={14} /> New team</button></div>}

    {draft && <div className="modal-backdrop" onClick={() => !busy && setDraft(null)}><section className="modal team-modal" role="dialog" aria-modal="true" aria-labelledby="team-modal-title" onClick={event => event.stopPropagation()}>
      <div className="modal-heading"><h2 id="team-modal-title">{draft.id ? "Manage team" : "Create team"}</h2><button aria-label="Close team editor" onClick={() => setDraft(null)}><X size={18} /></button></div>
      {error && <div className="task-error" role="alert">{error}</div>}
      <label>Team name<input autoFocus maxLength={60} value={draft.name} onChange={event => setDraft(value => value && ({ ...value, name: event.target.value }))} placeholder="Launch crew" /></label>
      <label>Description<textarea maxLength={240} rows={3} value={draft.description} onChange={event => setDraft(value => value && ({ ...value, description: event.target.value }))} placeholder="What this group works on." /></label>
      <fieldset className="team-choice"><legend>Color</legend><div>{TEAM_COLORS.map(color => <button type="button" className={`team-color tone-${TEAM_COLORS.indexOf(color)} ${draft.color === color ? "selected" : ""}`} aria-label={`${color} team color`} aria-pressed={draft.color === color} onClick={() => setDraft(value => value && ({ ...value, color }))} key={color}>{draft.color === color && <Check size={14} />}</button>)}</div></fieldset>
      <fieldset className="team-choice"><legend>Icon</legend><div>{TEAM_ICONS.map(icon => { const Icon = ICONS[icon]; return <button type="button" className={draft.icon === icon ? "selected" : ""} aria-label={`${icon} team icon`} aria-pressed={draft.icon === icon} onClick={() => setDraft(value => value && ({ ...value, icon }))} key={icon}><Icon size={17} /></button>; })}</div></fieldset>
      <div className="team-members-head"><label>Members</label><div className="search-box"><Search size={13} /><input value={search} onChange={event => setSearch(event.target.value)} placeholder="Find agents" aria-label="Find agents" /></div></div>
      <div className="team-member-list">{visibleAgents.map(agent => { const selected = draft.memberAgentIds.includes(agent.id); return <button type="button" className={selected ? "selected" : ""} aria-pressed={selected} onClick={() => setDraft(value => value && ({ ...value, memberAgentIds: selected ? value.memberAgentIds.filter(id => id !== agent.id) : [...value.memberAgentIds, agent.id] }))} key={agent.id}><span className={`task-avatar tone-${agent.tone % 6}`}>{agent.name[0]}</span><span><strong>{agent.name}</strong><small>{agent.role}</small></span>{selected && <Check size={15} />}</button>; })}</div>
      <div className="modal-footer">{draft.id && <button className="danger-text" disabled={busy} onClick={() => void remove()}><Trash2 size={14} /> Delete team</button>}<span className="drawer-spacer" /><button disabled={busy} onClick={() => setDraft(null)}>Cancel</button><button className="light-button" disabled={busy || !draft.name.trim()} onClick={() => void save()}>{busy ? <LoaderCircle className="spin" size={14} /> : <Check size={14} />} Save team</button></div>
    </section></div>}
  </section>;
}
