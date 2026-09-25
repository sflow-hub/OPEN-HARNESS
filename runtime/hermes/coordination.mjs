import readline from "node:readline";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

const agentId = process.env.OPEN_HARNESS_AGENT_ID;
const token = process.env.OPEN_HARNESS_AGENT_TOKEN;
const socketPath = process.env.OPEN_HARNESS_CONTROL_SOCKET || "/run/open-harness/coord.sock";
const controlUrl = process.env.OPEN_HARNESS_CONTROL_URL;
const tools = [
  {
    name: "task",
    description: "Read and manage board tasks and projects. Team tasks are visible only to members; changing another agent's card requires that profile's board permission, and board_create and board_update require its manage-projects permission. A project's stages, automation settings, and archived state stay under human control.",
    inputSchema: { type: "object", properties: { action: { type: "string", enum: ["list", "columns", "get", "create", "update", "move", "comment", "check", "additem", "claim", "release", "run", "board_create", "board_update"] }, taskId: { type: "string" }, boardId: { type: "string" }, input: { type: "object" } }, required: ["action"], additionalProperties: false },
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
    const req = send(options, response => {
      let body = "";
      response.on("data", chunk => { body += chunk; });
      response.on("end", () => { try { const value = JSON.parse(body); if ((response.statusCode || 500) >= 400) reject(new Error(value.error || "Coordination request failed.")); else resolve(value); } catch { reject(new Error("Invalid coordination response.")); } });
    });
    // Only a failure to reach the coordinator is retryable. A 4xx is the coordinator's answer --
    // "delegation is disabled for this run" must not be retried down another route.
    req.on("error", () => reject(new Unreachable("unreachable")));
    req.end(JSON.stringify(input));
  });
}
async function call(path, input) {
  // One options object, never (url, options, callback): node reads the second argument as the
  // response listener when the first is options rather than a URL, so the socket route -- how
  // every local container agent reaches the coordinator -- failed on every call with
  // "The listener argument must be of type function".
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${token}`, "X-Open-Harness-Agent": agentId, "X-Open-Harness-Run": process.env.OPEN_HARNESS_RUN_ID || "" };
  // The socket first, always: it needs no open port and cannot be reached from off the machine.
  // Docker Desktop passes a bind mount through a VM, and a unix socket inside that mount is
  // visible but refuses every connection, so the configured URL is a fallback for that case
  // rather than the default. One failed connect to a socket that is not there costs nothing.
  const routes = [{ socketPath, path, method: "POST", headers }];
  if (controlUrl) {
    const target = new URL(`${controlUrl.replace(/\/$/, '')}${path}`);
    routes.push({ protocol: target.protocol, hostname: target.hostname, port: target.port || undefined, path: `${target.pathname}${target.search}`, method: "POST", headers });
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
    const value = name === "delegate_named_agent" ? await call("/internal/handoff", args) : name === "create_open_harness_routine" ? await call("/internal/schedule", args) : name === "task" ? await call("/internal/task", args) : (() => { throw new Error(`Unknown tool: ${name}`); })();
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
