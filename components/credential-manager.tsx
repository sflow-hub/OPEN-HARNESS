"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ArrowLeft, Check, CircleAlert, KeyRound, LoaderCircle, Plus, RefreshCw, Search, Trash2, X } from "lucide-react";
import { ControlRequestError, type ControlClient } from "../lib/control-client";
import { CREDENTIAL_LABEL_MAX, CREDENTIAL_PROVIDERS, modelForCredential, describeCredential, providerLabel, summarizeUsage, type CredentialList, type CredentialRecord, type CredentialUsage } from "../lib/credentials";

import type { ModelChoice, ProfileResponse } from "../lib/agent-profile";
import ModelPicker from "./model-picker";
import CodexSignIn from "./codex-sign-in";
import { CODEX_PROVIDER } from "../lib/codex";

// The repository follows the familiar automation-tool flow: a searchable list, a service
// picker, then one form with Connection and Details panes. Values are write-only: the form
// starts empty on edit and only a non-empty value is sent, as a separate rotate request.
type Draft = { ref?: string; label: string; provider: string; value: string; model: string; baseUrl: string };
type Step = { kind: "pick"; query: string; choice: string | null } | { kind: "form"; draft: Draft; original?: CredentialRecord; tab: "connection" | "details"; confirmDelete?: boolean; seed?: string };
type Pending = { ref: string; label: string; usage: CredentialUsage };
type Sort = "updated" | "created" | "name" | "name-desc";

const SERVICE_DETAIL: Record<string, string> = {
  "": "A key or token for a connector, tool, or endpoint. Works with every provider.",
  xai: "API key for Grok models.",
  openai: "API key for OpenAI models.",
  [CODEX_PROVIDER]: "Sign in with a ChatGPT account. No key to paste.",
  openrouter: "One key for models from many providers.",
  anthropic: "API key for Claude models.",
  local: "A model server on this computer or your network.",
  custom: "Any OpenAI-compatible endpoint.",
};
// Monograms, not vendor logos: the app ships no third-party marks.
const MONOGRAM: Record<string, string> = { xai: "xA", openai: "OA", [CODEX_PROVIDER]: "CX", openrouter: "OR", anthropic: "AN", local: "LO", custom: "CU" };
const serviceLabel = (id: string) => id ? providerLabel(id) : "Generic secret";
const SERVICES = CREDENTIAL_PROVIDERS.map(option => ({ id: option.id, label: serviceLabel(option.id), detail: SERVICE_DETAIL[option.id] || "" }));

function ServiceIcon({ provider, size = 34 }: { provider: string; size?: number }) {
  let hue = 95; for (const char of provider) hue = (hue * 31 + char.charCodeAt(0)) % 360;
  return <span className="credential-icon" aria-hidden="true" style={{ width: size, height: size, background: `hsl(${hue} 22% 20%)`, color: `hsl(${hue} 55% 80%)`, borderColor: `hsl(${hue} 20% 30%)` }}>
    {provider ? MONOGRAM[provider] || provider.slice(0, 2).toUpperCase() : <KeyRound size={Math.round(size * 0.45)} />}
  </span>;
}

function relative(stamp: string | null) {
  if (!stamp) return "Never used";
  const days = Math.floor((Date.now() - new Date(stamp).getTime()) / 86_400_000);
  if (days < 1) return "Used today";
  if (days === 1) return "Used yesterday";
  return days < 30 ? `Used ${days} days ago` : `Used ${Math.floor(days / 30)} month${days < 60 ? "" : "s"} ago`;
}
function ago(stamp: string) {
  const minutes = Math.floor((Date.now() - new Date(stamp).getTime()) / 60_000);
  const unit = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"} ago`;
  if (!Number.isFinite(minutes)) return "unknown";
  if (minutes < 1) return "just now";
  if (minutes < 60) return unit(minutes, "minute");
  if (minutes < 1440) return unit(Math.floor(minutes / 60), "hour");
  const days = Math.floor(minutes / 1440);
  return days < 30 ? unit(days, "day") : days < 365 ? unit(Math.floor(days / 30), "month") : unit(Math.floor(days / 365), "year");
}
const day = (stamp: string | null) => stamp ? new Date(stamp).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : "Never";

// Portalled for the page; inline when the repository already sits inside a dialog, so a
// second backdrop never stacks over the first.
// `guard` keeps a typed draft from vanishing on a stray backdrop click or Escape; the
// explicit Close and Cancel buttons still discard it.
function Layer({ embedded, label, role = "dialog", wide, guard = false, onClose, children }: { embedded: boolean; label: string; role?: "dialog" | "alertdialog"; wide?: boolean; guard?: boolean; onClose: () => void; children: ReactNode }) {
  const close = useRef(onClose); useEffect(() => { close.current = onClose; }, [onClose]);
  const guarded = useRef(guard); useEffect(() => { guarded.current = guard; }, [guard]);
  useEffect(() => {
    if (embedded) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape" && !guarded.current) close.current(); };
    window.addEventListener("keydown", onKey); return () => window.removeEventListener("keydown", onKey);
  }, [embedded]);
  if (embedded) return <div className="credential-step" role={role} aria-label={label}>{children}</div>;
  if (typeof document === "undefined") return null;
  return createPortal(<div className="modal-backdrop credential-backdrop" onClick={() => { if (!guarded.current) close.current(); }}>
    <section className={`modal credential-modal credential-layer ${wide ? "wide" : ""}`} role={role} aria-modal="true" aria-label={label} onClick={event => event.stopPropagation()}>{children}</section>
  </div>, document.body);
}

export function CredentialRepository({ client, provider = "", embedded = false, onChanged, onBusyChange }: { client: ControlClient; provider?: string; embedded?: boolean; onChanged?: (credentials: CredentialRecord[]) => void; onBusyChange?: (busy: boolean) => void }) {
  const [items, setItems] = useState<CredentialRecord[]>([]);
  const [backend, setBackend] = useState("");
  const [step, setStep] = useState<Step | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [reassignTo, setReassignTo] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusyState] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [query, setQuery] = useState("");
  const [type, setType] = useState<string | null>(null);
  const [sort, setSort] = useState<Sort>("updated");
  const setBusy = useCallback((value: boolean) => { setBusyState(value); onBusyChange?.(value); }, [onBusyChange]);

  const refresh = useCallback(async () => {
    const result = await client.request<CredentialList>("/v1/credentials");
    setItems(result.credentials); setBackend(result.backend); onChanged?.(result.credentials);
    return result.credentials;
  }, [client, onChanged]);

  useEffect(() => { void (async () => {
    try { await refresh(); } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not load saved credentials."); }
    finally { setLoading(false); }
  })(); }, [refresh]);

  const types = useMemo(() => [...new Set(items.map(item => item.provider))].sort((a, b) => serviceLabel(a).localeCompare(serviceLabel(b))), [items]);
  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const matches = items.filter(item => (type === null || item.provider === type) && (!needle || [item.label, item.ref, serviceLabel(item.provider), item.model, item.baseUrl].some(text => text.toLowerCase().includes(needle))));
    const by: Record<Sort, (a: CredentialRecord, b: CredentialRecord) => number> = {
      updated: (a, b) => b.updatedAt.localeCompare(a.updatedAt),
      created: (a, b) => b.createdAt.localeCompare(a.createdAt),
      name: (a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: "base" }),
      "name-desc": (a, b) => b.label.localeCompare(a.label, undefined, { sensitivity: "base" }),
    };
    return [...matches].sort(by[sort]);
  }, [items, query, type, sort]);

  const freeName = (base: string) => {
    const taken = new Set(items.map(item => item.label.toLowerCase()));
    if (!taken.has(base.toLowerCase())) return base;
    for (let n = 2; n < 100; n++) if (!taken.has(`${base} ${n}`.toLowerCase())) return `${base} ${n}`;
    return "";
  };
  const startAdd = () => { setError(""); setNotice(""); setPending(null); setStep({ kind: "pick", query: "", choice: SERVICES.some(service => service.id === provider) ? provider : null }); };
  const choose = (id: string) => { const label = freeName(`${serviceLabel(id)} ${id === CODEX_PROVIDER ? "account" : id ? "key" : ""}`.trim()).slice(0, CREDENTIAL_LABEL_MAX); setStep({ kind: "form", tab: "connection", seed: label, draft: { label, provider: id, value: "", model: "", baseUrl: "" } }); };
  const openEdit = (item: CredentialRecord, tab: "connection" | "details" = "connection") => { setError(""); setNotice(""); setPending(null); setStep({ kind: "form", tab, original: item, draft: { ref: item.ref, label: item.label, provider: item.provider, value: "", model: item.model, baseUrl: item.baseUrl } }); };
  const patch = (change: Partial<Draft>) => setStep(current => current?.kind === "form" ? { ...current, draft: { ...current.draft, ...change } } : current);
  const close = () => { if (!busy) { setStep(null); setError(""); } };

  const save = async () => {
    if (step?.kind !== "form") return;
    const { draft, original } = step;
    setBusy(true); setError("");
    try {
      if (!original) await client.request("/v1/credentials", { method: "POST", body: JSON.stringify({ label: draft.label, provider: draft.provider, model: draft.model, baseUrl: draft.baseUrl, value: draft.value }) });
      else {
        const ref = encodeURIComponent(original.ref);
        if (draft.label !== original.label || draft.provider !== original.provider || draft.model !== original.model || draft.baseUrl !== original.baseUrl)
          await client.request(`/v1/credentials/${ref}`, { method: "PUT", body: JSON.stringify({ label: draft.label, provider: draft.provider, model: draft.model, baseUrl: draft.baseUrl }) });
        if (draft.value.trim()) await client.request(`/v1/credentials/${ref}/value`, { method: "POST", body: JSON.stringify({ value: draft.value }) });
      }
      await refresh(); setStep(null);
    } catch (cause) {
      // A metadata save can land before a rejected value; refresh so the form compares against it.
      const fresh = original ? await refresh().catch(() => null) : null;
      const updated = fresh?.find(item => item.ref === original?.ref);
      if (updated) setStep(current => current?.kind === "form" ? { ...current, original: updated } : current);
      setError(cause instanceof Error ? cause.message : "Could not save this credential.");
    }
    finally { setBusy(false); }
  };

  const remove = async (ref: string, suffix = "") => {
    setBusy(true); setError("");
    try { const result = await client.request<{ warning?: string }>(`/v1/credentials/${encodeURIComponent(ref)}${suffix}`, { method: "DELETE" }); await refresh(); setPending(null); setStep(null); setNotice(result.warning || ""); }
    catch (cause) {
      // The service refuses an in-use credential (profiles or a running task) with a 409
      // carrying fresh usage, so the first refusal is the prompt, not an error. The list
      // snapshot can be stale, so it is only a fallback for a coordinator without usage.
      const record = items.find(item => item.ref === ref);
      const usage = cause instanceof ControlRequestError && cause.status === 409 ? asUsage(cause.body.usage) ?? record?.usage : undefined;
      void refresh().catch(() => {});
      if (usage && (usage.uses.length || usage.activeRuns)) {
        setStep(null); setPending({ ref, label: record?.label || pending?.label || ref, usage });
        if (!usage.uses.length || !items.some(item => item.ref === reassignTo && item.ref !== ref)) setReassignTo("");
        // A retry that is refused again means the usage changed under the operator.
        if (suffix) setError(cause instanceof Error ? cause.message : "This credential is still in use.");
      }
      else setError(cause instanceof Error ? cause.message : "Could not delete this credential.");
    }
    finally { setBusy(false); }
  };

  const others = items.filter(item => item.ref !== pending?.ref);
  const pendingCodex = items.find(item => item.ref === pending?.ref)?.provider === CODEX_PROVIDER;

  const picker = step?.kind === "pick" && (() => {
    const needle = step.query.trim().toLowerCase();
    const matches = SERVICES.filter(service => !needle || `${service.label} ${service.detail}`.toLowerCase().includes(needle));
    return <Layer embedded={embedded} label="Add new credential" onClose={close}>
      <div className="modal-heading credential-step-heading">
        <div><h2>Add new credential</h2><p className="profile-help">Choose the app or service this credential connects to.</p></div>
        <button aria-label={embedded ? "Back to saved credentials" : "Close"} onClick={close}>{embedded ? <ArrowLeft size={18} /> : <X size={19} />}</button>
      </div>
      <label className="credential-search"><Search size={14} aria-hidden="true" /><input autoFocus aria-label="Search for a service" placeholder="Search for a service…" value={step.query} onChange={event => setStep({ ...step, query: event.target.value })} onKeyDown={event => { if (event.key === "Enter" && matches.length === 1) choose(matches[0].id); }} /></label>
      <div className="credential-services" role="listbox" aria-label="Services" onKeyDown={event => {
        if (!["ArrowDown", "ArrowUp"].includes(event.key) || !matches.length) return;
        event.preventDefault();
        const at = matches.findIndex(service => service.id === step.choice), next = matches[(at + (event.key === "ArrowDown" ? 1 : matches.length - 1) + (at < 0 && event.key === "ArrowUp" ? 1 : 0)) % matches.length];
        setStep({ ...step, choice: next.id });
        (event.currentTarget.querySelector(`[data-service="${next.id || "generic"}"]`) as HTMLElement | null)?.focus();
      }}>
        {matches.map(service => <button type="button" role="option" aria-selected={step.choice === service.id} className={step.choice === service.id ? "selected" : ""} data-service={service.id || "generic"} key={service.id || "generic"} onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); choose(service.id); } }} onClick={() => setStep({ ...step, choice: service.id })} onDoubleClick={() => choose(service.id)}>
          <ServiceIcon provider={service.id} size={30} /><span><strong>{service.label}</strong><small>{service.detail}</small></span>{step.choice === service.id && <Check size={15} />}
        </button>)}
        {!matches.length && <p className="credential-none">No service matches &ldquo;{step.query}&rdquo;. Choose Generic secret for anything else.</p>}
      </div>
      <div className="modal-footer">
        <button className="subtle-button" onClick={close}>Cancel</button>
        <button className="light-button" disabled={step.choice === null} onClick={() => step.choice !== null && choose(step.choice)}>Continue</button>
      </div>
    </Layer>;
  })();

  const form = step?.kind === "form" && (() => {
    const { draft, original, tab } = step;
    const codex = draft.provider === CODEX_PROVIDER;
    const changed = !original || Boolean(draft.value.trim()) || draft.label !== original.label || draft.provider !== original.provider || draft.model !== original.model || draft.baseUrl !== original.baseUrl;
    const dirty = original ? changed : Boolean(draft.value || draft.model || draft.baseUrl) || draft.label !== (step.seed ?? "");
    const valid = Boolean(draft.label.trim()) && changed && (original ? true : Boolean(draft.value.trim()));
    // Generic secrets are usually connector tokens; model fields stay folded until used.
    const modelFields = <>
      {!codex && <label>Model API base URL<input type="url" value={draft.baseUrl} onChange={event => patch({ baseUrl: event.target.value })} placeholder={["local", "custom"].includes(draft.provider) ? "Your endpoint, including /v1" : "Optional custom endpoint, including /v1"} /></label>}
      <ModelPicker client={client} provider={draft.provider} credentialRef={original?.ref} apiKey={draft.value} baseUrl={draft.baseUrl} value={draft.model} label="Default model" onChange={model => patch({ model })} />
      <p className="profile-help">Optional starting model when an agent selects this credential. Each agent can choose a different model, and editing this default leaves existing agent choices in place.</p>
    </>;
    const title = original ? original.label : `New ${serviceLabel(draft.provider)} credential`;
    const setTab = (next: "connection" | "details") => setStep({ ...step, tab: next });
    return <Layer embedded={embedded} wide guard={dirty || busy} label={original ? `Edit ${original.label}` : title} onClose={close}>
      <div className="credential-form-heading">
        {embedded && <button className="profile-icon-button" aria-label="Back to saved credentials" disabled={busy} onClick={close}><ArrowLeft size={16} /></button>}
        <ServiceIcon provider={draft.provider} size={38} />
        <div className="credential-form-title">
          <input aria-label="Name" autoFocus={!original} maxLength={CREDENTIAL_LABEL_MAX} value={draft.label} onChange={event => patch({ label: event.target.value })} placeholder="Name this credential" autoComplete="off" />
          <small>{serviceLabel(draft.provider)}{original ? ` · ${original.ref}` : ""}</small>
        </div>
        {!(codex && !original) && <button className="light-button" disabled={busy || !valid} onClick={() => void save()}>{busy ? <LoaderCircle className="spin" size={14} /> : <Check size={14} />} {original ? "Save changes" : "Save credential"}</button>}
        {!embedded && <button className="profile-icon-button" aria-label="Close" disabled={busy} onClick={close}><X size={17} /></button>}
      </div>
      {error && <div className="task-error" role="alert">{error}</div>}
      <div className="credential-form-body">
        <nav className="credential-tabs" role="tablist" aria-label="Credential sections">
          <button role="tab" aria-selected={tab === "connection"} className={tab === "connection" ? "active" : ""} onClick={() => setTab("connection")}>Connection</button>
          <button role="tab" aria-selected={tab === "details"} className={tab === "details" ? "active" : ""} onClick={() => setTab("details")}>Details</button>
        </nav>
        {tab === "connection" ? <div className="credential-pane" role="tabpanel" aria-label="Connection">
          {original && !original.present && <p className="computer-warning"><CircleAlert size={13} /> The value is missing from the credential store. Enter it again to use this credential.</p>}
          {codex ? <>
            <p className="profile-help">{original ? "This credential is a ChatGPT sign-in. Reconnect to refresh the session; there is no key to paste." : "Sign in with your ChatGPT account. The session is stored by the coordinator and never sent back to this page."}</p>
            <CodexSignIn client={client} allowAccountSelection={false} credentialRef={original?.ref} onConnected={() => { void refresh().then(fresh => { const updated = fresh.find(item => item.ref === original?.ref); setStep(current => !original ? null : current?.kind === "form" && updated ? { ...current, original: updated } : current); }, () => { if (!original) setStep(null); }); }} />
          </> : <>
            <label>Value<input aria-label="Value" type="password" autoFocus={Boolean(original)} value={draft.value} onChange={event => patch({ value: event.target.value })} placeholder={original ? "Saved. Paste a new value to replace it" : "Paste the key. It is never shown again"} autoComplete="new-password" />
              <small>{original ? "Leave blank to keep the saved value. Saved values are never shown or sent back to this page." : "Stored only in this computer’s credential store and never shown again."}</small></label>
          </>}
          {(!codex || original) && (draft.provider ? modelFields : <details className="profile-advanced credential-model-fields" open={Boolean(draft.baseUrl || draft.model)}><summary>Use as a model key</summary>{modelFields}</details>)}
        </div> : <div className="credential-pane" role="tabpanel" aria-label="Details">
          {original && !codex && <label>Provider<select aria-label="Provider" value={draft.provider} onChange={event => patch({ provider: event.target.value, model: "", baseUrl: "" })}>{CREDENTIAL_PROVIDERS.filter(option => option.id !== CODEX_PROVIDER).map(option => <option value={option.id} key={option.id || "any"}>{serviceLabel(option.id)}</option>)}</select></label>}
          <dl className="credential-details">
            <dt>Reference</dt><dd>{original ? <code className="credential-ref">{original.ref}</code> : "Made from the name when you save. Agents use it as the variable name."}</dd>
            <dt>Stored in</dt><dd>{backend || "Protected credential store"}</dd>
            {original && <><dt>Saved value</dt><dd>{original.present ? describeCredential(original) || "Saved" : "Missing"}</dd>
              <dt>Created</dt><dd>{day(original.createdAt)}</dd>
              <dt>Last updated</dt><dd>{day(original.updatedAt)}</dd>
              <dt>Last used</dt><dd>{day(original.lastUsedAt)}</dd>
              <dt>Used by</dt><dd>{original.usage.uses.length ? <ul className="credential-uses">{original.usage.uses.map((use, index) => <li key={index}>{describeUse(use)}</li>)}</ul> : "Nothing yet"}</dd></>}
          </dl>
          {original && (step.confirmDelete
            ? <div className="credential-delete-confirm" role="group" aria-label={`Confirm deleting ${original.label}`}><span>Delete {original.label}? The saved value is removed from this computer and cannot be recovered.</span><button className="subtle-button" disabled={busy} onClick={() => setStep({ ...step, confirmDelete: false })}>Keep it</button><button className="danger-button" disabled={busy} onClick={() => void remove(original.ref)}><Trash2 size={13} /> Delete</button></div>
            : <button className="subtle-button danger-text credential-delete" disabled={busy} onClick={() => setStep({ ...step, confirmDelete: true })}><Trash2 size={13} /> Delete credential</button>)}
        </div>}
      </div>
    </Layer>;
  })();

  const pendingUses = pending?.usage.uses.length ?? 0, pendingRuns = pending?.usage.activeRuns ?? 0;
  const confirm = pending && <Layer embedded={embedded} role="alertdialog" label={`Delete ${pending.label}`} onClose={() => !busy && setPending(null)}>
    <div className="profile-discard credential-confirm">
      <strong>{pending.label} is still in use</strong>
      {error && <div className="task-error" role="alert">{error}</div>}
      {pendingUses > 0 && <ul className="credential-uses">{pending.usage.uses.map((use, index) => <li key={index}>{describeUse(use)}</li>)}</ul>}
      {pendingRuns > 0 && <p>{pendingRuns} task{pendingRuns === 1 ? " is" : "s are"} running on it now{pendingUses ? "" : ", although no agent setting still names it"}. {pendingCodex ? "Disconnecting this sign-in stops further model requests from these tasks." : "Deleting removes the value they may still read; let them finish or stop them first."}</p>}
      {pendingUses > 0 && <p>Moving them saves each agent, so anyone with that agent&rsquo;s settings open will be asked to reload.</p>}
      <div className="profile-actions">
        {pendingUses > 0 && <label className="credential-move">Move them to<select value={reassignTo} onChange={event => setReassignTo(event.target.value)}><option value="">Choose a credential</option>{others.map(item => <option value={item.ref} key={item.ref}>{item.label}</option>)}</select></label>}
        <span className="drawer-spacer" />
        <button className="subtle-button" disabled={busy} onClick={() => { setPending(null); setError(""); }}>Cancel</button>
        {pendingUses > 0 && <button className="subtle-button" disabled={busy || !reassignTo} onClick={() => void remove(pending.ref, `?reassignTo=${encodeURIComponent(reassignTo)}`)}>Move and delete</button>}
        <button className="danger-button" disabled={busy} onClick={() => void remove(pending.ref, "?force=1")}>Delete anyway</button>
      </div>
    </div>
  </Layer>;

  // Inside a dialog a step replaces the list; on the page it floats above it.
  if (embedded && step) return <div className="credential-repo">{picker}{form}</div>;
  return <div className="credential-repo">
    <div className="credential-toolbar">
      {items.length > 0 && <>
        <label className="credential-search"><Search size={14} aria-hidden="true" /><input aria-label="Search credentials" placeholder="Search credentials…" value={query} onChange={event => setQuery(event.target.value)} /></label>
        <select aria-label="Filter by type" value={type ?? "*"} onChange={event => setType(event.target.value === "*" ? null : event.target.value)}><option value="*">All types</option>{types.map(id => <option key={id || "generic"} value={id}>{serviceLabel(id)}</option>)}</select>
        <select aria-label="Sort credentials" value={sort} onChange={event => setSort(event.target.value as Sort)}><option value="updated">Sort by last updated</option><option value="created">Sort by last created</option><option value="name">Sort by name (A-Z)</option><option value="name-desc">Sort by name (Z-A)</option></select>
      </>}
      <span className="drawer-spacer" />
      <button className="light-button" onClick={startAdd}><Plus size={14} /> Add credential</button>
    </div>
    <p className="profile-help credential-store-note">Stored in this computer&rsquo;s {backend || "protected credential store"}. Values are never shown again, never sent back to this page, and are left out of exports and diagnostics.</p>
    {error && !step && !pending && <div className="task-error" role="alert">{error}</div>}
    {embedded && confirm}
    {loading ? <div className="credential-empty"><LoaderCircle className="spin" size={20} /></div>
      : !items.length ? <div className="credential-empty"><KeyRound size={26} /><p>No saved credentials yet. Add one to connect a model.</p><button className="subtle-button" onClick={startAdd}><Plus size={13} /> Add your first credential</button></div>
      : !visible.length ? <div className="credential-empty"><Search size={22} /><p>No credentials match these filters.</p><button className="subtle-button" onClick={() => { setQuery(""); setType(null); }}>Clear filters</button></div>
      : <div className="credential-list">
        {visible.length !== items.length && <p className="credential-count">Showing {visible.length} of {items.length}</p>}
        {visible.map(item => <article className={`credential-row ${item.present ? "" : "absent"}`} key={item.ref}>
          <button type="button" className="credential-open" aria-label={`Open ${item.label}`} onClick={() => openEdit(item)}>
            <ServiceIcon provider={item.provider} />
            <span className="credential-summary">
              <strong>{item.label}</strong>
              <span className="credential-meta">
                <span>{serviceLabel(item.provider)}</span>
                {item.model && <span>{item.model}</span>}
                <span>Last updated {ago(item.updatedAt)}</span>
                <span>Created {day(item.createdAt)}</span>
                <span>{relative(item.lastUsedAt)}</span>
              </span>
            </span>
          </button>
          <div className="credential-actions">
            {!item.present && <span className="credential-usage missing"><CircleAlert size={11} /> Value missing</span>}
            <span className={`credential-usage ${item.usage.agentCount || item.usage.uses.length ? "" : "idle"}`}>{summarizeUsage(item.usage)}</span>
            {item.provider === CODEX_PROVIDER && <button className="subtle-button" disabled={busy} onClick={() => openEdit(item)}><RefreshCw size={13} /> Reconnect</button>}
            <button className="profile-icon-button danger-text" disabled={busy} aria-label={`Delete ${item.label}`} title={`Delete ${item.label}`} onClick={() => void remove(item.ref)}><Trash2 size={14} /></button>
          </div>
        </article>)}
      </div>}
    {notice && <p role="status">{notice}</p>}
    {!embedded && confirm}
    {picker}{form}
  </div>;
}

// The 409 body is coordinator data; accept it only in the shape the list already uses.
function asUsage(value: unknown): CredentialUsage | undefined {
  const usage = value as Partial<CredentialUsage> | null | undefined;
  return usage && Array.isArray(usage.uses) && typeof usage.activeRuns === "number" ? { uses: usage.uses, agentCount: Number(usage.agentCount) || 0, activeRuns: usage.activeRuns } : undefined;
}

function describeUse(use: CredentialUsage["uses"][number]) {
  return use.kind === "workspace-default" ? "The workspace default, which every inheriting agent uses" : use.kind === "agent-model" ? `${use.agentName} — model credential` : `${use.agentName} — ${use.connectorName} connection${use.enabled ? "" : " (off)"}`;
}

// The Credentials tab in the sidebar.
export function CredentialsPage({ client, onChanged }: { client: ControlClient; onChanged?: (credentials: CredentialRecord[]) => void }) {
  return <section className="files-page credentials-page" aria-labelledby="credentials-page-title">
    <div className="eyebrow">KEYS AND TOKENS</div>
    <div className="files-title"><div><h1 id="credentials-page-title">Credentials</h1><p className="intro">Keys, tokens, and sign-ins your agents use to reach models and services.</p></div></div>
    <CredentialRepository client={client} onChanged={onChanged} />
  </section>;
}

// The same repository as a dialog, for settings panels that must keep their own state open.
export default function CredentialManager({ client, onClose, onChanged, provider = "" }: { client: ControlClient; onClose: () => void; onChanged?: (credentials: CredentialRecord[]) => void; provider?: string }) {
  const busy = useRef(false);
  const onBusyChange = useCallback((value: boolean) => { busy.current = value; }, []);
  return <div className="modal-backdrop credential-backdrop" onClick={() => !busy.current && onClose()}>
    <section className="modal credential-modal" role="dialog" aria-modal="true" aria-labelledby="credential-title" onClick={event => event.stopPropagation()}>
      <div className="modal-heading">
        <div><div className="eyebrow">KEYS AND TOKENS</div><h2 id="credential-title">Saved credentials</h2></div>
        <button aria-label="Close saved credentials" onClick={onClose}><X size={19} /></button>
      </div>
      <CredentialRepository client={client} provider={provider} embedded onChanged={onChanged} onBusyChange={onBusyChange} />
    </section>
  </div>;
}

// The quick switch. Lives on the agent card and the conversation header so a credential
// can be changed without opening the profile editor. One PUT; it applies to the next task,
// exactly like every other profile edit.
export function CredentialSwitcher({ agent, credentials, workspaceRef, workspaceProvider, client, onManage, onSaved, onCredentialsChanged, running = false }: {
  agent: { id: string; name: string; profile?: { model: { inherit: boolean; credentialRef: string; provider: string; model: string } } };
  credentials: CredentialRecord[];
  workspaceRef: string;
  workspaceProvider: string;
  client: ControlClient;
  onManage: () => void;
  onSaved: (profile: unknown) => void;
  onCredentialsChanged?: (credentials: CredentialRecord[]) => void;
  running?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [selection, setSelection] = useState<ModelChoice | null>(null);
  const [revision, setRevision] = useState(0);
  const [loaded, setLoaded] = useState(false);
  const model = agent.profile?.model;
  const byRef = (ref: string) => credentials.find(item => item.ref === ref);
  const workspaceLabel = byRef(workspaceRef)?.label || (workspaceRef ? `${workspaceRef} — missing` : "None");
  const current = !model || model.inherit ? "Workspace default" : `${byRef(model.credentialRef)?.label || (model.credentialRef ? `${model.credentialRef} — missing` : "No credential")}${model.model ? ` · ${model.model}` : ""}`;
  // '' provider credentials fit anywhere, which is what connector and custom-endpoint keys need.
  const effectiveProvider = !model || model.inherit ? workspaceProvider : model.provider;
  const options = credentials.filter(item => !item.provider || !effectiveProvider || item.provider === effectiveProvider);

  const wrap = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void client.request<ProfileResponse>(`/v1/agents/${encodeURIComponent(agent.id)}/profile`).then(value => {
      if (!cancelled) { setSelection(value.effectiveModel); setRevision(value.profile.revision); setLoaded(true); }
    }, () => { if (!cancelled) setError("Could not load this agent’s model. Close and reopen to try again."); });
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    const onDown = (event: MouseEvent) => { if (!wrap.current?.contains(event.target as Node)) setOpen(false); };
    window.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    return () => { cancelled = true; window.removeEventListener("keydown", onKey); document.removeEventListener("mousedown", onDown); };
  }, [open, client, agent.id]);

  const choose = async (inherit = false) => {
    if (!selection || !loaded) return;
    setBusy(true); setError("");
    try {
      const body = inherit ? { inherit: true, revision } : { ...selection, ref: selection.credentialRef, revision };
      const saved = await client.request<ProfileResponse>(`/v1/agents/${encodeURIComponent(agent.id)}/credential`, { method: "PUT", body: JSON.stringify(body) });
      onSaved(saved.profile); setOpen(false);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "Could not switch this model and credential."); }
    finally { setBusy(false); }
  };

  return <span className="credential-switch" ref={wrap}>
    <button type="button" className="credential-chip" aria-haspopup="dialog" aria-expanded={open} disabled={busy} aria-label={`Credential for ${agent.name}`} title={`Model and credential for ${agent.name}`} onClick={() => { setLoaded(false); setError(""); setSelection(null); setOpen(value => !value); }}>
      {busy ? <LoaderCircle className="spin" size={12} /> : <KeyRound size={12} />}<span>{current}</span>
    </button>
    {open && <div className="credential-menu" role="dialog" aria-label={`Model and credential for ${agent.name}`}>
      <strong>Model and credential</strong>
      {error && <p role="alert">{error}</p>}
      {!loaded && !error && <p>Loading current model…</p>}
      {loaded && selection && <fieldset disabled={busy}>
        {options.length > 0 && <div role="menu" aria-label="Credentials for this provider" className="credential-quick">{options.map(item => <button type="button" role="menuitem" key={item.ref} onClick={() => setSelection(modelForCredential(selection, item))}>
          <span>{item.label}<small>{item.present ? describeCredential(item) || item.ref : "Value missing"}</small></span>{selection.credentialRef === item.ref && <Check size={14} />}
        </button>)}</div>}
        <label>Saved credential<select value={selection.credentialRef} onChange={event => {
          const credential = byRef(event.target.value);
          setSelection(credential ? modelForCredential(selection, credential) : { ...selection, credentialRef: '' });
        }}><option value="">None / local endpoint</option>{credentials.map(item => <option key={item.ref} value={item.ref}>{item.label}{item.present ? '' : ' — missing'}</option>)}{selection.credentialRef && !byRef(selection.credentialRef) && <option value={selection.credentialRef}>{selection.credentialRef} — missing</option>}</select></label>
        <label>Provider<select aria-label="Provider" value={selection.provider} onChange={event => setSelection({ ...selection, provider: event.target.value, model: '', baseUrl: '' })}>{[...new Set([...CREDENTIAL_PROVIDERS.map(item => item.id).filter(Boolean), selection.provider])].map(provider => <option key={provider} value={provider}>{providerLabel(provider)}</option>)}</select></label>
        <ModelPicker client={client} {...selection} value={selection.model} onCredentialChange={ref => { setSelection(current => current && ({...current,credentialRef:ref})); void client.request<CredentialList>('/v1/credentials').then(value=>onCredentialsChanged?.(value.credentials)).catch(()=>{}); }} onChange={model => setSelection({ ...selection, model })} />
        <details open={Boolean(selection.baseUrl) || ['local', 'custom'].includes(selection.provider)}><summary>Advanced endpoint</summary><label>Model API base URL<input type="url" value={selection.baseUrl} onChange={event => setSelection({ ...selection, baseUrl: event.target.value })} /></label></details>
        <button type="button" className="light-button" disabled={!selection.model.trim() || Boolean(selection.credentialRef && !byRef(selection.credentialRef)?.present)} onClick={() => void choose()}>Apply model and credential</button>
        <button type="button" title={`Workspace credential: ${workspaceLabel}`} onClick={() => void choose(true)}>Use workspace default</button>
      </fieldset>}
      <p>{running ? `${agent.name} is working now. Changes apply to its next task.` : 'Each agent can use any saved credential and choose its own model.'}</p>
      <button type="button" disabled={busy} onClick={() => { setOpen(false); onManage(); }}>Manage credentials…</button>
    </div>}
  </span>;
}
