'use client';
import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, Cpu, FileText, LoaderCircle, Plus, RefreshCw, Search, SlidersHorizontal, Trash2, UserRound, X, Cable } from 'lucide-react';
import { ControlClient } from '../lib/control-client';
import { DEFAULT_MODEL, TOOL_GROUPS, draftProfile, type AgentProfile, type ModelCatalog, type ModelChoice, type ProfileResponse, type ToolCatalog, type ToolInfo } from '../lib/agent-profile';
import { initialWorkspace, type Agent } from '../lib/types';

type Props = { agent: Agent; client: ControlClient; onClose: () => void; onSaved: (profile: AgentProfile) => void };
const tabs = [{ id: 'profile', label: 'Profile', icon: UserRound }, { id: 'model', label: 'Model', icon: Cpu }, { id: 'prompt', label: 'System prompt', icon: FileText }, { id: 'tools', label: 'Tools & connections', icon: SlidersHorizontal }] as const;
type Tab = typeof tabs[number]['id'];
const serialize = (value: AgentProfile) => JSON.stringify(value);
const errorText = (error: unknown) => error instanceof Error ? error.message : 'Could not reach the local service. Your draft is still here.';
function Toggle({ checked, onChange, label, description, mixed = false }: { checked: boolean; onChange: (on: boolean) => void; label: string; description?: string; mixed?: boolean }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { if (ref.current) ref.current.indeterminate = mixed; }, [mixed]);
  return <label className="profile-switch-row"><span><strong>{label}</strong>{description && <small>{description}</small>}</span><input ref={ref} type="checkbox" role="switch" aria-label={label} checked={checked} onChange={e => onChange(e.target.checked)} /><span className={`profile-switch ${mixed ? 'mixed' : ''}`} aria-hidden="true" /></label>;
}
export default function AgentSettings({ agent, client, onClose, onSaved }: Props) {
  const [draft, setDraft] = useState(() => draftProfile(agent));
  const [baseline, setBaseline] = useState(() => serialize(draftProfile(agent)));
  const [tab, setTab] = useState<Tab>('profile');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [discard, setDiscard] = useState(false);
  const [workspaceModel, setWorkspaceModel] = useState<ModelChoice>(DEFAULT_MODEL);
  const [activeRevision, setActiveRevision] = useState<number | null>(null);
  const [secretNames, setSecretNames] = useState<string[]>([]);
  const [catalog, setCatalog] = useState<ToolCatalog>({ source: 'unavailable', tools: [] });
  const [models, setModels] = useState<ModelCatalog>({ models: [] });
  const [catalogBusy, setCatalogBusy] = useState(false);
  const [modelsBusy, setModelsBusy] = useState(false);
  const [search, setSearch] = useState('');
  const [connection, setConnection] = useState('');
  const [checking, setChecking] = useState(false);
  const [connectorChecks, setConnectorChecks] = useState<Record<string, string>>({});
  const [secretName, setSecretName] = useState('');
  const [secretValue, setSecretValue] = useState('');
  const [secretBusy, setSecretBusy] = useState(false);
  const dirty = baseline !== serialize(draft);
  const dirtyRef = useRef(false); dirtyRef.current = dirty;
  const dialogRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = previous; };
  }, []);
  useEffect(() => {
    if (discard) dialogRef.current?.querySelector<HTMLButtonElement>('[role=alertdialog] button')?.focus();
  }, [discard]);
  const effectiveModel = draft.model.inherit ? workspaceModel : draft.model;
  const base = `/v1/agents/${encodeURIComponent(agent.id)}`;
  function edit(patch: Partial<AgentProfile>) { setSuccess(''); setDraft(current => ({ ...current, ...patch })); }
  function editModel(patch: Partial<AgentProfile['model']>) { setConnection(''); edit({ model: { ...draft.model, ...patch } }); }
  function close() { if (saving) return; if (dirty || secretValue) setDiscard(true); else onClose(); }
  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        if (!client.token) await client.bootstrap();
        const defaults = await client.request<{ model: ModelChoice }>('/v1/workspace/model');
        if (!cancelled) setWorkspaceModel(defaults.model);
        if (draft.revision || agent.profile) {
          const value = await client.request<ProfileResponse>(`${base}/profile`);
          if (!cancelled && !dirtyRef.current) { setDraft(value.profile); setBaseline(serialize(value.profile)); setActiveRevision(value.activeRevision); setSecretNames(value.secretNames); }
        } else {
          try { const value = await client.request<ProfileResponse>(`${base}/profile`); if (!cancelled && !dirtyRef.current) { setDraft(value.profile); setBaseline(serialize(value.profile)); setActiveRevision(value.activeRevision); setSecretNames(value.secretNames); } } catch { /* A new agent can be saved without a server profile yet. */ }
        }
        const health = await client.request<{ secrets: string[] }>('/v1/health'); if (!cancelled) setSecretNames(health.secrets);
      } catch (err) { if (!cancelled) setError(`Profile service unavailable. You can edit a draft, but it has not been saved. ${errorText(err)}`); }
      finally { if (!cancelled) setLoading(false); }
    }
    void load();
    return () => { cancelled = true; };
    // Load once per editor; subsequent local edits stay intact when parent state changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent.id]);
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (discard) setDiscard(false); else close(); }
      if (discard && event.key === 'Tab') {
        const buttons = dialogRef.current?.querySelectorAll<HTMLButtonElement>('[role=alertdialog] button');
        if (buttons?.length) { event.preventDefault(); event.stopPropagation(); (document.activeElement === buttons[0] ? buttons[1] : buttons[0]).focus(); }
      }
      if ((event.ctrlKey || event.metaKey) && event.key === 's') { event.preventDefault(); void save(); }
    };
    const before = (event: BeforeUnloadEvent) => { if (dirtyRef.current) event.preventDefault(); };
    const dialog = dialogRef.current;
    dialog?.addEventListener('keydown', handler); window.addEventListener('beforeunload', before);
    return () => { dialog?.removeEventListener('keydown', handler); window.removeEventListener('beforeunload', before); };
  });
  async function refreshTools() {
    setCatalogBusy(true);
    try { setCatalog(await client.request<ToolCatalog>(`${base}/tools`)); }
    catch (err) { setCatalog(old => ({ ...old, source: old.tools.length ? 'cached' : 'unavailable', error: errorText(err) })); }
    finally { setCatalogBusy(false); }
  }
  async function refreshModels() {
    setModelsBusy(true);
    try { setModels(await client.request<ModelCatalog>(`${base}/models`)); }
    catch (err) { setModels({ models: [], error: errorText(err) }); }
    finally { setModelsBusy(false); }
  }
  function selectTab(next: Tab) {
    setTab(next);
    if (next === 'tools' && !catalog.tools.length && !catalogBusy) void refreshTools();
    if (next === 'model' && !models.models.length && !modelsBusy) void refreshModels();
  }
  async function save() {
    if (saving || loading || discard) return;
    if (!draft.name.trim() || !draft.role.trim()) { setTab('profile'); setError('Give this agent a name and a role.'); return; }
    if (!draft.model.inherit && (!draft.model.provider.trim() || !draft.model.model.trim())) { setTab('model'); setError('Select a provider and model, or use the workspace default.'); return; }
    setSaving(true); setError(''); setSuccess('');
    try {
      if (!client.token) await client.bootstrap();
      const result = await client.request<ProfileResponse>(`${base}/profile`, { method: 'PUT', body: JSON.stringify(draft) });
      setDraft(result.profile); setBaseline(serialize(result.profile)); setActiveRevision(result.activeRevision); setSecretNames(result.secretNames); onSaved(result.profile);
      setSuccess(result.activeRevision !== null ? 'Saved — applies to next task.' : 'Saved. Ready for the next task.');
    } catch (err) { setError(errorText(err)); }
    finally { setSaving(false); }
  }
  async function storeCredential() {
    if (!secretName.trim() || !secretValue) { setError('Enter a credential name and its secret value.'); return; }
    setSecretBusy(true); setError('');
    try {
      await client.request('/v1/secrets', { method: 'POST', body: JSON.stringify({ name: secretName.trim(), value: secretValue }) });
      setSecretNames(current => [...new Set([...current, secretName.trim()])]);
      if (!draft.model.inherit) editModel({ credentialRef: secretName.trim() });
      setSecretValue(''); setSuccess('Credential stored securely. Save the profile to use your selection.');
    } catch (err) { setError(errorText(err)); }
    finally { setSecretBusy(false); }
  }
  function toggleTools(ids: string[], on: boolean) {
    edit({ allowedTools: on ? [...new Set([...draft.allowedTools, ...ids])] : draft.allowedTools.filter(id => !ids.includes(id)) });
  }
  const providers = [...new Set(['xai', 'openrouter', 'anthropic', 'openai', 'local', 'custom', draft.model.provider, ...models.models.map(m => m.provider)])];
  const unknown: ToolInfo[] = draft.allowedTools.filter(id => !catalog.tools.some(t => t.id === id)).map(id => ({ id, name: id.replaceAll('_', ' '), group: 'other', description: 'Previously selected tool.', available: false, reason: 'Not found in the current tool catalog.' }));
  const tools = [...catalog.tools, ...unknown];
  const credentialForm = <details className="profile-advanced"><summary><Plus size={14} /> Add a saved credential</summary><div className="profile-two-columns"><label>Credential name<input value={secretName} onChange={e => setSecretName(e.target.value.toUpperCase())} placeholder="MY_PROVIDER_API_KEY" autoComplete="off" /></label><label>Secret value<input type="password" value={secretValue} onChange={e => setSecretValue(e.target.value)} autoComplete="new-password" placeholder="Paste a key — it is never shown again" /></label></div><button type="button" className="subtle-button" disabled={secretBusy} onClick={() => void storeCredential()}>{secretBusy ? 'Storing…' : 'Store credential'}</button><p className="profile-help">Stored on the local server with restricted file permissions. Secret values are never returned or included in normal exports.</p></details>;
  return <div className="modal-backdrop profile-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) close(); }}>
    <section ref={dialogRef} className="agent-settings-panel" role="dialog" aria-modal="true" aria-labelledby="agent-settings-title">
      <header className="profile-header"><div className={`avatar tone-${draft.tone}`}><UserRound size={24} /></div><div><div className="eyebrow">MAKE IT YOURS</div><h2 id="agent-settings-title">Agent settings</h2><p>{draft.name || 'Your new agent'} <span>· {draft.role || 'Give it a role'}</span></p></div><button className="profile-close" type="button" aria-label="Close agent settings" onClick={close}><X size={21} /></button></header>
      <div className="profile-tabs" inert={saving || discard} role="tablist" aria-label="Agent settings sections" onKeyDown={e => {
        if (!['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(e.key)) return;
        e.preventDefault(); const i = tabs.findIndex(t => t.id === tab); const n = e.key === 'Home' ? 0 : e.key === 'End' ? tabs.length - 1 : (i + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
        selectTab(tabs[n].id); document.getElementById(`profile-tab-${tabs[n].id}`)?.focus();
      }}>{tabs.map(t => <button type="button" id={`profile-tab-${t.id}`} role="tab" aria-selected={tab === t.id} aria-controls={`profile-panel-${t.id}`} tabIndex={tab === t.id ? 0 : -1} key={t.id} onClick={() => selectTab(t.id)}><t.icon size={16} />{t.label}</button>)}</div>
      <div className="profile-body" inert={saving || discard} role="tabpanel" id={`profile-panel-${tab}`} aria-labelledby={`profile-tab-${tab}`}>
        {loading && <p className="profile-status"><LoaderCircle size={15} /> Loading saved profile…</p>}
        {activeRevision !== null && <div className="profile-info">This agent is working with revision {activeRevision}. Changes you save will apply to its next task.</div>}
        {tab === 'profile' && <><div className="profile-section-heading"><h3>A familiar face. A clear purpose.</h3><p>Give your agent an identity you can recognize across your workspace.</p></div><div className="profile-two-columns"><label>Name<input autoFocus maxLength={30} value={draft.name} onChange={e => edit({ name: e.target.value })} placeholder="Atlas" /></label><label>Role<input maxLength={60} value={draft.role} onChange={e => edit({ role: e.target.value })} placeholder="Research partner" /></label></div><label>Short description<textarea rows={3} maxLength={180} value={draft.description} onChange={e => edit({ description: e.target.value })} placeholder="What should this agent help you with?" /></label><fieldset className="profile-colors"><legend>Avatar color</legend>{['Sage', 'Blue', 'Amber', 'Violet', 'Rose', 'Teal'].map((color, tone) => <label className={`profile-color tone-${tone}`} key={color} title={color}><input type="radio" name="avatar-color" aria-label={color} checked={draft.tone === tone} onChange={() => edit({ tone })} /><span>{draft.tone === tone && <Check size={18} />}</span></label>)}</fieldset><div className="profile-info">Memories, skills, conversations, and files stay with this agent when you edit its profile.</div></>}
        {tab === 'model' && <><div className="profile-section-heading"><h3>Choose how this agent thinks.</h3><p>Use your workspace model or give this agent its own.</p></div><Toggle label="Use workspace default" checked={draft.model.inherit} onChange={inherit => editModel({ inherit })} description={`${workspaceModel.provider} / ${workspaceModel.model}`} /><div className="profile-model-summary"><Cpu size={20} /><span><small>Effective model</small><strong>{effectiveModel.model}</strong><small>{effectiveModel.provider} · {effectiveModel.credentialRef ? (secretNames.includes(effectiveModel.credentialRef) ? 'Credential saved' : 'Missing credential') : 'No credential selected'}</small></span></div><fieldset disabled={draft.model.inherit}><div className="profile-two-columns"><label>Provider<select aria-label="Provider" value={draft.model.provider} onChange={e => editModel({ provider: e.target.value, credentialRef: ({ xai: 'XAI_API_KEY', openrouter: 'OPENROUTER_API_KEY', anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY' } as Record<string,string>)[e.target.value] || '' })}>{providers.map(p => <option key={p} value={p}>{p === 'local' ? 'Local model server' : p === 'custom' ? 'Custom provider' : p}</option>)}</select></label><label>Model<input aria-label="Model" list="agent-model-options" aria-autocomplete="list" value={draft.model.model} onChange={e => editModel({ model: e.target.value })} placeholder="Search models or enter a custom model ID" /><datalist id="agent-model-options">{models.models.filter(m => m.provider === draft.model.provider).map(m => <option key={`${m.provider}:${m.id}`} value={m.id}>{m.label}</option>)}</datalist><small>Type to search, or paste any exact model ID.</small></label></div><label>Saved credential<select value={draft.model.credentialRef} onChange={e => editModel({ credentialRef: e.target.value })}><option value="">None / local endpoint</option>{[...new Set([...secretNames, ...(draft.model.credentialRef ? [draft.model.credentialRef] : [])])].map(name => <option key={name} value={name}>{name}{secretNames.includes(name) ? '' : ' — missing'}</option>)}</select></label><details className="profile-advanced" open={Boolean(draft.model.baseUrl) || draft.model.provider === 'local' || draft.model.provider === 'custom'}><summary>Advanced endpoint <ChevronDown size={14} /></summary><label>Model API base URL<input type="url" value={draft.model.baseUrl} onChange={e => editModel({ baseUrl: e.target.value })} placeholder="http://host.docker.internal:11434/v1" /></label><p className="profile-help">For a model server on this computer, use host.docker.internal. Inside an agent container, localhost refers to that container.</p></details></fieldset><div className="profile-actions"><button className="subtle-button" type="button" disabled={modelsBusy} onClick={() => void refreshModels()}><RefreshCw size={14} />{modelsBusy ? 'Refreshing…' : 'Refresh model list'}</button><button className="subtle-button" type="button" disabled={checking} onClick={async () => { setChecking(true); setConnection(''); try { const r = await client.request<{ message: string }>(`${base}/connection-check`, { method: 'POST', body: JSON.stringify({ model: effectiveModel }) }); setConnection(r.message); } catch (err) { setConnection(errorText(err)); } finally { setChecking(false); } }}>{checking ? 'Checking…' : 'Test connection'}</button></div>{models.error && <p className="profile-help">{models.error}</p>}{connection && <p role="status" className="profile-info">{connection}</p>}{credentialForm}</>}
        {tab === 'prompt' && <><div className="profile-section-heading"><h3>Tell your agent what good work looks like.</h3><p>Describe its job, style, and priorities in your own words.</p></div><Toggle label="Use custom instructions" description="Turn off to use Hermes’s operating instructions alone. Your text will be kept." checked={draft.prompt.enabled} onChange={enabled => edit({ prompt: { ...draft.prompt, enabled } })} /><label>System prompt / agent instructions<textarea className="profile-prompt" rows={15} maxLength={12000} disabled={!draft.prompt.enabled} value={draft.prompt.text} onChange={e => edit({ prompt: { ...draft.prompt, text: e.target.value } })} placeholder="You are a careful research partner. Cite your sources, distinguish evidence from inference, and save useful deliverables…" /></label><div className="profile-actions"><span className="profile-help">{draft.prompt.text.length.toLocaleString()} / 12,000 characters</span><button type="button" className="subtle-button" onClick={() => edit({ prompt: { ...draft.prompt, text: initialWorkspace.agents.find(a => a.id === agent.id)?.instructions || 'Take ownership of the requested outcome. Use your available tools, communicate clearly, and save useful deliverables.' } })}>Restore starter instructions</button></div><p className="profile-info">These instructions shape identity and behavior. Hermes keeps its operating instructions and execution guards. Existing memories and skills are preserved.</p></>}
        {tab === 'tools' && <><div className="profile-section-heading"><h3>Give this agent the right tools.</h3><p>Expand a group to choose individual tools. New tools start switched off.</p></div><div className="profile-tool-toolbar"><label className="profile-search"><Search size={15} /><input aria-label="Search tools" value={search} onChange={e => setSearch(e.target.value)} placeholder="Search tools…" /></label><button type="button" className="subtle-button" onClick={() => edit({ allowedTools: [] })}>Disable all tools</button><button type="button" className="subtle-button" disabled={catalogBusy} onClick={() => void refreshTools()} aria-label="Refresh tools"><RefreshCw size={15} /></button></div>{catalog.error && <p className="profile-info">{catalog.error} {draft.revision === 0 ? 'Save this new agent first, then refresh its tools.' : 'Saved choices are preserved.'}</p>}{catalog.source === 'mock' && <p className="profile-help">Deterministic test runtime — tool availability is simulated.</p>}{TOOL_GROUPS.map(([id, title, description]) => {
          const members = tools.filter(t => (TOOL_GROUPS.some(g => g[0] === t.group) ? t.group : 'other') === id);
          const filtered = members.filter(t => `${t.name} ${t.id} ${t.description} ${title}`.toLowerCase().includes(search.toLowerCase()));
          if (search && !filtered.length) return null;
          const enabled = members.filter(t => draft.allowedTools.includes(t.id)).length;
          return <details key={id} className="profile-tool-group" open={search ? true : undefined}><summary><ChevronDown size={15} /><span><strong>{title}</strong><small>{enabled} / {members.length} enabled</small></span><span className="profile-group-toggle" onClick={e => e.stopPropagation()}><input type="checkbox" aria-label={`Enable ${title}`} aria-checked={enabled > 0 && enabled < members.length ? 'mixed' : enabled > 0} checked={members.length > 0 && enabled === members.length} disabled={!members.length} onChange={e => toggleTools(members.map(t => t.id), e.target.checked)} /><span aria-hidden="true" /></span></summary><p className="profile-help">{description}</p>{filtered.map(tool => <Toggle key={tool.id} label={tool.name} description={`${tool.description.slice(0,180)} · ${tool.available ? 'Available now' : tool.reason || 'Unavailable'}`} checked={draft.allowedTools.includes(tool.id)} onChange={on => toggleTools([tool.id], on)} />)}{!members.length && <p className="profile-help">No tools discovered for this group.</p>}</details>;
        })}<p className="profile-info">These switches control Hermes tools. Enabled Terminal can still read workspace files or make network requests. Container isolation remains the filesystem boundary.</p><div className="profile-section-heading"><h3><Cable size={18} /> MCP connections</h3><p>Test the connection to discover its tools, then enable the ones this agent needs.</p></div>{draft.connectors.map((c, index) => {
          const change = (patch: Partial<typeof c>) => { setConnectorChecks(current => ({ ...current, [c.id]: '' })); edit({ connectors: draft.connectors.map((other, i) => i === index ? { ...other, ...patch } : other) }); };
          return <div className="profile-connector" key={c.id}><Toggle label={c.name || 'New connection'} description="Connection changes apply to the next task." checked={c.enabled} onChange={enabled => change({ enabled })} /><div className="profile-two-columns"><label>Connection name<input value={c.name} onChange={e => change({ name: e.target.value })} placeholder="my-research-tools" /></label><label>Executable<input value={c.command} onChange={e => change({ command: e.target.value })} placeholder="npx" /></label></div><label>Arguments — one per line<textarea rows={3} value={c.args.join('\n')} onChange={e => change({ args: e.target.value.split('\n') })} placeholder={'-y\n@vendor/mcp-server'} /></label><label>Required saved credential<select value={c.secretRef} onChange={e => change({ secretRef: e.target.value })}><option value="">None</option>{[...new Set([...secretNames, ...(c.secretRef ? [c.secretRef] : [])])].map(name => <option key={name}>{name}</option>)}</select></label><div className="profile-actions"><button type="button" className="subtle-button" disabled={connectorChecks[c.id] === 'Checking…'} onClick={async () => { setConnectorChecks(current => ({ ...current, [c.id]: 'Checking…' })); try { const r = await client.request<{ status: string; error?: string; tools: ToolInfo[] }>(`${base}/connector-check`, { method: 'POST', body: JSON.stringify({ connector: c }) }); setConnectorChecks(current => ({ ...current, [c.id]: r.error || `${r.status} · ${r.tools.length} tools discovered` })); if (r.status === 'connected') setCatalog(old => ({ ...old, tools: [...old.tools.filter(t => !t.id.startsWith(`mcp_${c.name}_`)), ...r.tools] })); } catch (err) { setConnectorChecks(current => ({ ...current, [c.id]: errorText(err) })); } }}>Test connection</button><button type="button" className="subtle-button" onClick={() => edit({ connectors: draft.connectors.filter((_, i) => i !== index), allowedTools: draft.allowedTools.filter(id => !id.startsWith(`mcp_${c.name}_`)) })}><Trash2 size={13} /> Remove</button></div><p role="status" className="profile-help">{connectorChecks[c.id] || 'Not checked. Executable availability alone does not prove a connection.'}</p></div>;
        })}<button type="button" className="subtle-button" onClick={() => edit({ connectors: [...draft.connectors, { id: crypto.randomUUID(), name: '', command: '', args: [], secretRef: '', enabled: true }] })}><Plus size={14} /> Add MCP connection</button>{credentialForm}</>}
      </div>
      <footer className="profile-footer" inert={discard}><div className="profile-save-status" aria-live="polite">{error ? <div><p role="alert" className="profile-error">{error}</p>{error.includes('changed elsewhere') && <button type="button" className="subtle-button" onClick={async () => { try { const saved = await client.request<ProfileResponse>(`${base}/profile`); setDraft(saved.profile); setBaseline(serialize(saved.profile)); setError(''); } catch (err) { setError(errorText(err)); } }}>Replace draft with saved version</button>}</div> : success ? <p className="profile-success"><Check size={14} />{success}</p> : <p>{dirty ? 'Unsaved changes' : draft.revision ? `All changes saved · Revision ${draft.revision}` : 'New agent — not saved yet'}</p>}</div><div className="profile-footer-actions"><button type="button" className="subtle-button" disabled={saving} onClick={close}>Cancel</button><button type="button" className="light-button" disabled={saving || loading || (!dirty && draft.revision > 0)} onClick={() => void save()}>{saving ? <LoaderCircle size={15} /> : <Check size={15} />}{saving ? 'Saving…' : 'Save changes'}</button></div></footer>
      {discard && <div className="profile-discard" role="alertdialog" aria-labelledby="discard-title"><h3 id="discard-title">Discard unsaved changes?</h3><p>Your saved profile will stay as it is.</p><div className="profile-actions"><button type="button" className="subtle-button" onClick={() => setDiscard(false)}>Keep editing</button><button type="button" className="light-button" onClick={onClose}>Discard changes</button></div></div>}
    </section>
  </div>;
}
