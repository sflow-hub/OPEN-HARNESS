"use client";

import { useCallback, useEffect, useState } from "react";
import { Check, LoaderCircle, MonitorCog, Plus, RefreshCw, Trash2, X } from "lucide-react";
import type { ControlClient } from "../lib/control-client";
import type { MachineInfo } from "../lib/agent-profile";
import type { Agent } from "../lib/types";

const PLATFORMS: Record<MachineInfo["platform"], string> = { linux: "Linux", darwin: "macOS", win32: "Windows", unknown: "Unknown OS" };
const CAPABILITIES = [["container", "Container"], ["direct", "Direct"], ["desktop", "Desktop"], ["virtualDesktop", "Virtual desktop"]] as const;
const errorText = (error: unknown) => error instanceof Error ? error.message : "Could not reach the local service.";
function lastSeen(machine: MachineInfo) {
  if (machine.local || machine.status === "online") return "Now";
  if (!machine.lastSeenAt) return "Never";
  const minutes = Math.floor((Date.now() - Date.parse(machine.lastSeenAt)) / 60_000);
  if (minutes < 1) return "Just now";
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 1440) return `${Math.floor(minutes / 60)} h ago`;
  return `${Math.floor(minutes / 1440)} d ago`;
}
const agentCount = (count: number) => `${count} agent${count === 1 ? "" : "s"}`;

export default function ComputersPage({ client, agents, onAddComputer }: { client: ControlClient; agents: Agent[]; onAddComputer: () => void }) {
  const [machines, setMachines] = useState<MachineInfo[] | null>(null);
  const [busy, setBusy] = useState("");
  const [messages, setMessages] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const [revoking, setRevoking] = useState<MachineInfo | null>(null);
  const refresh = useCallback(async () => {
    try { if (!client.token) await client.bootstrap(); setMachines(await client.listMachines()); setError(""); }
    catch (cause) { setError(errorText(cause)); }
  }, [client]);
  useEffect(() => { const first = setTimeout(() => void refresh(), 0), timer = setInterval(() => void refresh(), 10_000); return () => { clearTimeout(first); clearInterval(timer); }; }, [refresh]);
  useEffect(() => {
    if (!revoking) return;
    const close = (event: KeyboardEvent) => { if (event.key === "Escape" && !busy) setRevoking(null); };
    window.addEventListener("keydown", close); return () => window.removeEventListener("keydown", close);
  }, [busy, revoking]);
  const act = async (machine: MachineInfo, action: "test" | "reconnect") => {
    setBusy(machine.id); setMessages(current => ({ ...current, [machine.id]: "" }));
    try { const result = await client.machineAction(machine.id, action); setMessages(current => ({ ...current, [machine.id]: result.message })); await refresh(); }
    catch (cause) { setMessages(current => ({ ...current, [machine.id]: errorText(cause) })); }
    finally { setBusy(""); }
  };
  const revoke = async () => {
    if (!revoking) return;
    setBusy(revoking.id); setError("");
    try { await client.revokeMachine(revoking.id); setRevoking(null); await refresh(); }
    catch (cause) { setError(`${revoking.name} was not revoked: ${errorText(cause)}`); setRevoking(null); await refresh(); }
    finally { setBusy(""); }
  };
  const agentName = (id: string | null) => id ? agents.find(agent => agent.id === id)?.name || id : "";

  return <section className="teams-content computers-content">
    <div className="teams-heading"><div><div className="eyebrow">WHERE AGENTS WORK</div><h1>Computers</h1><p>This computer and every runner you have paired. Several agents can share one computer.</p></div><div className="computers-heading-actions"><button className="subtle-button" aria-label="Refresh computers" onClick={() => void refresh()}><RefreshCw size={14} /></button><button className="light-button" onClick={onAddComputer}><Plus size={14} /> Add computer</button></div></div>
    <p className="muted small">New computers are paired from Agent settings → Computer, which selects the new computer for that agent.</p>
    {error && <div className="task-error" role="alert">{error}</div>}
    {!machines && !error && <p className="muted small"><LoaderCircle className="spin" size={13} /> Loading computers…</p>}
    <div className="computer-list">
      {machines?.map(machine => <article className="computer-card" key={machine.id} aria-label={machine.name}>
        <div className="computer-card-main">
          <span className={`computer-status ${machine.status}`} aria-hidden="true" />
          <div>
            <h2>{machine.name} {machine.local && <span className="team-badge unassigned">This computer</span>}</h2>
            <p>{PLATFORMS[machine.platform]} · {machine.arch}</p>
          </div>
          <span className={`computer-state ${machine.status}`}>{machine.status === "online" ? "Online" : machine.status === "pairing" ? "Pairing" : "Offline"}</span>
        </div>
        <dl className="computer-facts">
          <div><dt>Last seen</dt><dd>{lastSeen(machine)}</dd></div>
          <div><dt>Assigned</dt><dd>{agentCount(machine.assignedAgents)}</dd></div>
          <div><dt>Reserved for</dt><dd>{agentName(machine.reservedAgentId) || "Anyone"}</dd></div>
        </dl>
        <ul className="computer-capabilities" aria-label={`${machine.name} capabilities`}>{CAPABILITIES.map(([key, label]) => <li key={key} className={machine.capabilities[key] ? "available" : ""}>{machine.capabilities[key] ? <Check size={11} /> : <X size={11} />} {label}</li>)}</ul>
        <div className="computer-card-actions">
          <button className="subtle-button" disabled={Boolean(busy)} onClick={() => void act(machine, "test")}>{busy === machine.id ? <LoaderCircle className="spin" size={13} /> : <Check size={13} />} Test</button>
          <button className="subtle-button" disabled={Boolean(busy)} onClick={() => void act(machine, "reconnect")}><RefreshCw size={13} /> Reconnect</button>
          <button className="subtle-button danger" aria-label={`Revoke ${machine.name}`} title={machine.local ? "The computer hosting Open Harness cannot be revoked." : undefined} disabled={machine.local || Boolean(busy)} onClick={() => setRevoking(machine)}><Trash2 size={13} /> Revoke</button>
        </div>
        {messages[machine.id] && <p className="muted small" role="status">{messages[machine.id]}</p>}
      </article>)}
    </div>
    {machines && machines.length === 1 && <div className="team-empty"><MonitorCog size={28} /><h2>Only this computer so far</h2><p>Pair a VPS or another computer you own to let agents work there.</p><button onClick={onAddComputer}><Plus size={14} /> Add computer</button></div>}
    {revoking && <div className="modal-backdrop" onClick={() => !busy && setRevoking(null)}>
      <section className="modal" role="alertdialog" aria-modal="true" aria-labelledby="revoke-computer-title" aria-describedby="revoke-computer-body" onClick={event => event.stopPropagation()}>
        <div className="modal-heading"><div><div className="eyebrow">REVOKE COMPUTER</div><h2 id="revoke-computer-title">Revoke {revoking.name}?</h2></div><button aria-label="Close" disabled={Boolean(busy)} onClick={() => setRevoking(null)}><X size={19} /></button></div>
        <div className="modal-body" id="revoke-computer-body">
          <p>{revoking.assignedAgents ? `${agentCount(revoking.assignedAgents)} ${revoking.assignedAgents === 1 ? "is" : "are"} assigned to ${revoking.name}.` : `No agents are assigned to ${revoking.name}.`}</p>
          <ul className="computer-revoke-effects">
            <li>The runner’s credential stops working immediately, and any work it is doing now ends.</li>
            <li>Agents assigned to it stop running there until you move them to another computer.</li>
            <li>To use this computer again, you will need to pair it again.</li>
          </ul>
        </div>
        <div className="modal-footer"><button className="subtle-button" autoFocus disabled={Boolean(busy)} onClick={() => setRevoking(null)}>Cancel</button><button className="danger-button" disabled={Boolean(busy)} onClick={() => void revoke()}>{busy ? <LoaderCircle className="spin" size={14} /> : <Trash2 size={14} />} Revoke computer</button></div>
      </section>
    </div>}
  </section>;
}
