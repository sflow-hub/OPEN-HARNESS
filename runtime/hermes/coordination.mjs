import readline from "node:readline";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

const agentId = process.env.OPEN_HARNESS_AGENT_ID;
const token = process.env.OPEN_HARNESS_AGENT_TOKEN;
const socketPath = process.env.OPEN_HARNESS_CONTROL_SOCKET || "/run/open-harness/coord.sock";
const controlUrl = process.env.OPEN_HARNESS_CONTROL_URL;
const tools = [
  { name: "post_message", description: "Post a message to a conversation you belong to.", inputSchema: { type: "object", properties: { conversationId: { type: "string" }, body: { type: "string" }, mentions: { type: "array", items: { type: "string" } }, idempotencyKey: { type: "string" } }, required: ["conversationId", "body"], additionalProperties: false } },
  { name: "read_inbox", description: "Read pending messages once without waiting. Optionally acknowledge your own message IDs.", inputSchema: { type: "object", properties: { conversationId: { type: "string" }, messageIds: { type: "array", items: { type: "string" } } }, additionalProperties: false } },
  {
    name: "computer",
    description: 'See and control the managed private browser on this agent’s assigned computer. Capture before input and inspect the result afterwards. Navigation, input and stage-upload require coordinator approval; human takeover blocks agent control. Downloads are copied into this agent’s private/downloads. stage-upload copies the named file’s current contents from private/exchange into private browser upload staging and returns its container path; it does not submit the file to a website. Approval covers the named file as it exists when copied. This tool cannot run commands or grant permissions. Never repeat an action whose completion is uncertain.',
    inputSchema: { type: 'object', properties: { action: { type: 'string', enum: ['capture', 'navigate', 'input', 'stage-upload'] }, fileName: { type: 'string', maxLength: 180, description: 'One file name in this agent’s private/exchange folder, for stage-upload. No directories.' }, requestId: { type: 'string', description: 'Optional UUID; reuse only to retry the exact same reviewed action.' }, url: { type: 'string', maxLength: 8192, description: 'An http(s) URL for navigate.' }, input: { type: 'object', properties: { type: { type: 'string', enum: ['click', 'scroll', 'key', 'text', 'drag'] }, clickCount: { type: 'integer', enum: [1,2] }, fromX: { type: 'integer', minimum: 0, maximum: 1439 }, fromY: { type: 'integer', minimum: 0, maximum: 899 }, toX: { type: 'integer', minimum: 0, maximum: 1439 }, toY: { type: 'integer', minimum: 0, maximum: 899 }, x: { type: 'integer', minimum: 0, maximum: 1439 }, y: { type: 'integer', minimum: 0, maximum: 899 }, button: { type: 'string', enum: ['left', 'middle', 'right'] }, direction: { type: 'string', enum: ['up', 'down', 'left', 'right'] }, amount: { type: 'integer', minimum: 1, maximum: 10 }, key: { type: 'string', enum: ['Enter', 'Tab', 'Shift+Tab', 'Escape', 'Backspace', 'Delete', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End', 'PageUp', 'PageDown', 'Control+l', 'Control+a', 'Control+r'] }, text: { type: 'string', maxLength: 4000 } }, required: ['type'], additionalProperties: false } }, required: ['action'], additionalProperties: false },
  },
  {
    name: "workspace",
    description: 'Inspect current/delegated tasks, record verified checkpoints, report results, and propose a paused responsibility for operator review. Every field goes at the top level, next to action. Only the current responsibility may be paused, completed, or assigned a bounded next check. connections returns explicitly shared account IDs and operationInputs. status reports durable task IDs. Never resubmit an uncertain action; ask the operator to check its destination. This tool never grants new permissions.',
    inputSchema: { type: 'object', properties: {
      action: { type: 'string', enum: ['status','checkpoint','report_result','propose_responsibility','update_responsibility','connections','prepare_action','execute_action'] },
      title: { type: 'string', description: 'report_result (up to 150 characters) or propose_responsibility.' },
      summary: { type: 'string', description: 'report_result (up to 4000 characters) or checkpoint.' },
      artifacts: { type: 'array', maxItems: 20, description: 'report_result: actual outputs only. Reported references are not verification.', items: { type: 'object', properties: { label: { type: 'string' }, kind: { type: 'string', enum: ['file', 'link'] }, path: { type: 'string', description: 'A flat shared filename, for a file.' }, url: { type: 'string', description: 'An http(s) URL, for a link.' } }, required: ['label', 'kind'], additionalProperties: false } },
      sources: { type: 'array', maxItems: 30, description: 'report_result: sources you inspected.', items: { type: 'object', properties: { label: { type: 'string' }, url: { type: 'string' } }, required: ['label', 'url'], additionalProperties: false } },
      evidence: { type: 'string', description: 'checkpoint: what you verified and how.' },
      goal: { type: 'string', description: 'propose_responsibility.' },
      intervalMinutes: { type: 'integer', minimum: 1, description: 'propose_responsibility.' },
      maxRuns: { type: 'integer', minimum: 1, description: 'propose_responsibility.' },
      revision: { type: 'integer', description: 'update_responsibility.' },
      state: { type: 'string', enum: ['paused', 'completed'], description: 'update_responsibility.' },
      nextCheckAt: { type: 'string', description: 'update_responsibility: ISO timestamp of the next bounded check.' },
      requestId: { type: 'string', description: 'prepare_action: reuse only to retry the same exact action.' },
      connectionId: { type: 'string', description: 'prepare_action: an account ID from connections.' },
      operation: { type: 'string', description: 'prepare_action: an operation listed by connections.' },
      operationInput: { type: 'string', description: 'prepare_action: a JSON object with the operation-specific fields from operationInputs.' },
      grantId: { type: 'string', description: 'prepare_action: optional routine allowance.' },
      actionId: { type: 'string', description: 'execute_action. A pending write must first be approved by its account owner.' },
    }, required: ['action'], additionalProperties: false },
  },
  {
    name: "group_chat",
    description: 'Read and message group conversations you belong to. Posting without recipients saves context without starting work. Request replies from up to four other group members only for a bounded handoff; depth and cycle limits apply.',
    inputSchema: { type: 'object', properties: { action: { type: 'string', enum: ['list', 'read', 'post'] }, groupId: { type: 'string' }, text: { type: 'string' }, recipientAgentIds: { type: 'array', items: { type: 'string' }, maxItems: 4 }, requestId: { type: 'string', description: 'Reuse this identifier when retrying the same message.' } }, required: ['action'], additionalProperties: false },
  },
  {
    name: "api_request",
    description: 'Call an API using a saved credential granted to this run. Credential references and allowed origins are listed in your API access instructions. Authentication is added by Open Harness.', inputSchema: { type: 'object', properties: { credentialRef: { type: 'string' }, url: { type: 'string' }, method: { type: 'string', enum: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'] }, query: { type: 'object', additionalProperties: { type: 'string' } }, headers: { type: 'object', additionalProperties: { type: 'string' } }, body: {} }, required: ['credentialRef', 'url'], additionalProperties: false } },
  {
    name: "task",
    description: "Read and change task cards on Open Harness projects. Send every field at the top level, next to action. list: a summary of the cards you can see (boardId to show one project's), plus projects and their stages. get: taskId, with its checklist, comments and runs. create: title (boardId optional when there is one project; stageId, description, priority, dueAt, labels, ownerAgentId, teamId optional). update: taskId plus the fields to change. move: taskId, stageId (beforeId to place it). comment and additem: taskId, text. check: taskId, item (the checklist item ID), done. claim: taskId. release: taskId, reason. run: taskId (needs the project to allow agent dispatch). Team cards are visible only to members; changing or assigning another agent's card needs the \"Change other agents' cards\" permission. Use the project tool to create or change projects.",
    inputSchema: { type: "object", properties: {
      action: { type: "string", enum: ["list", "get", "create", "update", "move", "comment", "check", "additem", "claim", "release", "run"] },
      taskId: { type: "string", description: "The card to act on: every action except list and create." },
      boardId: { type: "string", description: "create: the project (optional when only one exists). list: show only this project's cards." },
      stageId: { type: "string", description: "The stage for move, or the starting stage for create. Stage IDs come from list." },
      beforeId: { type: "string", description: "move: place the card before this card." },
      title: { type: "string" },
      description: { type: "string" },
      priority: { type: "string", enum: ["low", "normal", "high", "urgent"] },
      dueAt: { type: "string", description: "ISO 8601 date-time." },
      labels: { type: "array", items: { type: "string" } },
      ownerAgentId: { type: "string", description: "Assign the card to this agent ID. An empty string unassigns it." },
      teamId: { type: "string" },
      text: { type: "string", description: "comment and additem: the text to add." },
      item: { type: "string", description: "check: the checklist item ID." },
      done: { type: "boolean", description: "check: true to tick the item, false to clear it." },
      reason: { type: "string", description: "release: why the card is being handed back." },
    }, required: ["action"], additionalProperties: false },
  },
  {
    name: "project",
    description: "Create and change Open Harness projects (task boards). Send every field at the top level, next to action. list: projects and their stages (includeArchived to add archived ones). get: boardId. create: name (description, color, defaultOwnerAgentId optional). update: boardId plus name, description, color, defaultOwnerAgentId or doneStageId. archive and restore: boardId. add_stage: boardId, name, category. update_stage: stageId plus name, category or position (0 is first). remove_stage: stageId, plus moveToStageId when it holds cards; the project's run stage cannot be removed until a person chooses another one. Deleting projects, sharing folders and automatic task starts stay with a person.",
    inputSchema: { type: "object", properties: {
      action: { type: "string", enum: ["list", "get", "create", "update", "archive", "restore", "add_stage", "update_stage", "remove_stage"] },
      boardId: { type: "string" },
      name: { type: "string", description: "Project name for create and update, or stage name for add_stage and update_stage." },
      description: { type: "string" },
      color: { type: "string", enum: ["sage", "blue", "amber", "violet", "rose", "teal"] },
      defaultOwnerAgentId: { type: "string", description: "Agent ID new cards are assigned to. An empty string clears it." },
      doneStageId: { type: "string", description: "update: the stage a card moves to when its run finishes." },
      stageId: { type: "string" },
      category: { type: "string", enum: ["backlog", "ready", "in_progress", "review", "done"] },
      position: { type: "integer", minimum: 0 },
      moveToStageId: { type: "string", description: "remove_stage: where the stage's cards go." },
      includeArchived: { type: "boolean" },
    }, required: ["action"], additionalProperties: false },
  },
  {
    name: "routines",
    description: "See and manage this agent's own Open Harness routines. list. get, history, pause, resume, run (run now) and delete: routineId. update: routineId plus name, prompt or intervalMinutes. Create routines with create_open_harness_routine.",
    inputSchema: { type: "object", properties: {
      action: { type: "string", enum: ["list", "get", "history", "update", "pause", "resume", "run", "delete"] },
      routineId: { type: "string" },
      name: { type: "string" },
      prompt: { type: "string" },
      intervalMinutes: { type: "integer", minimum: 1 },
    }, required: ["action"], additionalProperties: false },
  },
  {
    name: "directory",
    description: "See the Open Harness teams this agent belongs to and its teammates. teams: your active teams and their member IDs. agents: you and your teammates with name, role and status (working, queued or idle). agent: agentId for one of them.",
    inputSchema: { type: "object", properties: {
      action: { type: "string", enum: ["teams", "agents", "agent"] },
      agentId: { type: "string" },
    }, required: ["action"], additionalProperties: false },
  },
  {
    name: "runs",
    description: "See this agent's runs and the work it delegated, and stop them. list (optional state filter and limit). get: runId, with its direct child runs. conversation: runId, this agent's own or delegated turns in that conversation; other agents' private turns are excluded. stop: runId; a run cannot stop itself.",
    inputSchema: { type: "object", properties: {
      action: { type: "string", enum: ["list", "get", "conversation", "stop"] },
      runId: { type: "string" },
      state: { type: "string", enum: ["queued", "running", "waiting_approval", "waiting_input", "completed", "failed", "interrupted", "cancelled"] },
      limit: { type: "integer", minimum: 1, maximum: 50 },
    }, required: ["action"], additionalProperties: false },
  },
  {
    name: "decide",
    description: "Ask the workspace decision model for a fast, structured decision. It returns option IDs, probabilities and confidence, never actions: act on the answer with your other tools. When decided is false, ask the user instead of guessing. Send every field at the top level, next to op. choose: pick k of options (default 1), for routing; debias asks twice in opposite orders. rank: order every option by how well it meets question. classify: give each option one of labels. score: rate each option on levels (lowest first; a default five-level scale otherwise). check: the probability that question is true of context; no options. Instead of options, pool fills them: agents (you and teammates, needs the Teams and agents permission) or stages (boardId's stages). Phrase question literally: the model answers exactly what is written. It does not count, compare numbers or order dates, so sort by those yourself. Its answers are advice and never authorize anything.",
    inputSchema: { type: "object", properties: {
      op: { type: "string", enum: ["choose", "rank", "classify", "score", "check"] },
      question: { type: "string", description: "The decision, phrased literally: say exactly what counts." },
      context: { type: "string", description: "Only what the decision needs; unrelated text lowers accuracy. Required for check." },
      options: { type: "array", maxItems: 255, items: { type: "object", properties: {
        id: { type: "string", description: "Returned in the answer. Letters, digits and _ . : -, not only digits." },
        text: { type: "string", description: "What the model reads about this option." },
      }, required: ["id", "text"], additionalProperties: false } },
      pool: { type: "string", enum: ["agents", "stages"], description: "Fill options from Open Harness instead of sending them." },
      boardId: { type: "string", description: "pool stages: the project whose stages to use." },
      k: { type: "integer", minimum: 1, description: "choose: how many options to return." },
      labels: { type: "array", items: { type: "string" }, description: "classify: the allowed labels." },
      levels: { type: "array", minItems: 2, maxItems: 10, items: { type: "string" }, description: "score: ordered levels, lowest first." },
      minConfidence: { type: "number", minimum: 0, maximum: 1, description: "Below this, decided is false. Default 0.6." },
      debias: { type: "boolean", description: "choose: ask twice in opposite orders and average." },
    }, required: ["op", "question"], additionalProperties: false },
  },
  {
    name: "delegate_named_agent",
    description: "Hand a bounded piece of work to another named Open Harness agent who shares an active team, and wait for its result. Send agentId and prompt to start. If the reply says done is false, the agent is still working: call again with only runId to keep waiting, never with the prompt again. Delegation depth is limited to two and cycles are rejected.",
    inputSchema: { type: "object", properties: { agentId: { type: "string", description: "The agent to hand the work to." }, prompt: { type: "string", description: "Everything that agent needs to do the work." }, runId: { type: "string", description: "Keep waiting on an earlier handoff's run instead of starting a new one." } }, required: [], additionalProperties: false },
  },
  {
    name: "create_open_harness_routine",
    description: "Create a recurring task for this agent in the Open Harness scheduler.",
    inputSchema: { type: "object", properties: { name: { type: "string" }, prompt: { type: "string" }, intervalMinutes: { type: "integer", minimum: 1 }, timezone: { type: "string" } }, required: ["name", "prompt", "intervalMinutes"], additionalProperties: false },
  },
];
class Unreachable extends Error {}
// The coordinator's answer to a well-formed call it will not carry out: a missing field, a
// permission, a conflict. Returned to the model as an ordinary result, never as an error.
class Refused extends Error { constructor(status, value) { super(value?.error || "Request refused."); this.status = status; this.value = value; } }
let reported = false;
function attempt(options, input) {
  return new Promise((resolve, reject) => {
    const send = options.protocol === 'https:' ? httpsRequest : httpRequest;
    let connected = false;
    const req = send(options, response => {
      let body = "", size = 0;
      response.on("data", chunk => { size += chunk.length; if (size > 8_100_000) { reject(new Error('Coordination response is too large.')); response.destroy(); req.destroy(); } else body += chunk; });
      response.on('error', () => reject(new Error('Coordination response was interrupted. Inspect the destination before repeating an action.')));
      response.on("end", () => {
        const status = response.statusCode || 500;
        let value; try { value = JSON.parse(body); } catch { reject(new Error("Open Harness returned an unreadable response. This was not caused by your arguments.")); return; }
        if (status >= 500) reject(new Error(value.error || "Open Harness could not complete this request. This was not caused by your arguments."));
        else if (status >= 400) reject(new Refused(status, value));
        else resolve(value);
      });
    });
    req.on('socket', socket => { if (!socket.connecting) connected = true; else socket.once('connect', () => { connected = true; }); });
    if (options.path.endsWith('/internal/computer')) req.setTimeout(30000, () => req.destroy(new Error('Computer request timed out.')));
    // Only a failure to reach the coordinator is retryable. A 4xx is the coordinator's answer --
    // "delegation is disabled for this run" must not be retried down another route.
    req.on("error", () => reject(options.path.endsWith('/internal/computer') && connected ? new Error('Computer action completion was not confirmed. Inspect the browser before repeating it.') : new Unreachable("unreachable")));
    req.end(options.method === 'GET' ? undefined : JSON.stringify(input));
  });
}
function computerResult(action, value) {
  if (action !== 'capture') {
    if (value?.state === 'denied') return { content: [{ type: 'text', text: JSON.stringify({ ok: false, denied: true, error: 'The operator did not approve this computer action. No action was dispatched.' }) }] };
    if (value?.ok !== true) throw new Error('The computer action was not confirmed. Inspect the browser before repeating it.');
    return { content: [{ type: 'text', text: JSON.stringify(value) }] };
  }
  const prefix = 'data:image/png;base64,';
  if (!value || value.ok !== true || typeof value.image !== 'string' || !value.image.startsWith(prefix) || value.image.length > prefix.length + 8_000_000 || !Number.isInteger(value.width) || !Number.isInteger(value.height) || value.width < 1 || value.width > 1440 || value.height < 1 || value.height > 900) throw new Error('The managed computer returned an invalid capture.');
  const data = value.image.slice(prefix.length), png = Buffer.from(data, 'base64');
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(data) || data.length % 4 || png.length > 6_000_000 || png.length < 24 || png.toString('base64') !== data || !png.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) || png.toString('ascii', 12, 16) !== 'IHDR' || png.readUInt32BE(16) !== value.width || png.readUInt32BE(20) !== value.height) throw new Error('The managed computer returned an invalid capture.');
  return { content: [{ type: 'text', text: JSON.stringify({ ok: true, width: value.width, height: value.height, ...(Array.isArray(value.downloads) && value.downloads.length <= 100 ? { downloads: value.downloads } : {}), ...(value.fileExchangeError ? { fileExchangeError: 'Some browser files could not be copied into the agent workspace. Check the exchange limits and file ownership.' } : {}) }) }, { type: 'image', mimeType: 'image/png', data }] };
}
function activeRunId() {
  let runId=process.env.OPEN_HARNESS_RUN_ID||'';
  if(process.env.OPEN_HARNESS_RUN_LEASE){let lease;try{lease=JSON.parse(readFileSync(process.env.OPEN_HARNESS_RUN_LEASE,'utf8'));}catch{throw new Error('The active task lease is unavailable.');}if(lease.active!==true||typeof lease.runId!=='string'||!lease.runId||typeof lease.expiresAt!=='number'||!Number.isFinite(lease.expiresAt)||lease.expiresAt<=Date.now())throw new Error('No active task owns this runtime.');runId=lease.runId;}
  return runId;
}
async function call(path, input, expectedRunId, method = "POST") {
  // One options object, never (url, options, callback): node reads the second argument as the
  // response listener when the first is options rather than a URL, so the socket route -- how
  // every local container agent reaches the coordinator -- failed on every call with
  // "The listener argument must be of type function".
  const runId = activeRunId();
  if (expectedRunId !== undefined && expectedRunId !== runId) throw new Error('The task owning this computer request has changed.');
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${token}`, "X-Open-Harness-Agent": agentId, "X-Open-Harness-Run": runId };
  // The socket first, always: it needs no open port and cannot be reached from off the machine.
  // Docker Desktop passes a bind mount through a VM, and a unix socket inside that mount is
  // visible but refuses every connection, so the configured URL is a fallback for that case
  // rather than the default. One failed connect to a socket that is not there costs nothing.
  const routes = [{ socketPath, path, method, headers }];
  if (controlUrl) {
    const target = new URL(`${controlUrl.replace(/\/$/, '')}${path}`);
    routes.push({ protocol: target.protocol, hostname: target.hostname, port: target.port || undefined, path: `${target.pathname}${target.search}`, method, headers });
  }
  for (const [index, route] of routes.entries()) {
    try {
      const value = await attempt(route, input);
      if (index && !reported) { reported = true; process.stderr.write("Open Harness: the coordination socket refused the connection; using the coordinator URL instead.\n"); }
      return value;
    } catch (error) { if (!(error instanceof Unreachable)) throw error; }
  }
  throw new Error("Open Harness is not reachable right now. This was not caused by your arguments: try once more, and if it fails again tell the user that Open Harness may be stopped.");
}
const routes = { post_message: "/internal/message", read_inbox: "/internal/inbox", workspace: "/internal/workspace", group_chat: "/internal/group-chat", api_request: "/internal/api-request", delegate_named_agent: "/internal/handoff", create_open_harness_routine: "/internal/schedule", task: "/internal/task", project: "/internal/project", routines: "/internal/routines", directory: "/internal/directory", runs: "/internal/runs", decide: "/internal/decide" };
// Models fill flat, typed fields; the coordinator's workspace route keeps its { action, input } shape.
function workspaceInput(args) {
  const { action, operationInput, ...fields } = args || {};
  if (operationInput === undefined) return { action, input: fields };
  let operation; try { operation = JSON.parse(operationInput); } catch { operation = null; }
  if (!operation || typeof operation !== 'object' || Array.isArray(operation)) throw new Refused(400, { error: 'operationInput must be a JSON object of the fields operationInputs lists for this operation.', missing: ['operationInput'] });
  return { action, input: { ...fields, input: operation } };
}
const shapes = { workspace: workspaceInput };
const rpcError = (code, message) => Object.assign(new Error(message), { code });
// Pinned Hermes counts every JSON-RPC error AND every result with isError:true as a strike
// against this server, and after three in a row reports it "unreachable" and blocks it for about
// a minute. A refusal ("Task title is required.", a missing permission) means the coordinator is
// working, so it comes back as an ordinary result the model can read and correct. Only a real
// outage is isError, and only a malformed request is a protocol error.
async function dispatch(message) {
  if (message.method === "initialize") return { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "open-harness-coordination", version: "0.3.0" } };
  if (message.method === "ping") return {};
  if (message.method === "tools/list") return { tools };
  if (message.method === "tools/call") {
    const name = message.params?.name, args = message.params?.arguments || {};
    if (name !== 'computer' && !Object.hasOwn(routes, name)) throw rpcError(-32602, `Unknown tool: ${name}`);
    // Pinned Hermes counts JSON-RPC errors and isError results as strikes and blocks the whole server
    // after three, so refusals return as ordinary results; only real failures are marked isError.
    try {
      if (name === 'computer') {
        const input = { ...args, ...(['navigate', 'input', 'stage-upload'].includes(args.action) ? { requestId: args.requestId || randomUUID() } : {}) };
        const runId = activeRunId();
        while (true) {
          const value = await call('/internal/computer', input, runId);
          if (value?.state !== 'pending') return computerResult(args.action, value);
          if (!input.requestId || value.requestId !== input.requestId) throw new Error('The computer approval does not match this request.');
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }
      if (name === 'read_inbox') {
        const value = args.messageIds ? await call('/internal/inbox/ack', { messageIds: args.messageIds }) : await call(`/internal/inbox${args.conversationId ? `?conversationId=${encodeURIComponent(args.conversationId)}` : ''}`, {}, undefined, 'GET');
        return { content: [{ type: "text", text: JSON.stringify(value) }] };
      }
      return { content: [{ type: "text", text: JSON.stringify(await call(routes[name], shapes[name] ? shapes[name](args) : args)) }] };
    } catch (error) {
      if (error instanceof Refused) return { content: [{ type: "text", text: JSON.stringify({ ok: false, ...error.value, error: error.message }) }] };
      return { content: [{ type: "text", text: error instanceof Error ? error.message : "Open Harness could not complete this request." }], isError: true };
    }
  }
  if (message.method?.startsWith("notifications/")) return undefined;
  throw rpcError(-32601, `Unsupported MCP method: ${message.method}`);
}
const lines = readline.createInterface({ input: process.stdin });
lines.on("line", async line => {
  let message; try { message = JSON.parse(line); } catch { return; }
  if (message.id == null) { try { await dispatch(message); } catch {} return; }
  try { const result = await dispatch(message); process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\n"); }
  catch (error) { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: typeof error?.code === "number" ? error.code : -32603, message: error instanceof Error ? error.message : "Request failed" } }) + "\n"); }
});
