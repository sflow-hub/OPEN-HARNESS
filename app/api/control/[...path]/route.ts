import { env } from "cloudflare:workers";
import { hostedTaskSchema } from "../../../../db/schema";
import type { AgentTask, TaskBoard, TaskStage, WorkflowCategory } from "../../../../lib/task-types";

export const runtime = "edge";

type Row = Record<string, unknown>;
type RouteContext = { params: Promise<{ path: string[] }> };
const categories: WorkflowCategory[] = ["backlog", "ready", "in_progress", "review", "done"];
const priorities = new Set(["low", "normal", "high", "urgent"]);
const stamp = () => new Date().toISOString();
const id = () => crypto.randomUUID();

function database() {
  const db = (env as unknown as { DB?: D1Database }).DB;
  if (!db) throw new HttpError(503, "Task storage is not configured for this site.");
  return db;
}

class HttpError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

function required(value: unknown, label: string, limit = 240) {
  const text = String(value || "").trim();
  if (!text) throw new HttpError(400, `${label} is required.`);
  return text.slice(0, limit);
}

function array<T>(value: unknown): T[] {
  try { return Array.isArray(value) ? value as T[] : JSON.parse(String(value || "[]")); }
  catch { return []; }
}

function json(value: unknown, status = 200) {
  return Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
}

async function input(request: Request): Promise<Row> {
  if (request.method === "GET" || request.method === "DELETE") return {};
  try {
    const text = await request.text();
    if (text.length > 250_000) throw new HttpError(413, "Request is too large.");
    const value = text ? JSON.parse(text) : {};
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value as Row;
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(400, "Invalid request.");
  }
}

async function prepare(db: D1Database) {
  await db.batch(hostedTaskSchema.map(sql => db.prepare(sql)));
  const now = stamp();
  await db.batch([
    db.prepare("INSERT OR IGNORE INTO task_boards(id,name,archived,revision,created_at,updated_at) VALUES(?,?,?,?,?,?)").bind("default-board", "Open Harness", 0, 1, now, now),
    ...categories.map((category, position) => db.prepare("INSERT OR IGNORE INTO task_stages(id,board_id,name,category,position) VALUES(?,?,?,?,?)").bind(`default-${category}`, "default-board", category === "in_progress" ? "In Progress" : category[0].toUpperCase() + category.slice(1), category, position)),
  ]);
}

function mapStage(row: Row): TaskStage {
  return { id: String(row.id), boardId: String(row.board_id), name: String(row.name), category: String(row.category) as WorkflowCategory, position: Number(row.position) };
}

async function getBoard(db: D1Database, boardId: string): Promise<TaskBoard> {
  const row = await db.prepare("SELECT * FROM task_boards WHERE id=?").bind(boardId).first<Row>();
  if (!row) throw new HttpError(404, "Board not found.");
  const stages = (await db.prepare("SELECT * FROM task_stages WHERE board_id=? ORDER BY position,id").bind(boardId).all<Row>()).results.map(mapStage);
  return { id: String(row.id), name: String(row.name), archived: Boolean(row.archived), revision: Number(row.revision), stages, createdAt: String(row.created_at), updatedAt: String(row.updated_at) };
}

async function listBoards(db: D1Database, includeArchived: boolean) {
  const rows = (await db.prepare(`SELECT * FROM task_boards ${includeArchived ? "" : "WHERE archived=0"} ORDER BY created_at,id`).all<Row>()).results;
  return Promise.all(rows.map(row => getBoard(db, String(row.id))));
}

function mapTask(row: Row): AgentTask {
  return {
    id: String(row.id), boardId: String(row.board_id), stageId: String(row.stage_id), title: String(row.title), description: String(row.description || ""),
    ownerAgentId: row.owner_agent_id ? String(row.owner_agent_id) : null, collaboratorAgentIds: array<string>(row.collaborators_json),
    priority: String(row.priority) as AgentTask["priority"], labels: array<string>(row.labels_json), dueAt: row.due_at ? String(row.due_at) : null,
    position: Number(row.position), archived: Boolean(row.archived), revision: Number(row.revision), activeRunId: null, runState: null,
    checklist: array<AgentTask["checklist"][number]>(row.checklist_json), comments: array<AgentTask["comments"][number]>(row.comments_json),
    activity: array<AgentTask["activity"][number]>(row.activity_json), runs: [], createdAt: String(row.created_at), updatedAt: String(row.updated_at),
  };
}

async function getTask(db: D1Database, taskId: string) {
  const row = await db.prepare("SELECT * FROM tasks WHERE id=?").bind(taskId).first<Row>();
  if (!row) throw new HttpError(404, "Task not found.");
  return mapTask(row);
}

async function listTasks(db: D1Database, includeArchived: boolean) {
  const where = includeArchived ? "" : "WHERE tasks.archived=0 AND task_boards.archived=0";
  const rows = (await db.prepare(`SELECT tasks.* FROM tasks JOIN task_boards ON task_boards.id=tasks.board_id ${where} ORDER BY tasks.position,tasks.created_at`).all<Row>()).results;
  return rows.map(mapTask);
}

function cleanChecklist(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 100).map((entry, position) => {
    const item = entry as Row;
    return { id: String(item.id || id()), text: String(item.text || "").trim().slice(0, 500), done: Boolean(item.done), position };
  }).filter(item => item.text);
}

function cleanStrings(value: unknown, count: number, limit: number) {
  return Array.isArray(value) ? [...new Set(value.map(item => String(item).trim()).filter(Boolean))].slice(0, count).map(item => item.slice(0, limit)) : [];
}

async function createBoard(db: D1Database, body: Row) {
  const boardId = id(), now = stamp(), name = required(body.name, "Board name");
  await db.batch([
    db.prepare("INSERT INTO task_boards(id,name,archived,revision,created_at,updated_at) VALUES(?,?,?,?,?,?)").bind(boardId, name, 0, 1, now, now),
    ...categories.map((category, position) => db.prepare("INSERT INTO task_stages(id,board_id,name,category,position) VALUES(?,?,?,?,?)").bind(id(), boardId, category === "in_progress" ? "In Progress" : category[0].toUpperCase() + category.slice(1), category, position)),
  ]);
  return getBoard(db, boardId);
}

async function createTask(db: D1Database, body: Row) {
  const board = await getBoard(db, required(body.boardId, "Board"));
  if (board.archived) throw new HttpError(409, "Restore this board before adding tasks.");
  const stageId = String(body.stageId || board.stages.find(stage => stage.category === "backlog")?.id || "");
  if (!board.stages.some(stage => stage.id === stageId)) throw new HttpError(400, "Stage is not on this board.");
  const priority = priorities.has(String(body.priority)) ? String(body.priority) : "normal";
  const position = Number((await db.prepare("SELECT COALESCE(MAX(position),-1)+1 AS next FROM tasks WHERE stage_id=?").bind(stageId).first<Row>())?.next || 0);
  const taskId = id(), now = stamp();
  const activity = [{ id: id(), type: "created", detail: "Task created", createdAt: now }];
  await db.prepare(`INSERT INTO tasks(id,board_id,stage_id,title,description,owner_agent_id,priority,due_at,position,archived,revision,collaborators_json,labels_json,checklist_json,comments_json,activity_json,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).bind(taskId, board.id, stageId, required(body.title, "Task title"), String(body.description || "").slice(0, 20_000), body.ownerAgentId || null, priority, body.dueAt || null, position, 0, 1, JSON.stringify(cleanStrings(body.collaboratorAgentIds, 25, 120)), JSON.stringify(cleanStrings(body.labels, 20, 40)), JSON.stringify(cleanChecklist(body.checklist)), "[]", JSON.stringify(activity), now, now).run();
  return getTask(db, taskId);
}

async function updateTask(db: D1Database, taskId: string, body: Row) {
  const task = await getTask(db, taskId);
  if (Number(body.revision) !== task.revision) throw new HttpError(409, "This task changed elsewhere. Refresh and try again.");
  const boardId = body.boardId === undefined ? task.boardId : String(body.boardId);
  const board = await getBoard(db, boardId);
  const stageId = body.stageId === undefined ? task.stageId : String(body.stageId);
  if (!board.stages.some(stage => stage.id === stageId)) throw new HttpError(400, "Stage is not on this board.");
  const priority = body.priority === undefined ? task.priority : String(body.priority);
  if (!priorities.has(priority)) throw new HttpError(400, "Invalid task priority.");
  const now = stamp();
  const activity = [{ id: id(), type: "updated", detail: "Task details updated", createdAt: now }, ...task.activity].slice(0, 200);
  const collaborators = body.collaboratorAgentIds === undefined ? task.collaboratorAgentIds : cleanStrings(body.collaboratorAgentIds, 25, 120);
  const labels = body.labels === undefined ? task.labels : cleanStrings(body.labels, 20, 40);
  const checklist = body.checklist === undefined ? task.checklist : cleanChecklist(body.checklist);
  const result = await db.prepare(`UPDATE tasks SET board_id=?,stage_id=?,title=?,description=?,owner_agent_id=?,priority=?,due_at=?,position=?,archived=?,revision=revision+1,collaborators_json=?,labels_json=?,checklist_json=?,activity_json=?,updated_at=? WHERE id=? AND revision=?`).bind(
    boardId, stageId, body.title === undefined ? task.title : required(body.title, "Task title"), body.description === undefined ? task.description : String(body.description).slice(0, 20_000), body.ownerAgentId === undefined ? task.ownerAgentId : body.ownerAgentId || null, priority, body.dueAt === undefined ? task.dueAt : body.dueAt || null, body.position === undefined ? task.position : Number(body.position), body.archived === undefined ? Number(task.archived) : Number(Boolean(body.archived)), JSON.stringify(collaborators), JSON.stringify(labels), JSON.stringify(checklist), JSON.stringify(activity), now, taskId, task.revision,
  ).run();
  if (!result.meta.changes) throw new HttpError(409, "This task changed elsewhere. Refresh and try again.");
  return getTask(db, taskId);
}

async function commentTask(db: D1Database, taskId: string, body: Row) {
  const task = await getTask(db, taskId), now = stamp();
  const comments = [...task.comments, { id: id(), body: required(body.body, "Comment", 5_000), createdAt: now }];
  const activity = [{ id: id(), type: "commented", detail: "Comment added", createdAt: now }, ...task.activity].slice(0, 200);
  await db.prepare("UPDATE tasks SET comments_json=?,activity_json=?,revision=revision+1,updated_at=? WHERE id=? AND revision=?").bind(JSON.stringify(comments), JSON.stringify(activity), now, taskId, task.revision).run();
  return getTask(db, taskId);
}

async function approveTask(db: D1Database, taskId: string, body: Row) {
  const task = await getTask(db, taskId);
  if (body.revision !== undefined && Number(body.revision) !== task.revision) throw new HttpError(409, "This task changed elsewhere. Refresh and try again.");
  const board = await getBoard(db, task.boardId), done = board.stages.find(stage => stage.category === "done");
  if (!done) throw new HttpError(400, "This board needs a Done stage.");
  const now = stamp(), activity = [{ id: id(), type: "approved", detail: "Task approved and marked done", createdAt: now }, ...task.activity].slice(0, 200);
  await db.prepare("UPDATE tasks SET stage_id=?,activity_json=?,revision=revision+1,updated_at=? WHERE id=? AND revision=?").bind(done.id, JSON.stringify(activity), now, taskId, task.revision).run();
  return getTask(db, taskId);
}

async function updateBoard(db: D1Database, boardId: string, body: Row) {
  const board = await getBoard(db, boardId);
  if (Number(body.revision) !== board.revision) throw new HttpError(409, "This board changed elsewhere. Refresh and try again.");
  const result = await db.prepare("UPDATE task_boards SET name=?,archived=?,revision=revision+1,updated_at=? WHERE id=? AND revision=?").bind(body.name === undefined ? board.name : required(body.name, "Board name"), body.archived === undefined ? Number(board.archived) : Number(Boolean(body.archived)), stamp(), boardId, board.revision).run();
  if (!result.meta.changes) throw new HttpError(409, "This board changed elsewhere. Refresh and try again.");
  return getBoard(db, boardId);
}

async function addStage(db: D1Database, boardId: string, body: Row) {
  await getBoard(db, boardId);
  const category = categories.includes(String(body.category) as WorkflowCategory) ? String(body.category) : "backlog";
  const position = Number((await db.prepare("SELECT COALESCE(MAX(position),-1)+1 AS next FROM task_stages WHERE board_id=?").bind(boardId).first<Row>())?.next || 0);
  const now = stamp();
  await db.batch([
    db.prepare("INSERT INTO task_stages(id,board_id,name,category,position) VALUES(?,?,?,?,?)").bind(id(), boardId, required(body.name, "Stage name", 100), category, position),
    db.prepare("UPDATE task_boards SET revision=revision+1,updated_at=? WHERE id=?").bind(now, boardId),
  ]);
  return getBoard(db, boardId);
}

async function updateStage(db: D1Database, stageId: string, body: Row) {
  const row = await db.prepare("SELECT * FROM task_stages WHERE id=?").bind(stageId).first<Row>();
  if (!row) throw new HttpError(404, "Stage not found.");
  const category = body.category === undefined ? String(row.category) : String(body.category);
  if (!categories.includes(category as WorkflowCategory)) throw new HttpError(400, "Invalid workflow category.");
  const boardId = String(row.board_id), now = stamp();
  await db.batch([
    db.prepare("UPDATE task_stages SET name=?,category=?,position=? WHERE id=?").bind(body.name === undefined ? row.name : required(body.name, "Stage name", 100), category, body.position === undefined ? row.position : Number(body.position), stageId),
    db.prepare("UPDATE task_boards SET revision=revision+1,updated_at=? WHERE id=?").bind(now, boardId),
  ]);
  return getBoard(db, boardId);
}

async function removeStage(db: D1Database, stageId: string, moveToStageId: string | null) {
  const row = await db.prepare("SELECT * FROM task_stages WHERE id=?").bind(stageId).first<Row>();
  if (!row) throw new HttpError(404, "Stage not found.");
  const boardId = String(row.board_id), category = String(row.category);
  if (["in_progress", "review", "done"].includes(category)) {
    const count = Number((await db.prepare("SELECT COUNT(*) AS count FROM task_stages WHERE board_id=? AND category=?").bind(boardId, category).first<Row>())?.count || 0);
    if (count <= 1) throw new HttpError(409, `Keep at least one ${category.replaceAll("_", " ")} stage for automation.`);
  }
  const taskCount = Number((await db.prepare("SELECT COUNT(*) AS count FROM tasks WHERE stage_id=?").bind(stageId).first<Row>())?.count || 0);
  let target: Row | null = null;
  if (moveToStageId) target = await db.prepare("SELECT * FROM task_stages WHERE id=? AND board_id=?").bind(moveToStageId, boardId).first<Row>();
  if (taskCount && !target) throw new HttpError(409, "Move this stage's tasks to another stage before removing it.");
  const statements = [];
  if (taskCount && target) statements.push(db.prepare("UPDATE tasks SET stage_id=?,revision=revision+1,updated_at=? WHERE stage_id=?").bind(String(target.id), stamp(), stageId));
  statements.push(db.prepare("DELETE FROM task_stages WHERE id=?").bind(stageId));
  statements.push(db.prepare("UPDATE task_boards SET revision=revision+1,updated_at=? WHERE id=?").bind(stamp(), boardId));
  await db.batch(statements);
  return getBoard(db, boardId);
}

async function handler(request: Request, context: RouteContext) {
  try {
    const db = database();
    await prepare(db);
    const { path } = await context.params;
    const pathname = `/${path.join("/")}`, url = new URL(request.url), body = await input(request);

    if (pathname === "/v1/bootstrap" && request.method === "GET") return json({ token: "hosted-site", runtime: { available: false, version: null, message: "Agent execution requires the local Open Harness runtime." }, version: "0.3.0", hermes: { release: "hosted", commit: "sites" } });
    if (pathname === "/v1/agents/sync" && request.method === "POST") return json({ agents: Array.isArray(body.agents) ? body.agents : [] });
    if (pathname === "/v1/migrate" && request.method === "POST") return json({ migrated: false, reason: "hosted" });
    if (pathname === "/v1/workspace/model/import" && request.method === "POST") return json({ model: body.model || { provider: "xai", model: "grok-4-1-fast", baseUrl: "" }, revision: 0 });
    if (pathname === "/v1/routines" && request.method === "GET") return json({ routines: [] });
    if (pathname === "/v1/runs" && request.method === "GET") return json({ runs: [] });

    if (pathname === "/v1/boards") {
      if (request.method === "GET") return json({ boards: await listBoards(db, url.searchParams.get("includeArchived") === "1") });
      if (request.method === "POST") return json(await createBoard(db, body), 201);
    }
    const boardMatch = pathname.match(/^\/v1\/boards\/([^/]+)(?:\/(stages))?$/);
    if (boardMatch) {
      const boardId = decodeURIComponent(boardMatch[1]);
      if (!boardMatch[2] && request.method === "GET") return json(await getBoard(db, boardId));
      if (!boardMatch[2] && request.method === "PUT") return json(await updateBoard(db, boardId, body));
      if (boardMatch[2] && request.method === "POST") return json(await addStage(db, boardId, body), 201);
    }
    const stageMatch = pathname.match(/^\/v1\/stages\/([^/]+)$/);
    if (stageMatch) {
      const stageId = decodeURIComponent(stageMatch[1]);
      if (request.method === "PUT") return json(await updateStage(db, stageId, body));
      if (request.method === "DELETE") return json(await removeStage(db, stageId, url.searchParams.get("moveToStageId")));
    }
    if (pathname === "/v1/tasks") {
      const includeArchived = url.searchParams.get("includeArchived") === "1";
      if (request.method === "GET") return json({ boards: await listBoards(db, includeArchived), tasks: await listTasks(db, includeArchived) });
      if (request.method === "POST") return json(await createTask(db, body), 201);
    }
    const taskMatch = pathname.match(/^\/v1\/tasks\/([^/]+)(?:\/(comments|start|request-changes|approve|runs))?$/);
    if (taskMatch) {
      const taskId = decodeURIComponent(taskMatch[1]), action = taskMatch[2];
      if (!action && request.method === "GET") return json(await getTask(db, taskId));
      if (!action && request.method === "PUT") return json(await updateTask(db, taskId, body));
      if (action === "comments" && request.method === "POST") return json(await commentTask(db, taskId, body), 201);
      if (action === "approve" && request.method === "POST") return json(await approveTask(db, taskId, body));
      if (action === "runs" && request.method === "GET") return json({ runs: [] });
      if ((action === "start" || action === "request-changes") && request.method === "POST") throw new HttpError(409, "Start agent tasks from the local Open Harness app.");
    }
    throw new HttpError(404, "Not found.");
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Request failed." }, error instanceof HttpError ? error.status : 500);
  }
}

export const GET = handler;
export const POST = handler;
export const PUT = handler;
export const DELETE = handler;
