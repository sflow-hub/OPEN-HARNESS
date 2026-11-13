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
    description: 'Inspect current/delegated tasks, record verified checkpoints, and propose a paused responsibility for operator review. Only the current responsibility may be paused, completed, or assigned a bounded next check. This tool never grants new permissions.',
    inputSchema: { type: 'object', properties: { action: { type: 'string', enum: ['status','checkpoint','report_result','propose_responsibility','update_responsibility','connections','prepare_action','execute_action'] }, input: { type: 'object', description: 'report_result: {title?,summary,artifacts?:[{label,kind:file|link,path?:flat shared filename,url?:http(s) URL}],sources?:[{label,url}]}; reported references are not verification, use only actual outputs. checkpoint: {summary,evidence}; propose_responsibility: {title,goal,intervalMinutes,maxRuns}; update_responsibility: {revision,state?,nextCheckAt?}. connections returns explicitly shared account IDs and operationInputs. prepare_action: {requestId,connectionId,operation,input: operation-specific fields from operationInputs,grantId?}; reuse requestId only for the same exact action. execute_action: {actionId}; a pending write must first be approved by its account owner. status reports durable task IDs. Never resubmit an uncertain action; ask the operator to check its destination.' } }, required: ['action'], additionalProperties: false },
  },
  {
    name: "group_chat",
    description: 'Read and message group conversations you belong to. Posting without recipients saves context without starting work. Request replies from up to four other group members only for a bounded handoff; depth and cycle limits apply.',
    inputSchema: { type: 'object', properties: { action: { type: 'string', enum: ['list', 'read', 'post'] }, groupId: { type: 'string' }, text: { type: 'string' }, recipientAgentIds: { type: 'array', items: { type: 'string' }, maxItems: 4 }, requestId: { type: 'string', description: 'Reuse this identifier when retrying the same message.' } }, required: ['action'], additionalProperties: false },
  },
  {
    name: "task",
    description: "Read and manage board tasks and projects. Team tasks are visible only to members; changing another agent's card requires that profile's board permission, and board_create and board_update require its manage-projects permission. A project's stages, automation settings, and archived state stay under human control.",
    inputSchema: { type: "object", properties: { action: { type: "string", enum: ["list", "columns", "get", "create", "update", "move", "comment", "check", "additem", "claim", "release", "run", "board_create", "board_update"] }, taskId: { type: "string", description: "The task to act on: required for get, update, move, comment, check, additem, claim, release and run." }, boardId: { type: "string", description: "The board to act on: required for create and board_update." }, input: { type: "object", description: "The fields for this action, always nested here rather than alongside action. move: {stageId} from action columns, optionally {beforeId} to place it. create: {title, description, teamId, ownerAgentId}. update: {revision, and the fields to change}. comment: {text}. check: {item, done}. additem: {text}. release: {reason}. board_create and board_update: {name, description, color}." } }, required: ["action"], additionalProperties: false },
  },
  {
    name: "delegate_named_agent",
    description: "Assign a bounded task to another named Open Harness agent who shares an active team and return the durable run ID. Delegation depth is limited to two and cycles are rejected.",
    inputSchema: { type: "object", properties: { agentId: { type: "string", description: "Target agent ID" }, prompt: { type: "string" } }, required: ["agentId", "prompt"], additionalProperties: false },
  },
  {
    name: "create_open_harness_routine",
    description: "Create a recurring task for this agent in the Open Harness scheduler.",
    inputSchema: { type: "object", properties: { name: { type: "string" }, prompt: { type: "string" }, intervalMinutes: { type: "integer", minimum: 1 }, timezone: { type: "string" } }, required: ["name", "prompt", "intervalMinutes"], additionalProperties: false },
  },
];
class Unreachable extends Error {}
let reported = false;
function attempt(options, input) {
  return new Promise((resolve, reject) => {
    const send = options.protocol === 'https:' ? httpsRequest : httpRequest;
    let connected = false;
    const req = send(options, response => {
      let body = "", size = 0;
      response.on("data", chunk => { size += chunk.length; if (size > 8_100_000) { reject(new Error('Coordination response is too large.')); response.destroy(); req.destroy(); } else body += chunk; });
      response.on('error', () => reject(new Error('Coordination response was interrupted. Inspect the destination before repeating an action.')));
      response.on("end", () => { try { const value = JSON.parse(body); if ((response.statusCode || 500) >= 400) reject(new Error(value.error || "Coordination request failed.")); else resolve(value); } catch { reject(new Error("Invalid coordination response.")); } });
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
    if (value?.state === 'denied') return { isError: true, content: [{ type: 'text', text: 'The operator did not approve this computer action. No action was dispatched.' }] };
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
  throw new Error("The local coordination service is unavailable. Check Open Harness runtime status.");
}
async function dispatch(message) {
  if (message.method === "initialize") return { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "open-harness-coordination", version: "0.2.0" } };
  if (message.method === "tools/list") return { tools };
  if (message.method === "tools/call") {
    const name = message.params?.name, args = message.params?.arguments || {};
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
    const value = name === 'post_message' ? await call('/internal/message', args) : name === 'read_inbox' ? (args.messageIds ? await call('/internal/inbox/ack', { messageIds: args.messageIds }) : await call(`/internal/inbox${args.conversationId ? `?conversationId=${encodeURIComponent(args.conversationId)}` : ''}`, {}, undefined, 'GET')) : name === 'workspace' ? await call('/internal/workspace', args) : name === 'group_chat' ? await call('/internal/group-chat', args) : name === "delegate_named_agent" ? await call("/internal/handoff", args) : name === "create_open_harness_routine" ? await call("/internal/schedule", args) : name === "task" ? await call("/internal/task", args) : (() => { throw new Error(`Unknown tool: ${name}`); })();
    return { content: [{ type: "text", text: JSON.stringify(value) }] };
  }
  if (message.method === "notifications/initialized") return undefined;
  throw new Error(`Unsupported MCP method: ${message.method}`);
}
const lines = readline.createInterface({ input: process.stdin });
lines.on("line", async line => {
  let message; try { message = JSON.parse(line); } catch { return; }
  if (message.id == null) { try { await dispatch(message); } catch {} return; }
  try { const result = await dispatch(message); process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\n"); }
  catch (error) { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: error instanceof Error ? error.message : "Tool failed" } }) + "\n"); }
});
