"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Check, CircleAlert, KeyRound, LoaderCircle, Pencil, Plus, RefreshCw, Trash2, X } from "lucide-react";
import type { ControlClient } from "../lib/control-client";
import { CREDENTIAL_LABEL_MAX, CREDENTIAL_PROVIDERS, describeCredential, providerLabel, summarizeUsage, type CredentialList, type CredentialRecord, type CredentialUsage } from "../lib/credentials";

type Draft = { mode: "create" | "rotate" | "rename"; ref?: string; label: string; provider: string; value: string };
type Pending = { ref: string; label: string; usage: CredentialUsage };
const emptyDraft = (provider = ""): Draft => ({ mode: "create", label: "", provider, value: "" });

function relative(stamp: string | null) {
  if (!stamp) return "Never used";
  const days = Math.floor((Date.now() - new Date(stamp).getTime()) / 86_400_000);
  if (days < 1) return "Used today";
  if (days === 1) return "Used yesterday";
  return days < 30 ? `Used ${days} days ago` : `Used ${Math.floor(days / 30)} month${days < 60 ? "" : "s"} ago`;
}

export default function CredentialManager({ client, onClose, onChanged, provider = "" }: { client: ControlClient; onClose: () => void; onChanged?: (credentials: CredentialRecord[]) => void; provider?: string }) {
  const [items, setItems] = useState<CredentialRecord[]>([]);
  const [backend, setBackend] = useState("");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [reassignTo, setReassignTo] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const refresh = useCallback(async () => {
    const result = await client.request<CredentialList>("/v1/credentials");
    setItems(result.credentials); setBackend(result.backend); onChanged?.(result.credentials);
    return result.credentials;
  }, [client, onChanged]);

  useEffect(() => { void (async () => {
    try { await refresh(); } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not load saved credentials."); }
    finally { setLoading(false); }
  })(); }, [refresh]);

  const save = async () => {
    if (!draft) return;
    setBusy(true); setError("");
    try {
      if (draft.mode === "create") await client.request("/v1/credentials", { method: "POST", body: JSON.stringify({ label: draft.label, provider: draft.provider, value: draft.value }) });
      else if (draft.mode === "rotate") await client.request(`/v1/credentials/${encodeURIComponent(draft.ref!)}/value`, { method: "POST", body: JSON.stringify({ value: draft.value }) });
      else await client.request(`/v1/credentials/${encodeURIComponent(draft.ref!)}`, { method: "PUT", body: JSON.stringify({ label: draft.label, provider: draft.provider }) });
      await refresh(); setDraft(null);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not save this credential."); }
    finally { setBusy(false); }
  };

  const remove = async (ref: string, query = "") => {
    setBusy(true); setError("");
    try { await client.request(`/v1/credentials/${encodeURIComponent(ref)}${query}`, { method: "DELETE" }); await refresh(); setPending(null); }
    catch (cause) {
      // The service refuses an in-use credential until the operator has seen what
      // references it, so the first failure is the prompt, not an error.
      const record = items.find(item => item.ref === ref);
      if (!query && record?.usage.uses.length) { setPending({ ref, label: record.label, usage: record.usage }); setReassignTo(""); }
      else setError(cause instanceof Error ? cause.message : "Could not delete this credential.");
    }
    finally { setBusy(false); }
  };

  const others = items.filter(item => item.ref !== pending?.ref);
  const fields = draft && <div className="profile-advanced credential-draft">
    <strong>{draft.mode === "create" ? "Add a credential" : draft.mode === "rotate" ? `Replace the value for ${draft.label}` : `Rename ${draft.label}`}</strong>
    {draft.mode !== "rotate" && <div className="profile-two-columns">
      <label>Name<input autoFocus maxLength={CREDENTIAL_LABEL_MAX} value={draft.label} onChange={event => setDraft(value => value && ({ ...value, label: event.target.value }))} placeholder="Work xAI key" autoComplete="off" /></label>
      <label>Provider<select value={draft.provider} onChange={event => setDraft(value => value && ({ ...value, provider: event.target.value }))}>{CREDENTIAL_PROVIDERS.map(option => <option value={option.id} key={option.id || "any"}>{option.label}</option>)}</select></label>
    </div>}
    {draft.mode !== "rename" && <label>Value<input type="password" autoFocus={draft.mode === "rotate"} value={draft.value} onChange={event => setDraft(value => value && ({ ...value, value: event.target.value }))} placeholder="Paste the key — it is never shown again" autoComplete="new-password" /></label>}
    <div className="profile-actions">
      <button className="subtle-button" disabled={busy} onClick={() => setDraft(null)}>Cancel</button>
      <button className="light-button" disabled={busy || (draft.mode !== "rotate" && !draft.label.trim()) || (draft.mode !== "rename" && !draft.value.trim())} onClick={() => void save()}>{busy ? <LoaderCircle className="spin" size={14} /> : <Check size={14} />} {draft.mode === "create" ? "Save credential" : draft.mode === "rotate" ? "Replace value" : "Save name"}</button>
    </div>
  </div>;

  return <div className="modal-backdrop credential-backdrop" onClick={() => !busy && onClose()}>
    <section className="modal credential-modal" role="dialog" aria-modal="true" aria-labelledby="credential-title" onClick={event => event.stopPropagation()}>
      <div className="modal-heading">
        <div><div className="eyebrow">KEYS AND TOKENS</div><h2 id="credential-title">Saved credentials</h2></div>
        <button aria-label="Close saved credentials" onClick={onClose}><X size={19} /></button>
      </div>
      <p className="profile-help">Stored in this computer&rsquo;s {backend || "protected credential store"}. Values are never shown again, never sent back to this page, and are left out of exports and diagnostics.</p>
      {error && <div className="task-error" role="alert">{error}</div>}

      {loading ? <div className="credential-empty"><LoaderCircle className="spin" size={20} /></div>
        : !items.length ? <div className="credential-empty"><KeyRound size={26} /><p>No saved credentials yet. Add one to connect a model.</p></div>
        : <div className="credential-list">{items.map(item => <article className={`credential-row ${item.present ? "" : "absent"}`} key={item.ref}>
            <div>
              <strong>{item.label}</strong>
              <div className="credential-meta">
                <span className="credential-ref">{item.ref}</span>
                <span>{providerLabel(item.provider)}</span>
                {describeCredential(item) && <span>{describeCredential(item)}</span>}
                <span>{relative(item.lastUsedAt)}</span>
              </div>
              {!item.present && <p className="computer-warning"><CircleAlert size={13} /> The value is missing from the credential store. Replace it to use this credential again.</p>}
              <span className={`credential-usage ${item.usage.agentCount || item.usage.uses.length ? "" : "idle"}`}>{summarizeUsage(item.usage)}</span>
            </div>
            <div className="credential-actions">
              <button className="subtle-button" disabled={busy} onClick={() => { setError(""); setDraft({ mode: "rotate", ref: item.ref, label: item.label, provider: item.provider, value: "" }); }}><RefreshCw size={13} /> Replace</button>
              <button className="subtle-button" disabled={busy} onClick={() => { setError(""); setDraft({ mode: "rename", ref: item.ref, label: item.label, provider: item.provider, value: "" }); }}><Pencil size={13} /> Rename</button>
              <button className="profile-icon-button danger-text" disabled={busy} aria-label={`Delete ${item.label}`} title={`Delete ${item.label}`} onClick={() => void remove(item.ref)}><Trash2 size={14} /></button>
            </div>
          </article>)}</div>}

      {pending && <div className="profile-discard credential-confirm" role="alertdialog" aria-label={`Delete ${pending.label}`}>
        <strong>{pending.label} is still in use</strong>
        <ul className="credential-uses">
          {pending.usage.uses.map((use, index) => <li key={index}>{use.kind === "workspace-default" ? "The workspace default, which every inheriting agent uses" : use.kind === "agent-model" ? `${use.agentName} — model credential` : `${use.agentName} — ${use.connectorName} connection${use.enabled ? "" : " (off)"}`}</li>)}
        </ul>
        {pending.usage.activeRuns > 0 && <p>{pending.usage.activeRuns} task{pending.usage.activeRuns === 1 ? " is" : "s are"} running on it now. They finish on the credential they started with.</p>}
        <p>Moving them saves each agent, so anyone with that agent&rsquo;s settings open will be asked to reload.</p>
        <div className="profile-actions">
          <label className="credential-move">Move them to<select value={reassignTo} onChange={event => setReassignTo(event.target.value)}><option value="">Choose a credential</option>{others.map(item => <option value={item.ref} key={item.ref}>{item.label}</option>)}</select></label>
          <span className="drawer-spacer" />
          <button className="subtle-button" disabled={busy} onClick={() => setPending(null)}>Cancel</button>
          <button className="subtle-button" disabled={busy || !reassignTo} onClick={() => void remove(pending.ref, `?reassignTo=${encodeURIComponent(reassignTo)}`)}>Move and delete</button>
          <button className="danger-button" disabled={busy} onClick={() => void remove(pending.ref, "?force=1")}>Delete anyway</button>
        </div>
      </div>}

      {fields}
      <div className="modal-footer">
        <span className="drawer-spacer" />
        {!draft && <button className="light-button" onClick={() => { setError(""); setDraft(emptyDraft(provider)); }}><Plus size={14} /> Add credential</button>}
      </div>
    </section>
  </div>;
}

// The quick switch. Lives on the agent card and the conversation header so a credential
// can be changed without opening the profile editor. One PUT; it applies to the next task,
// exactly like every other profile edit.
export function CredentialSwitcher({ agent, credentials, workspaceRef, client, onManage, onSaved, running = false }: {
  agent: { id: string; name: string; profile?: { model: { inherit: boolean; credentialRef: string; provider: string } } };
  credentials: CredentialRecord[];
  workspaceRef: string;
  client: ControlClient;
  onManage: () => void;
  onSaved: (profile: unknown) => void;
  running?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const model = agent.profile?.model;
  const byRef = (ref: string) => credentials.find(item => item.ref === ref);
  const workspaceLabel = byRef(workspaceRef)?.label || (workspaceRef ? `${workspaceRef} — missing` : "None");
  const current = !model || model.inherit ? `Workspace default` : byRef(model.credentialRef)?.label || (model.credentialRef ? `${model.credentialRef} — missing` : "No credential");
  // '' provider credentials fit anywhere, which is what connector and custom-endpoint keys need.
  const options = credentials.filter(item => !item.provider || !model?.provider || item.provider === model.provider);

  const wrap = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    const onDown = (event: MouseEvent) => { if (!wrap.current?.contains(event.target as Node)) setOpen(false); };
    window.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    return () => { window.removeEventListener("keydown", onKey); document.removeEventListener("mousedown", onDown); };
  }, [open]);

  const choose = async (body: { ref?: string; inherit?: boolean }) => {
    setBusy(true); setError("");
    try { const saved = await client.request<{ profile: unknown }>(`/v1/agents/${encodeURIComponent(agent.id)}/credential`, { method: "PUT", body: JSON.stringify(body) }); onSaved(saved.profile); setOpen(false); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "Could not switch this credential."); }
    finally { setBusy(false); }
  };

  return <span className="credential-switch" ref={wrap}>
    <button type="button" className="credential-chip" aria-haspopup="menu" aria-expanded={open} disabled={busy} aria-label={`Credential for ${agent.name}`} title={`Credential for ${agent.name}`} onClick={() => setOpen(value => !value)}>
      {busy ? <LoaderCircle className="spin" size={12} /> : <KeyRound size={12} />}<span>{current}</span>
    </button>
    {open && <div className="credential-menu" role="menu">
        {error && <p role="alert">{error}</p>}
        <button role="menuitem" onClick={() => void choose({ inherit: true })}><span>Workspace default<small>{workspaceLabel}</small></span>{model?.inherit && <Check size={14} />}</button>
        <hr />
        {options.length ? options.map(item => <button role="menuitem" key={item.ref} onClick={() => void choose({ ref: item.ref })}>
          <span>{item.label}<small>{item.present ? describeCredential(item) || item.ref : "Value missing"}</small></span>
          {!model?.inherit && model?.credentialRef === item.ref && <Check size={14} />}
        </button>) : <p>No saved credential fits this agent&rsquo;s provider yet.</p>}
        <hr />
        {running && <p>{agent.name} is working now. A switch applies to its next task.</p>}
        <button role="menuitem" onClick={() => { setOpen(false); onManage(); }}><span>Manage credentials…</span></button>
    </div>}
  </span>;
}
