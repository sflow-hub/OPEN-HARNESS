import readline from "node:readline";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

const agentId = process.env.OPEN_HARNESS_AGENT_ID;
const token = process.env.OPEN_HARNESS_AGENT_TOKEN;
const socketPath = process.env.OPEN_HARNESS_CONTROL_SOCKET || "/run/open-harness/coord.sock";
const controlUrl = process.env.OPEN_HARNESS_CONTROL_URL;
const sitesToken = process.env.OPEN_HARNESS_SITES_TOKEN;
const tools = [
  {
    name: "delegate_named_agent",
    description: "Assign a bounded task to another named Open Harness agent and return the durable run ID. Delegation depth is limited to two and cycles are rejected.",
    inputSchema: { type: "object", properties: { agentId: { type: "string", description: "Target agent ID" }, prompt: { type: "string" } }, required: ["agentId", "prompt"], additionalProperties: false },
  },
  {
    name: "create_open_harness_routine",
    description: "Create a recurring task for this agent in the Open Harness scheduler.",
    inputSchema: { type: "object", properties: { name: { type: "string" }, prompt: { type: "string" }, intervalMinutes: { type: "integer", minimum: 1 }, timezone: { type: "string" } }, required: ["name", "prompt", "intervalMinutes"], additionalProperties: false },
  },
];
async function call(path, input) {
  return new Promise((resolve, reject) => {
    const target = controlUrl ? new URL(`${controlUrl.replace(/\/$/, '')}${path}`) : null;
    const send = target?.protocol === 'https:' ? httpsRequest : httpRequest;
    const req = send(target || { socketPath, path }, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}`, "X-Open-Harness-Agent": agentId, "X-Open-Harness-Run": process.env.OPEN_HARNESS_RUN_ID || "", ...(sitesToken ? { "OAI-Sites-Authorization": `Bearer ${sitesToken}` } : {}) } }, response => {
      let body = "";
      response.on("data", chunk => { body += chunk; });
      response.on("end", () => { try { const value = JSON.parse(body); if ((response.statusCode || 500) >= 400) reject(new Error(value.error || "Coordination request failed.")); else resolve(value); } catch { reject(new Error("Invalid coordination response.")); } });
    });
    req.on("error", () => reject(new Error("The local coordination service is unavailable. Check Open Harness runtime status.")));
    req.end(JSON.stringify(input));
  });
}
async function dispatch(message) {
  if (message.method === "initialize") return { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "open-harness-coordination", version: "0.2.0" } };
  if (message.method === "tools/list") return { tools };
  if (message.method === "tools/call") {
    const name = message.params?.name, args = message.params?.arguments || {};
    const value = name === "delegate_named_agent" ? await call("/internal/handoff", args) : name === "create_open_harness_routine" ? await call("/internal/schedule", args) : (() => { throw new Error(`Unknown tool: ${name}`); })();
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
