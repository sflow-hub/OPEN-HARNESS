/* eslint-disable @typescript-eslint/no-explicit-any */
import type { DeviceCredential } from './hub';
import type { MachineInfo } from './agent-profile';

export type RuntimeStatus = {
  token: string;
  runtime: { available: boolean; version: string | null; message: string };
  version: string;
  hermes: { release: string; commit: string };
  machine?: MachineInfo;
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
  machine_connection?: "online" | "suspended" | "offline" | "revoked" | null;
};

const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "::1"];

function base() {
  if (typeof window !== "undefined") {
    const testPort = new URLSearchParams(window.location.search).get("controlPort");
    if (testPort && /^\d{2,5}$/.test(testPort)) return `http://127.0.0.1:${testPort}`;
    if (process.env.NEXT_PUBLIC_OPEN_HARNESS_SELF_HOSTED === '1') return `${window.location.origin}/api/local`;
    if (!LOOPBACK_HOSTS.includes(window.location.hostname)) return `${window.location.origin}/api/control`;
  }
  return "http://127.0.0.1:4317";
}

// A browser that reached this page over the network, rather than from the machine running
// the coordinator. It cannot be handed the master control token — that authorizes arbitrary
// run creation, host-path mounts and direct OS execution — so it pairs for its own scoped,
// revocable credential exactly as the phone app does. Mirrors base()'s precedence: the
// Playwright control-port override is a loopback coordinator and never counts as remote.
export function isRemoteOrigin() {
  if (typeof window === "undefined") return false;
  const testPort = new URLSearchParams(window.location.search).get("controlPort");
  if (testPort && /^\d{2,5}$/.test(testPort)) return false;
  return !LOOPBACK_HOSTS.includes(window.location.hostname);
}

// The address a remote browser pairs against: the origin it is already on. Unlike the phone
// app, there is nothing for the person to type, because they are looking at the hub.
export function selfHostedHubUrl() {
  if (typeof window === "undefined") return "";
  return base();
}

// Thrown when the coordinator refuses to hand this client the control token. It is not an
// outage: it means "pair instead", and the caller shows the pairing screen.
export class PairingRequiredError extends Error {
  constructor(message: string) { super(message); this.name = "PairingRequiredError"; }
}

export class ControlClient {
  token = "";
  // Set once a phone has paired. It changes three things: where requests go, which headers
  // identify the caller, and which fetch makes the call. Everything above this layer is
  // unchanged, which is why the whole dashboard works on a phone without knowing about it.
  private device: DeviceCredential | null = null;
  private fetchImpl: typeof fetch = (...args) => fetch(...args);

  useDevice(credential: DeviceCredential | null, fetchImpl?: typeof fetch) {
    this.device = credential;
    if (fetchImpl) this.fetchImpl = fetchImpl;
    this.token = "";
  }
  get pairedMachineId() { return this.device?.machineId || ""; }
  private endpoint() { return this.device ? this.device.hubUrl : base(); }
  private headers(extra: HeadersInit = {}): HeadersInit {
    if (this.device) {
      return {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.device.token}`,
        "X-Open-Harness-Machine": this.device.machineId,
        ...(this.device.sitesToken ? { "OAI-Sites-Authorization": `Bearer ${this.device.sitesToken}` } : {}),
        ...extra,
      };
    }
    return { "Content-Type": "application/json", Authorization: `Bearer ${this.token}`, ...extra };
  }
  async bootstrap() {
    // A phone never receives the master control token. It asks for its own session instead,
    // which reports the same runtime facts plus the machine row it is paired as.
    if (this.device) {
      const response = await this.fetchImpl(`${this.endpoint()}/v1/device/session`, { headers: this.headers() });
      if (response.status === 401) throw new Error("This phone is no longer paired. Connect it to your hub again.");
      if (!response.ok) throw new Error("Could not reach your Open Harness hub.");
      return (await response.json()) as RuntimeStatus;
    }
    const response = await this.fetchImpl(`${base()}/v1/bootstrap`);
    // 403 here is the deliberate refusal to expose the control token off-machine. Saying so
    // lets the caller offer pairing instead of reporting a service that is in fact healthy.
    if (response.status === 403) {
      const detail = await response.json().catch(() => ({})) as { error?: string };
      throw new PairingRequiredError(detail.error || "This dashboard needs to be paired before it can reach your coordinator.");
    }
    if (!response.ok) throw new Error("Open Harness control service is unavailable.");
    const status = (await response.json()) as RuntimeStatus; this.token = status.token; return status;
  }
  async request<T>(path: string, init: RequestInit = {}) {
    const response = await this.fetchImpl(`${this.endpoint()}${path}`, { ...init, headers: this.headers(init.headers) });
    const value = await response.json() as T & { error?: string };
    if (!response.ok) throw new Error(value.error || `Control service returned HTTP ${response.status}.`);
    return value;
  }
  createRun(input: { agentId: string; conversationId?: string; prompt: string; parentRunId?: string }) { return this.request<PersistentRun>("/v1/runs", { method: "POST", body: JSON.stringify(input) }); }
  events(runId: string, after: number) { return this.request<{ events: Array<{ seq: number; id: string; type: string; payload: any }>; run: PersistentRun }>(`/v1/runs/${runId}/events?after=${after}`); }
}
