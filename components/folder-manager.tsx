"use client";

import { useEffect, useState } from "react";
import { Check, CircleAlert, Folder, LoaderCircle, RotateCcw } from "lucide-react";
import type { ControlClient } from "../lib/control-client";
import type { MachineInfo, SharedFolder } from "../lib/agent-profile";
import type { Agent } from "../lib/types";
import { addFolder, capAgents, FolderAccessTable, FolderGrantRows } from "./folder-grants";

type Listed = { revision: number; folders: SharedFolder[] };

// The folders agents keep across every task and chat, and who may use each one. Project folders
// add to these for a project's own work; nothing here depends on a project.
export default function FolderManager({ agents, client }: { agents: Agent[]; client: ControlClient }) {
  const [saved, setSaved] = useState<Listed | null>(null);
  const [draft, setDraft] = useState<SharedFolder[]>([]);
  const [machines, setMachines] = useState<MachineInfo[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  useEffect(() => {
    let cancelled = false;
    void Promise.all([client.request<Listed>("/v1/folders"), client.request<{ machines: MachineInfo[] }>("/v1/machines")]).then(([listed, { machines }]) => {
      if (cancelled) return;
      setSaved(listed); setDraft(listed.folders); setMachines(machines.filter(machine => machine.status !== "revoked")); setError("");
    }).catch(cause => { if (!cancelled) setError(cause instanceof Error ? cause.message : "Folders could not be loaded."); });
    return () => { cancelled = true; };
  }, [client]);
  const dirty = Boolean(saved) && JSON.stringify(saved!.folders) !== JSON.stringify(draft);
  const local = machines.find(machine => machine.local), localExports = local?.folderExports;
  const machineName = (id = "local") => machines.find(machine => machine.id === id)?.name || "another computer";
  const agentMachine = (agent: Agent) => agent.profile?.computer.machineId || "local";
  const save = async () => {
    if (!saved) return;
    setBusy(true); setError(""); setStatus("");
    try { const next = await client.request<Listed>("/v1/folders", { method: "PUT", body: JSON.stringify({ revision: saved.revision, folders: draft }) }); setSaved(next); setDraft(next.folders); setStatus("Saved. Agents use these folders from their next task."); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Folders could not be saved."); }
    finally { setBusy(false); }
  };
  return <section className="teams-content folders-content">
    <div className="teams-heading"><div><div className="eyebrow">ALWAYS AVAILABLE</div><h1>Folders</h1><p>Folders on your computers that agents can use in every task and chat. Choose who gets each one; an agent left at No access never sees it.</p></div>
      <button className="light-button" disabled={!saved || draft.length >= 100 || localExports?.length === 0} onClick={() => setDraft(current => addFolder(current, localExports, { agents: {}, machineId: "local" }))}><Folder size={14} /> Add folder</button></div>
    {!saved && !error && <p className="muted"><LoaderCircle size={14} /> Loading folders…</p>}
    {localExports && <p className="profile-info computer-exports">Open Harness is running in Docker Desktop, so folders on this computer can be shared only once they are exported in your host-folder Compose override, at their <code>/host-folders/…</code> paths. {localExports.length === 0 ? <>None are exported yet; docs/LOCAL_BROWSER.md has the steps. Exports change only at a relaunch.</> : <>Exporting a folder grants nothing by itself, and a folder exported read-only stays read-only here.</>}</p>}
    {saved && !draft.length && <div className="team-empty"><Folder size={28} /><h2>No folders shared</h2><p>Agents work in their own private space and Shared files. Add a folder to let chosen agents read or edit it in every task.</p></div>}
    <div className="workspace-folders">
      <FolderGrantRows folders={draft} onChange={next => setDraft(capAgents(next))} machines={machines} scope="agent" label="Folder" />
      {draft.length > 0 && <><h2>Who can use them</h2><p className="muted small">Access applies from each agent&apos;s next task. A folder reaches an agent only while that agent works on the computer the folder is on.</p></>}
      <FolderAccessTable folders={draft} agents={agents} onChange={setDraft} unavailable={(agent, folder) => agentMachine(agent) === (folder.machineId || "local") ? "" : `${agent.name} works on ${machineName(agentMachine(agent))}; this folder is on ${machineName(folder.machineId)}.`} />
    </div>
    {error && <div className="task-alert error" role="alert"><CircleAlert size={16} /> {error}</div>}
    {(dirty || status) && <div className="folders-footer">
      <span role="status">{dirty ? "Unsaved changes" : status}</span>
      {dirty && <><button className="subtle-button" disabled={busy} onClick={() => { setDraft(saved!.folders); setError(""); }}><RotateCcw size={14} /> Discard</button><button className="light-button" disabled={busy} onClick={() => void save()}>{busy ? <LoaderCircle size={14} /> : <Check size={14} />} Save folders</button></>}
    </div>}
  </section>;
}
