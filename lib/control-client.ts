import type { SandboxResult } from '../runtime/sandbox-selftest';
/* eslint-disable @typescript-eslint/no-explicit-any */
import { normalizeRoutine, type RoutineInput, type RoutineRun } from "./routine";
import type { Agent } from "./types";
import { normalizeConversation, normalizeMember, normalizeMessage, normalizeScheduledRuns, type GroupChatInput, type MemberRole } from "./conversation";

export type AuditEvent = {
  seq: number; id: string; at: string; actorKind: "operator" | "agent" | "runner" | "system";
  actorId: string | null; action: string; targetKind: string | null; targetId: string | null; detail: unknown;
};

export type RuntimeStatus = {
  token: string;
  mode: "live" | "test";
  runtime: { available: boolean; version: string | null; message: string };
  version: string;
  hermes: { release: string; commit: string };
};

export type PersistentRun = {
  id: string;
  agent_id: string;
  conversation_id: string;
  prompt: string;
  state: "queued" | "running" | "waiting_approval" | "waiting_input" | "completed" | "failed" | "interrupted" | "cancelled";
  result?: string | null;
  error?: string | null;
  machine_id?: string | null;
  machine_connection?: "online" | "offline" | "revoked" | null;
};

function base() {
  if (typeof window !== "undefined") {
    // ?controlPort= is how the browser suite reaches its own coordinator. Honour it only
    // on a loopback page: from a remote dashboard, a crafted link carrying it would aim
    // the visitor's browser at whatever is listening on their machine.
    if (["localhost", "127.0.0.1", "::1"].includes(window.location.hostname)) {
      const testPort = new URLSearchParams(window.location.search).get("controlPort");
      if (testPort && /^\d{2,5}$/.test(testPort)) return `http://127.0.0.1:${testPort}`;
    }
    if (process.env.NEXT_PUBLIC_OPEN_HARNESS_SELF_HOSTED === '1') return `${window.location.origin}/api/local`;
  }
  return "http://127.0.0.1:4317";
}

// A coordinator that accepts the socket and then never answers used to leave the page on
// "Working on it…" for good, because only a rejected fetch was ever retried.
const REQUEST_TIMEOUT_MS = 30_000;

// The proxy forwards whatever content type it was given, so a reverse proxy's HTML 502 or an
// empty body would surface as "Unexpected end of JSON input". Say what actually arrived.
async function parseBody(response: Response) {
  const text = await response.text();
  if (!text.trim()) return {};
  try { return JSON.parse(text) as Record<string, unknown>; }
  catch { throw new Error(response.ok ? "Open Harness received a reply it could not read. Check whether something else is answering on the coordinator's address." : `The coordinator returned HTTP ${response.status}. Check that it is running and reachable.`); }
}

export class ControlClient {
  token = "";
  async listAuditEvents(filters: { after?: number; limit?: number; action?: string; targetKind?: string; targetId?: string } = {}) {
    const query = new URLSearchParams(Object.entries(filters).filter(([, value]) => value !== undefined).map(([key, value]) => [key, String(value)]));
    return (await this.request<{ events: AuditEvent[] }>(`/v1/audit?${query}`)).events;
  }
  async bootstrap() {
    const response = await fetch(`${base()}/v1/bootstrap`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    const body = await parseBody(response);
    if (!response.ok) throw new Error((body as { error?: string }).error || "Open Harness control service is unavailable.");
    const status = body as unknown as RuntimeStatus; this.token = status.token; return status;
  }
  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const send = () => fetch(`${base()}${path}`, { ...init, signal: init.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS), headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.token}`, ...init.headers } });
    let response = await send();
    // The token changes when the coordinator restarts with a new data folder. One silent
    // re-bootstrap beats making the operator reload to escape "Invalid local control token".
    if (response.status === 401 && this.token) {
      try { await this.bootstrap(); response = await send(); } catch { /* report the original 401 below */ }
    }
    const value = await parseBody(response) as T & { error?: string };
    if (!response.ok) throw new Error(value.error || `Control service returned HTTP ${response.status}.`);
    return value;
  }
  sandboxSelftest(id: string) { return this.request<{ result: SandboxResult }>(`/v1/agents/${encodeURIComponent(id)}/sandbox-selftest`, { method: 'POST', signal: AbortSignal.timeout(120_000) }); }
  sandboxHistory(id: string) { return this.request<{ latest: { result: SandboxResult } | null }>(`/v1/agents/${encodeURIComponent(id)}/sandbox-selftest`); }
  async listAgents() { return (await this.request<{ agents: Agent[] }>("/v1/agents")).agents; }
  async createAgent(input: { name: string; role?: string; description?: string; prompt?: string; id?: string }) { return (await this.request<{ agent: Agent }>("/v1/agents", { method: "POST", body: JSON.stringify(input) })).agent; }
  deleteAgent(id: string) { return this.request<{ ok: true; id: string }>(`/v1/agents/${encodeURIComponent(id)}`, { method: "DELETE" }); }
  createRun(input: { agentId: string; conversationId?: string; prompt: string; parentRunId?: string }) { return this.request<PersistentRun>("/v1/runs", { method: "POST", body: JSON.stringify(input) }); }
  events(runId: string, after: number) { return this.request<{ events: Array<{ seq: number; id: string; type: string; payload: any }>; run: PersistentRun }>(`/v1/runs/${runId}/events?after=${after}`); }
  async listRoutines() { return (await this.request<{ routines: unknown[] }>("/v1/routines")).routines.map(normalizeRoutine); }
  createRoutine(input: RoutineInput) { return this.request<{ id: string; nextRunAt: string }>("/v1/routines", { method: "POST", body: JSON.stringify(input) }); }
  async updateRoutine(id: string, input: Partial<RoutineInput>) { const row = await this.request<{ nextRunAt?: string }>(`/v1/routines/${id}`, { method: "PUT", body: JSON.stringify(input) }); return { ...normalizeRoutine(row), ...(typeof row?.nextRunAt === "string" ? { nextRunAt: row.nextRunAt } : {}) }; }
  deleteRoutine(id: string) { return this.request<{ ok: boolean }>(`/v1/routines/${id}`, { method: "DELETE" }); }
  runRoutine(id: string) { return this.request<PersistentRun>(`/v1/routines/${id}/run`, { method: "POST" }); }
  toggleRoutine(id: string) { return this.request<{ enabled: boolean }>(`/v1/routines/${id}/toggle`, { method: "POST" }); }
  async routineHistory(id: string) { return (await this.request<{ history: RoutineRun[] }>(`/v1/routines/${id}/history`)).history; }
  async listGroupChats() { return (await this.request<{ conversations: unknown[] }>("/v1/conversations?kind=group")).conversations.map(normalizeConversation); }
  async createGroupChat(input: GroupChatInput) { return normalizeConversation(await this.request("/v1/conversations", { method: "POST", body: JSON.stringify({ kind: "group", title: input.title, members: input.agentIds.map(id => ({ kind: "agent", id, role: "member" })), turnPolicy: "manual" }) })); }
  async getConversation(id: string) { return normalizeConversation(await this.request(`/v1/conversations/${encodeURIComponent(id)}`)); }
  async addConversationMember(id: string, agentId: string, role: Exclude<MemberRole, "owner"> = "member") { return normalizeMember(await this.request(`/v1/conversations/${encodeURIComponent(id)}/members`, { method: "POST", body: JSON.stringify({ kind: "agent", id: agentId, role }) })); }
  async removeConversationMember(id: string, agentId: string) { return normalizeMember(await this.request(`/v1/conversations/${encodeURIComponent(id)}/members/${encodeURIComponent(agentId)}`, { method: "DELETE" })); }
  // The caller keeps idempotencyKey across retries of the same draft, so a repeated send returns the stored message.
  async postConversationMessage(id: string, input: { body: string; mentions?: string[]; idempotencyKey: string }) { const row = await this.request<{ scheduledRuns?: unknown }>(`/v1/conversations/${encodeURIComponent(id)}/messages`, { method: "POST", body: JSON.stringify(input) }); return { message: normalizeMessage(row), scheduledRuns: normalizeScheduledRuns(row.scheduledRuns) }; }
  async listConversationMessages(id: string, after = 0, limit = 100) { return (await this.request<{ messages: unknown[] }>(`/v1/conversations/${encodeURIComponent(id)}/messages?after=${after}&limit=${limit}`)).messages.map(normalizeMessage); }
  // Coordinators without halt/resume answer the generic "Not found." route miss; null lets the UI hide the control.
  haltConversation(id: string) { return this.conversationControl<{ halted: boolean; stopped: number }>(id, "halt"); }
  resumeConversation(id: string) { return this.conversationControl<Record<string, unknown>>(id, "resume"); }
  private conversationControl<T>(id: string, action: "halt" | "resume") { return this.request<T>(`/v1/conversations/${encodeURIComponent(id)}/${action}`, { method: "POST" }).catch((error: unknown) => { if (error instanceof Error && error.message === "Not found.") return null; throw error; }); }
}
