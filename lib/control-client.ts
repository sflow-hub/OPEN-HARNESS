/* eslint-disable @typescript-eslint/no-explicit-any */
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
  createRun(input: { agentId: string; conversationId?: string; prompt: string; parentRunId?: string }) { return this.request<PersistentRun>("/v1/runs", { method: "POST", body: JSON.stringify(input) }); }
  events(runId: string, after: number) { return this.request<{ events: Array<{ seq: number; id: string; type: string; payload: any }>; run: PersistentRun }>(`/v1/runs/${runId}/events?after=${after}`); }
}
