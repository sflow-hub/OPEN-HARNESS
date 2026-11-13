"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { ControlClient } from "@/lib/control-client";
import styles from "./network-settings.module.css";

// Shapes follow work/network-tool/CONTRACT.md, which the runtime implements.
export type NetworkState = "ok" | "degraded" | "failing" | "untested";
export type NetworkProfile = { coordinatorUrl: string | null; httpProxy: string | null; httpsProxy: string | null; noProxy: string | null; dnsServers: string[]; pollIntervalMs: number; requestTimeoutMs: number; retries: number; keepGatewayWarm: string[] };
export type NetworkSetting = keyof NetworkProfile;
export type NetworkMachine = { id: string; name: string; local: boolean; status: "online" | "offline" | "pairing" | "revoked"; lastSeenAt: string | null; agents: Array<{ id: string; name: string; route: "socket" | "url" | "unknown" }>; profile: NetworkProfile };
export type NetworkLink = { id: string; kind: "coordinator-runner" | "agent-coordinator" | "gateway" | "provider" | "machine-machine"; from: string; to: string; label: string; machineId: string; state: NetworkState; latencyMs: number | null; testedAt: string | null; detail?: string };
export type NetworkProbe = { id: string; linkId: string; kind: NetworkLink["kind"]; state: Exclude<NetworkState, "untested">; latencyMs: number | null; phases?: { dnsMs?: number; tcpMs?: number; tlsMs?: number; httpMs?: number }; detail: string; startedBy: { type: "agent"; agentId: string; runId: string } | { type: "operator" }; createdAt: string };
export type NetworkChangeState = "awaiting_approval" | "denied" | "applying" | "verifying" | "applied" | "rolled_back" | "failed" | "reverted";
export type NetworkChange = { id: string; machineId: string; setting: NetworkSetting; before: unknown; after: unknown; reason: string; evidenceProbeIds: string[]; proposedBy: { type: "agent"; agentId: string; agentName: string; runId: string } | { type: "operator" }; state: NetworkChangeState; confirmation: string; verification?: { probeId: string; state: "ok" | "degraded" | "failing"; detail: string }; revertOf?: string; createdAt: string; updatedAt: string };
export type NetworkOverview = { enabled: boolean; updatedAt: string | null; machines: NetworkMachine[]; links: NetworkLink[]; pending: NetworkChange[]; history: NetworkChange[]; probes: NetworkProbe[] };

const SETTING_LABELS: Record<NetworkSetting, string> = { coordinatorUrl: "Coordinator address", httpProxy: "HTTP proxy", httpsProxy: "HTTPS proxy", noProxy: "Proxy exceptions", dnsServers: "DNS servers", pollIntervalMs: "Check-in interval", requestTimeoutMs: "Request timeout", retries: "Retries", keepGatewayWarm: "Keep agent ready between messages" };
const STATE_LABELS: Record<NetworkState, string> = { ok: "Healthy", degraded: "Slow", failing: "Not connecting", untested: "Not tested yet" };
const CHANGE_LABELS: Record<NetworkChangeState, string> = { awaiting_approval: "Waiting for your approval", denied: "Denied", applying: "Applying…", verifying: "Checking the new setting…", applied: "Applied and checked", rolled_back: "Check failed · previous setting restored", failed: "Could not be applied · nothing changed", reverted: "Reverted" };
const message = (cause: unknown, fallback: string) => cause instanceof Error && cause.message ? cause.message : fallback;
const when = (value: string | null) => value ? new Date(value).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "never";

function describe(setting: NetworkSetting, value: unknown, agentName: (id: string) => string) {
  if (value === null || value === undefined || value === "" || Array.isArray(value) && !value.length) return setting === "coordinatorUrl" ? "Local connection" : setting === "dnsServers" ? "Default" : setting === "keepGatewayWarm" ? "No agents" : "Not set";
  if (setting === "keepGatewayWarm" && Array.isArray(value)) return value.map(id => agentName(String(id))).join(", ");
  if (Array.isArray(value)) return value.join(", ");
  if (setting === "pollIntervalMs" || setting === "requestTimeoutMs") return `${Number(value) / 1000} s`;
  return String(value);
}

export default function NetworkSettings({ client }: { client: ControlClient }) {
  const [overview, setOverview] = useState<NetworkOverview | null>(null);
  const [error, setError] = useState("");
  const [loadError, setLoadError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState("");
  const mounted = useRef(true);
  const load = useCallback(() => client.request<NetworkOverview>("/v1/network").then(
    value => { if (mounted.current) { setOverview(value); setLoadError(""); } },
    cause => { if (mounted.current) setLoadError(message(cause, "Network connections could not be loaded. Check that the coordinator is running.")); },
  ), [client]);
  useEffect(() => {
    mounted.current = true; void load();
    // Applying and verifying finish on the coordinator, so keep the result fresh while settings stay open.
    const timer = window.setInterval(() => void load(), 10_000);
    return () => { mounted.current = false; window.clearInterval(timer); };
  }, [load]);

  async function act<T>(key: string, work: () => Promise<T>, done: string | ((result: T) => string), fallback: string) {
    setBusy(key); setError(""); setNotice("");
    try { const result = await work(); setNotice(typeof done === "function" ? done(result) : done); await load(); }
    catch (cause) { setError(message(cause, fallback)); await load(); }
    finally { if (mounted.current) setBusy(""); }
  }
  // The switch moves at once so it feels direct; a refused save puts it back and says so.
  const toggle = (enabled: boolean) => act("toggle", async () => { setOverview(current => current && { ...current, enabled }); const value = await client.request<{ enabled: boolean; updatedAt: string | null }>("/v1/network/settings", { method: "PUT", body: JSON.stringify({ enabled }) }); setOverview(current => current && { ...current, ...value }); }, enabled ? "Network tools are on. Give an agent the Network tools in its settings to use them." : "Network tools are off. Changes already applied stay in place.", "The network setting could not be saved. Nothing changed.");
  const runTests = () => act("tests", () => client.request<{ probes: NetworkProbe[] }>("/v1/network/tests", { method: "POST", body: "{}" }), result => { const failing = result.probes.filter(probe => probe.state !== "ok").length; return failing ? `${failing} of ${result.probes.length} connections need attention.` : `All ${result.probes.length} connections are healthy.`; }, "Connection tests could not run. Try again in a moment.");
  const decide = (change: NetworkChange, approved: boolean) => act(`decide:${change.id}`, () => client.request(`/v1/network/changes/${encodeURIComponent(change.id)}/decision`, { method: "POST", body: JSON.stringify({ approved, confirmation: change.confirmation }) }), approved ? "Approved. The change is being applied and checked." : "Denied. Nothing changed.", "This decision could not be saved. The change may have been updated; review it again.");
  const revert = (change: NetworkChange) => act(`revert:${change.id}`, () => client.request(`/v1/network/changes/${encodeURIComponent(change.id)}/revert`, { method: "POST", body: "{}" }), "Reverting to the earlier setting and checking it.", "The change could not be reverted. The current setting is unchanged.");

  const machines = overview?.machines || [];
  const machineName = (id: string) => machines.find(machine => machine.id === id)?.name || "Unknown computer";
  const agentName = (id: string) => machines.flatMap(machine => machine.agents).find(agent => agent.id === id)?.name || id;
  const probe = (id: string) => overview?.probes.find(item => item.id === id);
  const reverted = new Set((overview?.history || []).map(change => change.revertOf).filter(Boolean));

  return <section className={styles.panel} aria-label="Network tools">
    <h3>Let agents test and fix network connections</h3>
    <p>Agents with the Network tools can check how their computers reach the coordinator, each other, and model providers, then suggest a fix. Every change waits for your approval, is checked after it&rsquo;s applied, and is undone automatically if the check fails. Agents can never change firewall rules, routes, or system settings.</p>
    <label className={`settings-feature-toggle ${styles.toggle}`}>
      <input type="checkbox" checked={Boolean(overview?.enabled)} disabled={!overview || busy === "toggle"} onChange={event => void toggle(event.target.checked)} />
      <span><strong>Let agents test and change network connections</strong><small>{overview?.enabled ? "On. Each agent also needs Network turned on under Agent settings → Tools." : "Off. Agents can’t run network tests or propose changes."}</small></span>
    </label>

    {overview && overview.pending.length > 0 && <div className={styles.group} role="region" aria-label="Changes waiting for approval">
      <h4>Waiting for your approval</h4>
      {overview.pending.map(change => <article key={change.id} className={styles.change} aria-label={`${SETTING_LABELS[change.setting]} on ${machineName(change.machineId)}`}>
        <p className={styles.changeTitle}>{change.proposedBy.type === "agent" ? change.proposedBy.agentName : "You"} {change.proposedBy.type === "agent" ? "suggests" : "requested"} changing <strong>{SETTING_LABELS[change.setting]}</strong> on {machineName(change.machineId)}</p>
        <dl className={styles.diff}><dt>Now</dt><dd>{describe(change.setting, change.before, agentName)}</dd><dt>After</dt><dd>{describe(change.setting, change.after, agentName)}</dd></dl>
        {change.reason && <p>Why: {change.reason}</p>}
        {change.evidenceProbeIds.length > 0 && <ul className={styles.evidence} aria-label="Test results behind this suggestion">{change.evidenceProbeIds.map(id => { const item = probe(id); return <li key={id}>{item ? `${overview.links.find(link => link.id === item.linkId)?.label || "Connection"}: ${STATE_LABELS[item.state]}${item.latencyMs !== null ? ` · ${item.latencyMs} ms` : ""} · ${item.detail}` : "An earlier test result"}</li>; })}</ul>}
        <div className={styles.actions}><button type="button" className={styles.primary} disabled={Boolean(busy)} onClick={() => void decide(change, true)}>Approve change</button><button type="button" disabled={Boolean(busy)} onClick={() => void decide(change, false)}>Deny</button></div>
      </article>)}
    </div>}

    <div className={styles.group} role="region" aria-label="Connections">
      <div className={styles.heading}><h4>Connections</h4><button type="button" disabled={!overview || Boolean(busy)} onClick={() => void runTests()}>{busy === "tests" ? "Testing…" : "Run connection tests"}</button></div>
      {overview && !machines.length && <p>No computers are connected yet.</p>}
      {machines.map(machine => { const links = overview!.links.filter(link => link.machineId === machine.id); return <div key={machine.id} className={styles.machine}>
        <p className={styles.machineName}><strong>{machine.name}</strong> <span>{machine.local ? "This computer" : "Runner"} · {machine.status === "online" ? "online" : machine.status} · last seen {when(machine.lastSeenAt)}</span></p>
        {machine.agents.length > 0 && <p className={styles.agents}>Agents: {machine.agents.map(agent => agent.name).join(", ")}</p>}
        <ul className={styles.links}>{links.length ? links.map(link => <li key={link.id} data-state={link.state}><span className={styles.dot} aria-hidden="true" /><span className={styles.linkLabel}>{link.label}</span><span className={styles.linkState}>{STATE_LABELS[link.state]}{link.latencyMs !== null ? ` · ${link.latencyMs} ms` : ""}{link.testedAt ? ` · ${when(link.testedAt)}` : ""}</span>{link.detail && link.state !== "ok" && <small>{link.detail}</small>}</li>) : <li data-state="untested"><span className={styles.dot} aria-hidden="true" /><span className={styles.linkLabel}>No connections to test yet</span></li>}</ul>
      </div>; })}
    </div>

    {overview && overview.history.length > 0 && <details className={styles.group}>
      <summary>Change history ({overview.history.length})</summary>
      <ul className={styles.history}>{overview.history.map(change => <li key={change.id}>
        <p><strong>{SETTING_LABELS[change.setting]}</strong> on {machineName(change.machineId)}: {describe(change.setting, change.before, agentName)} → {describe(change.setting, change.after, agentName)}</p>
        <p className={styles.meta}>{CHANGE_LABELS[change.state]} · {change.revertOf ? "revert" : change.proposedBy.type === "agent" ? `suggested by ${change.proposedBy.agentName}` : "by you"} · {when(change.updatedAt)}</p>
        {change.verification && change.state !== "applied" && <p className={styles.meta}>{change.verification.detail}</p>}
        {change.state === "applied" && !change.revertOf && !reverted.has(change.id) && <button type="button" disabled={Boolean(busy)} onClick={() => void revert(change)}>{busy === `revert:${change.id}` ? "Reverting…" : "Revert"}</button>}
      </li>)}</ul>
    </details>}

    {!overview && loadError && <p className={styles.status}>Network tools aren’t available from this coordinator yet. Update Open Harness to use them.</p>}
    {(error || overview && loadError) && <p className={styles.error} role="alert">{error || loadError}</p>}{notice && <p role="status">{notice}</p>}
  </section>;
}
