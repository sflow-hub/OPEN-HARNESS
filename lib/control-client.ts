/* eslint-disable @typescript-eslint/no-explicit-any */
export type RuntimeStatus = {
  token: string;
  mode: "live" | "test";
  runtime: { available: boolean; version: string | null; message: string };
  version: string;
  features?: string[];
  hermes: { release: string; commit: string };
  workspaceRole?: 'owner'|'operator'|'viewer';
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
  reply_only?: boolean;
  pendingApprovals?: Array<{ approvalId: string; detail: string; payload?: Record<string, any> }>;
  pendingInputs?: Array<{ inputId: string; type: "clarify" | "secret" | "sudo"; payload?: Record<string, any> }>;
};

export type RemoteConversation = { id: string; agentId: string; title: string; updatedAt: string; runs: PersistentRun[] };
export const isLiveRun = (run: Pick<PersistentRun, "state">) => ["queued", "running", "waiting_approval", "waiting_input"].includes(run.state);

// Private agent computer: the desktop status the coordinator reports and the human terminal.
export type ComputerOwnershipState = 'agent' | 'taking-control' | 'human' | 'handing-back' | 'blocked';
export type TerminalRevocation = { state: 'none' | 'pending' | 'confirmed'; confirmedAt?: string | null; requestedAt?: string; reason?: string; machineId?: string };
export type DesktopMachine = { id: string; name: string; status: 'online' | 'offline' | 'revoked' | 'pairing' | string; local?: boolean; platform?: string; capabilities?: { features?: string[] } };
export type DesktopStatus = {
  readOnly?: boolean; agentActive?: boolean;
  available: boolean; controlled: boolean; youControl?: boolean; canRelease?: boolean; controllerId?: string; ready: boolean; canContinue: boolean; leaseId: string;
  recording: boolean; steps: number; revision: number; browserSessionTeamId: string; teams: Array<{ id: string; name: string }>; sharedWith: Array<{ id: string; name: string }>;
  machine?: DesktopMachine; ownershipState?: ComputerOwnershipState; controllerName?: string; controllerAgentId?: string; inControlSince?: string;
  browserSessionPreserved?: boolean; shellJobsStopped?: boolean; terminal?: { available: boolean; ready: boolean; reason?: string };
  revocation?: TerminalRevocation; ownership?: { generation: number; owner: 'agent' | 'human' | 'idle'; identity: string };
};
export type DesktopPointerButton = 'left' | 'right' | 'middle';
export type DesktopInputAction = { type: 'click'; x: number; y: number; button: DesktopPointerButton; clickCount?: 1 | 2 } | { type: 'drag'; fromX: number; fromY: number; toX: number; toY: number } | { type: 'scroll'; direction: 'up' | 'down' | 'left' | 'right'; amount: number } | { type: 'key'; key: string } | { type: 'text'; text: string };
export type TerminalTicket = { path: string; url?: string; expiresIn?: number };
export type TerminalClientMessage = { type: 'input'; data: string } | { type: 'resize'; cols: number; rows: number };
export type TerminalServerMessage = { type: 'output'; data: string } | { type: 'exit'; code: number } | { type: 'error'; message: string };
// The desktop is a fixed 1440x900 screen; every pointer position is clamped into it.
export const DESKTOP_WIDTH = 1440, DESKTOP_HEIGHT = 900;
export function parseTerminalMessage(raw: unknown): TerminalServerMessage | null {
  if (typeof raw !== 'string') return null;
  try {
    const value = JSON.parse(raw) as Record<string, unknown>;
    if (value.type === 'output' && typeof value.data === 'string') return { type: 'output', data: value.data };
    if (value.type === 'exit') return { type: 'exit', code: Number.isFinite(Number(value.code)) ? Number(value.code) : -1 };
    if (value.type === 'error') return { type: 'error', message: typeof value.message === 'string' ? value.message : 'The terminal reported an error.' };
  } catch { /* Ignore frames that are not part of the terminal protocol. */ }
  return null;
}

function base() {
  if (typeof window !== "undefined") {
    if(process.env.NEXT_PUBLIC_OPEN_HARNESS_CLOUD==='1'){let id=new URLSearchParams(window.location.search).get('workspace')||'';try{id ||= localStorage.getItem('open-harness.cloud-workspace')||'';}catch{}return `${window.location.origin}/cloud/v1/workspaces/${encodeURIComponent(id)}/runtime`;}
    // ?controlPort= is how the browser suite reaches its own coordinator. Honour it only
    // on a loopback page: from a remote dashboard, a crafted link carrying it would aim
    // the visitor's browser at whatever is listening on their machine.
    if (["localhost", "127.0.0.1", "::1"].includes(window.location.hostname)) {
      const testPort = new URLSearchParams(window.location.search).get("controlPort");
      if (testPort && /^\d{2,5}$/.test(testPort)) return `http://${window.location.hostname}:${testPort}`;
    }
    if (process.env.NEXT_PUBLIC_OPEN_HARNESS_SELF_HOSTED === '1') return `${window.location.origin}/api/local`;
  }
  return typeof window !== 'undefined' && window.location.hostname === 'localhost' ? 'http://localhost:4317' : 'http://127.0.0.1:4317';
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
// Callers that branch on a refusal (a 409 naming what still uses a credential) need the
// status and the parsed body, not only the message.
export class ControlRequestError extends Error {
  constructor(message: string, readonly status: number, readonly body: Record<string, unknown>) { super(message); this.name = "ControlRequestError"; }
}
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
  readonly managed=process.env.NEXT_PUBLIC_OPEN_HARNESS_CLOUD==='1';
  desktopEndpoint(agentId:string,action:string){return `/v1/agents/${encodeURIComponent(agentId)}/desktop/${action}`;}
  desktopStatus(agentId:string){return this.request<DesktopStatus>(this.desktopEndpoint(agentId,'status'));}
  desktopInput(agentId:string,leaseId:string,input:DesktopInputAction){return this.request<{ok:boolean;steps:number}>(this.desktopEndpoint(agentId,'input'),{method:'POST',body:JSON.stringify({leaseId,input})});}
  // A short-lived ticket for the human workspace terminal; only the current controller gets one.
  terminalTicket(agentId:string,leaseId:string){return this.request<TerminalTicket>(`/v1/agents/${encodeURIComponent(agentId)}/terminal`,{method:'POST',body:JSON.stringify({leaseId})});}
  websocketUrl(path:string){const url=new URL(this.managed&&path.startsWith('/cloud/')?path:`${base()}${path}`,typeof window==='undefined'?'http://localhost':window.location.href);url.protocol=url.protocol==='https:'?'wss:':'ws:';return url.href;}
  async download(path:string){const response=await fetch(`${base()}${path}`,{credentials:'include',headers:this.managed?{}:{Authorization:`Bearer ${this.token}`},signal:AbortSignal.timeout(60000)});if(!response.ok){const value=await parseBody(response);throw new Error(String(value.error||'The file could not be downloaded.'));}if(Number(response.headers.get('content-length'))>100000000){await response.body?.cancel();throw new Error('Use the local backup command to download this file larger than 100 MB.');}return response.blob();}
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
    if(this.managed){
      const response=await fetch('/cloud/v1/me',{credentials:'include',signal:AbortSignal.timeout(REQUEST_TIMEOUT_MS)});if(!response.ok)throw new Error('Sign in to your managed workspace to continue.');
      const identity=await response.json() as {workspaces:Array<{id:string}>},url=new URL(window.location.href);let selected=url.searchParams.get('workspace')||localStorage.getItem('open-harness.cloud-workspace')||'';
      if(!identity.workspaces.some(workspace=>workspace.id===selected))selected=identity.workspaces[0]?.id||'';if(!selected)throw new Error('Create a workspace from Account to continue.');
      // The URL takes precedence over storage, so a stale workspace link must follow the fallback too.
      if(url.searchParams.has('workspace')&&url.searchParams.get('workspace')!==selected){url.searchParams.set('workspace',selected);window.history.replaceState(null,'',url.href);}
      localStorage.setItem('open-harness.cloud-workspace',selected);this.token='';return this.request<RuntimeStatus>('/v1/client-status');
    }
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
    const timeout = init.method === 'POST' && path === '/v1/onboarding/action' ? 3_600_000 : init.method === 'POST' && /^\/v1\/agents\/[^/]+\/desktop\/(take-control|release)$/.test(path) ? 90_000 : REQUEST_TIMEOUT_MS;
    const csrf=this.managed&&typeof document!=='undefined'?document.cookie.split(';').map(value=>value.trim()).find(value=>value.startsWith('oh_csrf='))?.slice(8)||'':'';
    const send = () => fetch(`${base()}${path}`, { ...init, credentials: this.managed||path.startsWith('/v1/connections')?'include':'same-origin', signal: init.signal ?? AbortSignal.timeout(timeout), headers: { "Content-Type": "application/json", ...(this.managed?{'X-CSRF-Token':csrf}:{Authorization: `Bearer ${this.token}`}), ...init.headers } }).catch((error: unknown) => {
      if (error instanceof TypeError) throw new Error('Cannot reach the Open Harness coordinator. Make sure it is running and this computer can connect, then try again.');
      throw error;
    });
    let response = await send();
    // The token changes when the coordinator restarts with a new data folder. One silent
    // re-bootstrap beats making the operator reload to escape "Invalid local control token".
    if (response.status === 401 && this.token) {
      try { await this.bootstrap(); response = await send(); }
      catch (error) { if (error instanceof PairingRequiredError) throw error; /* otherwise report the original 401 below */ }
    }
    const value = await parseBody(response) as T & { error?: string };
    if (!response.ok) throw new ControlRequestError(value.error || `Control service returned HTTP ${response.status}.`, response.status, (value && typeof value === "object" ? value : {}) as Record<string, unknown>);
    return value;
  }
  conversations() { return this.request<{ conversations: RemoteConversation[] }>("/v1/conversations"); }
  answerInput(runId: string, inputId: string, value: string | string[]) { return this.request<{ ok: boolean }>(`/v1/runs/${runId}/input`, { method: "POST", body: JSON.stringify({ inputId, value }) }); }
  // Asks the coordinator to start the agent's runtime ahead of a message. Only a hint: it
  // never queues work, and a coordinator that is busy or cannot prepare simply declines.
  prepareAgent(agentId: string, replyOnly = false) { return this.request<{ preparing: boolean; ready: boolean }>(`/v1/agents/${encodeURIComponent(agentId)}/prepare`, { method: "POST", body: JSON.stringify({ replyOnly }) }); }
  createRun(input: { agentId: string; conversationId?: string; prompt: string; parentRunId?: string; requestId?:string;replyOnly?:boolean }) { return this.request<PersistentRun>("/v1/runs", { method: "POST", body: JSON.stringify({...input,requestId:input.requestId||crypto.randomUUID()}) }); }
  events(runId: string, after: number, options: { waitMs?: number; signal?: AbortSignal } = {}) {
    const wait = Math.min(25_000, Math.max(0, options.waitMs ?? 25_000));
    return this.request<{ events: Array<{ seq: number; id: string; type: string; payload: any }>; run: PersistentRun }>(`/v1/runs/${encodeURIComponent(runId)}/events?after=${Math.max(0, Math.floor(after) || 0)}&wait=${wait}`, { signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]) : AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  }
}
