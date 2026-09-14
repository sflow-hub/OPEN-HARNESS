"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Archive, ArrowDown, ArrowLeft, ArrowRight, ArrowUp, CalendarDays, Check,
  CheckCircle2, ChevronDown, CircleAlert, Clock3, Filter, GripVertical, LayoutDashboard,
  List, LoaderCircle, MessageSquare, Play, Plus, RotateCcw, Search,
  Settings2, Tags, Trash2, Users, X,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { ControlClient, PersistentRun } from "../lib/control-client";
import type { Agent } from "../lib/types";
import type { AgentTask, TaskBoard, TaskPriority, TaskSnapshot, WorkflowCategory } from "../lib/task-types";

type TaskView = "board" | "list" | "agent";
type Filters = {
  owners: string[]; collaborators: string[]; assigned: string[]; stages: string[];
  priorities: string[]; labels: string[]; due: string[]; runs: string[]; archived: boolean;
};
type Draft = Omit<AgentTask, "runs" | "activity" | "comments" | "runState" | "activeRunId" | "createdAt" | "updatedAt">;
const EMPTY_FILTERS: Filters = { owners: [], collaborators: [], assigned: [], stages: [], priorities: [], labels: [], due: [], runs: [], archived: false };
const CATEGORIES: Array<{ id: WorkflowCategory; label: string }> = [
  { id: "backlog", label: "Backlog" }, { id: "ready", label: "Ready" },
  { id: "in_progress", label: "In progress" }, { id: "review", label: "Review" }, { id: "done", label: "Done" },
];
const PRIORITIES: TaskPriority[] = ["low", "normal", "high", "urgent"];
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
    title: "", description: "", ownerAgentId: null, collaboratorAgentIds: [], priority: "normal", labels: [], dueAt: null,
    position: 0, archived: false, revision: 0, checklist: [],
  };
}

function Avatar({ agent, empty = false }: { agent?: Agent; empty?: boolean }) {
  return <span className={`task-avatar ${agent ? `tone-${agent.tone % 6}` : "unassigned"}`}>{empty ? "–" : agent?.name[0] || "?"}</span>;
}

function FilterGroup({ title, options, values, onChange }: { title: string; options: Array<{ id: string; label: string }>; values: string[]; onChange: (next: string[]) => void }) {
  return <fieldset className="filter-group"><legend>{title}</legend>{options.map(option => <label key={option.id}>
    <input type="checkbox" checked={values.includes(option.id)} onChange={() => onChange(values.includes(option.id) ? values.filter(value => value !== option.id) : [...values, option.id])} />
    {option.label}
  </label>)}</fieldset>;
}

export default function TaskManager({ agents, client, onOpenRun }: { agents: Agent[]; client: ControlClient; onOpenRun: (run: PersistentRun, title: string) => void }) {
  const [snapshot, setSnapshot] = useState<TaskSnapshot>({ boards: [], tasks: [] });
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
  const [detailId, setDetailId] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [comment, setComment] = useState("");
  const [feedback, setFeedback] = useState("");
  const [sort, setSort] = useState<{ key: keyof AgentTask; direction: 1 | -1 }>({ key: "position", direction: 1 });
  const [dragged, setDragged] = useState<string | null>(null);
  const [clock, setClock] = useState(Date.now);

  const refresh = useCallback(async (quiet = false) => {
    try {
      const value = await client.request<TaskSnapshot>(`/v1/tasks?includeArchived=${filters.archived ? "1" : "0"}`);
      setSnapshot(value); setLoaded(true); setStale(false);
      setSelectedBoard(current => current === "all" || value.boards.some(board => board.id === current) ? current : "all");
      if (!quiet) setError("");
    } catch (cause) {
      setStale(true); setLoaded(true);
      if (!quiet) setError(cause instanceof Error ? cause.message : "Task data is unavailable.");
    }
  }, [client, filters.archived]);

  useEffect(() => {
    // Hydrate device-local view preferences after the server-rendered frame.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    try { const saved = JSON.parse(localStorage.getItem(PREF_KEY) || "{}"); if (["board", "list", "agent"].includes(saved.taskView)) setTaskView(saved.taskView); if (typeof saved.selectedBoard === "string") setSelectedBoard(saved.selectedBoard); } catch {}
  }, []);
  useEffect(() => { localStorage.setItem(PREF_KEY, JSON.stringify({ taskView, selectedBoard })); }, [taskView, selectedBoard]);
  useEffect(() => {
    // The service is the task source of truth; refresh immediately on mount.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
    const timer = window.setInterval(() => void refresh(true), 2000);
    return () => window.clearInterval(timer);
  }, [refresh]);
  useEffect(() => { const timer = window.setInterval(() => setClock(Date.now()), 60_000); return () => window.clearInterval(timer); }, []);

  const board = snapshot.boards.find(item => item.id === selectedBoard);
  const boardsById = useMemo(() => new Map(snapshot.boards.map(item => [item.id, item])), [snapshot.boards]);
  const agentsById = useMemo(() => new Map(agents.map(item => [item.id, item])), [agents]);
  const allLabels = useMemo(() => [...new Set(snapshot.tasks.flatMap(task => task.labels))].sort(), [snapshot.tasks]);
  const activeFilterCount = Object.entries(filters).reduce((total, [key, value]) => total + (key === "archived" ? (value ? 1 : 0) : (value as string[]).length), 0);
  const tasks = useMemo(() => snapshot.tasks.filter(task => {
    if (selectedBoard !== "all" && task.boardId !== selectedBoard) return false;
    const query = search.trim().toLowerCase();
    if (query && ![task.title, task.description, ...task.labels].join(" ").toLowerCase().includes(query)) return false;
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
    setDraft({ id: task.id, boardId: task.boardId, stageId: task.stageId, title: task.title, description: task.description, ownerAgentId: task.ownerAgentId, collaboratorAgentIds: task.collaboratorAgentIds, priority: task.priority, labels: task.labels, dueAt: task.dueAt, position: task.position, archived: task.archived, revision: task.revision, checklist: task.checklist });
  };
  const createTask = (stageId?: string) => {
    const target = board || snapshot.boards.find(item => !item.archived);
    if (!target) return;
    const next = emptyDraft(target); if (stageId) next.stageId = stageId;
    setDetailId("new"); setDraft(next);
  };
  const closeDetail = () => { setDetailId(null); setDraft(null); setComment(""); setFeedback(""); };
  const current = detailId && detailId !== "new" ? snapshot.tasks.find(task => task.id === detailId) : null;

  const save = async () => {
    if (!draft) return null;
    const path = draft.id ? `/v1/tasks/${draft.id}` : "/v1/tasks";
    const saved = await request<AgentTask>(path, { method: draft.id ? "PUT" : "POST", body: JSON.stringify(draft) });
    if (saved) { setDetailId(saved.id); setDraft({ ...draft, id: saved.id, revision: saved.revision }); }
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
    await request(`/v1/tasks/${task.id}`, { method: "PUT", body: JSON.stringify({ revision: task.revision, stageId, position: position ?? task.position }) });
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
    ? CATEGORIES.map(category => ({ ...category, taskStageIds: snapshot.boards.flatMap(item => item.stages.filter(stage => stage.category === category.id).map(stage => stage.id)) }))
    : (board?.stages || []).map(stage => ({ id: stage.id, label: stage.name, taskStageIds: [stage.id] }));

  return <section className="tasks-page">
    <div className="tasks-heading">
      <div><div className="eyebrow">AGENT WORK QUEUE</div><h1>Tasks</h1><p>Plan the work, assign your agents, and follow every task through review.</p></div>
      <div className="task-heading-actions"><button disabled={stale || busy} onClick={async () => { const name = window.prompt("Project board name"); if (name?.trim()) { const created = await request<TaskBoard>("/v1/boards", { method: "POST", body: JSON.stringify({ name }) }); if (created) setSelectedBoard(created.id); } }}><Plus size={15} /> New board</button><button className="task-primary" disabled={stale || busy || !snapshot.boards.length} onClick={() => createTask()}><Plus size={16} /> New task</button></div>
    </div>
    {stale && <div className="task-alert"><CircleAlert size={16} /> Showing the last task data received. Editing is paused until the local service reconnects.<button onClick={() => void refresh()}>Retry</button></div>}
    {error && <div className="task-alert error"><CircleAlert size={16} /> {error}<button aria-label="Dismiss" onClick={() => setError("")}><X size={15} /></button></div>}
    <div className="task-toolbar">
      <label className="task-select"><span>Project</span><select value={selectedBoard} onChange={event => setSelectedBoard(event.target.value)}><option value="all">All tasks</option>{snapshot.boards.map(item => <option value={item.id} key={item.id}>{item.name}{item.archived ? " (archived)" : ""}</option>)}</select><ChevronDown size={14} /></label>
      <div className="task-view-switch" aria-label="Task view">
        <button className={taskView === "board" ? "active" : ""} onClick={() => setTaskView("board")}><LayoutDashboard size={14} /> Board</button>
        <button className={taskView === "list" ? "active" : ""} onClick={() => setTaskView("list")}><List size={14} /> List</button>
        <button className={taskView === "agent" ? "active" : ""} onClick={() => setTaskView("agent")}><Users size={14} /> By agent</button>
      </div>
      <label className="task-search"><Search size={15} /><input value={search} onChange={event => setSearch(event.target.value)} aria-label="Search tasks" placeholder="Search tasks" /></label>
      <button className={`task-filter ${filtersOpen ? "active" : ""}`} onClick={() => setFiltersOpen(value => !value)}><Filter size={15} /> Filter{activeFilterCount > 0 && <b>{activeFilterCount}</b>}</button>
      {board && <button className="task-icon-button" aria-label="Board settings" onClick={() => setBoardOpen(true)}><Settings2 size={16} /></button>}
    </div>
    {activeFilterCount > 0 && <div className="filter-chips">{Object.entries(filters).flatMap(([key, value]) => key === "archived" ? (value ? [<span key="archived">Archived included</span>] : []) : (value as string[]).map(item => <span key={`${key}-${item}`}>{item.replaceAll("_", " ")}</span>))}<button onClick={() => setFilters(EMPTY_FILTERS)}>Clear all</button></div>}
    {filtersOpen && <div className="filter-panel">
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

    {taskView === "board" && <div className="kanban-board">{boardColumns.map(column => {
      const columnTasks = tasks.filter(task => column.taskStageIds.includes(task.stageId));
      return <section className="kanban-column" key={column.id} onDragOver={event => event.preventDefault()} onDrop={() => { const task = snapshot.tasks.find(item => item.id === dragged); const targetStage = selectedBoard === "all" ? boardsById.get(task?.boardId || "")?.stages.find(stage => stage.category === column.id) : board?.stages.find(stage => stage.id === column.id); if (task && targetStage) void move(task, targetStage.id, columnTasks.length); }}>
        <div className="kanban-column-title"><span>{column.label}</span><b>{columnTasks.length}</b></div>
        {columnTasks.map(task => renderCard(task, boardsById.get(task.boardId)?.stages || []))}
        {selectedBoard !== "all" && <button className="kanban-add" disabled={stale} onClick={() => createTask(String(column.id))}><Plus size={14} /> Add task</button>}
      </section>;
    })}</div>}

    {taskView === "list" && <div className="task-table-wrap"><table className="task-table"><thead><tr>{[["title", "Task"], ["boardId", "Project"], ["stageId", "Stage"], ["ownerAgentId", "Owner"], ["priority", "Priority"], ["dueAt", "Due"], ["runState", "Execution"]].map(([key, label]) => <th key={key}><button onClick={() => setSort(currentSort => ({ key: key as keyof AgentTask, direction: currentSort.key === key ? currentSort.direction === 1 ? -1 : 1 : 1 }))}>{label}{sort.key === key && (sort.direction === 1 ? <ArrowUp size={12} /> : <ArrowDown size={12} />)}</button></th>)}</tr></thead><tbody>{[...tasks].sort((a, b) => String(a[sort.key] || "").localeCompare(String(b[sort.key] || "")) * sort.direction).map(task => {
      const taskBoard = boardsById.get(task.boardId); const owner = task.ownerAgentId ? agentsById.get(task.ownerAgentId) : undefined;
      return <tr key={task.id} onClick={() => openTask(task)}><td><strong>{task.title}</strong>{task.labels.length > 0 && <small>{task.labels.join(" · ")}</small>}</td><td>{taskBoard?.name}</td><td>{taskBoard?.stages.find(stage => stage.id === task.stageId)?.name}</td><td><span className="table-owner"><Avatar agent={owner} empty={!owner} />{owner?.name || "Unassigned"}{task.collaboratorAgentIds.length > 0 && <small>+{task.collaboratorAgentIds.length}</small>}</span></td><td><span className={`task-priority ${task.priority}`}>{task.priority}</span></td><td>{displayDate(task.dueAt)}</td><td><span className={`run-pill ${task.runState || ""}`}>{runLabel(task.runState)}</span></td></tr>;
    })}</tbody></table>{tasks.length === 0 && <div className="task-empty">No tasks match this view.</div>}</div>}

    {taskView === "agent" && <div className="agent-task-grid">{[...agents, undefined].map(agent => {
      const owned = tasks.filter(task => agent ? task.ownerAgentId === agent.id : !task.ownerAgentId);
      const collaborating = agent ? tasks.filter(task => task.collaboratorAgentIds.includes(agent.id) && task.ownerAgentId !== agent.id) : [];
      const queued = owned.filter(task => task.runState === "queued"); const running = owned.filter(task => ["running", "waiting_approval", "waiting_input"].includes(task.runState || ""));
      const review = owned.filter(task => boardsById.get(task.boardId)?.stages.find(stage => stage.id === task.stageId)?.category === "review");
      const applyAgent = (kind: "owned" | "collab" | "queued" | "running" | "review") => { setFilters({ ...EMPTY_FILTERS, ...(kind === "owned" ? { owners: [agent?.id || "unassigned"] } : kind === "collab" ? { collaborators: agent ? [agent.id] : [] } : kind === "queued" ? { owners: [agent?.id || "unassigned"], runs: ["queued"] } : kind === "running" ? { owners: [agent?.id || "unassigned"], runs: ["running", "waiting_approval", "waiting_input"] } : { owners: [agent?.id || "unassigned"], stages: ["review"] }) }); setTaskView("list"); };
      return <article className="agent-task-card" key={agent?.id || "unassigned"}><div className="agent-task-head"><Avatar agent={agent} empty={!agent} /><div><strong>{agent?.name || "Unassigned"}</strong><small>{agent?.role || "Tasks waiting for an owner"}</small></div></div><div className="agent-task-counts"><button onClick={() => applyAgent("owned")}><b>{owned.length}</b><span>Owned</span></button><button onClick={() => applyAgent("collab")} disabled={!agent}><b>{collaborating.length}</b><span>Collaborating</span></button><button onClick={() => applyAgent("running")}><b>{running.length}</b><span>Running</span></button><button onClick={() => applyAgent("queued")}><b>{queued.length}</b><span>Queued</span></button><button onClick={() => applyAgent("review")}><b>{review.length}</b><span>Review</span></button></div></article>;
    })}</div>}

    {draft && <div className="task-drawer-backdrop" onClick={closeDetail}><aside className="task-drawer" role="dialog" aria-modal="true" aria-labelledby="task-detail-title" onClick={event => event.stopPropagation()}>
      <div className="task-drawer-head"><span>{draft.id ? "Task details" : "New task"}</span><button onClick={closeDetail} aria-label="Close task"><X size={19} /></button></div>
      <div className="task-drawer-scroll">
        <input id="task-detail-title" className="task-title-input" value={draft.title} onChange={event => setDraft(value => value && ({ ...value, title: event.target.value }))} placeholder="What needs to be done?" autoFocus />
        <div className="task-form-grid"><label>Project<select value={draft.boardId} disabled={Boolean(current && isActive(current))} onChange={event => { const nextBoard = boardsById.get(event.target.value); setDraft(value => value && ({ ...value, boardId: event.target.value, stageId: nextBoard?.stages.find(stage => stage.category === "backlog")?.id || nextBoard?.stages[0]?.id || "" })); }}>{snapshot.boards.filter(item => !item.archived || item.id === draft.boardId).map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
          <label>Stage<select value={draft.stageId} disabled={Boolean(current && isActive(current))} onChange={event => setDraft(value => value && ({ ...value, stageId: event.target.value }))}>{boardsById.get(draft.boardId)?.stages.map(stage => <option key={stage.id} value={stage.id}>{stage.name}</option>)}</select></label>
          <label>Owner<select value={draft.ownerAgentId || ""} disabled={Boolean(current && isActive(current))} onChange={event => setDraft(value => value && ({ ...value, ownerAgentId: event.target.value || null }))}><option value="">Unassigned</option>{agents.map(agent => <option key={agent.id} value={agent.id}>{agent.name}</option>)}</select></label>
          <label>Priority<select value={draft.priority} onChange={event => setDraft(value => value && ({ ...value, priority: event.target.value as TaskPriority }))}>{PRIORITIES.map(priority => <option value={priority} key={priority}>{priority[0].toUpperCase() + priority.slice(1)}</option>)}</select></label>
          <label className="full">Due date<input type="date" value={draft.dueAt?.slice(0, 10) || ""} onChange={event => setDraft(value => value && ({ ...value, dueAt: event.target.value ? new Date(`${event.target.value}T23:59:59`).toISOString() : null }))} /></label>
        </div>
        <div className="task-form-section"><label>Description</label><textarea rows={5} value={draft.description} onChange={event => setDraft(value => value && ({ ...value, description: event.target.value }))} placeholder="Give the agent the context and expected outcome." />{draft.description && <div className="task-markdown"><ReactMarkdown remarkPlugins={[remarkGfm]}>{draft.description}</ReactMarkdown></div>}</div>
        <div className="task-form-section"><label><Tags size={14} /> Labels</label><input value={draft.labels.join(", ")} onChange={event => setDraft(value => value && ({ ...value, labels: event.target.value.split(",").map(item => item.trim()).filter(Boolean) }))} placeholder="research, launch, writing" /></div>
        <div className="task-form-section"><label><Users size={14} /> Collaborators</label><div className="collaborator-picker">{agents.map(agent => <button className={draft.collaboratorAgentIds.includes(agent.id) ? "selected" : ""} key={agent.id} onClick={() => setDraft(value => value && ({ ...value, collaboratorAgentIds: value.collaboratorAgentIds.includes(agent.id) ? value.collaboratorAgentIds.filter(id => id !== agent.id) : [...value.collaboratorAgentIds, agent.id] }))}><Avatar agent={agent} />{agent.name}{draft.collaboratorAgentIds.includes(agent.id) && <Check size={13} />}</button>)}</div></div>
        <div className="task-form-section"><div className="section-row"><label><CheckCircle2 size={14} /> Checklist</label><button onClick={() => setDraft(value => value && ({ ...value, checklist: [...value.checklist, { id: uuid(), text: "", done: false, position: value.checklist.length }] }))}><Plus size={13} /> Add item</button></div>{draft.checklist.map((item, index) => <div className="checklist-row" key={item.id}><input type="checkbox" checked={item.done} onChange={event => setDraft(value => value && ({ ...value, checklist: value.checklist.map((entry, itemIndex) => itemIndex === index ? { ...entry, done: event.target.checked } : entry) }))} /><input value={item.text} onChange={event => setDraft(value => value && ({ ...value, checklist: value.checklist.map((entry, itemIndex) => itemIndex === index ? { ...entry, text: event.target.value } : entry) }))} placeholder="Checklist item" /><button aria-label="Remove item" onClick={() => setDraft(value => value && ({ ...value, checklist: value.checklist.filter((_, itemIndex) => itemIndex !== index) }))}><Trash2 size={14} /></button></div>)}</div>
        {current && <><div className="task-form-section"><label><MessageSquare size={14} /> Comments</label><div className="comment-compose"><textarea value={comment} onChange={event => setComment(event.target.value)} rows={2} placeholder="Add a comment" /><button disabled={!comment.trim() || busy} onClick={async () => { const updated = await request<AgentTask>(`/v1/tasks/${current.id}/comments`, { method: "POST", body: JSON.stringify({ body: comment }) }); if (updated) setComment(""); }}>Comment</button></div>{current.comments.map(item => <div className="task-comment" key={item.id}><p>{item.body}</p><time>{displayTime(item.createdAt)}</time></div>)}</div>
          <div className="task-form-section"><label><Clock3 size={14} /> Runs and activity</label>{current.runs.map(run => <button className="run-history" key={run.id} onClick={() => onOpenRun(run, current.title)}><span><b>Attempt {run.attempt}</b><small>{displayTime(run.startedAt)}</small></span><span className={`run-pill ${run.state}`}>{runLabel(run.state)}</span>{run.result && <p>{run.result}</p>}{run.error && <p className="run-error">{run.error}</p>}</button>)}{current.activity.slice(0, 8).map(item => <div className="activity-row" key={item.id}><i /><span>{item.detail}<small>{displayTime(item.createdAt)}</small></span></div>)}</div></>}
      </div>
      <div className="task-drawer-footer">
        {current && !current.archived && <button className="danger-text" disabled={busy || isActive(current)} onClick={async () => { const updated = await request<AgentTask>(`/v1/tasks/${current.id}`, { method: "PUT", body: JSON.stringify({ revision: current.revision, archived: true }) }); if (updated) closeDetail(); }}><Archive size={14} /> Archive</button>}
        {current?.archived && <button disabled={busy} onClick={async () => { const updated = await request<AgentTask>(`/v1/tasks/${current.id}`, { method: "PUT", body: JSON.stringify({ revision: current.revision, archived: false }) }); if (updated) closeDetail(); }}><RotateCcw size={14} /> Restore</button>}
        <span className="drawer-spacer" />
        {current && !current.activeRunId && boardsById.get(current.boardId)?.stages.find(stage => stage.id === current.stageId)?.category === "review" && <><input className="feedback-input" value={feedback} onChange={event => setFeedback(event.target.value)} placeholder="Changes needed…" /><button disabled={!feedback.trim() || busy} onClick={() => void start(feedback)}>Request changes</button><button className="task-primary" disabled={busy} onClick={async () => { const updated = await request<AgentTask>(`/v1/tasks/${current.id}/approve`, { method: "POST", body: JSON.stringify({ revision: current.revision }) }); if (updated) closeDetail(); }}><Check size={14} /> Approve</button></>}
        {current?.activeRunId && <button onClick={() => current.runs[0] && onOpenRun(current.runs[0], current.title)}><Clock3 size={14} /> Open run</button>}
        {!current?.activeRunId && !(current && boardsById.get(current.boardId)?.stages.find(stage => stage.id === current.stageId)?.category === "review") && <button className="task-primary" disabled={busy || !draft.title.trim() || !draft.ownerAgentId || draft.archived} onClick={() => void start()}><Play size={14} /> {current?.runs.length ? "Retry" : "Start"}</button>}
        <button disabled={busy || !draft.title.trim()} onClick={() => void save()}>{busy ? <LoaderCircle className="spin" size={14} /> : <Check size={14} />} Save</button>
      </div>
    </aside></div>}

    {boardOpen && board && <BoardSettings board={board} tasks={snapshot.tasks.filter(task => task.boardId === board.id)} busy={busy} request={request} onClose={() => setBoardOpen(false)} />}
  </section>;
}

function BoardSettings({ board, tasks, busy, request, onClose }: { board: TaskBoard; tasks: AgentTask[]; busy: boolean; request: <T>(path: string, init: RequestInit) => Promise<T | null>; onClose: () => void }) {
  const [name, setName] = useState(board.name);
  const [newStage, setNewStage] = useState("");
  const saveBoard = async (archived = board.archived) => { const saved = await request<TaskBoard>(`/v1/boards/${board.id}`, { method: "PUT", body: JSON.stringify({ revision: board.revision, name, archived }) }); if (saved) onClose(); };
  return <div className="modal-backdrop" onClick={onClose}><section className="modal board-settings" role="dialog" aria-modal="true" aria-labelledby="board-settings-title" onClick={event => event.stopPropagation()}><div className="modal-heading"><h2 id="board-settings-title">Board settings</h2><button onClick={onClose}><X size={18} /></button></div><label>Board name<input value={name} onChange={event => setName(event.target.value)} /></label><h3>Stages</h3><p className="muted small">Rename, categorize, and reorder this board&apos;s workflow.</p><div className="stage-editor">{board.stages.map((stage, index) => {
    const count = tasks.filter(task => task.stageId === stage.id).length;
    const update = (patch: object) => request<TaskBoard>(`/v1/stages/${stage.id}`, { method: "PUT", body: JSON.stringify(patch) });
    return <div className="stage-editor-row" key={stage.id}><input defaultValue={stage.name} onBlur={event => event.target.value !== stage.name && void update({ name: event.target.value })} /><select value={stage.category} onChange={event => void update({ category: event.target.value })}>{CATEGORIES.map(category => <option key={category.id} value={category.id}>{category.label}</option>)}</select><span>{count}</span><button disabled={index === 0} onClick={() => void update({ position: board.stages[index - 1].position - .5 })} aria-label="Move stage left"><ArrowUp size={13} /></button><button disabled={index === board.stages.length - 1} onClick={() => void update({ position: board.stages[index + 1].position + .5 })} aria-label="Move stage right"><ArrowDown size={13} /></button><button className="danger-text" aria-label="Delete stage" onClick={() => { const target = board.stages.find(item => item.id !== stage.id); if (target) void request(`/v1/stages/${stage.id}?moveToStageId=${encodeURIComponent(target.id)}`, { method: "DELETE" }); }}><Trash2 size={13} /></button></div>;
  })}</div><div className="add-stage"><input value={newStage} onChange={event => setNewStage(event.target.value)} placeholder="New stage name" /><button disabled={!newStage.trim() || busy} onClick={async () => { const saved = await request<TaskBoard>(`/v1/boards/${board.id}/stages`, { method: "POST", body: JSON.stringify({ name: newStage, category: "backlog" }) }); if (saved) setNewStage(""); }}><Plus size={14} /> Add</button></div><div className="modal-footer"><button className="danger-text" disabled={busy} onClick={() => void saveBoard(!board.archived)}>{board.archived ? <RotateCcw size={14} /> : <Archive size={14} />}{board.archived ? "Restore board" : "Archive board"}</button><button className="light-button" disabled={!name.trim() || busy} onClick={() => void saveBoard()}><Check size={14} /> Save</button></div></section></div>;
}
