"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Archive, ArrowDown, ArrowLeft, ArrowRight, ArrowUp, CalendarDays, Check,
  CheckCircle2, ChevronDown, CircleAlert, Clock3, Copy, Filter, FolderKanban, GripVertical, LayoutDashboard,
  List, LoaderCircle, MessageSquare, Play, Plus, RotateCcw, Search,
  Settings2, Tags, Trash2, Users, X,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ControlClient, PersistentRun } from "../lib/control-client";
import type { Agent } from "../lib/types";
import type { Team } from "../lib/team";
import { TeamBadge } from "./team-manager";
import { BOARD_COLORS, type AgentTask, type BoardColor, type BoardSummary, type TaskBoard, type TaskPriority, type TaskSnapshot, type WorkflowCategory } from "../lib/task-types";

type TaskView = "board" | "list" | "agent" | "projects";
type BoardDraft = { name: string; description: string; color: BoardColor; defaultOwnerAgentId: string | null };
type Filters = {
  teams: string[]; owners: string[]; collaborators: string[]; assigned: string[]; stages: string[];
  priorities: string[]; labels: string[]; due: string[]; runs: string[]; archived: boolean;
};
type Draft = Omit<AgentTask, "runs" | "activity" | "comments" | "runState" | "activeRunId" | "createdAt" | "updatedAt">;
const EMPTY_FILTERS: Filters = { teams: [], owners: [], collaborators: [], assigned: [], stages: [], priorities: [], labels: [], due: [], runs: [], archived: false };
const CATEGORIES: Array<{ id: WorkflowCategory; label: string }> = [
  { id: "backlog", label: "Backlog" }, { id: "ready", label: "Ready" },
  { id: "in_progress", label: "In progress" }, { id: "review", label: "Review" }, { id: "done", label: "Done" },
];
// Priority is an ordered scale and dueAt is a date; comparing either as text ranks
// "high" above "low" and sorts 2026-01 before 2025-12 once the day widths differ.
const PRIORITY_ORDER: Record<string, number> = { urgent: 0, high: 1, normal: 2, low: 3 };
function compareTasks(a: AgentTask, b: AgentTask, key: keyof AgentTask) {
  if (key === "priority") return (PRIORITY_ORDER[a.priority] ?? 99) - (PRIORITY_ORDER[b.priority] ?? 99);
  if (key === "dueAt") {
    // Tasks with no due date sort last in either direction rather than clumping at the top.
    if (!a.dueAt && !b.dueAt) return 0;
    if (!a.dueAt) return 1;
    if (!b.dueAt) return -1;
    return Date.parse(a.dueAt) - Date.parse(b.dueAt);
  }
  if (key === "position") return a.position - b.position;
  return String(a[key] ?? "").localeCompare(String(b[key] ?? ""));
}

const PRIORITIES: TaskPriority[] = ["low", "normal", "high", "urgent"];
const TASK_VIEWS: TaskView[] = ["board", "list", "agent", "projects"];
const EMPTY_SUMMARY: Omit<BoardSummary, "boardId"> = { total: 0, archivedCount: 0, byCategory: { backlog: 0, ready: 0, in_progress: 0, review: 0, done: 0 }, activeRuns: 0, ownerAgentIds: [] };
const emptyBoardDraft = (): BoardDraft => ({ name: "", description: "", color: "sage", defaultOwnerAgentId: null });
const ACTIVE_RUNS = ["queued", "running", "waiting_approval", "waiting_input"];
const PREF_KEY = "open-harness.tasks.view.v1";
const uuid = () => crypto.randomUUID();
const displayDate = (value: string | null) => value ? new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(new Date(value)) : "No due date";
const displayTime = (value: string) => new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(value));
const runLabel = (value: string | null) => ({ waiting_approval: "Needs approval", waiting_input: "Needs input", in_progress: "In progress" }[value || ""] || (value ? value.replaceAll("_", " ") : "Not started"));
const isActive = (task: AgentTask) => Boolean(task.runState && ACTIVE_RUNS.includes(task.runState));

function emptyDraft(board: TaskBoard): Draft {
  return {
    id: "", boardId: board.id, stageId: board.stages.find(stage => stage.category === "backlog")?.id || board.stages[0]?.id || "",
    title: "", description: "", teamId: null, ownerAgentId: board.defaultOwnerAgentId, collaboratorAgentIds: [], priority: "normal", labels: [], dueAt: null,
    position: 0, archived: false, revision: 0, checklist: [],
  };
}

function Avatar({ agent, empty = false }: { agent?: Agent; empty?: boolean }) {
  return <span className={`task-avatar ${agent ? `tone-${agent.tone % 6}` : "unassigned"}`}>{empty ? "–" : agent?.name[0] || "?"}</span>;
}

// Project colours are the avatar tones, so a project dot and an agent avatar picked from
// the same palette read as the same colour.
function ProjectDot({ color, size = 10 }: { color: BoardColor; size?: number }) {
  return <span className={`project-dot tone-${BOARD_COLORS.indexOf(color)}`} style={{ width: size, height: size }} aria-hidden="true" />;
}

function ColorPicker({ value, onChange }: { value: BoardColor; onChange: (color: BoardColor) => void }) {
  return <fieldset className="project-colors"><legend>Colour</legend>{BOARD_COLORS.map(color => <label className={`project-color tone-${BOARD_COLORS.indexOf(color)}`} key={color} title={color[0].toUpperCase() + color.slice(1)}>
    <input type="radio" name="project-color" aria-label={color} checked={value === color} onChange={() => onChange(color)} />
    <span>{value === color && <Check size={15} />}</span>
  </label>)}</fieldset>;
}

function OwnerSelect({ agents, value, onChange, label }: { agents: Agent[]; value: string | null; onChange: (value: string | null) => void; label: string }) {
  return <label>{label}<select value={value || ""} onChange={event => onChange(event.target.value || null)}><option value="">Unassigned</option>{agents.map(agent => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</select></label>;
}

function Toggle({ label, checked, onChange }: { label: string; checked: boolean; onChange: (value: boolean) => void }) {
  return <label className="task-toggle"><input type="checkbox" checked={checked} onChange={event => onChange(event.target.checked)} /> {label}</label>;
}

function FilterGroup({ title, options, values, onChange }: { title: string; options: Array<{ id: string; label: string }>; values: string[]; onChange: (next: string[]) => void }) {
  return <fieldset className="filter-group"><legend>{title}</legend>{options.map(option => <label key={option.id}>
    <input type="checkbox" checked={values.includes(option.id)} onChange={() => onChange(values.includes(option.id) ? values.filter(value => value !== option.id) : [...values, option.id])} />
    {option.label}
  </label>)}</fieldset>;
}

export default function TaskManager({ agents, teams, client, onOpenRun }: { agents: Agent[]; teams: Team[]; client: ControlClient; onOpenRun: (run: PersistentRun, title: string) => void }) {
  const activeTeams = useMemo(() => teams.filter(team => !team.retiredAt), [teams]);
  const [snapshot, setSnapshot] = useState<TaskSnapshot>({ boards: [], tasks: [], summaries: [] });
  const [loaded, setLoaded] = useState(false);
  const [stale, setStale] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [selectedBoard, setSelectedBoard] = useState("all");
  const [taskView, setTaskView] = useState<TaskView>("board");
  const [search, setSearch] = useState("");
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [boardOpen, setBoardOpen] = useState(false);
  const [newBoardOpen, setNewBoardOpen] = useState(false);
  const [newBoard, setNewBoard] = useState<BoardDraft>(emptyBoardDraft);
  const [showArchivedProjects, setShowArchivedProjects] = useState(false);
  const [confirmDeleteBoard, setConfirmDeleteBoard] = useState<TaskBoard | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [comment, setComment] = useState("");
  const [feedback, setFeedback] = useState("");
  // What the drawer held when it opened. Closing is only free if nothing has changed
  // since; otherwise a backdrop click would throw away edits with no way to get them back.
  const [baseline, setBaseline] = useState("");
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [sort, setSort] = useState<{ key: keyof AgentTask; direction: 1 | -1 }>({ key: "position", direction: 1 });
  const [dragged, setDragged] = useState<string | null>(null);
  const [clock, setClock] = useState(Date.now);

  // The Projects view needs archived projects without forcing archived tasks into every
  // other view, so it widens the request alone; visibleBoards keeps them out elsewhere.
  const refresh = useCallback(async (quiet = false) => {
    try {
      const value = await client.request<TaskSnapshot>(`/v1/tasks?includeArchived=${filters.archived || showArchivedProjects ? "1" : "0"}`);
      setSnapshot(value); setLoaded(true); setStale(false);
      setSelectedBoard(current => current === "all" || value.boards.some(board => board.id === current) ? current : "all");
      if (!quiet) setError("");
    } catch (cause) {
      setStale(true); setLoaded(true);
      if (!quiet) setError(cause instanceof Error ? cause.message : "Task data is unavailable.");
    }
  }, [client, filters.archived, showArchivedProjects]);

  useEffect(() => {
    // Hydrate device-local view preferences after the server-rendered frame.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    try { const saved = JSON.parse(localStorage.getItem(PREF_KEY) || "{}"); if (TASK_VIEWS.includes(saved.taskView)) setTaskView(saved.taskView); if (typeof saved.selectedBoard === "string") setSelectedBoard(saved.selectedBoard); } catch {}
  }, []);
  useEffect(() => { localStorage.setItem(PREF_KEY, JSON.stringify({ taskView, selectedBoard })); }, [taskView, selectedBoard]);
  useEffect(() => {
    // The service is the task source of truth; refresh immediately on mount.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
    const timer = window.setInterval(() => { if (!document.hidden && !dragged) void refresh(true); }, snapshot.tasks.some(isActive) ? 2000 : 8000);
    return () => window.clearInterval(timer);
  }, [refresh, snapshot.tasks, dragged]);
  useEffect(() => { const timer = window.setInterval(() => setClock(Date.now()), 60_000); return () => window.clearInterval(timer); }, []);

  const board = snapshot.boards.find(item => item.id === selectedBoard);
  const boardsById = useMemo(() => new Map(snapshot.boards.map(item => [item.id, item])), [snapshot.boards]);
  const summariesById = useMemo(() => new Map(snapshot.summaries.map(item => [item.boardId, item])), [snapshot.summaries]);
  // Archived projects are fetched for the Projects view but must not reappear in the
  // picker or the cross-project board until someone asks for archived work explicitly.
  const visibleBoards = useMemo(() => filters.archived ? snapshot.boards : snapshot.boards.filter(item => !item.archived || item.id === selectedBoard), [snapshot.boards, filters.archived, selectedBoard]);
  const agentsById = useMemo(() => new Map(agents.map(item => [item.id, item])), [agents]);
  const teamsById = useMemo(() => new Map(teams.map(item => [item.id, item])), [teams]);
  const allLabels = useMemo(() => [...new Set(snapshot.tasks.flatMap(task => task.labels))].sort(), [snapshot.tasks]);
  const activeFilterCount = Object.entries(filters).reduce((total, [key, value]) => total + (key === "archived" ? (value ? 1 : 0) : (value as string[]).length), 0);
  const tasks = useMemo(() => snapshot.tasks.filter(task => {
    if (selectedBoard !== "all" && task.boardId !== selectedBoard) return false;
    if (!filters.archived && task.boardId !== selectedBoard && boardsById.get(task.boardId)?.archived) return false;
    const query = search.trim().toLowerCase();
    if (query && ![task.title, task.description, ...task.labels].join(" ").toLowerCase().includes(query)) return false;
    if (filters.teams.length && !filters.teams.includes(task.teamId || "unscoped")) return false;
    if (filters.owners.length && !filters.owners.includes(task.ownerAgentId || "unassigned")) return false;
    if (filters.collaborators.length && !filters.collaborators.some(id => task.collaboratorAgentIds.includes(id))) return false;
    if (filters.assigned.length && !filters.assigned.some(id => task.ownerAgentId === id || task.collaboratorAgentIds.includes(id) || (id === "unassigned" && !task.ownerAgentId))) return false;
    const category = boardsById.get(task.boardId)?.stages.find(stage => stage.id === task.stageId)?.category;
    if (filters.stages.length && !filters.stages.includes(category || "")) return false;
    if (filters.priorities.length && !filters.priorities.includes(task.priority)) return false;
    if (filters.labels.length && !filters.labels.some(label => task.labels.includes(label))) return false;
    if (filters.runs.length && !filters.runs.includes(task.runState || "not_started")) return false;
    if (filters.due.length) {
      const overdue = Boolean(task.dueAt && new Date(task.dueAt).getTime() < clock && category !== "done");
      if (!filters.due.some(value => value === "overdue" ? overdue : value === "dated" ? Boolean(task.dueAt) : !task.dueAt)) return false;
    }
    return filters.archived ? true : !task.archived;
  }), [snapshot.tasks, selectedBoard, search, filters, boardsById, clock]);

  const request = async <T,>(path: string, init: RequestInit): Promise<T | null> => {
    if (stale) return null;
    setBusy(true); setError("");
    try { const value = await client.request<T>(path, init); await refresh(true); return value; }
    catch (cause) { setError(cause instanceof Error ? cause.message : "The task could not be updated."); return null; }
    finally { setBusy(false); }
  };

  const openTask = (task: AgentTask) => {
    setDetailId(task.id);
    const next: Draft = { id: task.id, teamId: task.teamId, boardId: task.boardId, stageId: task.stageId, title: task.title, description: task.description, ownerAgentId: task.ownerAgentId, collaboratorAgentIds: task.collaboratorAgentIds, priority: task.priority, labels: task.labels, dueAt: task.dueAt, position: task.position, archived: task.archived, revision: task.revision, checklist: task.checklist };
    setDraft(next); setBaseline(JSON.stringify(next)); setConfirmDiscard(false);
  };
  const createTask = (stageId?: string) => {
    const target = board || snapshot.boards.find(item => !item.archived);
    if (!target) return;
    const next = emptyDraft(target); if (stageId) next.stageId = stageId;
    setDetailId("new"); setDraft(next); setBaseline(JSON.stringify(next)); setConfirmDiscard(false);
  };
  const createBoard = async () => {
    const created = await request<TaskBoard>("/v1/boards", { method: "POST", body: JSON.stringify(newBoard) });
    if (created) { setSelectedBoard(created.id); setNewBoard(emptyBoardDraft()); setNewBoardOpen(false); }
  };
  const deleteBoard = async (target: TaskBoard) => {
    const removed = await request<{ ok: boolean }>(`/v1/boards/${target.id}`, { method: "DELETE" });
    if (removed) { setConfirmDeleteBoard(null); setBoardOpen(false); setSelectedBoard(current => current === target.id ? "all" : current); }
  };
  const closeDetail = () => { setDetailId(null); setDraft(null); setComment(""); setFeedback(""); setBaseline(""); setConfirmDiscard(false); };
  const dirty = Boolean(draft) && (JSON.stringify(draft) !== baseline || comment.trim() !== "" || feedback.trim() !== "");
  // Saving, archiving and approving call closeDetail directly: the work is already
  // committed, so there is nothing to warn about. Only user-initiated dismissal asks.
  const requestClose = () => { if (dirty) setConfirmDiscard(true); else closeDetail(); };
  // Escape is how people close a panel. The page-level handler only knows about the
  // settings and file modals, so without this the drawer can only be dismissed by mouse.
  useEffect(() => {
    if (!draft) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      if (confirmDiscard) setConfirmDiscard(false);
      else if (dirty) setConfirmDiscard(true);
      else closeDetail();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [draft, dirty, confirmDiscard]);
  const current = detailId && detailId !== "new" ? snapshot.tasks.find(task => task.id === detailId) : null;
  const eligibleAgents = draft?.teamId ? agents.filter(agent => teamsById.get(draft.teamId!)?.memberAgentIds.includes(agent.id)) : agents;

  const save = async () => {
    if (!draft) return null;
    const path = draft.id ? `/v1/tasks/${draft.id}` : "/v1/tasks";
    const saved = await request<AgentTask>(path, { method: draft.id ? "PUT" : "POST", body: JSON.stringify(draft) });
    if (saved) { const synced = { ...draft, id: saved.id, revision: saved.revision }; setDetailId(saved.id); setDraft(synced); setBaseline(JSON.stringify(synced)); setComment(""); setFeedback(""); }
    return saved;
  };
  const start = async (changes = "") => {
    const saved = await save(); if (!saved) return;
    const action = changes ? "request-changes" : "start";
    const result = await request<{ task: AgentTask; run: PersistentRun }>(`/v1/tasks/${saved.id}/${action}`, { method: "POST", body: JSON.stringify({ revision: saved.revision, feedback: changes, idempotencyKey: uuid() }) });
    if (result) { setDraft(previous => previous ? { ...previous, revision: result.task.revision, stageId: result.task.stageId } : previous); setFeedback(""); }
  };
  const move = async (task: AgentTask, stageId: string, position?: number) => {
    if (isActive(task)) return;
    const moved = await request<AgentTask>(`/v1/tasks/${task.id}/move`, { method: "POST", body: JSON.stringify({ stageId, position: position ?? task.position }) });
    const currentBoard = boardsById.get(task.boardId);
    if (moved && stageId === currentBoard?.settings.runStageId && currentBoard.settings.autoRunOnDrop) {
      if (!moved.ownerAgentId) { openTask(moved); setError("Choose an owner before running this task."); return; }
      await request(`/v1/tasks/${moved.id}/start`, { method: "POST", body: JSON.stringify({ revision: moved.revision, idempotencyKey: uuid() }) });
    }
  };

  const renderCard = (task: AgentTask, stages: TaskBoard["stages"]) => {
    const owner = task.ownerAgentId ? agentsById.get(task.ownerAgentId) : undefined;
    const due = task.dueAt ? new Date(task.dueAt) : null;
    const overdue = Boolean(due && due.getTime() < clock && stages.find(stage => stage.id === task.stageId)?.category !== "done");
    const index = stages.findIndex(stage => stage.id === task.stageId);
    return <article className={`task-card ${isActive(task) ? "active-run" : ""}`} draggable={!isActive(task)} onDragStart={() => setDragged(task.id)} onDragEnd={() => setDragged(null)} key={task.id}>
      <button className="task-card-open" onClick={() => openTask(task)}>
        <span className="task-card-top"><span className={`task-priority ${task.priority}`}>{task.priority}</span>{task.runState && <span className={`run-pill ${task.runState}`}>{runLabel(task.runState)}</span>}</span>
        <strong>{task.title}</strong>
        {task.teamId && teamsById.get(task.teamId) && <TeamBadge team={teamsById.get(task.teamId)!} />}
        {task.labels.length > 0 && <span className="task-labels">{task.labels.slice(0, 3).map(label => <i key={label}>{label}</i>)}</span>}
        {task.checklist.length > 0 && <span className="task-progress"><CheckCircle2 size={13} /> {task.checklist.filter(item => item.done).length}/{task.checklist.length}</span>}
        <span className={`task-card-meta ${overdue ? "overdue" : ""}`}><CalendarDays size={13} /> {displayDate(task.dueAt)}</span>
        <span className="task-card-footer"><Avatar agent={owner} empty={!owner} />{owner?.name || "Unassigned"}<span className="collab-stack">{task.collaboratorAgentIds.slice(0, 2).map(id => <Avatar key={id} agent={agentsById.get(id)} />)}</span></span>
      </button>
      <div className="task-move-controls" aria-label={`Move ${task.title}`}>
        <GripVertical size={14} />
        <button aria-label="Move left" disabled={isActive(task) || index <= 0} onClick={() => void move(task, stages[index - 1]?.id)}><ArrowLeft size={13} /></button>
        <button aria-label="Move right" disabled={isActive(task) || index < 0 || index >= stages.length - 1} onClick={() => void move(task, stages[index + 1]?.id)}><ArrowRight size={13} /></button>
      </div>
    </article>;
  };

  if (!loaded) return <section className="tasks-page task-loading"><LoaderCircle className="spin" /> Loading tasks…</section>;
  const boardColumns = selectedBoard === "all"
    ? CATEGORIES.map(category => ({ ...category, taskStageIds: visibleBoards.flatMap(item => item.stages.filter(stage => stage.category === category.id).map(stage => stage.id)) }))
    : (board?.stages || []).map(stage => ({ id: stage.id, label: stage.name, taskStageIds: [stage.id] }));

  return <section className="tasks-page">
    <div className="tasks-heading">
      <div><div className="eyebrow">AGENT WORK QUEUE</div><h1>Tasks</h1><p>Plan the work, assign your agents, and follow every task through review.</p></div>
      <div className="task-heading-actions"><button disabled={stale || busy} onClick={() => setNewBoardOpen(true)}><Plus size={15} /> New project</button><button className="task-primary" disabled={stale || busy || !snapshot.boards.length} onClick={() => createTask()}><Plus size={16} /> New task</button></div>
    </div>
    {stale && <div className="task-alert"><CircleAlert size={16} /> Showing the last task data received. Editing is paused until task storage reconnects.<button onClick={() => void refresh()}>Retry</button></div>}
    {error && <div className="task-alert error"><CircleAlert size={16} /> {error}<button aria-label="Dismiss" onClick={() => setError("")}><X size={15} /></button></div>}
    <div className="task-toolbar">
      <label className="task-select">{board ? <ProjectDot color={board.color} /> : <FolderKanban size={14} className="task-select-glyph" />}<span>Project</span><select value={selectedBoard} onChange={event => setSelectedBoard(event.target.value)}><option value="all">All tasks</option>{visibleBoards.map(item => <option value={item.id} key={item.id}>{item.name}{item.archived ? " (archived)" : ""}</option>)}</select><ChevronDown size={14} /></label>
      <div className="task-view-switch" aria-label="Task view">
        <button className={taskView === "board" ? "active" : ""} onClick={() => setTaskView("board")}><LayoutDashboard size={14} /> Board</button>
        <button className={taskView === "list" ? "active" : ""} onClick={() => setTaskView("list")}><List size={14} /> List</button>
        <button className={taskView === "agent" ? "active" : ""} onClick={() => setTaskView("agent")}><Users size={14} /> By agent</button>
        <button className={taskView === "projects" ? "active" : ""} onClick={() => setTaskView("projects")}><FolderKanban size={14} /> Projects</button>
      </div>
      <label className="task-search"><Search size={15} /><input value={search} onChange={event => setSearch(event.target.value)} aria-label="Search tasks" placeholder="Search tasks" /></label>
      <button className={`task-filter ${filtersOpen ? "active" : ""}`} onClick={() => setFiltersOpen(value => !value)}><Filter size={15} /> Filter{activeFilterCount > 0 && <b>{activeFilterCount}</b>}</button>
      {board && <button className="task-icon-button" aria-label="Board settings" onClick={() => setBoardOpen(true)}><Settings2 size={16} /></button>}
    </div>
    {activeFilterCount > 0 && <div className="filter-chips">{Object.entries(filters).flatMap(([key, value]) => key === "archived" ? (value ? [<span key="archived">Archived included</span>] : []) : (value as string[]).map(item => <span key={`${key}-${item}`}>{item.replaceAll("_", " ")}</span>))}<button onClick={() => setFilters(EMPTY_FILTERS)}>Clear all</button></div>}
    {filtersOpen && <div className="filter-panel">
      <FilterGroup title="Team" options={[{ id: "unscoped", label: "Unscoped" }, ...activeTeams.map(team => ({ id: team.id, label: team.name }))]} values={filters.teams} onChange={teamValues => setFilters(value => ({ ...value, teams: teamValues }))} />
      <FilterGroup title="Owner" options={[{ id: "unassigned", label: "Unassigned" }, ...agents.map(agent => ({ id: agent.id, label: agent.name }))]} values={filters.owners} onChange={owners => setFilters(value => ({ ...value, owners }))} />
      <FilterGroup title="Collaborator" options={agents.map(agent => ({ id: agent.id, label: agent.name }))} values={filters.collaborators} onChange={collaborators => setFilters(value => ({ ...value, collaborators }))} />
      <FilterGroup title="Any assigned agent" options={[{ id: "unassigned", label: "Unassigned" }, ...agents.map(agent => ({ id: agent.id, label: agent.name }))]} values={filters.assigned} onChange={assigned => setFilters(value => ({ ...value, assigned }))} />
      <FilterGroup title="Stage" options={CATEGORIES} values={filters.stages} onChange={stages => setFilters(value => ({ ...value, stages }))} />
      <FilterGroup title="Priority" options={PRIORITIES.map(value => ({ id: value, label: value[0].toUpperCase() + value.slice(1) }))} values={filters.priorities} onChange={priorities => setFilters(value => ({ ...value, priorities }))} />
      <FilterGroup title="Labels" options={allLabels.map(label => ({ id: label, label }))} values={filters.labels} onChange={labels => setFilters(value => ({ ...value, labels }))} />
      <FilterGroup title="Due" options={[{ id: "overdue", label: "Overdue" }, { id: "dated", label: "Has due date" }, { id: "undated", label: "No due date" }]} values={filters.due} onChange={due => setFilters(value => ({ ...value, due }))} />
      <FilterGroup title="Execution" options={[{ id: "not_started", label: "Not started" }, ...["queued", "running", "waiting_approval", "waiting_input", "completed", "failed", "interrupted", "cancelled"].map(value => ({ id: value, label: runLabel(value) }))]} values={filters.runs} onChange={runs => setFilters(value => ({ ...value, runs }))} />
      <label className="show-archived"><input type="checkbox" checked={filters.archived} onChange={event => setFilters(value => ({ ...value, archived: event.target.checked }))} /> Include archived tasks and boards</label>
    </div>}

    {taskView === "board" && board && (board.description || board.archived) && <div className="project-banner"><ProjectDot color={board.color} size={12} /><div><strong>{board.name}{board.archived && <i className="project-badge">Archived</i>}</strong>{board.description && <p>{board.description}</p>}</div></div>}
    {taskView === "board" && <div className="kanban-board">{boardColumns.map(column => {
      const columnTasks = tasks.filter(task => column.taskStageIds.includes(task.stageId));
      return <section className="kanban-column" key={column.id} onDragOver={event => event.preventDefault()} onDrop={() => { const task = snapshot.tasks.find(item => item.id === dragged); const targetStage = selectedBoard === "all" ? boardsById.get(task?.boardId || "")?.stages.find(stage => stage.category === column.id) : board?.stages.find(stage => stage.id === column.id); if (task && targetStage) void move(task, targetStage.id, columnTasks.length); }}>
        <div className="kanban-column-title"><span>{column.label}</span><b>{columnTasks.length}</b></div>
        {columnTasks.map(task => renderCard(task, boardsById.get(task.boardId)?.stages || []))}
        {selectedBoard !== "all" && <button className="kanban-add" disabled={stale} onClick={() => createTask(String(column.id))}><Plus size={14} /> Add task</button>}
      </section>;
    })}</div>}

    {taskView === "list" && <div className="task-table-wrap"><table className="task-table"><thead><tr>{[["title", "Task"], ["teamId", "Team"], ["boardId", "Project"], ["stageId", "Stage"], ["ownerAgentId", "Owner"], ["priority", "Priority"], ["dueAt", "Due"], ["runState", "Execution"]].map(([key, label]) => <th key={key}><button onClick={() => setSort(currentSort => ({ key: key as keyof AgentTask, direction: currentSort.key === key ? currentSort.direction === 1 ? -1 : 1 : 1 }))}>{label}{sort.key === key && (sort.direction === 1 ? <ArrowUp size={12} /> : <ArrowDown size={12} />)}</button></th>)}</tr></thead><tbody>{[...tasks].sort((a, b) => compareTasks(a, b, sort.key) * sort.direction).map(task => {
      const taskBoard = boardsById.get(task.boardId); const owner = task.ownerAgentId ? agentsById.get(task.ownerAgentId) : undefined;
      const taskTeam = task.teamId ? teamsById.get(task.teamId) : undefined;
      return <tr key={task.id} tabIndex={0} role="button" aria-label={`Open task ${task.title}`} onClick={() => openTask(task)} onKeyDown={event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); openTask(task); } }}><td><strong>{task.title}</strong>{task.labels.length > 0 && <small>{task.labels.join(" · ")}</small>}</td><td>{taskTeam ? <TeamBadge team={taskTeam} /> : <span className="muted small">Unscoped</span>}</td><td>{taskBoard && <span className="table-project"><ProjectDot color={taskBoard.color} />{taskBoard.name}</span>}</td><td>{taskBoard?.stages.find(stage => stage.id === task.stageId)?.name}</td><td><span className="table-owner"><Avatar agent={owner} empty={!owner} />{owner?.name || "Unassigned"}{task.collaboratorAgentIds.length > 0 && <small>+{task.collaboratorAgentIds.length}</small>}</span></td><td><span className={`task-priority ${task.priority}`}>{task.priority}</span></td><td>{displayDate(task.dueAt)}</td><td><span className={`run-pill ${task.runState || ""}`}>{runLabel(task.runState)}</span></td></tr>;
    })}</tbody></table>{tasks.length === 0 && <div className="task-empty">No tasks match this view.</div>}</div>}

    {taskView === "agent" && <div className="agent-task-grid">{[...agents, undefined].map(agent => {
      const owned = tasks.filter(task => agent ? task.ownerAgentId === agent.id : !task.ownerAgentId);
      const collaborating = agent ? tasks.filter(task => task.collaboratorAgentIds.includes(agent.id) && task.ownerAgentId !== agent.id) : [];
      const queued = owned.filter(task => task.runState === "queued"); const running = owned.filter(task => ["running", "waiting_approval", "waiting_input"].includes(task.runState || ""));
      const review = owned.filter(task => boardsById.get(task.boardId)?.stages.find(stage => stage.id === task.stageId)?.category === "review");
      const applyAgent = (kind: "owned" | "collab" | "queued" | "running" | "review") => { setFilters({ ...EMPTY_FILTERS, ...(kind === "owned" ? { owners: [agent?.id || "unassigned"] } : kind === "collab" ? { collaborators: agent ? [agent.id] : [] } : kind === "queued" ? { owners: [agent?.id || "unassigned"], runs: ["queued"] } : kind === "running" ? { owners: [agent?.id || "unassigned"], runs: ["running", "waiting_approval", "waiting_input"] } : { owners: [agent?.id || "unassigned"], stages: ["review"] }) }); setTaskView("list"); };
      return <article className="agent-task-card" key={agent?.id || "unassigned"}><div className="agent-task-head"><Avatar agent={agent} empty={!agent} /><div><strong>{agent?.name || "Unassigned"}</strong><small>{agent?.role || "Tasks waiting for an owner"}</small></div></div><div className="agent-task-counts"><button onClick={() => applyAgent("owned")}><b>{owned.length}</b><span>Owned</span></button><button onClick={() => applyAgent("collab")} disabled={!agent}><b>{collaborating.length}</b><span>Collaborating</span></button><button onClick={() => applyAgent("running")}><b>{running.length}</b><span>Running</span></button><button onClick={() => applyAgent("queued")}><b>{queued.length}</b><span>Queued</span></button><button onClick={() => applyAgent("review")}><b>{review.length}</b><span>Review</span></button></div></article>;
    })}</div>}

    {taskView === "projects" && <ProjectsView
      boards={snapshot.boards} summaries={summariesById} agents={agents} busy={busy} stale={stale}
      showArchived={showArchivedProjects} onShowArchived={setShowArchivedProjects}
      onOpen={boardId => { setSelectedBoard(boardId); setTaskView("board"); }}
      onSettings={boardId => { setSelectedBoard(boardId); setBoardOpen(true); }}
      onDelete={setConfirmDeleteBoard} onCreate={() => setNewBoardOpen(true)} request={request} />}

    {draft && <div className="task-drawer-backdrop" onClick={requestClose}><aside className="task-drawer" role="dialog" aria-modal="true" aria-label={draft.id ? "Task details" : "New task"} onClick={event => event.stopPropagation()}>
      {confirmDiscard && <div className="task-discard" role="alertdialog" aria-labelledby="task-discard-title"><h3 id="task-discard-title">Discard unsaved changes?</h3><p>This task will stay as it was last saved.</p><div className="task-discard-actions"><button type="button" autoFocus onClick={() => setConfirmDiscard(false)}>Keep editing</button><button type="button" className="task-primary" onClick={closeDetail}>Discard changes</button></div></div>}
      <div className="task-drawer-head"><span>{draft.id ? "Task details" : "New task"}</span><button onClick={requestClose} aria-label="Close task"><X size={19} /></button></div>
      <div className="task-drawer-scroll">
        <input id="task-detail-title" className="task-title-input" value={draft.title} onChange={event => setDraft(value => value && ({ ...value, title: event.target.value }))} placeholder="What needs to be done?" autoFocus />
        <div className="task-form-grid"><label>Project<select value={draft.boardId} disabled={Boolean(current && isActive(current))} onChange={event => { const nextBoard = boardsById.get(event.target.value); setDraft(value => value && ({ ...value, boardId: event.target.value, stageId: nextBoard?.stages.find(stage => stage.category === "backlog")?.id || nextBoard?.stages[0]?.id || "" })); }}>{snapshot.boards.filter(item => !item.archived || item.id === draft.boardId).map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
          <label>Stage<select value={draft.stageId} disabled={Boolean(current && isActive(current))} onChange={event => setDraft(value => value && ({ ...value, stageId: event.target.value }))}>{boardsById.get(draft.boardId)?.stages.map(stage => <option key={stage.id} value={stage.id}>{stage.name}</option>)}</select></label>
          <label>Team<select value={draft.teamId || ""} disabled={Boolean(current && isActive(current))} onChange={event => { const teamId = event.target.value || null, members = teamId ? teamsById.get(teamId)?.memberAgentIds || [] : []; setDraft(value => value && ({ ...value, teamId, ownerAgentId: value.ownerAgentId && members.includes(value.ownerAgentId) ? value.ownerAgentId : null, collaboratorAgentIds: teamId ? value.collaboratorAgentIds.filter(id => members.includes(id)) : [] })); }}><option value="">Unscoped</option>{activeTeams.map(team => <option key={team.id} value={team.id}>{team.name}</option>)}{draft.teamId && teamsById.get(draft.teamId)?.retiredAt && <option value={draft.teamId}>{teamsById.get(draft.teamId)?.name} (retired)</option>}</select></label>
          <label>Owner<select value={draft.ownerAgentId || ""} disabled={Boolean(current && isActive(current))} onChange={event => setDraft(value => value && ({ ...value, ownerAgentId: event.target.value || null, collaboratorAgentIds: value.collaboratorAgentIds.filter(id => id !== event.target.value) }))}><option value="">Unassigned</option>{eligibleAgents.map(agent => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</select></label>
          <label>Priority<select value={draft.priority} onChange={event => setDraft(value => value && ({ ...value, priority: event.target.value as TaskPriority }))}>{PRIORITIES.map(priority => <option value={priority} key={priority}>{priority[0].toUpperCase() + priority.slice(1)}</option>)}</select></label>
          <label className="full">Due date<input type="date" value={draft.dueAt?.slice(0, 10) || ""} onChange={event => setDraft(value => value && ({ ...value, dueAt: event.target.value ? new Date(`${event.target.value}T23:59:59`).toISOString() : null }))} /></label>
        </div>
        <div className="task-form-section"><label>Description</label><textarea rows={5} value={draft.description} onChange={event => setDraft(value => value && ({ ...value, description: event.target.value }))} placeholder="Give the agent the context and expected outcome." />{draft.description && <div className="task-markdown"><ReactMarkdown remarkPlugins={[remarkGfm]}>{draft.description}</ReactMarkdown></div>}</div>
        <div className="task-form-section"><label><Tags size={14} /> Labels</label><input value={draft.labels.join(", ")} onChange={event => setDraft(value => value && ({ ...value, labels: event.target.value.split(",").map(item => item.trim()).filter(Boolean) }))} placeholder="research, launch, writing" /></div>
        <div className="task-form-section"><label><Users size={14} /> Collaborators</label>{!draft.teamId && <p className="muted small">Choose a team to add collaborators.{draft.collaboratorAgentIds.length ? " Existing legacy collaborators are preserved until you change them." : ""}</p>}<div className="collaborator-picker">{eligibleAgents.filter(agent => agent.id !== draft.ownerAgentId).map(agent => <button disabled={!draft.teamId || Boolean(current && isActive(current))} className={draft.collaboratorAgentIds.includes(agent.id) ? "selected" : ""} key={agent.id} onClick={() => setDraft(value => value && ({ ...value, collaboratorAgentIds: value.collaboratorAgentIds.includes(agent.id) ? value.collaboratorAgentIds.filter(id => id !== agent.id) : [...value.collaboratorAgentIds, agent.id] }))}><Avatar agent={agent} />{agent.name}{draft.collaboratorAgentIds.includes(agent.id) && <Check size={13} />}</button>)}</div></div>
        <div className="task-form-section"><div className="section-row"><label><CheckCircle2 size={14} /> Checklist</label><button onClick={() => setDraft(value => value && ({ ...value, checklist: [...value.checklist, { id: uuid(), text: "", done: false, position: value.checklist.length }] }))}><Plus size={13} /> Add item</button></div>{draft.checklist.map((item, index) => <div className="checklist-row" key={item.id}><input type="checkbox" checked={item.done} onChange={event => setDraft(value => value && ({ ...value, checklist: value.checklist.map((entry, itemIndex) => itemIndex === index ? { ...entry, done: event.target.checked } : entry) }))} /><input value={item.text} onChange={event => setDraft(value => value && ({ ...value, checklist: value.checklist.map((entry, itemIndex) => itemIndex === index ? { ...entry, text: event.target.value } : entry) }))} placeholder="Checklist item" /><button aria-label="Remove item" onClick={() => setDraft(value => value && ({ ...value, checklist: value.checklist.filter((_, itemIndex) => itemIndex !== index) }))}><Trash2 size={14} /></button></div>)}</div>
        {current && <><div className="task-form-section"><label><MessageSquare size={14} /> Comments</label><div className="comment-compose"><textarea value={comment} onChange={event => setComment(event.target.value)} rows={2} placeholder="Add a comment" /><button disabled={!comment.trim() || busy} onClick={async () => { const updated = await request<AgentTask>(`/v1/tasks/${current.id}/comments`, { method: "POST", body: JSON.stringify({ body: comment }) }); if (updated) setComment(""); }}>Comment</button></div>{current.comments.map(item => <div className="task-comment" key={item.id}><p>{item.body}</p><time>{item.author || 'you'} · {displayTime(item.createdAt)}</time></div>)}</div>
          <div className="task-form-section"><label><Clock3 size={14} /> Runs and activity</label>{current.runs.map(run => <button className="run-history" key={run.id} onClick={() => onOpenRun(run, current.title)}><span><b>Attempt {run.attempt}</b><small>{displayTime(run.startedAt)}</small></span><span className={`run-pill ${run.state}`}>{runLabel(run.state)}</span>{run.output && <p>{run.output.slice(-2000)}</p>}{run.error && <p className="run-error">{run.error}</p>}</button>)}{current.activity.slice(0, 8).map(item => <div className="activity-row" key={item.id}><i /><span>{item.detail}<small>{displayTime(item.createdAt)}</small></span></div>)}</div></>}
      </div>
      <div className="task-drawer-footer">
        {current && !current.archived && <button className="danger-text" disabled={busy || isActive(current)} onClick={async () => { const updated = await request<AgentTask>(`/v1/tasks/${current.id}`, { method: "PUT", body: JSON.stringify({ revision: current.revision, archived: true }) }); if (updated) closeDetail(); }}><Archive size={14} /> Archive</button>}
        {current?.archived && <button disabled={busy} onClick={async () => { const updated = await request<AgentTask>(`/v1/tasks/${current.id}`, { method: "PUT", body: JSON.stringify({ revision: current.revision, archived: false }) }); if (updated) closeDetail(); }}><RotateCcw size={14} /> Restore</button>}
        <span className="drawer-spacer" />
        {current && !current.activeRunId && boardsById.get(current.boardId)?.stages.find(stage => stage.id === current.stageId)?.category === "review" && <><input className="feedback-input" value={feedback} onChange={event => setFeedback(event.target.value)} placeholder="Changes needed…" /><button disabled={!feedback.trim() || busy} onClick={() => void start(feedback)}>Request changes</button><button className="task-primary" disabled={busy} onClick={async () => { const updated = await request<AgentTask>(`/v1/tasks/${current.id}/approve`, { method: "POST", body: JSON.stringify({ revision: current.revision }) }); if (updated) closeDetail(); }}><Check size={14} /> Approve</button></>}
        {current?.activeRunId && <><button className="danger-text" disabled={busy} onClick={() => void request(`/v1/tasks/${current.id}/stop`, { method: "POST" })}><CircleAlert size={14} /> Stop</button><button onClick={() => current.runs[0] && onOpenRun(current.runs[0], current.title)}><Clock3 size={14} /> Open run</button></>}
        {!current?.activeRunId && !(current && boardsById.get(current.boardId)?.stages.find(stage => stage.id === current.stageId)?.category === "review") && <button className="task-primary" disabled={busy || !draft.title.trim() || !draft.ownerAgentId || draft.archived} onClick={() => void start()}><Play size={14} /> {current?.runs.length ? "Retry" : "Start"}</button>}
        <button disabled={busy || !draft.title.trim()} onClick={() => void save()}>{busy ? <LoaderCircle className="spin" size={14} /> : <Check size={14} />} Save</button>
      </div>
    </aside></div>}

    {newBoardOpen && <div className="modal-backdrop" onClick={() => setNewBoardOpen(false)}><section className="modal board-create" role="dialog" aria-modal="true" aria-labelledby="new-board-title" onClick={event => event.stopPropagation()} onKeyDown={event => { if (event.key === "Enter" && newBoard.name.trim() && !busy) void createBoard(); }}><div className="modal-heading"><h2 id="new-board-title">New project</h2><button aria-label="Close new project" onClick={() => setNewBoardOpen(false)}><X size={18} /></button></div><label>Project name<input autoFocus value={newBoard.name} onChange={event => setNewBoard(value => ({ ...value, name: event.target.value }))} placeholder="Website launch" /></label><label>Description<textarea rows={2} value={newBoard.description} onChange={event => setNewBoard(value => ({ ...value, description: event.target.value }))} placeholder="What this project is for." /></label><ColorPicker value={newBoard.color} onChange={color => setNewBoard(value => ({ ...value, color }))} /><OwnerSelect label="Default owner" agents={agents} value={newBoard.defaultOwnerAgentId} onChange={defaultOwnerAgentId => setNewBoard(value => ({ ...value, defaultOwnerAgentId }))} /><div className="modal-footer"><button onClick={() => setNewBoardOpen(false)}>Cancel</button><button className="light-button" disabled={!newBoard.name.trim() || busy} onClick={() => void createBoard()}>{busy ? <LoaderCircle className="spin" size={14} /> : <Plus size={14} />} Create project</button></div></section></div>}
    {boardOpen && board && <BoardSettings board={board} agents={agents} tasks={snapshot.tasks.filter(task => task.boardId === board.id)} busy={busy} request={request} onClose={() => setBoardOpen(false)} onDelete={() => { setBoardOpen(false); setConfirmDeleteBoard(board); }} />}
    {confirmDeleteBoard && <DeleteProjectModal board={confirmDeleteBoard} summary={summariesById.get(confirmDeleteBoard.id)} busy={busy} onCancel={() => setConfirmDeleteBoard(null)} onConfirm={() => void deleteBoard(confirmDeleteBoard)} />}
  </section>;
}

function BoardSettings({ board, agents, tasks, busy, request, onClose, onDelete }: { board: TaskBoard; agents: Agent[]; tasks: AgentTask[]; busy: boolean; request: <T>(path: string, init: RequestInit) => Promise<T | null>; onClose: () => void; onDelete: () => void }) {
  const [name, setName] = useState(board.name);
  const [meta, setMeta] = useState({ description: board.description, color: board.color, defaultOwnerAgentId: board.defaultOwnerAgentId });
  const [settings, setSettings] = useState(board.settings);
  const [newStage, setNewStage] = useState("");
  const saveBoard = async (archived = board.archived) => { const saved = await request<TaskBoard>(`/v1/boards/${board.id}`, { method: "PUT", body: JSON.stringify({ revision: board.revision, name, ...meta, archived, settings }) }); if (saved) onClose(); };
  return <div className="modal-backdrop" onClick={onClose}><section className="modal board-settings" role="dialog" aria-modal="true" aria-labelledby="board-settings-title" onClick={event => event.stopPropagation()}><div className="modal-heading"><h2 id="board-settings-title">Project settings</h2><button onClick={onClose}><X size={18} /></button></div><label>Project name<input value={name} onChange={event => setName(event.target.value)} /></label><label>Description<textarea rows={2} value={meta.description} onChange={event => setMeta(value => ({ ...value, description: event.target.value }))} placeholder="What this project is for." /></label><ColorPicker value={meta.color} onChange={color => setMeta(value => ({ ...value, color }))} /><OwnerSelect label="Default owner for new tasks" agents={agents} value={meta.defaultOwnerAgentId} onChange={defaultOwnerAgentId => setMeta(value => ({ ...value, defaultOwnerAgentId }))} /><div className="profile-two-columns"><label>Run stage<select value={settings.runStageId} onChange={event => setSettings(value => ({ ...value, runStageId: event.target.value }))}>{board.stages.map(stage => <option value={stage.id} key={stage.id}>{stage.name}</option>)}</select></label><label>Completion stage<select value={settings.doneStageId} onChange={event => setSettings(value => ({ ...value, doneStageId: event.target.value }))}>{board.stages.map(stage => <option value={stage.id} key={stage.id}>{stage.name}</option>)}</select></label></div><Toggle label="Run tasks when dropped" checked={settings.autoRunOnDrop} onChange={autoRunOnDrop => setSettings(value => ({ ...value, autoRunOnDrop }))} /><Toggle label="Allow agents to dispatch work" checked={settings.allowAgentDispatch} onChange={allowAgentDispatch => setSettings(value => ({ ...value, allowAgentDispatch }))} /><h3>Stages</h3><p className="muted small">Rename, categorize, and reorder this board&apos;s workflow.</p><div className="stage-editor">{board.stages.map((stage, index) => {
    const count = tasks.filter(task => task.stageId === stage.id).length;
    const update = (patch: object) => request<TaskBoard>(`/v1/stages/${stage.id}`, { method: "PUT", body: JSON.stringify(patch) });
    return <div className="stage-editor-row" key={stage.id}><input defaultValue={stage.name} onBlur={event => event.target.value !== stage.name && void update({ name: event.target.value })} /><select value={stage.category} onChange={event => void update({ category: event.target.value })}>{CATEGORIES.map(category => <option key={category.id} value={category.id}>{category.label}</option>)}</select><span>{count}</span><button disabled={index === 0} onClick={() => void update({ position: board.stages[index - 1].position - .5 })} aria-label="Move stage left"><ArrowUp size={13} /></button><button disabled={index === board.stages.length - 1} onClick={() => void update({ position: board.stages[index + 1].position + .5 })} aria-label="Move stage right"><ArrowDown size={13} /></button><button className="danger-text" aria-label="Delete stage" onClick={() => { const target = board.stages.find(item => item.id !== stage.id); if (target) void request(`/v1/stages/${stage.id}?moveToStageId=${encodeURIComponent(target.id)}`, { method: "DELETE" }); }}><Trash2 size={13} /></button></div>;
  })}</div><div className="add-stage"><input value={newStage} onChange={event => setNewStage(event.target.value)} placeholder="New stage name" /><button disabled={!newStage.trim() || busy} onClick={async () => { const saved = await request<TaskBoard>(`/v1/boards/${board.id}/stages`, { method: "POST", body: JSON.stringify({ name: newStage, category: "backlog" }) }); if (saved) setNewStage(""); }}><Plus size={14} /> Add</button></div><div className="modal-footer"><button className="danger-text" disabled={busy} onClick={onDelete}><Trash2 size={14} /> Delete</button><button className="danger-text" disabled={busy} onClick={() => void saveBoard(!board.archived)}>{board.archived ? <RotateCcw size={14} /> : <Archive size={14} />}{board.archived ? "Restore project" : "Archive project"}</button><button className="light-button" disabled={!name.trim() || busy} onClick={() => void saveBoard()}><Check size={14} /> Save</button></div></section></div>;
}

function ProjectsView({ boards, summaries, agents, busy, stale, showArchived, onShowArchived, onOpen, onSettings, onDelete, onCreate, request }: {
  boards: TaskBoard[]; summaries: Map<string, BoardSummary>; agents: Agent[]; busy: boolean; stale: boolean;
  showArchived: boolean; onShowArchived: (value: boolean) => void;
  onOpen: (boardId: string) => void; onSettings: (boardId: string) => void; onDelete: (board: TaskBoard) => void;
  onCreate: () => void; request: <T>(path: string, init: RequestInit) => Promise<T | null>;
}) {
  const agentsById = useMemo(() => new Map(agents.map(agent => [agent.id, agent])), [agents]);
  const active = boards.filter(item => !item.archived);
  const archived = boards.filter(item => item.archived);
  // Arrow reordering rather than drag: the kanban already owns a drag surface, and arrows
  // are reachable from the keyboard without pulling in a second one.
  const reorder = (boardId: string, direction: -1 | 1) => {
    const ids = active.map(item => item.id), index = ids.indexOf(boardId), next = index + direction;
    if (index < 0 || next < 0 || next >= ids.length) return;
    ids.splice(next, 0, ...ids.splice(index, 1));
    void request("/v1/boards/reorder", { method: "POST", body: JSON.stringify({ ids }) });
  };
  const rename = (item: TaskBoard, value: string) => {
    if (!value.trim() || value === item.name) return;
    void request<TaskBoard>(`/v1/boards/${item.id}`, { method: "PUT", body: JSON.stringify({ revision: item.revision, name: value.trim() }) });
  };
  const setArchived = (item: TaskBoard, archivedNext: boolean) =>
    void request<TaskBoard>(`/v1/boards/${item.id}`, { method: "PUT", body: JSON.stringify({ revision: item.revision, archived: archivedNext }) });

  const card = (item: TaskBoard, index: number, orderable: boolean) => {
    const summary = { boardId: item.id, ...EMPTY_SUMMARY, ...summaries.get(item.id) };
    const done = summary.byCategory.done || 0;
    const percent = summary.total ? Math.round((done / summary.total) * 100) : 0;
    const owners = summary.ownerAgentIds.map(id => agentsById.get(id)).filter(Boolean).slice(0, 4);
    return <article className="project-card" key={item.id}>
      <div className="project-card-head">
        <ProjectDot color={item.color} size={12} />
        <input className="project-name" aria-label={`Rename ${item.name}`} defaultValue={item.name} disabled={stale}
          onKeyDown={event => { if (event.key === "Enter") event.currentTarget.blur(); }}
          onBlur={event => rename(item, event.target.value)} />
        {item.archived && <i className="project-badge">Archived</i>}
        {summary.activeRuns > 0 && <span className="run-pill running">{summary.activeRuns} running</span>}
      </div>
      {item.description && <p className="project-card-desc">{item.description}</p>}
      <div className="project-progress" role="img" aria-label={`${done} of ${summary.total} tasks done`}><i style={{ width: `${percent}%` }} /></div>
      <div className="project-card-counts">{CATEGORIES.map(category => <span key={category.id}><b>{summary.byCategory[category.id] || 0}</b>{category.label}</span>)}</div>
      <div className="project-card-foot">
        <span className="project-owners">{owners.length === 0 ? <small>No owners yet</small> : owners.map(agent => <Avatar key={agent!.id} agent={agent} />)}{summary.ownerAgentIds.length > owners.length && <small>+{summary.ownerAgentIds.length - owners.length}</small>}</span>
        {summary.archivedCount > 0 && <small>{summary.archivedCount} archived</small>}
      </div>
      <div className="project-card-actions">
        <button className="light-button" disabled={stale} onClick={() => onOpen(item.id)}><LayoutDashboard size={14} /> Open</button>
        <button disabled={stale} onClick={() => onSettings(item.id)} aria-label={`Settings for ${item.name}`}><Settings2 size={14} /></button>
        <button disabled={stale || busy} onClick={() => void request(`/v1/boards/${item.id}/duplicate`, { method: "POST", body: JSON.stringify({}) })} aria-label={`Duplicate ${item.name}`}><Copy size={14} /></button>
        <button disabled={stale || busy} onClick={() => setArchived(item, !item.archived)} aria-label={item.archived ? `Restore ${item.name}` : `Archive ${item.name}`}>{item.archived ? <RotateCcw size={14} /> : <Archive size={14} />}</button>
        <button className="danger-text" disabled={stale || busy} onClick={() => onDelete(item)} aria-label={`Delete ${item.name}`}><Trash2 size={14} /></button>
        {orderable && <><button disabled={stale || index === 0} onClick={() => reorder(item.id, -1)} aria-label={`Move ${item.name} earlier`}><ArrowUp size={13} /></button>
        <button disabled={stale || index === active.length - 1} onClick={() => reorder(item.id, 1)} aria-label={`Move ${item.name} later`}><ArrowDown size={13} /></button></>}
      </div>
    </article>;
  };

  return <div className="projects-page">
    <div className="projects-grid">{active.map((item, index) => card(item, index, true))}
      <button className="project-add" disabled={stale} onClick={onCreate}><Plus size={16} /> New project</button>
    </div>
    <div className="projects-archived">
      <Toggle label="Show archived projects" checked={showArchived} onChange={onShowArchived} />
      {showArchived && (archived.length > 0
        ? <div className="projects-grid">{archived.map(item => card(item, 0, false))}</div>
        : <p className="muted small">No archived projects.</p>)}
    </div>
  </div>;
}

function DeleteProjectModal({ board, summary, busy, onCancel, onConfirm }: { board: TaskBoard; summary?: BoardSummary; busy: boolean; onCancel: () => void; onConfirm: () => void }) {
  const [typed, setTyped] = useState("");
  const count = (summary?.total || 0) + (summary?.archivedCount || 0);
  return <div className="modal-backdrop" onClick={onCancel}><section className="modal project-delete" role="alertdialog" aria-modal="true" aria-labelledby="delete-project-title" onClick={event => event.stopPropagation()}>
    <div className="modal-heading"><h2 id="delete-project-title">Delete this project?</h2><button aria-label="Cancel delete" onClick={onCancel}><X size={18} /></button></div>
    <p>Deleting <strong>{board.name}</strong> also deletes {count} task{count === 1 ? "" : "s"} with their checklists, comments, and activity. Runs already recorded stay in the run history. This cannot be undone.</p>
    <label>Type <b>{board.name}</b> to confirm<input autoFocus value={typed} onChange={event => setTyped(event.target.value)} /></label>
    <div className="modal-footer"><button onClick={onCancel}>Keep project</button><button className="danger-button" disabled={typed.trim() !== board.name || busy} onClick={onConfirm}>{busy ? <LoaderCircle className="spin" size={14} /> : <Trash2 size={14} />} Delete project</button></div>
  </section></div>;
}
