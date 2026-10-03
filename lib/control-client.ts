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
  parent_run_id?: string | null;
  created_at?: string;
  updated_at?: string;
  pendingApprovals?: Array<{ approvalId: string; detail: string; payload?: Record<string, any> }>;
  pendingInputs?: Array<{ inputId: string; type: "clarify" | "secret" | "sudo"; payload?: Record<string, any> }>;
};

export type RemoteConversation = { id: string; agentId: string; title: string; updatedAt: string; runs: PersistentRun[] };
export const isLiveRun = (run: Pick<PersistentRun, "state">) => ["queued", "running", "waiting_approval", "waiting_input"].includes(run.state);

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

// A coordinator that requires browser pairing (the Docker-backed local install) answers an
// unauthenticated bootstrap with 401 and this flag: the operator token is handed out only
// to a browser that presents a one-use code minted by the launcher. Nothing here ever
// retries such a refusal without credentials.
export class PairingRequiredError extends Error {
  readonly pairingRequired = true;
  constructor(message: string) { super(message); this.name = "PairingRequiredError"; }
}
// The token a paired browser keeps so it can reopen the dashboard later, kept per
// coordinator base so a test coordinator on another port never sees the local one's.
const pairKey = () => `open-harness.pair.v1:${base()}`;
function storedToken() { try { return localStorage.getItem(pairKey()) || ""; } catch { return ""; } }
function storeToken(token: string) { try { if (token) localStorage.setItem(pairKey(), token); else localStorage.removeItem(pairKey()); } catch { /* private mode: the token lives for this page only */ } }

export class ControlClient {
  token = "";
  // The token pairing produced, kept for this page as well as in storage: in a private
  // window or with site data blocked, storage throws or forgets, and the bootstrap that
  // follows pair() must still present what the coordinator just handed out. Scoped to the
  // coordinator base it came from, like the stored copy.
  private paired: { base: string; token: string } | null = null;
  // Counts successful pairings. A bootstrap that was already in flight when a pairing
  // completed was sent without (or with an older) token; whatever it comes back with
  // describes the state before that pairing and must not touch the token it produced.
  private pairings = 0;
  private keepPaired(token: string) { this.paired = token ? { base: base(), token } : null; storeToken(token); }
  private pairedToken() { return storedToken() || (this.paired && this.paired.base === base() ? this.paired.token : ""); }
  async bootstrap() {
    // A paired browser identifies itself; a plain source/dev dashboard has nothing stored and
    // bootstraps exactly as before.
    const epoch = this.pairings, paired = this.pairedToken();
    const response = await fetch(`${base()}/v1/bootstrap`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS), ...(paired ? { headers: { Authorization: `Bearer ${paired}` } } : {}) });
    const body = await parseBody(response) as { error?: string; pairingRequired?: boolean };
    const superseded = epoch !== this.pairings;
    if (response.status === 401 && body.pairingRequired) {
      if (superseded) throw new Error("This connection attempt was replaced by a newer browser pairing.");
      this.keepPaired(""); throw new PairingRequiredError(body.error || "This browser is not paired with Open Harness.");
    }
    if (!response.ok) throw new Error(body.error || "Open Harness control service is unavailable.");
    const status = body as unknown as RuntimeStatus;
    if (!superseded) { this.token = status.token; if (paired) this.keepPaired(status.token); }
    return status;
  }
  // Exchanges a one-use code from the launcher's link for the operator token, on this
  // coordinator only — the code never goes anywhere a link could point it.
  async pair(code: string) {
    const response = await fetch(`${base()}/v1/browser/pair`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ code }), signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    const body = await parseBody(response) as { error?: string };
    if (!response.ok) throw new Error(body.error || "This browser connection link is invalid or expired. Open Open Harness with its launcher to get a new link.");
    const status = body as unknown as RuntimeStatus; this.pairings += 1; this.token = status.token; this.keepPaired(status.token);
    return status;
  }
  async request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const send = () => fetch(`${base()}${path}`, { ...init, signal: init.signal ?? AbortSignal.timeout(path === "/v1/onboarding/action" && init.method === "POST" ? 3_600_000 : REQUEST_TIMEOUT_MS), headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.token}`, ...init.headers } });
    let response = await send();
    // The token changes when the coordinator restarts with a new data folder. One silent
    // re-bootstrap beats making the operator reload to escape "Invalid local control token".
    if (response.status === 401 && this.token) {
      try { await this.bootstrap(); response = await send(); }
      catch (error) { if (error instanceof PairingRequiredError) throw error; /* otherwise report the original 401 below */ }
    }
    const value = await parseBody(response) as T & { error?: string };
    if (!response.ok) throw new Error(value.error || `Control service returned HTTP ${response.status}.`);
    return value;
  }
  conversations() { return this.request<{ conversations: RemoteConversation[] }>("/v1/conversations"); }
  answerInput(runId: string, inputId: string, value: string | string[]) { return this.request<{ ok: boolean }>(`/v1/runs/${runId}/input`, { method: "POST", body: JSON.stringify({ inputId, value }) }); }
  createRun(input: { agentId: string; conversationId?: string; prompt: string; parentRunId?: string }) { return this.request<PersistentRun>("/v1/runs", { method: "POST", body: JSON.stringify(input) }); }
  events(runId: string, after: number) { return this.request<{ events: Array<{ seq: number; id: string; type: string; payload: any }>; run: PersistentRun }>(`/v1/runs/${runId}/events?after=${after}`); }
}
