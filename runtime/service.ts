/* eslint-disable @typescript-eslint/no-explicit-any */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdirSync, writeFileSync, readdirSync, readFileSync, statSync, unlinkSync, existsSync, rmSync } from "node:fs";
import { resolve, join } from "node:path";
import { createHmac, timingSafeEqual } from "node:crypto";
import { Profiles, ProfileError, validateModel, validId } from "./profiles";
import { discoverTools, discoverModels, prepareProfile, runtimeProbe } from "./profile-runtime";
import { profileAgent, type AgentProfile, type ToolCatalog } from "../lib/agent-profile";
import { Store, type RunRow } from "./db";
import { SecretStore } from "./secrets";
import { HermesGateway, dockerStatus, ensureContainer } from "./hermes";
import { coordinationSocket } from "./coordination-socket";
import { TaskError, TaskStore } from "./tasks";

const root = resolve(process.env.OPEN_HARNESS_STATE_DIR || ".open-harness");
mkdirSync(root, { recursive: true }); mkdirSync(join(root, "shared"), { recursive: true }); mkdirSync(join(root, "agents"), { recursive: true });
const store = new Store(join(root, "state.db"));
const tasks = new TaskStore(store.db);
store.runListener = run => tasks.syncRun(run);
tasks.reconcile();
const secrets = new SecretStore(join(root, "secrets.json"));
const profiles = new Profiles(store.db);
const importedWorkspace = store.db.prepare("SELECT payload_json FROM migrations WHERE key='browser-v1'").get() as { payload_json: string } | undefined;
const importedAgents = importedWorkspace ? JSON.parse(importedWorkspace.payload_json).agents || [] : [];
for (const row of store.db.prepare("SELECT * FROM agents").all() as any[]) profiles.import({ ...row, description: "", tone: 0, memory: [], ...importedAgents.find((a: any) => a.id === row.id), config: JSON.parse(row.config_json) });
const port = Number(process.env.OPEN_HARNESS_PORT || 4317);
const gateways = new Map<string, HermesGateway>();
const active = new Map<string, { gateway: HermesGateway; sessionId: string }>();
const stoppingAgents = new Set<string>();
const coordinationSockets = new Map<string, ReturnType<typeof coordinationSocket>>();
let pumping = false;

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store", "Access-Control-Allow-Origin": allowedOrigin(res.req.headers.origin), "Vary": "Origin", "Access-Control-Allow-Headers": "Authorization, Content-Type", "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS" });
  res.end(JSON.stringify(body));
}
function allowedOrigin(origin?: string) { return origin && /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin) ? origin : "http://localhost:3000"; }
async function body(req: IncomingMessage) {
  let text = ""; for await (const chunk of req) { text += chunk; if (text.length > 5_000_000) throw new Error("Request too large."); }
  return text ? JSON.parse(text) : {};
}
function authenticated(req: IncomingMessage) { return req.headers.authorization === `Bearer ${secrets.token}`; }
function agentToken(agentId: string) { return createHmac("sha256", secrets.token).update(`agent:${agentId}`).digest("hex"); }
function authenticatedAgent(req: IncomingMessage) {
  const id = String(req.headers["x-open-harness-agent"] || ""), supplied = String(req.headers.authorization || "").replace(/^Bearer /, ""), expected = agentToken(id);
  return Boolean(id && supplied.length === expected.length && timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) ? id : null;
}
function event(runId: string, type: string, payload: unknown) { return store.appendEvent(runId, type, payload); }
function profileResponse(profile: AgentProfile) {
  const live = store.listRuns().find(run => run.agent_id === profile.id && ["running", "waiting_approval", "waiting_input"].includes(run.state));
  const snapshot = live ? profiles.runSnapshot(live.id) : null;
  return { profile, effectiveModel: profiles.effective(profile), activeRevision: snapshot?.revision ?? null, pending: Boolean(snapshot && (snapshot.revision !== profile.revision || JSON.stringify(snapshot.effectiveModel) !== JSON.stringify(profiles.effective(profile)))), secretNames: secrets.names() };
}
function ensureProfileDirs(id: string) { validId(id); for (const folder of ['profile', 'private', 'managed']) mkdirSync(join(root, 'agents', id, folder), { recursive: true }); }
function internalAllowed(agentId: string | null, tool: string, runId?: string) {
  const run = runId ? store.getRun(runId) : store.listRuns().find(r => r.agent_id === agentId && ['running','waiting_approval','waiting_input'].includes(r.state));
  return Boolean(run && run.agent_id === agentId && ['running','waiting_approval','waiting_input'].includes(run.state) && profiles.runSnapshot(run.id)?.allowedTools.includes(tool));
}

async function gatewayFor(agentId: string, allowedTools: string[] | null = null) {
  let gateway = gateways.get(agentId);
  if (gateway) return gateway;
  const container = ensureContainer(agentId, root);
  gateway = new HermesGateway(container, allowedTools); gateways.set(agentId, gateway);
  try { await gateway.start(); return gateway; }
  catch (error) { gateways.delete(agentId); throw error; }
}

function mapHermesEvent(run: RunRow, value: any) {
  const type = String(value?.type || value?.event || "runtime.event");
  const payload = value?.payload ?? value?.data ?? value;
  if (type === "approval.request") {
    const approvalId = crypto.randomUUID();
    store.createApproval(approvalId, run.id, String(payload?.request_id || payload?.id || ""), payload);
    store.setRun(run.id, { state: "waiting_approval" });
    event(run.id, "approval.request", { ...payload, approvalId });
  } else if (type === "clarify.request" || type === "secret.request" || type === "sudo.request") {
    store.setRun(run.id, { state: "waiting_input" }); event(run.id, type, payload);
  } else event(run.id, type, payload);
}

async function execute(run: RunRow) {
  store.setRun(run.id, { state: "running" }); event(run.id, "run.started", { runId: run.id, agentId: run.agent_id });
  let subscribed: { gateway: HermesGateway; listener: (value: any) => void } | null = null;
  try {
    const profile = profiles.get(run.agent_id);
    if (!profile) throw new Error("Agent profile not found. Open Agent settings and save this agent.");
    const snapshot = profiles.snapshot(run.id, profile);
    event(run.id, "profile.applied", { revision: snapshot.revision, model: snapshot.effectiveModel, allowedTools: snapshot.allowedTools });
    const priorGateway = gateways.get(run.agent_id);
    if (priorGateway) { await priorGateway.stop(); gateways.delete(run.agent_id); }
    if (!coordinationSockets.has(run.agent_id)) coordinationSockets.set(run.agent_id, coordinationSocket(join(root, 'agents', run.agent_id, 'managed'), run.agent_id, (req, res) => { server.emit('request', req, res); }));
    await coordinationSockets.get(run.agent_id);
    if (store.getRun(run.id)?.state === 'cancelled') return;
    prepareProfile(root, snapshot, snapshot.effectiveModel, secrets, agentToken(run.agent_id), run.id);
    const gateway = await gatewayFor(run.agent_id, snapshot.allowedTools);
    const listener = (value: any) => mapHermesEvent(run, value); gateway.on("event", listener); subscribed = { gateway, listener };
    const session = run.session_id ? { session_id: run.session_id } : await gateway.request("session.create", { cwd: "/workspace/shared", profile: "default" });
    if (store.getRun(run.id)?.state === "cancelled") return;
    const sessionId = String(session?.session_id || session?.id || run.session_id || "");
    if (!sessionId) throw new Error("Hermes did not return a session ID.");
    store.setRun(run.id, { session_id: sessionId }); active.set(run.id, { gateway, sessionId });
    const result = await gateway.submitPrompt(sessionId, run.prompt);
    active.delete(run.id);
    const current = store.getRun(run.id);
    if (current?.state === "cancelled") return;
    const answer = String(result?.text || result?.final_response || result?.message || "");
    store.setRun(run.id, { state: "completed", result: answer }); event(run.id, "run.completed", { result: answer });
  } catch (error) {
    active.delete(run.id); const message = error instanceof Error ? error.message : "Hermes execution failed.";
    const state = store.getRun(run.id)?.state === "cancelled" ? "cancelled" : (error as { interrupted?: boolean })?.interrupted ? "interrupted" : "failed";
    store.setRun(run.id, { state, error: message }); event(run.id, `run.${state}`, { error: message });
  } finally { if (subscribed) subscribed.gateway.off("event", subscribed.listener); void pump(); }
}

async function pump() {
  if (pumping) return; pumping = true;
  try {
    while (store.activeCount() < 4) {
      const next = store.queued().find(candidate =>
        !store.agentBusy(candidate.agent_id) && !stoppingAgents.has(candidate.agent_id) &&
        (candidate.depth > 0 || store.activeTopLevelCount() < 2));
      if (!next) break;
      void execute(next);
    }
  } finally { pumping = false; }
}

async function stopRunTree(runId: string) {
  const ids = [runId, ...store.descendants(runId).map(item => item.id)];
  let stopped = 0;
  for (const id of ids) {
    const run = store.getRun(id);
    if (!run || ["completed", "failed", "interrupted", "cancelled"].includes(run.state)) continue;
    const live = active.get(id);
    stoppingAgents.add(run.agent_id);
    store.setRun(id, { state: "cancelled" });
    try {
      const gateway = live?.gateway || (run.state === 'queued' ? undefined : gateways.get(run.agent_id));
      if (live) await live.gateway.request("session.interrupt", { session_id: live.sessionId }, 5000).catch(() => {});
      if (gateway) { await gateway.stop(); gateways.delete(run.agent_id); }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Runtime stop could not be confirmed.";
      store.setRun(id, { state: "interrupted", error: message });
      event(id, "run.interrupted", { error: message });
      // Keep this agent out of admission until the service restarts and Docker is checked.
      throw error;
    }
    stoppingAgents.delete(run.agent_id);
    event(id, "run.cancelled", { stoppedWithParent: id !== runId }); stopped++;
  }
  void pump();
  return stopped;
}

async function waitForRun(id: string, timeoutMs = 30 * 60 * 1000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = store.getRun(id); if (!run) throw new Error("Delegated run disappeared.");
    if (["completed", "failed", "interrupted", "cancelled"].includes(run.state)) return run;
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error("Delegated run is still active after 30 minutes. Its run ID remains available in Open Harness.");
}

function createRun(input: { agentId: string; conversationId?: string; prompt: string; parentRunId?: string; depth?: number }) {
  if (!input.agentId || !input.prompt?.trim()) throw new Error("agentId and prompt are required.");
  if (!profiles.get(input.agentId)) throw new ProfileError("Agent profile not found.", 404);
  const parent = input.parentRunId ? store.getRun(input.parentRunId) : undefined;
  const depth = parent ? parent.depth + 1 : Number(input.depth || 0);
  if (depth > 2) throw new Error("Delegation depth is limited to two.");
  if (parent) {
    const ancestors = new Set<string>([parent.agent_id]); let cursor = parent;
    while (cursor.parent_run_id) { const previous = store.getRun(cursor.parent_run_id); if (!previous) break; ancestors.add(previous.agent_id); cursor = previous; }
    if (ancestors.has(input.agentId)) throw new Error("Cyclic agent handoffs are not allowed.");
  }
  const stamp = new Date().toISOString();
  const run: RunRow = { id: crypto.randomUUID(), agent_id: input.agentId, conversation_id: input.conversationId || crypto.randomUUID(), prompt: input.prompt.trim(), state: "queued", session_id: null, parent_run_id: input.parentRunId || null, depth, created_at: stamp, updated_at: stamp, result: null, error: null };
  store.createRun(run); event(run.id, "run.queued", { position: store.listRuns().filter(item => item.state === "queued").length }); void pump(); return run;
}

function listFiles(dir: string) {
  if (!dir.startsWith(root)) throw new Error("Invalid workspace path.");
  mkdirSync(dir, { recursive: true });
  return readdirSync(dir, { withFileTypes: true }).filter(entry => entry.isFile()).slice(0, 200).map(entry => {
    const path = join(dir, entry.name), stat = statSync(path); return { name: entry.name, size: stat.size, updatedAt: stat.mtime.toISOString(), mimeType: mimeType(entry.name), encoding: isText(entry.name) ? "utf8" : "base64" };
  });
}
function isText(name: string) { return /\.(txt|md|csv|json|html|css|js|mjs|cjs|ts|tsx|py|yaml|yml|xml|log|svg)$/i.test(name); }
function mimeType(name: string) {
  const ext = name.toLowerCase().split(".").pop();
  return ({ png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif", svg: "image/svg+xml", pdf: "application/pdf", json: "application/json", csv: "text/csv", md: "text/markdown", html: "text/html" } as Record<string, string>)[ext || ""] || (isText(name) ? "text/plain" : "application/octet-stream");
}
function workspaceDir(url: URL) { const scope = url.searchParams.get("scope") || "shared", agentId = url.searchParams.get("agentId") || ""; return { scope, dir: scope === "private" ? join(root, "agents", agentId.replace(/[^a-zA-Z0-9_.-]/g, "-"), "private") : join(root, "shared") }; }
function safeFile(dir: string, name: string) { if (!/^[a-zA-Z0-9][a-zA-Z0-9._ -]{0,159}$/.test(name) || name.includes("..")) throw new Error("Invalid filename."); const target = join(dir, name); if (!target.startsWith(dir + "/")) throw new Error("Invalid path."); return target; }

const server = createServer(async (req, res) => {
  const origin = req.headers.origin;
  if (origin && !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return json(res, 403, { error: "Open Harness accepts local browser clients only." });
  if (req.method === "OPTIONS") { res.writeHead(204, { "Access-Control-Allow-Origin": allowedOrigin(origin), "Access-Control-Allow-Headers": "Authorization, Content-Type", "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS" }); return res.end(); }
  const url = new URL(req.url || "/", `http://127.0.0.1:${port}`);
  try {
    if (req.method === "GET" && url.pathname === "/v1/bootstrap") return json(res, 200, { token: secrets.token, runtime: dockerStatus(), version: "0.2.0", hermes: { release: "v2026.9.11", commit: "939e45c91d751fadd94dcd1b873ac3cb44846213" } });
    const internalAgent = url.pathname.startsWith("/internal/") ? authenticatedAgent(req) : null;
    if (!authenticated(req) && !internalAgent) return json(res, 401, { error: "Invalid local control token." });
    if (req.method === "GET" && url.pathname === "/v1/health") return json(res, 200, { ok: true, runtime: dockerStatus(), activeRuns: store.activeCount(), queuedRuns: store.listRuns().filter(run => run.state === "queued").length, secrets: secrets.names() });
    if (req.method === "POST" && url.pathname === "/v1/agents/sync") {
      const input = await body(req);
      for (const agent of input.agents || []) { profiles.import(agent); ensureProfileDirs(agent.id); }
      return json(res, 200, { synced: input.agents?.length || 0, agents: profiles.list().map(p => profileAgent(p)) });
    }
    if (req.method === "GET" && url.pathname === "/v1/agents") return json(res, 200, { agents: profiles.list().map(p => profileAgent(p)) });
    if (req.method === "POST" && url.pathname === "/v1/workspace/model/import") {
      const input = await body(req);
      return json(res, 200, profiles.defaults().revision ? profiles.defaults() : profiles.setDefaults(input.model, 0));
    }
    if (url.pathname === "/v1/workspace/model") {
      if (req.method === "GET") return json(res, 200, profiles.defaults());
      if (req.method === "PUT") { const input = await body(req); return json(res, 200, profiles.setDefaults(input.model, input.revision)); }
    }
    const profileMatch = url.pathname.match(/^\/v1\/agents\/([^/]+)\/(profile|tools|models|connection-check|connector-check)$/);
    if (profileMatch) {
      const id = validId(decodeURIComponent(profileMatch[1])), action = profileMatch[2];
      const profile = profiles.get(id);
      if (action === 'profile' && req.method === 'PUT') {
        const input = await body(req); if (input.id !== id) throw new ProfileError('Profile ID does not match the selected agent.');
        const saved = profiles.save(input); ensureProfileDirs(id);
        return json(res, 200, profileResponse(saved));
      }
      if (!profile) return json(res, 404, { error: 'Agent profile not found.' });
      if (action === 'profile' && req.method === 'GET') return json(res, 200, profileResponse(profile));
      if (action === 'tools' && req.method === 'GET') {
        ensureProfileDirs(id);
        const catalog = await discoverTools(id, root);
        if (catalog.source === 'unavailable') {
          const cached = store.db.prepare('SELECT json FROM tool_catalogs WHERE agent_id=?').get(id) as { json: string } | undefined;
          if (cached) { catalog.tools = (JSON.parse(cached.json) as ToolCatalog).tools.map(t => ({ ...t, available: false, reason: catalog.error })); catalog.source = 'cached'; }
        } else {
          const cached = store.db.prepare('SELECT json FROM tool_catalogs WHERE agent_id=?').get(id) as { json: string } | undefined;
          // Keep discovered connection tools editable across refreshes. A past handshake
          // is inventory, not proof the connection is available now.
          if (cached) for (const tool of (JSON.parse(cached.json) as ToolCatalog).tools) {
            if (tool.group === 'mcp' && !catalog.tools.some(t => t.id === tool.id)) catalog.tools.push({ ...tool, available: false, reason: 'Previously discovered. Test this connection again to confirm availability.' });
          }
          store.db.prepare('INSERT INTO tool_catalogs VALUES(?,?) ON CONFLICT(agent_id) DO UPDATE SET json=excluded.json').run(id, JSON.stringify(catalog));
        }
        return json(res, 200, catalog);
      }
      if (action === 'models' && req.method === 'GET') {
        try {
          if (!gateways.has(id)) { ensureProfileDirs(id); prepareProfile(root, profile, profiles.effective(profile), secrets, agentToken(id), 'catalog'); }
          return json(res, 200, await discoverModels(await gatewayFor(id, [])));
        } catch { return json(res, 200, { models: [], error: 'Model catalog unavailable. Start the Hermes runtime or enter a custom model ID.' }); }
      }
      if (action === 'connection-check' && req.method === 'POST') {
        const input = await body(req), model = validateModel(input.model);
        if (model.credentialRef && !secrets.has(model.credentialRef)) return json(res, 200, { ok: false, message: `Add the ${model.credentialRef} credential first.` });
        if (process.env.OPEN_HARNESS_MOCK === '1') return json(res, 200, { ok: true, message: 'Deterministic test connection is ready.' });
        const endpoints: Record<string,string> = { xai: 'https://api.x.ai/v1', openrouter: 'https://openrouter.ai/api/v1', openai: 'https://api.openai.com/v1' };
        const baseUrl = model.baseUrl || endpoints[model.provider];
        if (!baseUrl) return json(res, 200, { ok: false, message: 'This provider does not expose a compatible model-list endpoint. Model authentication will be checked by Hermes at task start.' });
        ensureProfileDirs(id);
        try { return json(res, 200, await runtimeProbe(ensureContainer(id, root), { action: 'connection', baseUrl, apiKey: secrets.environment()[model.credentialRef] || '' })); }
        catch (error) { return json(res, 200, { ok: false, message: error instanceof Error ? error.message : 'Connection failed.' }); }
      }
      if (action === 'connector-check' && req.method === 'POST') {
        const input = await body(req), candidate = input.connector;
        // Validate a draft without persisting it or changing the active run configuration.
        const { validateProfile } = await import('./profiles');
        const tested = validateProfile({ ...profile, connectors: [candidate] }).connectors[0];
        if (tested.secretRef && !secrets.has(tested.secretRef)) return json(res, 200, { status: 'missing_credentials', error: `Add secret ${tested.secretRef}.`, tools: [] });
        try {
          ensureProfileDirs(id);
          const result = process.env.OPEN_HARNESS_MOCK === '1' ? { status: 'connected', tools: [{ name: 'lookup', description: 'Mock connected tool' }] } : await runtimeProbe(ensureContainer(id, root), { action: 'mcp', command: tested.command, args: tested.args, env: tested.secretRef ? { [tested.secretRef]: secrets.environment()[tested.secretRef] } : {} });
          const tools = (result.tools as Array<{ name: string; description: string }>).map(t => ({ id: `mcp_${tested.name}_${t.name}`, name: t.name, description: t.description, group: 'mcp', available: true }));
          const prior = store.db.prepare('SELECT json FROM tool_catalogs WHERE agent_id=?').get(id) as { json: string } | undefined;
          const catalog: ToolCatalog = prior ? JSON.parse(prior.json) : { source: 'runtime', tools: [] };
          catalog.tools = [...catalog.tools.filter(t => !t.id.startsWith(`mcp_${tested.name}_`)), ...tools];
          store.db.prepare('INSERT INTO tool_catalogs VALUES(?,?) ON CONFLICT(agent_id) DO UPDATE SET json=excluded.json').run(id, JSON.stringify(catalog));
          return json(res, 200, { ...result, tools });
        } catch { return json(res, 200, { status: 'failed', error: 'MCP initialize/tools-list handshake failed. Check the executable, arguments, and credentials.', tools: [] }); }
      }
    }
    const skillMatch = url.pathname.match(/^\/v1\/agents\/([^/]+)\/context\/skills\/([^/]+)$/);
    if (skillMatch) {
      const safe = skillMatch[1].replace(/[^a-zA-Z0-9_.-]/g, "-").slice(0, 48);
      const skill = decodeURIComponent(skillMatch[2]);
      if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,79}$/.test(skill)) return json(res, 400, { error: "Invalid skill name." });
      const skillDir = join(root, "agents", safe, "profile", "skills", skill), skillFile = join(skillDir, "SKILL.md");
      if (req.method === "GET") { if (!existsSync(skillFile)) return json(res, 404, { error: "Skill not found." }); return json(res, 200, { name: skill, content: readFileSync(skillFile, "utf8") }); }
      if (req.method === "PUT") { const input = await body(req); mkdirSync(skillDir, { recursive: true }); writeFileSync(skillFile, String(input.content || ""), { mode: 0o600 }); return json(res, 200, { ok: true }); }
      if (req.method === "DELETE") { if (existsSync(skillDir)) rmSync(skillDir, { recursive: true }); return json(res, 200, { ok: true }); }
    }
    const contextMatch = url.pathname.match(/^\/v1\/agents\/([^/]+)\/context$/);
    if (contextMatch) {
      const safe = contextMatch[1].replace(/[^a-zA-Z0-9_.-]/g, "-").slice(0, 48), profile = join(root, "agents", safe, "profile"), memoryPath = join(profile, "MEMORY.md"), userPath = join(profile, "USER.md"), skillsPath = join(profile, "skills"); mkdirSync(profile, { recursive: true });
      if (req.method === "PUT") { const input = await body(req); if (String(input.memory || "").length > 50_000) return json(res, 413, { error: "Memory is limited to 50 KB." }); writeFileSync(memoryPath, String(input.memory || ""), { mode: 0o600 }); return json(res, 200, { ok: true }); }
      if (req.method === "GET") { const skills = existsSync(skillsPath) ? readdirSync(skillsPath, { withFileTypes: true }).filter(item => item.isDirectory()).map(item => item.name).slice(0, 200) : [], available = dockerStatus().available; return json(res, 200, { memory: existsSync(memoryPath) ? readFileSync(memoryPath, "utf8") : "", user: existsSync(userPath) ? readFileSync(userPath, "utf8") : "", skills, capabilities: { terminal: available, process: available, code: available, files: available, web: available, browser: available, memory: available, skills: available, mcp: available, delegation: available, schedules: true } }); }
    }
    if (req.method === "POST" && url.pathname === "/v1/migrate") {
      const input = await body(req); const found = store.db.prepare("SELECT 1 FROM migrations WHERE key='browser-v1'").get();
      if (found) return json(res, 200, { migrated: false, reason: "already_migrated" });
      store.db.prepare("INSERT INTO migrations(key,payload_json,created_at) VALUES(?,?,?)").run("browser-v1", JSON.stringify(input), new Date().toISOString());
      for (const agent of input.agents || []) {
        profiles.import(agent);
        const safe = String(agent.id).replace(/[^a-zA-Z0-9_.-]/g, "-").slice(0, 48), profile = join(root, "agents", safe, "profile");
        mkdirSync(profile, { recursive: true });
        if (Array.isArray(agent.memory) && agent.memory.length) writeFileSync(join(profile, "MEMORY.md"), agent.memory.map((item: unknown) => `- ${String(item)}`).join("\n") + "\n", { mode: 0o600 });
      }
      for (const conversation of input.conversations || []) store.db.prepare("INSERT OR IGNORE INTO conversations(id,agent_id,title,legacy_json,created_at,updated_at) VALUES(?,?,?,?,?,?)").run(conversation.id, conversation.agentId, conversation.title, JSON.stringify(conversation), conversation.updatedAt || new Date().toISOString(), conversation.updatedAt || new Date().toISOString());
      for (const file of input.files || []) { const target = join(root, "shared", String(file.name).replace(/[^a-zA-Z0-9._ -]/g, "_")); writeFileSync(target, String(file.content).slice(0, 1_000_000)); }
      writeFileSync(join(root, "browser-v1-backup.json"), JSON.stringify(input, null, 2), { mode: 0o600 });
      return json(res, 200, { migrated: true });
    }
    if (url.pathname === "/v1/boards") {
      if (req.method === "GET") return json(res, 200, { boards: tasks.listBoards(url.searchParams.get("includeArchived") === "1") });
      if (req.method === "POST") return json(res, 201, tasks.createBoard(await body(req)));
    }
    const boardMatch = url.pathname.match(/^\/v1\/boards\/([^/]+)(?:\/(stages))?$/);
    if (boardMatch) {
      const boardId = decodeURIComponent(boardMatch[1]);
      if (!boardMatch[2] && req.method === "GET") return json(res, 200, tasks.getBoard(boardId));
      if (!boardMatch[2] && req.method === "PUT") return json(res, 200, tasks.updateBoard(boardId, await body(req)));
      if (boardMatch[2] === "stages" && req.method === "POST") return json(res, 201, tasks.addStage(boardId, await body(req)));
    }
    const stageMatch = url.pathname.match(/^\/v1\/stages\/([^/]+)$/);
    if (stageMatch) {
      if (req.method === "PUT") return json(res, 200, tasks.updateStage(decodeURIComponent(stageMatch[1]), await body(req)));
      if (req.method === "DELETE") return json(res, 200, tasks.removeStage(decodeURIComponent(stageMatch[1]), url.searchParams.get("moveToStageId") || undefined));
    }
    if (url.pathname === "/v1/tasks") {
      if (req.method === "GET") return json(res, 200, { boards: tasks.listBoards(url.searchParams.get("includeArchived") === "1"), tasks: tasks.listTasks(url.searchParams.get("includeArchived") === "1") });
      if (req.method === "POST") return json(res, 201, tasks.createTask(await body(req)));
    }
    const taskMatch = url.pathname.match(/^\/v1\/tasks\/([^/]+)(?:\/(comments|start|request-changes|approve|runs))?$/);
    if (taskMatch) {
      const taskId = decodeURIComponent(taskMatch[1]), action = taskMatch[2];
      if (!action && req.method === "GET") return json(res, 200, tasks.getTask(taskId));
      if (!action && req.method === "PUT") return json(res, 200, tasks.updateTask(taskId, await body(req)));
      if (action === "comments" && req.method === "POST") return json(res, 201, tasks.comment(taskId, await body(req)));
      if ((action === "start" || action === "request-changes") && req.method === "POST") return json(res, 202, tasks.start(taskId, await body(req), createRun));
      if (action === "approve" && req.method === "POST") { const input = await body(req); return json(res, 200, tasks.approve(taskId, input.revision === undefined ? undefined : Number(input.revision))); }
      if (action === "runs" && req.method === "GET") return json(res, 200, { runs: tasks.getTask(taskId).runs });
    }
    if (req.method === "POST" && url.pathname === "/v1/runs") return json(res, 202, createRun(await body(req)));
    if (req.method === "GET" && url.pathname === "/v1/runs") return json(res, 200, { runs: store.listRuns() });
    const runMatch = url.pathname.match(/^\/v1\/runs\/([^/]+)(?:\/(events|steer|stop|approval))?$/);
    if (runMatch) {
      const run = store.getRun(runMatch[1]); if (!run) return json(res, 404, { error: "Run not found." }); const action = runMatch[2];
      if (!action && req.method === "GET") return json(res, 200, run);
      if (action === "events" && req.method === "GET") return json(res, 200, { events: store.events(run.id, Number(url.searchParams.get("after") || 0)), run: store.getRun(run.id) });
      if (action === "steer" && req.method === "POST") { const input = await body(req), live = active.get(run.id); if (!live) return json(res, 409, { error: "Run is not active." }); await live.gateway.request("session.steer", { session_id: live.sessionId, text: String(input.text || "") }); event(run.id, "run.steered", { text: input.text }); return json(res, 200, { ok: true }); }
      if (action === "stop" && req.method === "POST") return json(res, 200, { ok: true, stopped: await stopRunTree(run.id) });
      if (action === "approval" && req.method === "POST") { const input = await body(req), approval = store.approval(String(input.approvalId)); if (!approval || approval.run_id !== run.id) return json(res, 404, { error: "Approval not found." }); const live = active.get(run.id); if (!live) return json(res, 409, { error: "Run is not active." }); const decision = input.decision === "approve" ? "approve" : "deny"; await live.gateway.request("approval.respond", { request_id: approval.gateway_request_id, decision }); store.resolveApproval(String(input.approvalId), decision); store.setRun(run.id, { state: "running" }); event(run.id, "approval.resolved", { approvalId: input.approvalId, decision }); return json(res, 200, { ok: true }); }
    }
    if (req.method === "POST" && url.pathname === "/v1/runs/stop-all") { let stopped = 0; for (const run of store.listRuns().filter(item => !item.parent_run_id && ["queued","running","waiting_approval","waiting_input"].includes(item.state))) stopped += await stopRunTree(run.id); return json(res, 200, { stopped }); }
    if (req.method === "POST" && url.pathname === "/v1/secrets") { const input = await body(req); secrets.set(String(input.name), String(input.value)); return json(res, 200, { ok: true, name: input.name }); }
    if (/^\/v1\/agents\/[^/]+\/connectors/.test(url.pathname)) return json(res, 410, { error: 'Connection settings moved into Agent settings. Reload the app.' });
    if (url.pathname === "/v1/files") { const { scope, dir } = workspaceDir(url); mkdirSync(dir, { recursive: true }); if (req.method === "GET") { const name = url.searchParams.get("name"); if (name) { const target = safeFile(dir, name); if (!existsSync(target)) return json(res, 404, { error: "File not found." }); const encoding = isText(name) ? "utf8" : "base64"; return json(res, 200, { name, content: readFileSync(target, encoding), encoding, mimeType: mimeType(name), scope }); } return json(res, 200, { files: listFiles(dir), scope }); } if (req.method === "POST") { const input = await body(req), content = String(input.content || ""), encoding = input.encoding === "base64" ? "base64" : "utf8", bytes = encoding === "base64" ? Buffer.byteLength(content, "base64") : Buffer.byteLength(content); if (bytes > 1_000_000) return json(res, 413, { error: "Files are limited to 1 MB." }); const target = safeFile(dir, String(input.name || "")); writeFileSync(target, content, { encoding, mode: 0o600 }); return json(res, 201, { name: input.name, scope }); } if (req.method === "DELETE") { const target = safeFile(dir, String(url.searchParams.get("name") || "")); if (existsSync(target)) unlinkSync(target); return json(res, 200, { ok: true }); } }
    if (req.method === "GET" && url.pathname === "/v1/routines") return json(res, 200, { routines: store.db.prepare("SELECT * FROM schedules ORDER BY created_at DESC").all() });
    if (req.method === "POST" && url.pathname === "/v1/routines") { const input = await body(req), stamp = new Date(), id = crypto.randomUUID(), minutes = Math.max(1, Number(input.intervalMinutes || 60)); const next = new Date(stamp.getTime() + minutes * 60000).toISOString(); store.db.prepare("INSERT INTO schedules(id,agent_id,name,prompt,interval_minutes,timezone,enabled,next_run_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)").run(id, input.agentId, input.name, input.prompt, minutes, input.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone, 1, next, stamp.toISOString(), stamp.toISOString()); return json(res, 201, { id, nextRunAt: next }); }
    const routineMatch = url.pathname.match(/^\/v1\/routines\/([^/]+)\/(run|toggle|history)$/);
    if (routineMatch) {
      const routine = store.db.prepare("SELECT * FROM schedules WHERE id=?").get(routineMatch[1]) as any;
      if (!routine) return json(res, 404, { error: "Routine not found." });
      if (routineMatch[2] === "history" && req.method === "GET") return json(res, 200, { history: store.db.prepare("SELECT schedule_runs.*,runs.state,runs.result,runs.error,runs.updated_at FROM schedule_runs JOIN runs ON runs.id=schedule_runs.run_id WHERE schedule_id=? ORDER BY scheduled_for DESC LIMIT 100").all(routine.id) });
      if (req.method === "POST" && routineMatch[2] === "run") { const stamp = new Date().toISOString(), run = createRun({ agentId: routine.agent_id, prompt: routine.prompt }); store.db.prepare("INSERT INTO schedule_runs(schedule_id,run_id,scheduled_for) VALUES(?,?,?)").run(routine.id, run.id, stamp); store.db.prepare("UPDATE schedules SET last_run_at=?,updated_at=? WHERE id=?").run(stamp, stamp, routine.id); return json(res, 202, run); }
      if (req.method === "POST" && routineMatch[2] === "toggle") { store.db.prepare("UPDATE schedules SET enabled=?,updated_at=? WHERE id=?").run(routine.enabled ? 0 : 1, new Date().toISOString(), routine.id); return json(res, 200, { enabled: !routine.enabled }); }
    }
    if (req.method === "POST" && url.pathname === "/internal/handoff") { const input = await body(req); const parent = store.listRuns().find(run => run.agent_id === internalAgent && ["running","waiting_approval","waiting_input"].includes(run.state)); if (!parent) return json(res, 409, { error: "The delegating agent has no active run." }); if (!internalAllowed(internalAgent, "mcp_open_harness_delegate_named_agent", String(req.headers["x-open-harness-run"] || parent.id))) return json(res, 403, { error: "Delegation is disabled for this run." }); const child = createRun({ agentId: input.agentId, prompt: input.prompt, parentRunId: parent.id }); event(parent.id, "handoff.created", { childRunId: child.id, targetAgentId: input.agentId, prompt: input.prompt }); const result = await waitForRun(child.id); event(parent.id, "handoff.completed", { childRunId: child.id, targetAgentId: input.agentId, state: result.state }); return json(res, 200, { runId: result.id, state: result.state, result: result.result, error: result.error }); }
    if (req.method === "POST" && url.pathname === "/internal/schedule") { if (!internalAllowed(internalAgent, "mcp_open_harness_create_open_harness_routine", String(req.headers["x-open-harness-run"] || ""))) return json(res, 403, { error: "Scheduling is disabled for this run." }); const input = await body(req), stamp = new Date(), id = crypto.randomUUID(), minutes = Math.max(1, Number(input.intervalMinutes || 60)), next = new Date(stamp.getTime() + minutes * 60000).toISOString(); store.db.prepare("INSERT INTO schedules(id,agent_id,name,prompt,interval_minutes,timezone,enabled,next_run_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)").run(id, internalAgent, input.name, input.prompt, minutes, input.timezone || "UTC", 1, next, stamp.toISOString(), stamp.toISOString()); return json(res, 201, { id, nextRunAt: next }); }
    return json(res, 404, { error: "Not found." });
  } catch (error) { return json(res, error instanceof ProfileError || error instanceof TaskError ? error.status : 400, { error: error instanceof Error ? error.message : "Request failed." }); }
});

setInterval(() => {
  const now = new Date(), due = store.db.prepare("SELECT * FROM schedules WHERE enabled=1 AND next_run_at<=?").all(now.toISOString()) as any[];
  for (const routine of due) {
    const scheduledFor = routine.next_run_at;
    const duplicate = store.db.prepare("SELECT 1 FROM schedule_runs WHERE schedule_id=? AND scheduled_for=?").get(routine.id, scheduledFor); if (duplicate) continue;
    const run = createRun({ agentId: routine.agent_id, prompt: routine.prompt }); store.db.prepare("INSERT INTO schedule_runs(schedule_id,run_id,scheduled_for) VALUES(?,?,?)").run(routine.id, run.id, scheduledFor);
    const next = new Date(now.getTime() + Number(routine.interval_minutes) * 60000).toISOString(); store.db.prepare("UPDATE schedules SET last_run_at=?,next_run_at=?,updated_at=? WHERE id=?").run(now.toISOString(), next, now.toISOString(), routine.id);
  }
}, 30_000).unref();

server.listen(port, "127.0.0.1", () => console.log(`Open Harness control service listening on http://127.0.0.1:${port}`));
process.on("SIGTERM", async () => { for (const gateway of gateways.values()) await gateway.stop().catch(() => {}); for (const socket of coordinationSockets.values()) await socket.then(s => s.close()).catch(() => {}); server.close(); });
