'use client';
import { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, Cpu, FileText, LoaderCircle, Plus, RefreshCw, Search, SlidersHorizontal, Trash2, UserRound, X, Cable, MonitorCog, Server, Folder, Copy, CircleStop, FolderKanban, ShieldAlert } from 'lucide-react';
import { ControlClient } from '../lib/control-client';
import { DEFAULT_MODEL, TOOL_GROUPS, draftProfile, isSandboxedComputer, type AgentProfile, type MachineInfo, type ModelCatalog, type ModelChoice, type ProfileResponse, type ToolCatalog, type ToolInfo } from '../lib/agent-profile';
import { initialWorkspace, type Agent } from '../lib/types';
import { describeCredential, fitsProvider, type CredentialRecord } from '../lib/credentials';

type Props = { agent: Agent; client: ControlClient; onClose: () => void; onSaved: (profile: AgentProfile) => void; initialTab?: Tab; advancedFeatures?: boolean; onManageCredentials?: () => void; credentialCatalog?: CredentialRecord[] };
const tabs = [{ id: 'profile', label: 'Profile', icon: UserRound }, { id: 'computer', label: 'Computer', icon: MonitorCog }, { id: 'model', label: 'Model', icon: Cpu }, { id: 'prompt', label: 'System prompt', icon: FileText }, { id: 'tools', label: 'Tools & connections', icon: SlidersHorizontal }] as const;
type Tab = typeof tabs[number]['id'];
const serialize = (value: AgentProfile) => JSON.stringify(value);
const errorText = (error: unknown) => error instanceof Error ? error.message : 'Could not reach the local service. Your draft is still here.';
function Toggle({ checked, onChange, label, description, mixed = false, disabled = false }: { checked: boolean; onChange: (on: boolean) => void; label: string; description?: string; mixed?: boolean; disabled?: boolean }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { if (ref.current) ref.current.indeterminate = mixed; }, [mixed]);
  return <label className="profile-switch-row"><span><strong>{label}</strong>{description && <small>{description}</small>}</span><input ref={ref} type="checkbox" role="switch" aria-label={label} checked={checked} disabled={disabled} onChange={e => onChange(e.target.checked)} /><span className={`profile-switch ${mixed ? 'mixed' : ''}`} aria-hidden="true" /></label>;
}
export default function AgentSettings({ agent, client, onClose, onSaved, initialTab = 'profile', advancedFeatures = false, onManageCredentials, credentialCatalog }: Props) {
  const [draft, setDraft] = useState(() => draftProfile(agent));
  const [baseline, setBaseline] = useState(() => serialize(draftProfile(agent)));
  const [tab, setTab] = useState<Tab>(initialTab);
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
  const [credentials, setCredentials] = useState<CredentialRecord[]>([]);
  const [credentialStorage, setCredentialStorage] = useState<'coordinator' | 'runner'>('coordinator');
  const [machines, setMachines] = useState<MachineInfo[]>([]);
  const [computerBusy, setComputerBusy] = useState(false);
  const [computerStatus, setComputerStatus] = useState('');
  const [showPairing, setShowPairing] = useState(false);
  const [pairPlatform, setPairPlatform] = useState<'linux' | 'darwin' | 'win32'>('linux');
  const [pairName, setPairName] = useState('');
  const [pairCoordinator, setPairCoordinator] = useState('');
  const [pairing, setPairing] = useState<{ command: string; expiresAt: string } | null>(null);
  const pairingBaseline = useRef<Set<string>>(new Set());
  const [transfer, setTransfer] = useState<{ state: string; detail: string } | null>(null);
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
  function editComputer(patch: Partial<AgentProfile['computer']>) { setComputerStatus(''); const computer = { ...draft.computer, ...patch }; edit({ computer, ...(computer.desktop === 'none' ? { allowedTools: draft.allowedTools.filter(id => id !== 'computer_use') } : {}) }); }
  function close() { if (saving) return; if (dirty) setDiscard(true); else onClose(); }
  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        if (!client.token) await client.bootstrap();
        const defaults = await client.request<{ model: ModelChoice }>('/v1/workspace/model');
        if (!cancelled) setWorkspaceModel(defaults.model);
        if (draft.revision || agent.profile) {
          const value = await client.request<ProfileResponse>(`${base}/profile`);
          if (!cancelled && !dirtyRef.current) { setDraft(value.profile); setBaseline(serialize(value.profile)); setActiveRevision(value.activeRevision); setSecretNames(value.secretNames); setCredentials(value.credentials ?? []); setTransfer(value.transfer || null); }
        } else {
          try { const value = await client.request<ProfileResponse>(`${base}/profile`); if (!cancelled && !dirtyRef.current) { setDraft(value.profile); setBaseline(serialize(value.profile)); setActiveRevision(value.activeRevision); setSecretNames(value.secretNames); setCredentials(value.credentials ?? []); setTransfer(value.transfer || null); } } catch { /* A new agent can be saved without a server profile yet. */ }
        }
        const machineResult = await client.request<{ machines: MachineInfo[] }>('/v1/machines');
        if (!cancelled) setMachines(machineResult.machines);
      } catch (err) { if (!cancelled) setError(`Profile service unavailable. You can edit a draft, but it has not been saved. ${errorText(err)}`); }
      finally { if (!cancelled) setLoading(false); }
    }
    void load();
    return () => { cancelled = true; };
    // Load once per editor; subsequent local edits stay intact when parent state changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent.id]);
  useEffect(() => {
    if (loading || !draft.computer.machineId) return;
    let cancelled = false;
    client.request<{ secrets: string[]; credentials?: CredentialRecord[]; storage: 'coordinator' | 'runner' }>(`/v1/machines/${encodeURIComponent(draft.computer.machineId)}/secrets`).then(value => { if (!cancelled) { setSecretNames(value.secrets); setCredentials(value.credentials ?? []); setCredentialStorage(value.storage); } }, err => { if (!cancelled) setComputerStatus(errorText(err)); });
    return () => { cancelled = true; };
  }, [client, draft.computer.machineId, loading, credentialCatalog]);
  useEffect(() => {
    if (!transfer || !['queued','exporting','importing','verifying'].includes(transfer.state)) return;
    let cancelled = false, timer: ReturnType<typeof setTimeout>;
    async function watchTransfer() {
      try {
        const value = await client.request<ProfileResponse>(`${base}/profile`); if (cancelled) return;
        setTransfer(value.transfer || null);
        if (value.transfer && ['completed','failed'].includes(value.transfer.state) && !dirtyRef.current) { setDraft(value.profile); setBaseline(serialize(value.profile)); setSecretNames(value.secretNames); setCredentials(value.credentials ?? []); onSaved(value.profile); }
      } catch { /* Keep the saved transfer visible through temporary dashboard disconnects. */ }
      if (!cancelled) timer = setTimeout(watchTransfer, 2_000);
    }
    timer = setTimeout(watchTransfer, 1_000);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [base, client, onSaved, transfer]);
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
  async function refreshMachines() { setComputerBusy(true); try { const result = await client.request<{ machines: MachineInfo[] }>('/v1/machines'); setMachines(result.machines); } catch (err) { setComputerStatus(errorText(err)); } finally { setComputerBusy(false); } }
  async function createPairing() { setComputerBusy(true); setComputerStatus(''); pairingBaseline.current = new Set(machines.map(machine => machine.id)); try { const result = await client.request<{ command: string; expiresAt: string }>('/v1/machines', { method: 'POST', body: JSON.stringify({ name: pairName, platform: pairPlatform, coordinatorUrl: pairCoordinator.trim() }) }); setPairing(result); setComputerStatus('Pairing code created. Run this command on the computer; this screen will connect it automatically.'); } catch (err) { setComputerStatus(errorText(err)); } finally { setComputerBusy(false); } }
  useEffect(() => {
    if (!pairing || !showPairing) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    async function watch() {
      if (Date.parse(pairing!.expiresAt) <= Date.now()) { setPairing(null); setComputerStatus('This pairing command expired. Create a new one to try again.'); return; }
      try {
        const result = await client.request<{ machines: MachineInfo[] }>('/v1/machines');
        if (cancelled) return;
        setMachines(result.machines);
        const connected = result.machines.find(machine => !pairingBaseline.current.has(machine.id) && machine.platform === pairPlatform && machine.status === 'online');
        if (connected) {
          setDraft(current => ({ ...current, computer: { ...current.computer, machineId: connected.id } }));
          setPairing(null); setShowPairing(false); setComputerStatus(`${connected.name} connected and was selected for this agent. Save changes when you are ready.`);
          return;
        }
      } catch { /* Keep waiting; a temporary dashboard disconnect should not cancel pairing. */ }
      timer = setTimeout(watch, 2_000);
    }
    timer = setTimeout(watch, 1_200);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [client, pairPlatform, pairing, showPairing]);
  async function computerAction(action: 'test' | 'reconnect') { setComputerBusy(true); setComputerStatus(''); try { const result = await client.request<{ message: string }>(`/v1/machines/${encodeURIComponent(draft.computer.machineId)}/${action}`, { method: 'POST', body: JSON.stringify({ agentId: agent.id }) }); setComputerStatus(result.message); await refreshMachines(); } catch (err) { setComputerStatus(errorText(err)); setComputerBusy(false); } }
  async function save() {
    if (saving || loading || discard) return;
    if (!draft.name.trim() || !draft.role.trim()) { setTab('profile'); setError('Give this agent a name and a role.'); return; }
    if (!draft.model.inherit && (!draft.model.provider.trim() || !draft.model.model.trim())) { setTab('model'); setError('Select a provider and model, or use the workspace default.'); return; }
    setSaving(true); setError(''); setSuccess('');
    try {
      if (!client.token) await client.bootstrap();
      const result = await client.request<ProfileResponse>(`${base}/profile`, { method: 'PUT', body: JSON.stringify(draft) });
      setDraft(result.profile); setBaseline(serialize(result.profile)); setActiveRevision(result.activeRevision); setSecretNames(result.secretNames); setTransfer(result.transfer || null); onSaved(result.profile);
      setSuccess(result.activeRevision !== null ? 'Saved — applies to next task.' : 'Saved. Ready for the next task.');
    } catch (err) { setError(errorText(err)); }
    finally { setSaving(false); }
  }
  function toggleTools(ids: string[], on: boolean) {
    edit({ allowedTools: on ? [...new Set([...draft.allowedTools, ...ids])] : draft.allowedTools.filter(id => !ids.includes(id)) });
  }
  const providers = [...new Set(['xai', 'openrouter', 'anthropic', 'openai', 'local', 'custom', draft.model.provider, ...models.models.map(m => m.provider)])];
  const unknown: ToolInfo[] = draft.allowedTools.filter(id => !catalog.tools.some(t => t.id === id)).map(id => ({ id, name: id.replaceAll('_', ' '), group: 'other', description: 'Previously selected tool.', available: false, reason: 'Not found in the current tool catalog.' }));
  const tools = [...catalog.tools, ...unknown];
  const selectedMachine = machines.find(item => item.id === draft.computer.machineId);
  const platformName = (value?: string) => ({ linux: 'Linux', darwin: 'macOS', win32: 'Windows', unknown: 'Unknown OS' } as Record<string,string>)[value || 'unknown'];
  const credentialLabel = (ref: string) => credentials.find(item => item.ref === ref)?.label || ref;
  // "" provider credentials fit anywhere, which is what connector secrets need.
  const credentialOptions = (provider: string, current: string) => {
    const fitting = credentials.filter(item => fitsProvider(item, provider));
    return <>{fitting.map(item => <option key={item.ref} value={item.ref}>{item.label}{item.present ? '' : ' — missing'}</option>)}{current && !fitting.some(item => item.ref === current) && <option value={current}>{current} — missing</option>}<option value="__manage">＋ Manage credentials…</option></>;
  };
  const chooseCredential = (value: string, apply: (ref: string) => void) => { if (value === '__manage') onManageCredentials?.(); else apply(value); };
  const credentialNote = <p className="profile-help">{credentialStorage === 'runner' ? 'Encrypted for the selected computer and saved by its runner. The hosted coordinator cannot decrypt it.' : 'Stored in this coordinator’s protected credential store and delivered only to runs that select it.'} Values are never returned or included in normal exports.</p>;
  // Every agent runs in its own container now, and the desktop it can be given is a private
  // one, so where an agent works is an ordinary setting. Advanced features only gates the
  // extras on that tab: reservations and resource limits.
  const visibleTabs = tabs;
  // A profile saved before direct access and existing-desktop control were withdrawn keeps
  // its values so nothing is lost, but the coordinator refuses to save or run it until it is
  // moved into a container. The conversion below is deliberate, never automatic.
  const legacyComputer = !isSandboxedComputer(draft.computer);
  const desktopCapable = Boolean(selectedMachine?.capabilities.virtualDesktop);
  const desktopUnavailableReason = !selectedMachine
    ? 'Choose a connected computer first.'
    : selectedMachine.platform !== 'linux'
      ? `Private agent desktops run in Linux containers. ${selectedMachine.name} runs ${platformName(selectedMachine.platform)}; connect a Linux computer with Docker to give this agent a desktop.`
      : !selectedMachine.capabilities.container
        ? `Docker is not available on ${selectedMachine.name}. Install and start Docker there to give this agent a desktop.`
        : `${selectedMachine.name} does not offer a private agent desktop.`;
  // Folders already listed stay exactly as granted; a legacy draft never gains access here.
  const convertComputer = (desktop: 'virtual' | 'none') => editComputer({ access: draft.computer.folders.length ? 'folders' : 'private', desktop });
  // The Docker Desktop install reports the host folders exported to it (an empty list when
  // none are); an agent there can be given only those, at their container paths, and never
  // more access than the export allows. Native and remote runners report nothing and keep
  // taking a path typed for that computer.
  const folderExports = selectedMachine?.folderExports;
  const exportFor = (path: string) => folderExports?.find(folder => folder.path === path);
  // The same field on the local machine says the whole installation is the Docker-backed
  // one, whose coordinator refuses model servers on this computer's loopback or Docker's
  // host aliases: the endpoint hint must not suggest them there.
  const composeDeployment = machines.some(machine => machine.local && machine.folderExports !== undefined);
  return <div className="modal-backdrop profile-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) close(); }}>
    <section ref={dialogRef} className="agent-settings-panel" role="dialog" aria-modal="true" aria-labelledby="agent-settings-title">
      <header className="profile-header"><div className={`avatar tone-${draft.tone}`}><UserRound size={24} /></div><div><div className="eyebrow">MAKE IT YOURS</div><h2 id="agent-settings-title">Agent settings</h2><p>{draft.name || 'Your new agent'} <span>· {draft.role || 'Give it a role'}</span></p></div><button className="profile-close" type="button" aria-label="Close agent settings" onClick={close}><X size={21} /></button></header>
      <div className="profile-tabs" inert={saving || discard} role="tablist" aria-label="Agent settings sections" onKeyDown={e => {
        if (!['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(e.key)) return;
        e.preventDefault(); const i = visibleTabs.findIndex(t => t.id === tab); const n = e.key === 'Home' ? 0 : e.key === 'End' ? visibleTabs.length - 1 : (i + (e.key === 'ArrowRight' ? 1 : -1) + visibleTabs.length) % visibleTabs.length;
        selectTab(visibleTabs[n].id); document.getElementById(`profile-tab-${visibleTabs[n].id}`)?.focus();
      }}>{visibleTabs.map(t => <button type="button" id={`profile-tab-${t.id}`} role="tab" aria-selected={tab === t.id} aria-controls={`profile-panel-${t.id}`} tabIndex={tab === t.id ? 0 : -1} key={t.id} onClick={() => selectTab(t.id)}><t.icon size={16} />{t.label}</button>)}</div>
      <div className="profile-body" inert={saving || discard} role="tabpanel" id={`profile-panel-${tab}`} aria-labelledby={`profile-tab-${tab}`}>
        {loading && <p className="profile-status"><LoaderCircle size={15} /> Loading saved profile…</p>}
        {activeRevision !== null && <div className="profile-info">This agent is working with revision {activeRevision}. Changes you save will apply to its next task.</div>}
        {tab === 'profile' && <><div className="profile-section-heading"><h3>A familiar face. A clear purpose.</h3><p>Give your agent an identity you can recognize across your workspace.</p></div><div className="profile-two-columns"><label>Name<input autoFocus maxLength={30} value={draft.name} onChange={e => edit({ name: e.target.value })} placeholder="Atlas" /></label><label>Role<input maxLength={60} value={draft.role} onChange={e => edit({ role: e.target.value })} placeholder="Research partner" /></label></div><label>Short description<textarea rows={3} maxLength={180} value={draft.description} onChange={e => edit({ description: e.target.value })} placeholder="What should this agent help you with?" /></label><fieldset className="profile-colors"><legend>Avatar color</legend>{['Sage', 'Blue', 'Amber', 'Violet', 'Rose', 'Teal'].map((color, tone) => <label className={`profile-color tone-${tone}`} key={color} title={color}><input type="radio" name="avatar-color" aria-label={color} checked={draft.tone === tone} onChange={() => edit({ tone })} /><span>{draft.tone === tone && <Check size={18} />}</span></label>)}</fieldset><div className="profile-info">Memories, skills, conversations, and files stay with this agent when you edit its profile.</div></>}
        {tab === 'computer' && <>
          <div className="profile-section-heading"><h3><Server size={19} /> Choose where this agent works.</h3><p>Every agent works inside its own isolated container on the computer you choose. Several agents can share one computer while keeping separate private storage.</p></div>
          {legacyComputer && <div className="computer-blocked" role="alert">
            <ShieldAlert size={18} />
            <div>
              <strong>{draft.computer.desktop === 'existing' ? 'Control of this computer’s signed-in desktop is no longer available.' : 'Direct computer access is no longer available.'}</strong>
              <p>It ran outside the sandbox, so Open Harness will not start this agent or save its settings until it moves into an isolated container. Everything else about this agent is kept.</p>
              <div className="profile-actions">
                {desktopCapable && <button type="button" className="light-button" onClick={() => convertComputer('virtual')}>Use a private agent desktop</button>}
                <button type="button" className="subtle-button" onClick={() => convertComputer('none')}>Use a private workspace</button>
              </div>
              {!desktopCapable && <small>{desktopUnavailableReason}</small>}
            </div>
          </div>}
          <div className="computer-heading"><h4>Where it runs</h4><button type="button" className="subtle-button" onClick={() => { setShowPairing(true); setPairing(null); }}><Plus size={14} /> Add computer</button></div>
          <label>Connected computer<select aria-label="Connected computer" value={draft.computer.machineId} onChange={e => editComputer({ machineId: e.target.value })}>{machines.map(machine => <option value={machine.id} key={machine.id}>{machine.name} · {platformName(machine.platform)} · {machine.status}</option>)}</select></label>
          {selectedMachine && <div className="computer-machine-card"><span className={`computer-status ${selectedMachine.status}`} aria-hidden="true" /><div><strong>{selectedMachine.name}</strong><small>{platformName(selectedMachine.platform)} · {selectedMachine.arch} · {selectedMachine.assignedAgents} agent{selectedMachine.assignedAgents === 1 ? '' : 's'} assigned</small><small>{selectedMachine.status === 'online' ? 'Connected and ready to receive work' : selectedMachine.status === 'offline' ? `Last seen ${selectedMachine.lastSeenAt ? new Date(selectedMachine.lastSeenAt).toLocaleString() : 'never'}` : selectedMachine.status}</small></div></div>}
          {transfer && <p className="profile-info" role="status">Transfer {transfer.state}: {transfer.detail}</p>}
          {advancedFeatures && <Toggle label="Reserve this computer for this agent" checked={draft.computer.reserveMachine} onChange={reserveMachine => editComputer({ reserveMachine })} description="Other agents will not be able to select it while this reservation is saved." />}

          <h4 className="computer-section-title">Computer access</h4>
          <fieldset className="computer-choice-grid"><legend className="sr-only">Computer access level</legend>{[
            ['private', 'Private workspace', 'Commands, files, and browser tools run in this agent’s own isolated container. Shared files stay shared with your other agents.'],
            ['folders', 'Selected folders', 'Keep the isolated container and add only the host folders you choose, read-only or read/write.'],
          ].map(([value, title, description]) => <label className={`computer-choice ${draft.computer.access === value ? 'selected' : ''}`} key={value}><input type="radio" name="computer-access" value={value} checked={draft.computer.access === value} onChange={() => editComputer({ access: value as AgentProfile['computer']['access'], desktop: draft.computer.desktop === 'existing' ? 'none' : draft.computer.desktop })} /><strong>{title}</strong><small>{description}</small></label>)}</fieldset>

          <h4 className="computer-section-title">Desktop</h4>
          <Toggle label="Private agent desktop" checked={draft.computer.desktop === 'virtual'} disabled={legacyComputer || (!desktopCapable && draft.computer.desktop !== 'virtual')} onChange={on => editComputer({ desktop: on ? 'virtual' : 'none' })} description={desktopCapable ? 'Its own Linux desktop with a browser and screen, inside the isolated container. Nothing on your screen is shared with it.' : desktopUnavailableReason} />
          {draft.computer.desktop === 'virtual' && (draft.allowedTools.includes('computer_use')
            ? <p className="profile-help" role="status">Desktop control tools are switched on for this agent in Tools &amp; connections.</p>
            : <p className="profile-help computer-desktop-note" role="status">The desktop is provided, but the tools to use it are granted separately: switch on <strong>Desktop control</strong> in Tools &amp; connections so this agent can see and act on it. <button type="button" className="subtle-button" onClick={() => selectTab('tools')}>Open Tools &amp; connections</button></p>)}
          <p className="profile-help">Controlling the desktop you are signed in to is not available: it would run outside the sandbox. A private agent desktop is the only desktop an agent can be given.</p>

          <details className="profile-advanced"><summary><ChevronDown size={14} /> Advanced resources and shared folders</summary>{advancedFeatures && <div className="profile-three-columns"><label>CPU cores<input aria-label="CPU cores" type="number" min="0.25" max="64" step="0.25" value={draft.computer.resources.cpu} onChange={e => editComputer({ resources: { ...draft.computer.resources, cpu: Number(e.target.value) } })} /></label><label>Memory (MB)<input aria-label="Memory in MB" type="number" min="256" max="262144" step="256" value={draft.computer.resources.memoryMb} onChange={e => editComputer({ resources: { ...draft.computer.resources, memoryMb: Number(e.target.value) } })} /></label><label>Concurrent tasks<input aria-label="Concurrent tasks" type="number" min="1" max="32" step="1" value={draft.computer.resources.concurrency} onChange={e => editComputer({ resources: { ...draft.computer.resources, concurrency: Number(e.target.value) } })} /></label></div>}
            <div className="computer-heading"><h4>Selected host folders</h4><button type="button" className="subtle-button" disabled={draft.computer.access !== 'folders' || folderExports?.length === 0} onClick={() => editComputer({ folders: [...draft.computer.folders, { id: crypto.randomUUID(), path: folderExports ? (folderExports.find(folder => !draft.computer.folders.some(item => item.path === folder.path)) || folderExports[0]).path : '', mode: 'read' }] })}><Folder size={13} /> Add folder</button></div>
            {draft.computer.access !== 'folders' && <p className="profile-help">Choose Selected folders above to configure explicit host paths.</p>}
            {folderExports && <p className="profile-info computer-exports">Open Harness is running in Docker Desktop. Agents can be given only the folders exported to it in your host-folder Compose override, at their <code>/host-folders/…</code> paths; a path on your computer such as <code>C:\Projects\website</code> or <code>/Users/me/website</code> cannot be selected here directly. {folderExports.length === 0
              ? <>No folders are exported yet. Stop Open Harness, copy <code>compose.host-folders.example.yaml</code>, put your folder in it, then start Open Harness again with <code>--override</code> (docs/LOCAL_BROWSER.md has the steps). Exports change only at a relaunch.</>
              : <>Exported now: {folderExports.map(folder => `${folder.path} (${folder.mode === 'read' ? 'read-only' : 'read/write'})`).join(', ')}. Exporting a folder grants nothing by itself: this agent gets only what you select below, never more than the export allows, and an export shared read-only stays read-only here.</>}</p>}
            {draft.computer.folders.map((folder, index) => { const exported = exportFor(folder.path); const readOnlyExport = exported?.mode === 'read'; return <div className="computer-folder" key={folder.id}><label>{folderExports ? 'Exported folder' : 'Host path'}{folderExports
              ? <select aria-label={`Shared folder ${index + 1} path`} value={folder.path} onChange={e => { const chosen = exportFor(e.target.value); editComputer({ folders: draft.computer.folders.map((item, i) => i === index ? { ...item, path: e.target.value, mode: chosen?.mode === 'read' ? 'read' : item.mode } : item) }); }}>{!exported && <option value={folder.path}>{folder.path ? `${folder.path} · no longer exported` : 'Choose an exported folder'}</option>}{folderExports.map(item => <option key={item.path} value={item.path}>{item.path} · {item.mode === 'read' ? 'read-only' : 'read/write'}</option>)}</select>
              : <input aria-label={`Shared folder ${index + 1} path`} value={folder.path} placeholder={selectedMachine?.platform === 'win32' ? 'C:\\Projects\\website' : '/home/me/projects/website'} onChange={e => editComputer({ folders: draft.computer.folders.map((item, i) => i === index ? { ...item, path: e.target.value } : item) })} />}</label><label>Access<select aria-label={`Shared folder ${index + 1} access`} value={folder.mode} disabled={readOnlyExport && folder.mode === 'read'} onChange={e => editComputer({ folders: draft.computer.folders.map((item, i) => i === index ? { ...item, mode: e.target.value as 'read' | 'write' } : item) })}><option value="read">Read only</option>{(!readOnlyExport || folder.mode === 'write') && <option value="write">Read and write</option>}</select>{readOnlyExport && <small>{folder.mode === 'write' ? 'This folder is now shared read-only with Open Harness. Choose Read only to save.' : 'Shared read-only with Open Harness.'}</small>}</label><button type="button" className="profile-icon-button" aria-label={`Remove shared folder ${index + 1}`} onClick={() => editComputer({ folders: draft.computer.folders.filter((_, i) => i !== index) })}><Trash2 size={15} /></button></div>; })}
          </details>
          <div className="profile-actions computer-actions"><button type="button" className="subtle-button" disabled={computerBusy || !selectedMachine || legacyComputer} onClick={() => void computerAction('test')}>{computerBusy ? <LoaderCircle size={14} /> : <Check size={14} />} Test access</button><button type="button" className="subtle-button" disabled={computerBusy || !selectedMachine} onClick={() => void computerAction('reconnect')}><RefreshCw size={14} /> Reconnect</button><button type="button" className="subtle-button danger" onClick={async () => { setComputerBusy(true); try { const result = await client.request<{ stopped: number; pending?: boolean }>(`${base}/stop`, { method: 'POST' }); setComputerStatus(result.pending ? 'Stop pending until the runner reconnects and confirms it.' : result.stopped ? 'Agent stopped.' : 'This agent has no active work.'); } catch (err) { setComputerStatus(errorText(err)); } finally { setComputerBusy(false); } }}><CircleStop size={14} /> Stop agent</button></div>
          {computerStatus && <p role="status" className="profile-info">{computerStatus}</p>}
          {showPairing && <div className="computer-wizard"><div className="computer-heading"><div><h4>Add a computer</h4><p className="profile-help">Install one runner per machine. Any number of agents can reuse it.</p></div><button className="profile-icon-button" type="button" aria-label="Close add computer" onClick={() => setShowPairing(false)}><X size={16} /></button></div><div className="profile-two-columns"><label>Computer name<input value={pairName} onChange={e => setPairName(e.target.value)} placeholder="Production VPS" /></label><label>Operating system<select aria-label="Computer operating system" value={pairPlatform} onChange={e => { setPairPlatform(e.target.value as typeof pairPlatform); setPairing(null); }}><option value="linux">Linux</option><option value="darwin">macOS</option><option value="win32">Windows</option></select></label></div><label>Public coordinator address <span className="profile-optional">self-hosted only</span><input value={pairCoordinator} onChange={e => { setPairCoordinator(e.target.value); setPairing(null); }} placeholder="https://agents.example.com/api/local" /><small>Leave blank when using the hosted dashboard. A self-hosted coordinator needs an HTTPS address reachable from the new computer, such as a Tailscale Serve or reverse-proxy address.</small></label>{!pairing ? <button type="button" className="light-button" disabled={computerBusy} onClick={() => void createPairing()}>{computerBusy ? 'Creating…' : 'Create pairing command'}</button> : <><label>Run on the computer<textarea readOnly rows={4} value={pairing.command} /></label><p className="profile-help"><LoaderCircle className="spin" size={13} /> Waiting for this computer. It will be selected automatically when it connects.</p><div className="profile-actions"><small>Expires {new Date(pairing.expiresAt).toLocaleTimeString()}</small><button type="button" className="subtle-button" onClick={async () => { await navigator.clipboard.writeText(pairing.command); setComputerStatus('Pairing command copied. Waiting for the computer to connect.'); }}><Copy size={13} /> Copy command</button></div></>}</div>}
        </>}
        {tab === 'model' && <><div className="profile-section-heading"><h3>Choose how this agent thinks.</h3><p>Use your workspace model or give this agent its own.</p></div><Toggle label="Use workspace default" checked={draft.model.inherit} onChange={inherit => editModel({ inherit })} description={`${workspaceModel.provider} / ${workspaceModel.model}`} /><div className="profile-model-summary"><Cpu size={20} /><span><small>Effective model</small><strong>{effectiveModel.model}</strong><small>{effectiveModel.provider} · {effectiveModel.credentialRef ? (secretNames.includes(effectiveModel.credentialRef) ? credentialLabel(effectiveModel.credentialRef) : 'Missing credential') : 'No credential selected'}</small></span></div><fieldset disabled={draft.model.inherit}><div className="profile-two-columns"><label>Provider<select aria-label="Provider" value={draft.model.provider} onChange={e => editModel({ provider: e.target.value, credentialRef: credentials.some(item => item.ref === draft.model.credentialRef && fitsProvider(item, e.target.value)) ? draft.model.credentialRef : credentials.find(item => item.provider === e.target.value)?.ref || '' })}>{providers.map(p => <option key={p} value={p}>{p === 'local' ? 'Local model server' : p === 'custom' ? 'Custom provider' : p}</option>)}</select></label><label>Model<input aria-label="Model" list="agent-model-options" aria-autocomplete="list" value={draft.model.model} onChange={e => editModel({ model: e.target.value })} placeholder="Search models or enter a custom model ID" /><datalist id="agent-model-options">{models.models.filter(m => m.provider === draft.model.provider).map(m => <option key={`${m.provider}:${m.id}`} value={m.id}>{m.label}</option>)}</datalist><small>Type to search, or paste any exact model ID.</small></label></div><label>Saved credential<select value={draft.model.credentialRef} onChange={e => chooseCredential(e.target.value, credentialRef => editModel({ credentialRef }))}><option value="">None / local endpoint</option>{credentialOptions(draft.model.provider, draft.model.credentialRef)}</select>{draft.model.credentialRef && <small>{describeCredential(credentials.find(item => item.ref === draft.model.credentialRef) || { length: 0, fingerprint: '' }) || draft.model.credentialRef}</small>}</label><details className="profile-advanced" open={Boolean(draft.model.baseUrl) || draft.model.provider === 'local' || draft.model.provider === 'custom'}><summary>Advanced endpoint <ChevronDown size={14} /></summary><label>Model API base URL<input type="url" value={draft.model.baseUrl} onChange={e => editModel({ baseUrl: e.target.value })} placeholder={composeDeployment ? 'https://models.example.com/v1' : 'http://host.docker.internal:11434/v1'} /></label><p className="profile-help">{composeDeployment ? 'Open Harness is running in Docker: a model server needs an address that the coordinator and the agent containers can both reach over the network. localhost, 127.0.0.1 and host.docker.internal on this computer are refused here — use a hosted provider, or a model server with a network address.' : 'The address must be reachable from where the agent runs. Inside an agent container, localhost refers to that container; for a model server on the computer running the agent, use host.docker.internal.'}</p></details></fieldset><div className="profile-actions"><button className="subtle-button" type="button" disabled={modelsBusy} onClick={() => void refreshModels()}><RefreshCw size={14} />{modelsBusy ? 'Refreshing…' : 'Refresh model list'}</button><button className="subtle-button" type="button" disabled={checking} onClick={async () => { setChecking(true); setConnection(''); try { const r = await client.request<{ message: string }>(`${base}/connection-check`, { method: 'POST', body: JSON.stringify({ model: effectiveModel }) }); setConnection(r.message); } catch (err) { setConnection(errorText(err)); } finally { setChecking(false); } }}>{checking ? 'Checking…' : 'Test connection'}</button></div>{models.error && <p className="profile-help">{models.error}</p>}{connection && <p role="status" className="profile-info">{connection}</p>}{credentialNote}</>}
        {tab === 'prompt' && <><div className="profile-section-heading"><h3>Tell your agent what good work looks like.</h3><p>Describe its job, style, and priorities in your own words.</p></div><Toggle label="Use custom instructions" description="Turn off to use Hermes’s operating instructions alone. Your text will be kept." checked={draft.prompt.enabled} onChange={enabled => edit({ prompt: { ...draft.prompt, enabled } })} /><label>System prompt / agent instructions<textarea className="profile-prompt" rows={15} maxLength={12000} disabled={!draft.prompt.enabled} value={draft.prompt.text} onChange={e => edit({ prompt: { ...draft.prompt, text: e.target.value } })} placeholder="You are a careful research partner. Cite your sources, distinguish evidence from inference, and save useful deliverables…" /></label><div className="profile-actions"><span className="profile-help">{draft.prompt.text.length.toLocaleString()} / 12,000 characters</span><button type="button" className="subtle-button" onClick={() => edit({ prompt: { ...draft.prompt, text: initialWorkspace.agents.find(a => a.id === agent.id)?.instructions || 'Take ownership of the requested outcome. Use your available tools, communicate clearly, and save useful deliverables.' } })}>Restore starter instructions</button></div><p className="profile-info">These instructions shape identity and behavior. Hermes keeps its operating instructions and execution guards. Existing memories and skills are preserved.</p></>}
        {tab === 'tools' && <><div className="profile-section-heading"><h3>Give this agent the right tools.</h3><p>Expand a group to choose individual tools. New tools start switched off.</p></div><div className="profile-tool-toolbar"><label className="profile-search"><Search size={15} /><input aria-label="Search tools" value={search} onChange={e => setSearch(e.target.value)} placeholder="Search tools…" /></label><button type="button" className="subtle-button" onClick={() => edit({ allowedTools: [] })}>Disable all tools</button><button type="button" className="subtle-button" disabled={catalogBusy} onClick={() => void refreshTools()} aria-label="Refresh tools"><RefreshCw size={15} /></button></div>{catalog.error && <p className="profile-info">{catalog.error} {draft.revision === 0 ? 'Save this new agent first, then refresh its tools.' : 'Saved choices are preserved.'}</p>}{catalog.source === 'mock' && <p className="profile-help">Deterministic test runtime — tool availability is simulated.</p>}{TOOL_GROUPS.map(([id, title, description]) => {
          const members = tools.filter(t => (TOOL_GROUPS.some(g => g[0] === t.group) ? t.group : 'other') === id);
          const filtered = members.filter(t => `${t.name} ${t.id} ${t.description} ${title}`.toLowerCase().includes(search.toLowerCase()));
          if (search && !filtered.length) return null;
          const enabled = members.filter(t => draft.allowedTools.includes(t.id)).length;
          return <details key={id} className="profile-tool-group" open={search ? true : undefined}><summary><ChevronDown size={15} /><span><strong>{title}</strong><small>{enabled} / {members.length} enabled</small></span><span className="profile-group-toggle" onClick={e => e.stopPropagation()}><input type="checkbox" aria-label={`Enable ${title}`} aria-checked={enabled > 0 && enabled < members.length ? 'mixed' : enabled > 0} checked={members.length > 0 && enabled === members.length} disabled={!members.length || (id === 'desktop' && draft.computer.desktop === 'none')} onChange={e => toggleTools(members.map(t => t.id), e.target.checked)} /><span aria-hidden="true" /></span></summary><p className="profile-help">{id === 'desktop' && draft.computer.desktop === 'none' ? 'Choose a desktop in Computer settings to enable this tool.' : description}</p>{filtered.map(tool => <Toggle key={tool.id} label={tool.name} description={`${tool.description.slice(0,180)} · ${id === 'desktop' && draft.computer.desktop === 'none' ? 'Choose a desktop first' : tool.available ? 'Available now' : tool.reason || 'Unavailable'}`} checked={draft.allowedTools.includes(tool.id)} disabled={id === 'desktop' && draft.computer.desktop === 'none'} onChange={on => toggleTools([tool.id], on)} />)}{!members.length && <p className="profile-help">No tools discovered for this group.</p>}</details>;
        })}<p className="profile-info">These switches control Hermes tools. Enabled Terminal can still read workspace files or make network requests. Container isolation remains the filesystem boundary.</p>{advancedFeatures && <><div className="profile-section-heading"><h3><FolderKanban size={18} /> Task board</h3><p>What this agent may do on shared projects. It may always work its own and unassigned cards.</p></div><Toggle label="Change other agents’ cards" description="Otherwise it can only touch unassigned cards and its own." checked={draft.board.assignOthers} onChange={assignOthers => edit({ board: { ...draft.board, assignOthers } })} /><Toggle label="Start other agents’ tasks" description="Still respects each project’s agent-dispatch setting." checked={draft.board.dispatch} onChange={dispatch => edit({ board: { ...draft.board, dispatch } })} /><Toggle label="Create and change projects" description="Name, description, colour, and default owner. It can never delete a project, archive one, or change its automation." checked={draft.board.manageProjects} onChange={manageProjects => edit({ board: { ...draft.board, manageProjects } })} /><div className="profile-section-heading"><h3><Cable size={18} /> MCP connections</h3><p>Test the connection to discover its tools, then enable the ones this agent needs.</p></div>{draft.connectors.map((c, index) => {
          const change = (patch: Partial<typeof c>) => { setConnectorChecks(current => ({ ...current, [c.id]: '' })); edit({ connectors: draft.connectors.map((other, i) => i === index ? { ...other, ...patch } : other) }); };
          return <div className="profile-connector" key={c.id}><Toggle label={c.name || 'New connection'} description="Connection changes apply to the next task." checked={c.enabled} onChange={enabled => change({ enabled })} /><div className="profile-two-columns"><label>Connection name<input value={c.name} onChange={e => change({ name: e.target.value })} placeholder="my-research-tools" /></label><label>Executable<input value={c.command} onChange={e => change({ command: e.target.value })} placeholder="npx" /></label></div><label>Arguments — one per line<textarea rows={3} value={c.args.join('\n')} onChange={e => change({ args: e.target.value.split('\n') })} placeholder={'-y\n@vendor/mcp-server'} /></label><label>Required saved credential<select value={c.secretRef} onChange={e => chooseCredential(e.target.value, secretRef => change({ secretRef }))}><option value="">None</option>{credentialOptions('', c.secretRef)}</select></label><div className="profile-actions"><button type="button" className="subtle-button" disabled={connectorChecks[c.id] === 'Checking…'} onClick={async () => { setConnectorChecks(current => ({ ...current, [c.id]: 'Checking…' })); try { const r = await client.request<{ status: string; error?: string; tools: ToolInfo[] }>(`${base}/connector-check`, { method: 'POST', body: JSON.stringify({ connector: c }) }); setConnectorChecks(current => ({ ...current, [c.id]: r.error || `${r.status} · ${r.tools.length} tools discovered` })); if (r.status === 'connected') setCatalog(old => ({ ...old, tools: [...old.tools.filter(t => !t.id.startsWith(`mcp_${c.name}_`)), ...r.tools] })); } catch (err) { setConnectorChecks(current => ({ ...current, [c.id]: errorText(err) })); } }}>Test connection</button><button type="button" className="subtle-button" onClick={() => edit({ connectors: draft.connectors.filter((_, i) => i !== index), allowedTools: draft.allowedTools.filter(id => !id.startsWith(`mcp_${c.name}_`)) })}><Trash2 size={13} /> Remove</button></div><p role="status" className="profile-help">{connectorChecks[c.id] || 'Not checked. Executable availability alone does not prove a connection.'}</p></div>;
        })}<button type="button" className="subtle-button" onClick={() => edit({ connectors: [...draft.connectors, { id: crypto.randomUUID(), name: '', command: '', args: [], secretRef: '', enabled: true }] })}><Plus size={14} /> Add MCP connection</button></>}{credentialNote}</>}
      </div>
      <footer className="profile-footer" inert={discard}><div className="profile-save-status" aria-live="polite">{error ? <div><p role="alert" className="profile-error">{error}</p>{error.includes('changed elsewhere') && <button type="button" className="subtle-button" onClick={async () => { try { const saved = await client.request<ProfileResponse>(`${base}/profile`); setDraft(saved.profile); setBaseline(serialize(saved.profile)); setError(''); } catch (err) { setError(errorText(err)); } }}>Replace draft with saved version</button>}</div> : success ? <p className="profile-success"><Check size={14} />{success}</p> : <p>{legacyComputer ? 'Computer settings must change before this agent can be saved.' : dirty ? 'Unsaved changes' : draft.revision ? `All changes saved · Revision ${draft.revision}` : 'New agent — not saved yet'}</p>}</div><div className="profile-footer-actions"><button type="button" className="subtle-button" disabled={saving} onClick={close}>Cancel</button><button type="button" className="light-button" disabled={saving || loading || legacyComputer || (!dirty && draft.revision > 0)} onClick={() => void save()}>{saving ? <LoaderCircle size={15} /> : <Check size={15} />}{saving ? 'Saving…' : 'Save changes'}</button></div></footer>
      {discard && <div className="profile-discard" role="alertdialog" aria-labelledby="discard-title"><h3 id="discard-title">Discard unsaved changes?</h3><p>Your saved profile will stay as it is.</p><div className="profile-actions"><button type="button" className="subtle-button" onClick={() => setDiscard(false)}>Keep editing</button><button type="button" className="light-button" onClick={onClose}>Discard changes</button></div></div>}
    </section>
  </div>;
}
