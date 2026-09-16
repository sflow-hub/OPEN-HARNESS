/* eslint-disable @typescript-eslint/no-explicit-any */
export type RuntimeStatus = {
  token: string;
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
    const testPort = new URLSearchParams(window.location.search).get("controlPort");
    if (testPort && /^\d{2,5}$/.test(testPort)) return `http://127.0.0.1:${testPort}`;
    if (process.env.NEXT_PUBLIC_OPEN_HARNESS_SELF_HOSTED === '1') return `${window.location.origin}/api/local`;
    if (!["localhost", "127.0.0.1", "::1"].includes(window.location.hostname)) return `${window.location.origin}/api/control`;
  }
  return "http://127.0.0.1:4317";
}

export class ControlClient {
  token = "";
  async bootstrap() {
    const response = await fetch(`${base()}/v1/bootstrap`);
    if (!response.ok) throw new Error("Open Harness control service is unavailable.");
    const status = (await response.json()) as RuntimeStatus; this.token = status.token; return status;
  }
  async request<T>(path: string, init: RequestInit = {}) {
    const response = await fetch(`${base()}${path}`, { ...init, headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.token}`, ...init.headers } });
    const value = await response.json() as T & { error?: string };
    if (!response.ok) throw new Error(value.error || `Control service returned HTTP ${response.status}.`);
    return value;
  }
  createRun(input: { agentId: string; conversationId?: string; prompt: string; parentRunId?: string }) { return this.request<PersistentRun>("/v1/runs", { method: "POST", body: JSON.stringify(input) }); }
  events(runId: string, after: number) { return this.request<{ events: Array<{ seq: number; id: string; type: string; payload: any }>; run: PersistentRun }>(`/v1/runs/${runId}/events?after=${after}`); }
}
