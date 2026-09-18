/* eslint-disable @typescript-eslint/no-explicit-any */
import type { DatabaseSync } from "node:sqlite";
import type { RunRow } from "./db";

type Row = Record<string, any>;
const categories = ["backlog", "ready", "in_progress", "review", "done"] as const;
const priorities = new Set(["low", "normal", "high", "urgent"]);
const activeStates = new Set(["queued", "running", "waiting_approval", "waiting_input"]);
const stamp = () => new Date().toISOString();
const id = () => crypto.randomUUID();
const bool = (value: unknown) => Boolean(Number(value));
const required = (value: unknown, name: string, max = 5000) => {
  const text = String(value || "").trim();
  if (!text) throw new Error(`${name} is required.`);
  if (text.length > max) throw new Error(`${name} is too long.`);
  return text;
};

export class TaskError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}
const conflict = (message: string): never => { throw new TaskError(message, 409); };

export class TaskStore {
  constructor(private db: DatabaseSync) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS task_boards (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, archived INTEGER NOT NULL DEFAULT 0,
        revision INTEGER NOT NULL DEFAULT 1, settings_json TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS task_stages (
        id TEXT PRIMARY KEY, board_id TEXT NOT NULL, name TEXT NOT NULL, category TEXT NOT NULL,
        position REAL NOT NULL, FOREIGN KEY(board_id) REFERENCES task_boards(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_task_stages_board_position ON task_stages(board_id,position);
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY, board_id TEXT NOT NULL, stage_id TEXT NOT NULL, title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '', owner_agent_id TEXT, priority TEXT NOT NULL DEFAULT 'normal',
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
    `);
    // Existing local installations predate board settings and run output. SQLite
    // has no ADD COLUMN IF NOT EXISTS, so these are intentionally idempotent.
    for (const sql of [
      "ALTER TABLE task_boards ADD COLUMN settings_json TEXT NOT NULL DEFAULT '{}'",
      "ALTER TABLE task_comments ADD COLUMN author TEXT NOT NULL DEFAULT 'you'",
      "ALTER TABLE task_runs ADD COLUMN output TEXT NOT NULL DEFAULT ''",
      "ALTER TABLE task_runs ADD COLUMN stop_reason TEXT",
    ]) try { db.exec(sql); } catch { /* already migrated */ }
    db.exec("PRAGMA optimize");
    this.ensureDefaultBoard();
    const restartMessage = "The local runtime restarted. This board task was not replayed; retry it when ready.";
    db.prepare("UPDATE runs SET state='interrupted',error=?,updated_at=? WHERE state='queued' AND id IN (SELECT run_id FROM task_runs)").run(restartMessage, stamp());
  }

  private transaction<T>(work: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = work(); this.db.exec("COMMIT"); return result; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }

  private activity(taskId: string, type: string, detail: string) {
    this.db.prepare("INSERT INTO task_activity(id,task_id,type,detail,created_at) VALUES(?,?,?,?,?)")
      .run(id(), taskId, type, detail, stamp());
  }

  private stage(boardId: string, category: string) {
    return this.db.prepare("SELECT * FROM task_stages WHERE board_id=? AND category=? ORDER BY position LIMIT 1").get(boardId, category) as Row | undefined;
  }

  private settings(boardId: string, raw: unknown) {
    const stages = this.db.prepare("SELECT id,category FROM task_stages WHERE board_id=? ORDER BY position").all(boardId) as Row[];
    const input = (() => { try { return JSON.parse(String(raw || '{}')) as Row; } catch { return {}; } })();
    const byCategory = (category: string) => String(stages.find(stage => stage.category === category)?.id || '');
    const valid = (value: unknown, fallback: string) => stages.some(stage => stage.id === value) ? String(value) : fallback;
    return {
      runStageId: valid(input.runStageId, byCategory('in_progress')),
      doneStageId: valid(input.doneStageId, byCategory('review')),
      autoRunOnDrop: input.autoRunOnDrop === undefined ? true : Boolean(input.autoRunOnDrop),
      allowAgentDispatch: input.allowAgentDispatch === undefined ? true : Boolean(input.allowAgentDispatch),
    };
  }

  ensureDefaultBoard() {
    if (this.db.prepare("SELECT 1 FROM task_boards LIMIT 1").get()) return;
    this.createBoard({ name: "Product launch" });
  }

  createBoard(input: Row) {
    const boardId = id(), createdAt = stamp(), name = required(input.name, "Board name", 120);
    this.transaction(() => {
      this.db.prepare("INSERT INTO task_boards(id,name,created_at,updated_at) VALUES(?,?,?,?)").run(boardId, name, createdAt, createdAt);
      const names = ["Backlog", "Ready", "In progress", "Review", "Done"];
      categories.forEach((category, position) => this.db.prepare("INSERT INTO task_stages(id,board_id,name,category,position) VALUES(?,?,?,?,?)").run(id(), boardId, names[position], category, position));
    });
    return this.getBoard(boardId);
  }

  listBoards(includeArchived = false) {
    const rows = this.db.prepare(`SELECT * FROM task_boards ${includeArchived ? "" : "WHERE archived=0"} ORDER BY created_at`).all() as Row[];
    return rows.map(row => this.board(row));
  }

  private board(row: Row) {
    const stages = (this.db.prepare("SELECT * FROM task_stages WHERE board_id=? ORDER BY position").all(row.id) as Row[]).map(stage => ({
      id: stage.id, boardId: stage.board_id, name: stage.name, category: stage.category, position: Number(stage.position),
    }));
    return { id: row.id, name: row.name, archived: bool(row.archived), revision: Number(row.revision), stages, settings: this.settings(String(row.id), row.settings_json), createdAt: row.created_at, updatedAt: row.updated_at };
  }

  getBoard(boardId: string) {
    const row = this.db.prepare("SELECT * FROM task_boards WHERE id=?").get(boardId) as Row | undefined;
    if (!row) throw new Error("Board not found.");
    return this.board(row);
  }

  updateBoard(boardId: string, input: Row) {
    const board = this.getBoard(boardId);
    if (Number(input.revision) !== board.revision) conflict("This board changed elsewhere. Refresh and try again.");
    const archived = input.archived === undefined ? board.archived : Boolean(input.archived);
    if (archived && this.db.prepare("SELECT 1 FROM tasks WHERE board_id=? AND active_run_id IS NOT NULL LIMIT 1").get(boardId)) conflict("Finish or stop active tasks before archiving this board.");
    const settings = input.settings === undefined ? board.settings : { ...board.settings, ...input.settings };
    const repaired = this.settings(boardId, JSON.stringify(settings));
    this.db.prepare("UPDATE task_boards SET name=?,archived=?,settings_json=?,revision=revision+1,updated_at=? WHERE id=?")
      .run(input.name === undefined ? board.name : required(input.name, "Board name", 120), archived ? 1 : 0, JSON.stringify(repaired), stamp(), boardId);
    return this.getBoard(boardId);
  }

  addStage(boardId: string, input: Row) {
    this.getBoard(boardId);
    const category = String(input.category || "backlog");
    if (!categories.includes(category as typeof categories[number])) throw new Error("Invalid workflow category.");
    const position = Number((this.db.prepare("SELECT COALESCE(MAX(position),-1)+1 n FROM task_stages WHERE board_id=?").get(boardId) as Row).n);
    const stageId = id();
    this.db.prepare("INSERT INTO task_stages(id,board_id,name,category,position) VALUES(?,?,?,?,?)").run(stageId, boardId, required(input.name, "Stage name", 80), category, position);
    return this.getBoard(boardId);
  }

  updateStage(stageId: string, input: Row) {
    const row = this.db.prepare("SELECT * FROM task_stages WHERE id=?").get(stageId) as Row | undefined;
    if (!row) throw new Error("Stage not found.");
    const category = input.category === undefined ? String(row.category) : String(input.category);
    if (!categories.includes(category as typeof categories[number])) throw new Error("Invalid workflow category.");
    this.db.prepare("UPDATE task_stages SET name=?,category=?,position=? WHERE id=?").run(
      input.name === undefined ? row.name : required(input.name, "Stage name", 80), category,
      input.position === undefined ? row.position : Number(input.position), stageId,
    );
    return this.getBoard(String(row.board_id));
  }

  removeStage(stageId: string, moveToStageId?: string) {
    const row = this.db.prepare("SELECT * FROM task_stages WHERE id=?").get(stageId) as Row | undefined;
    if (!row) throw new Error("Stage not found.");
    const count = Number((this.db.prepare("SELECT COUNT(*) n FROM tasks WHERE stage_id=?").get(stageId) as Row).n);
    if (count && !moveToStageId) throw new Error("Choose another stage for the tasks in this stage.");
    const sameCategory = Number((this.db.prepare("SELECT COUNT(*) n FROM task_stages WHERE board_id=? AND category=? AND id<>?").get(row.board_id, row.category, stageId) as Row).n);
    if (["in_progress", "review", "done"].includes(String(row.category)) && sameCategory === 0) throw new Error("Keep at least one In progress, Review, and Done destination.");
    if (moveToStageId) {
      const target = this.db.prepare("SELECT * FROM task_stages WHERE id=? AND board_id=?").get(moveToStageId, row.board_id);
      if (!target) throw new Error("Move-to stage is not on this board.");
      this.db.prepare("UPDATE tasks SET stage_id=?,revision=revision+1,updated_at=? WHERE stage_id=?").run(moveToStageId, stamp(), stageId);
    }
    this.db.prepare("DELETE FROM task_stages WHERE id=?").run(stageId);
    const board = this.getBoard(String(row.board_id));
    this.db.prepare("UPDATE task_boards SET settings_json=?,revision=revision+1,updated_at=? WHERE id=?")
      .run(JSON.stringify(board.settings), stamp(), row.board_id);
    return this.getBoard(String(row.board_id));
  }

  listTasks(includeArchived = false) {
    const rows = this.db.prepare(`SELECT tasks.*,COALESCE(active.state,(SELECT recent.state FROM task_runs linked JOIN runs recent ON recent.id=linked.run_id WHERE linked.task_id=tasks.id ORDER BY linked.attempt DESC LIMIT 1)) run_state FROM tasks LEFT JOIN runs active ON active.id=tasks.active_run_id ${includeArchived ? "" : "WHERE tasks.archived=0"} ORDER BY tasks.position,tasks.created_at`).all() as Row[];
    return rows.map(row => this.task(row));
  }

  getTask(taskId: string) {
    const row = this.db.prepare("SELECT tasks.*,COALESCE(active.state,(SELECT recent.state FROM task_runs linked JOIN runs recent ON recent.id=linked.run_id WHERE linked.task_id=tasks.id ORDER BY linked.attempt DESC LIMIT 1)) run_state FROM tasks LEFT JOIN runs active ON active.id=tasks.active_run_id WHERE tasks.id=?").get(taskId) as Row | undefined;
    if (!row) throw new Error("Task not found.");
    return this.task(row);
  }

  private task(row: Row) {
    const taskId = String(row.id);
    const collaborators = (this.db.prepare("SELECT agent_id FROM task_collaborators WHERE task_id=? ORDER BY agent_id").all(taskId) as Row[]).map(item => String(item.agent_id));
    const labels = (this.db.prepare("SELECT label FROM task_labels WHERE task_id=? ORDER BY label").all(taskId) as Row[]).map(item => String(item.label));
    const checklist = (this.db.prepare("SELECT * FROM task_checklist WHERE task_id=? ORDER BY position").all(taskId) as Row[]).map(item => ({ id: item.id, text: item.text, done: bool(item.done), position: Number(item.position) }));
    const comments = (this.db.prepare("SELECT id,body,author,created_at FROM task_comments WHERE task_id=? ORDER BY created_at DESC").all(taskId) as Row[]).map(item => ({ id: item.id, body: item.body, author: item.author || 'you', createdAt: item.created_at }));
    const activity = (this.db.prepare("SELECT id,type,detail,created_at FROM task_activity WHERE task_id=? ORDER BY created_at DESC LIMIT 100").all(taskId) as Row[]).map(item => ({ id: item.id, type: item.type, detail: item.detail, createdAt: item.created_at }));
    const runs = (this.db.prepare("SELECT runs.*,task_runs.attempt,task_runs.started_at FROM task_runs JOIN runs ON runs.id=task_runs.run_id WHERE task_runs.task_id=? ORDER BY task_runs.attempt DESC").all(taskId) as Row[]).map(run => ({
      id: run.id, agent_id: run.agent_id, conversation_id: run.conversation_id, prompt: run.prompt, state: run.state,
      result: run.result, error: run.error, output: String(run.output || run.result || '').slice(-20_000), stopReason: run.stop_reason || (run.state === 'completed' ? 'end_turn' : run.error || null), attempt: Number(run.attempt), startedAt: run.started_at,
    }));
    return {
      id: taskId, boardId: row.board_id, stageId: row.stage_id, title: row.title, description: row.description,
      ownerAgentId: row.owner_agent_id || null, collaboratorAgentIds: collaborators, priority: row.priority,
      labels, dueAt: row.due_at || null, position: Number(row.position), archived: bool(row.archived),
      revision: Number(row.revision), activeRunId: row.active_run_id || null, runState: row.run_state || null,
      checklist, comments, activity, runs, createdAt: row.created_at, updatedAt: row.updated_at,
    };
  }

  createTask(input: Row) {
    const board = this.getBoard(required(input.boardId, "Board", 100));
    const stageId = String(input.stageId || board.stages.find(stage => stage.category === "backlog")?.id || "");
    if (!board.stages.some(stage => stage.id === stageId)) throw new Error("Stage is not on this board.");
    const taskId = id(), createdAt = stamp();
    const position = Number((this.db.prepare("SELECT COALESCE(MAX(position),-1)+1 n FROM tasks WHERE stage_id=?").get(stageId) as Row).n);
    this.transaction(() => {
      this.db.prepare("INSERT INTO tasks(id,board_id,stage_id,title,description,owner_agent_id,priority,due_at,position,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)")
        .run(taskId, board.id, stageId, required(input.title, "Task title", 240), String(input.description || "").slice(0, 20000), input.ownerAgentId || null, priorities.has(String(input.priority)) ? input.priority : "normal", input.dueAt || null, position, createdAt, createdAt);
      this.replaceCollections(taskId, input);
      this.activity(taskId, "created", "Task created");
    });
    return this.getTask(taskId);
  }

  private replaceCollections(taskId: string, input: Row) {
    if (Array.isArray(input.collaboratorAgentIds)) {
      this.db.prepare("DELETE FROM task_collaborators WHERE task_id=?").run(taskId);
      for (const agentId of [...new Set(input.collaboratorAgentIds.map(String))].slice(0, 25)) this.db.prepare("INSERT INTO task_collaborators(task_id,agent_id) VALUES(?,?)").run(taskId, agentId);
    }
    if (Array.isArray(input.labels)) {
      this.db.prepare("DELETE FROM task_labels WHERE task_id=?").run(taskId);
      for (const label of [...new Set(input.labels.map(value => String(value).trim()).filter(Boolean))].slice(0, 20)) this.db.prepare("INSERT INTO task_labels(task_id,label) VALUES(?,?)").run(taskId, label.slice(0, 40));
    }
    if (Array.isArray(input.checklist)) {
      this.db.prepare("DELETE FROM task_checklist WHERE task_id=?").run(taskId);
      input.checklist.slice(0, 100).forEach((item: unknown, position: number) => {
        const value = item as Row; const text = String(value.text || "").trim();
        if (text) this.db.prepare("INSERT INTO task_checklist(id,task_id,text,done,position) VALUES(?,?,?,?,?)").run(String(value.id || id()), taskId, text.slice(0, 500), value.done ? 1 : 0, position);
      });
    }
  }

  updateTask(taskId: string, input: Row) {
    const task = this.getTask(taskId);
    if (Number(input.revision) !== task.revision) conflict("This task changed elsewhere. Refresh and try again.");
    const locked = Boolean(task.activeRunId && activeStates.has(String(task.runState)));
    const boardId = input.boardId === undefined ? task.boardId : String(input.boardId);
    const stageId = input.stageId === undefined ? task.stageId : String(input.stageId);
    const owner = input.ownerAgentId === undefined ? task.ownerAgentId : input.ownerAgentId || null;
    const archived = input.archived === undefined ? task.archived : Boolean(input.archived);
    if (locked && (boardId !== task.boardId || stageId !== task.stageId || owner !== task.ownerAgentId || archived !== task.archived)) conflict("Owner, project, stage, and archive status are locked while this task is active.");
    const board = this.getBoard(boardId);
    if (!board.stages.some(stage => stage.id === stageId)) throw new Error("Stage is not on this board.");
    const priority = input.priority === undefined ? task.priority : String(input.priority);
    if (!priorities.has(priority)) throw new Error("Invalid task priority.");
    this.transaction(() => {
      this.db.prepare("UPDATE tasks SET board_id=?,stage_id=?,title=?,description=?,owner_agent_id=?,priority=?,due_at=?,position=?,archived=?,revision=revision+1,updated_at=? WHERE id=?")
        .run(boardId, stageId, input.title === undefined ? task.title : required(input.title, "Task title", 240), input.description === undefined ? task.description : String(input.description).slice(0, 20000), owner, priority, input.dueAt === undefined ? task.dueAt : input.dueAt || null, input.position === undefined ? task.position : Number(input.position), archived ? 1 : 0, stamp(), taskId);
      this.replaceCollections(taskId, input);
      this.activity(taskId, "updated", "Task details updated");
    });
    return this.getTask(taskId);
  }

  comment(taskId: string, input: Row) {
    this.getTask(taskId); const body = required(input.body, "Comment", 5000), createdAt = stamp();
    this.db.prepare("INSERT INTO task_comments(id,task_id,body,author,created_at) VALUES(?,?,?,?,?)").run(id(), taskId, body, String(input.author || 'you').slice(0, 80), createdAt);
    this.activity(taskId, "commented", "Comment added");
    return this.getTask(taskId);
  }

  move(taskId: string, input: Row) {
    const task = this.getTask(taskId), board = this.getBoard(task.boardId);
    if (task.activeRunId && activeStates.has(String(task.runState))) conflict("Stage and owner are locked while this task is active.");
    const stageId = required(input.stageId, "Stage", 100);
    if (!board.stages.some(stage => stage.id === stageId)) throw new TaskError("Stage is not on this board.");
    const siblings = this.db.prepare("SELECT id,position FROM tasks WHERE stage_id=? AND archived=0 AND id<>? ORDER BY position,id").all(stageId, taskId) as Row[];
    const before = input.beforeId ? siblings.findIndex(row => row.id === input.beforeId) : -1;
    const next = before < 0 ? (siblings.length ? Number(siblings.at(-1)?.position) + 1000 : 1000) : (before === 0 ? Number(siblings[0].position) - 1000 : (Number(siblings[before - 1].position) + Number(siblings[before].position)) / 2);
    this.transaction(() => {
      this.db.prepare("UPDATE tasks SET stage_id=?,owner_agent_id=?,position=?,revision=revision+1,updated_at=? WHERE id=?").run(stageId, input.ownerAgentId === undefined ? task.ownerAgentId : input.ownerAgentId || null, next, stamp(), taskId);
      const all = this.db.prepare("SELECT id,position FROM tasks WHERE stage_id=? ORDER BY position,id").all(stageId) as Row[];
      if (all.some((row, index) => index > 0 && Number(row.position) - Number(all[index - 1].position) < .001)) all.forEach((row, index) => this.db.prepare("UPDATE tasks SET position=? WHERE id=?").run((index + 1) * 1000, row.id));
      this.activity(taskId, "moved", `Moved to ${board.stages.find(stage => stage.id === stageId)?.name || 'stage'}`);
    });
    return this.getTask(taskId);
  }

  check(taskId: string, item: string, done?: boolean) {
    const task = this.getTask(taskId), entry = task.checklist.find(value => value.id === item) || task.checklist[Number(item) - 1];
    if (!entry) throw new TaskError("Checklist item not found.", 404);
    this.db.prepare("UPDATE task_checklist SET done=? WHERE id=? AND task_id=?").run(done === undefined ? (entry.done ? 0 : 1) : (done ? 1 : 0), entry.id, taskId);
    this.activity(taskId, "checked", `${done === false ? 'Unchecked' : 'Checked'} ${entry.text}`);
    return this.getTask(taskId);
  }

  addItem(taskId: string, text: string) {
    this.getTask(taskId); const position = Number((this.db.prepare("SELECT COALESCE(MAX(position),-1)+1 n FROM task_checklist WHERE task_id=?").get(taskId) as Row).n);
    this.db.prepare("INSERT INTO task_checklist(id,task_id,text,done,position) VALUES(?,?,?,?,?)").run(id(), taskId, required(text, "Checklist item", 500), 0, position);
    this.activity(taskId, "checklist", "Checklist item added"); return this.getTask(taskId);
  }

  start(taskId: string, input: Row, createRun: (input: { agentId: string; conversationId?: string; prompt: string }) => RunRow) {
    const task = this.getTask(taskId), key = required(input.idempotencyKey, "Idempotency key", 200);
    const duplicate = this.db.prepare("SELECT run_id FROM task_runs WHERE idempotency_key=?").get(`${taskId}:${key}`) as Row | undefined;
    if (duplicate) return { task: this.getTask(taskId), run: this.db.prepare("SELECT * FROM runs WHERE id=?").get(duplicate.run_id) };
    if (task.activeRunId && activeStates.has(String(task.runState))) conflict("This task already has an active run.");
    if (!task.ownerAgentId) throw new Error("Assign an owner before starting this task.");
    if (input.revision !== undefined && Number(input.revision) !== task.revision) conflict("This task changed elsewhere. Refresh and try again.");
    const board = this.getBoard(task.boardId), progress = board.stages.find(stage => stage.id === board.settings.runStageId);
    if (!progress) throw new Error("This board needs a run stage.");
    const checklistText = task.checklist.map(item => `- [${item.done ? "x" : " "}] ${item.text}`).join("\n");
    const feedback = String(input.feedback || "").trim();
    const recentComments = task.comments.slice(0, 3).reverse().map(comment => `- ${comment.author}: ${comment.body}`).join("\n");
    const prompt = [`You are completing board task ${task.id}: ${task.title}`, `Stage: ${progress.name}`, `Priority: ${task.priority}`, task.dueAt && `Due: ${task.dueAt}`, task.description && `Brief:\n${task.description}`, checklistText && `Checklist (use item IDs when reporting progress):\n${checklistText}`, recentComments && `Recent comments:\n${recentComments}`, feedback && `Requested changes:\n${feedback}`, "Work independently. Update checklist items and leave concise progress comments when useful. Do not move this card; successful work is sent for review automatically. End with a short report for the card."].filter(Boolean).join("\n\n");
    let run!: RunRow;
    this.transaction(() => {
      run = createRun({ agentId: task.ownerAgentId!, prompt });
      const attempt = Number((this.db.prepare("SELECT COALESCE(MAX(attempt),0)+1 n FROM task_runs WHERE task_id=?").get(taskId) as Row).n);
      this.db.prepare("INSERT INTO task_runs(task_id,run_id,attempt,instructions_snapshot,checklist_snapshot,idempotency_key,started_at) VALUES(?,?,?,?,?,?,?)")
        .run(taskId, run.id, attempt, task.description, JSON.stringify(task.checklist), `${taskId}:${key}`, stamp());
      this.db.prepare("UPDATE tasks SET stage_id=?,active_run_id=?,revision=revision+1,updated_at=? WHERE id=?").run(progress.id, run.id, stamp(), taskId);
      this.activity(taskId, feedback ? "changes_requested" : "started", feedback || `Started attempt ${attempt}`);
    });
    return { task: this.getTask(taskId), run };
  }

  approve(taskId: string, revision?: number) {
    const task = this.getTask(taskId);
    if (revision !== undefined && revision !== task.revision) conflict("This task changed elsewhere. Refresh and try again.");
    if (task.activeRunId) throw new Error("Wait for the active run to finish.");
    const done = this.stage(task.boardId, "done"); if (!done) throw new Error("This board needs a Done stage.");
    this.db.prepare("UPDATE tasks SET stage_id=?,revision=revision+1,updated_at=? WHERE id=?").run(done.id, stamp(), taskId);
    this.activity(taskId, "approved", "Task approved and marked done");
    return this.getTask(taskId);
  }

  syncRun(run: RunRow) {
    const link = this.db.prepare("SELECT task_id FROM task_runs WHERE run_id=?").get(run.id) as Row | undefined;
    if (!link) return;
    const task = this.getTask(String(link.task_id));
    if (run.state === "completed") {
      const review = this.db.prepare("SELECT * FROM task_stages WHERE id=?").get(this.getBoard(task.boardId).settings.doneStageId) as Row | undefined;
      if (review) this.db.prepare("UPDATE tasks SET stage_id=?,active_run_id=NULL,revision=revision+1,updated_at=? WHERE id=?").run(review.id, stamp(), task.id);
      const output = String(run.result || '').slice(-20_000);
      this.db.prepare("UPDATE task_runs SET output=?,stop_reason=? WHERE run_id=?").run(output, 'end_turn', run.id);
      if (output) this.comment(task.id, { body: output.slice(-8_000), author: 'agent' });
      this.activity(task.id, "run_completed", "Agent finished; moved to review");
    } else if (["failed", "interrupted", "cancelled"].includes(run.state)) {
      this.db.prepare("UPDATE tasks SET active_run_id=NULL,revision=revision+1,updated_at=? WHERE id=?").run(stamp(), task.id);
      this.db.prepare("UPDATE task_runs SET output=?,stop_reason=? WHERE run_id=?").run(String(run.result || run.error || '').slice(-20_000), run.error || run.state, run.id);
      this.activity(task.id, `run_${run.state}`, run.error || `Run ${run.state}`);
    }
  }

  appendOutput(runId: string, text: string) {
    if (!text) return;
    const row = this.db.prepare("SELECT output FROM task_runs WHERE run_id=?").get(runId) as Row | undefined;
    if (!row) return;
    this.db.prepare("UPDATE task_runs SET output=? WHERE run_id=?").run(`${String(row.output || '')}${text}`.slice(-20_000), runId);
  }

  reconcile() {
    const linked = this.db.prepare("SELECT runs.* FROM tasks JOIN runs ON runs.id=tasks.active_run_id WHERE runs.state IN ('completed','failed','interrupted','cancelled')").all() as unknown as RunRow[];
    for (const run of linked) this.syncRun(run);
  }

  isTaskRun(runId: string) { return Boolean(this.db.prepare("SELECT 1 FROM task_runs WHERE run_id=?").get(runId)); }
  activeRunCount() { return Number((this.db.prepare("SELECT COUNT(*) n FROM task_runs JOIN runs ON runs.id=task_runs.run_id WHERE runs.state IN ('running','waiting_approval','waiting_input')").get() as Row).n); }
}
