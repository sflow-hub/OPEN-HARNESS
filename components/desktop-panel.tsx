"use client";

import { useCallback, useEffect, useRef, useState } from 'react';
import { Monitor, SquareTerminal, X } from 'lucide-react';
import { ControlRequestError, type ControlClient, type DesktopInputAction, type DesktopStatus } from '../lib/control-client';
import './desktop-panel.css';
import DesktopStream from './desktop-stream';
import DesktopInputSurface from './desktop-input-surface';
import WorkspaceTerminal from './workspace-terminal';
import type { WorkflowDraft } from '../lib/product';

type Frame = { image: string; width: number; height: number; mock?: boolean };
type View = 'desktop' | 'terminal';
const time = (value?: string) => { if (!value) return ''; const date = new Date(value); return Number.isNaN(date.getTime()) ? '' : date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); };
const machineStatus = (status?: string) => ({ online: 'online', offline: 'offline', revoked: 'removed', pairing: 'pairing' } as Record<string, string>)[status || ''] || status || 'unknown';

// One control lease covers the desktop and the human terminal of this agent's private workspace.
// Taking control stops the agent's work and its running commands; the managed browser stays.
export function DesktopPanel({ agentId, agentName, client, onClose, onWorkflowCreated, initialView = 'desktop' }: { agentId: string; agentName?: string; client: ControlClient; onClose(): void; onWorkflowCreated?(id: string): void; initialView?: View }) {
  const [status, setStatus] = useState<DesktopStatus | null>(null), [frame, setFrame] = useState<Frame | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [frameError, setFrameError] = useState(''), [watching, setWatching] = useState(false);
  const [text, setText] = useState(''), [draft, setDraft] = useState(''), [workflowName, setWorkflowName] = useState('Recorded workflow'), [saved, setSaved] = useState(false);
  const [durableDraft, setDurableDraft] = useState<WorkflowDraft | null>(null);
  const [teamId, setTeamId] = useState(''), [consent, setConsent] = useState(false), [notice, setNotice] = useState('');
  const [streaming, setStreaming] = useState(false), [view, setView] = useState<View>(initialView), [confirming, setConfirming] = useState(false), [handoff, setHandoff] = useState(''), [pending, setPending] = useState('');
  const [terminalLease,setTerminalLease]=useState('');
  const fallback = useCallback(() => setStreaming(false), []);
  const working = useRef(false), mutationPending = useRef(false), framePending = useRef<Promise<void> | null>(null), inputChain = useRef<Promise<unknown>>(Promise.resolve()), inputLease = useRef('');
  const name = agentName || 'This agent';
  const endpoint = useCallback((action: string) => client.desktopEndpoint(agentId, action), [agentId, client]);
  const apply = useCallback((next: DesktopStatus) => { setStatus(next); return next; }, []);
  const reload = useCallback(async () => apply(await client.desktopStatus(agentId)), [agentId, apply, client]);
  useEffect(() => { let mounted = true; client.desktopStatus(agentId).then(value => { if (mounted) { apply(value); setTeamId(value.browserSessionTeamId);setWatching(!value.readOnly && value.controlled); const loaded = (value as DesktopStatus & { draft?: WorkflowDraft | null }).draft; if (loaded) { setDurableDraft(loaded); setDraft(loaded.instructions); setWorkflowName(loaded.title); } } }).catch(value => { if (mounted) setError(value instanceof Error ? value.message : 'Could not open desktop status.'); }); return () => { mounted = false; }; }, [agentId, apply, client]);
  // Ownership can change elsewhere (another member, the runner, a revoke); keep the header true.
  useEffect(() => {
    const timer = setInterval(() => { if (!mutationPending.current && document.visibilityState === 'visible') void reload().catch(() => {}); }, 4000);
    return () => clearInterval(timer);
  }, [reload]);
  useEffect(() => {
    if (!watching || !status?.available || status.readOnly || streaming) return;
    let cancelled = false, timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      if (!working.current && !mutationPending.current && document.visibilityState === 'visible') {
        working.current = true;
        const task = (async () => {
          try { const value = await client.request<Frame>(endpoint('frame')); if (!cancelled) { setFrame(value); setFrameError(''); } }
          catch (value) { if (!cancelled) setFrameError(value instanceof Error ? value.message : 'Could not refresh the desktop.'); }
          finally { working.current = false; }
        })();
        framePending.current = task;
        await task;
        if (framePending.current === task) framePending.current = null;
      }
      if (!cancelled) timer = setTimeout(tick, 1500);
    };
    void tick();
    return () => { cancelled = true; clearTimeout(timer); };
  }, [watching, status?.available, status?.readOnly, client, endpoint, streaming]);
  const mutate = async (action: string, input: Record<string, unknown> = {}) => {
    if (mutationPending.current || status?.readOnly) return null;
    mutationPending.current = true; setBusy(true); setError(''); setNotice(''); setPending(action);
    inputLease.current = ''; await inputChain.current;
    await framePending.current;
    working.current = true;
    try {
      const value = await client.request<Record<string, unknown>>(endpoint(action), { method: 'POST', body: JSON.stringify({ leaseId: status?.leaseId, ...input }) });
      if (action === 'record-stop') { setDraft(String(value.draft || '')); setSaved(false); if (value.draftId) setDurableDraft(await client.request<WorkflowDraft>(`/v1/workflow-drafts/${value.draftId}`)); }
      if (action === 'take-control') { setWatching(true); setConfirming(false); const next = value as unknown as DesktopStatus; setHandoff(next.browserSessionPreserved === true ? 'The browser and its open pages are as the agent left them.' : next.browserSessionPreserved === false ? 'A desktop browser session was started. Inspect the current page before continuing.' : 'Browser session continuity has not been confirmed. Inspect the current page.'); }
      if (action === 'release') { setWatching(false); setFrame(null); setText(''); setHandoff('');setTerminalLease('');const cleanup=value.shellJobsStopped===true?' Commands you left running were stopped.':' Command cleanup was not reported by this runner.';setNotice((input.continueWork ? `Handed back. ${name} starts a new follow-up task from the current screen.` : 'Handed back without starting a follow-up task. Queued or scheduled tasks can run.')+cleanup); }
      const refreshed=await reload();if(action==='configure-sharing')setTeamId(refreshed.browserSessionTeamId);
      return value;
    } catch (value) { setError(value instanceof Error ? value.message : 'The desktop request failed.'); await reload().catch(() => {}); return null; }
    finally { working.current = false; mutationPending.current = false; setBusy(false); setPending(''); }
  };
  const youControl = Boolean(status?.controlled && !status.readOnly && status.youControl !== false), canInput = Boolean(youControl && status?.ready && (!status.machine || status.machine.status === 'online') && !busy);
  const activeLease = canInput ? status!.leaseId : '';
  const chooseView=(next:View)=>{if(view==='terminal')setTerminalLease(status?.leaseId||'');setView(next);};
  useEffect(() => { inputLease.current = activeLease; }, [activeLease]);
  // Pointer and keyboard input is sent one request at a time, in order, under the current lease.
  // Nothing is queued past a lost lease: the first refusal stops input until control is retaken.
  const send = useCallback((input: DesktopInputAction) => {
    const leaseId = inputLease.current; if (!leaseId) return Promise.resolve(null);
    const next = inputChain.current.then(async () => {
      if (inputLease.current !== leaseId) return null;
      try { return await client.desktopInput(agentId, leaseId, input); }
      catch (cause) {
        inputLease.current = '';
        setError(cause instanceof ControlRequestError && [403, 409].includes(cause.status) ? 'Your control ended, so that input was not sent. Take control again to continue.' : cause instanceof Error ? cause.message : 'The desktop did not accept that input.');
        void reload().catch(() => {});
        return null;
      }
    });
    inputChain.current = next.catch(() => null);
    return next;
  }, [agentId, client, reload]);
  const saveWorkflow = async () => {
    setBusy(true); setError('');
    try { const value = durableDraft ? await client.request<WorkflowDraft>(`/v1/workflow-drafts/${durableDraft.id}`, { method: 'PATCH', body: JSON.stringify({ ...durableDraft, title: workflowName, instructions: draft }) }) : await client.request<WorkflowDraft>('/v1/workflow-drafts', { method: 'POST', body: JSON.stringify({ agentId, title: workflowName, instructions: draft }) }); setDurableDraft(value); const workflow = await client.request<{ workflowId: string }>(`/v1/workflow-drafts/${value.id}/promote`, { method: 'POST', body: JSON.stringify({ revision: value.revision }) }); setSaved(true); setNotice('Workflow draft saved. Review its success criteria and run a supervised test in Routines.'); onWorkflowCreated?.(workflow.workflowId); }
    catch (value) { setError(value instanceof Error ? value.message : 'Could not save this workflow. Your draft is still here.'); }
    finally { setBusy(false); }
  };
  const machine = status?.machine, online = !machine || machine.status === 'online';
  const state = pending === 'take-control' ? 'taking-control' : pending === 'release' ? 'handing-back' : status ? status.ownershipState || (status.controlled ? (status.ready ? 'human' : 'blocked') : 'agent') : 'agent';
  // A teammate agent sharing this browser holds it as a peer: controlled, but not by a person.
  const peer = Boolean(status?.controlled && status.controllerAgentId && status.controllerAgentId !== agentId);
  const controller = status?.controlled ? (youControl ? 'You' : status.controllerName || (peer ? 'A teammate agent' : 'Another workspace member')) : name;
  const paired = Boolean(machine && !(machine.local ?? machine.id === 'local'));
  // A paired runner reports what it supports; an older one cannot open the workspace terminal.
  const computerUpgrade = paired && !machine!.capabilities?.features?.includes('continuous-computer') ? `Update the Open Harness runner on ${machine!.name} to use continuous desktop control.` : '';
  const terminalUpgrade = computerUpgrade || (paired && !machine!.capabilities?.features?.includes('terminal-pty') ? `Update the Open Harness runner on ${machine!.name} to use the workspace terminal.` : '');
  const since = time(status?.inControlSince);
  const ownershipText = !status ? '' : state === 'taking-control' ? `Taking control… stopping ${name}’s work and any running commands.`
    : state === 'handing-back' ? 'Handing back… stopping commands you left running.'
    : state === 'blocked' ? 'Control is blocked: startup or cleanup did not finish. Release control, then take control again.'
    : peer ? `${controller} is using this shared browser. You can watch; take control after it finishes.`
    : status.controlled ? youControl ? `You are in control${since ? ` since ${since}` : ''}. ${name} stays stopped until you hand back, even if you close this panel.` : `${controller} is in control${since ? ` since ${since}` : ''}. You can watch; only they can send input.`
    : `${name} is in control. Watch it work, or take control for sign-in, 2FA, a demonstration or your own commands.`;
  const takeControl = <>{!confirming ? <button className="light-button" disabled={busy || !online || Boolean(computerUpgrade)} onClick={() => setConfirming(true)}>Take control</button>
    : <div className="desktop-confirm" role="group" aria-label="Confirm taking control">
      <p>This stops {name}’s current work and any commands running in its workspace. The browser and its open pages stay as they are.</p>
      <button className="light-button" disabled={busy} onClick={() => void mutate('take-control', { confirm: true })}>Stop agent work and take control</button>
      <button disabled={busy} onClick={() => setConfirming(false)}>Cancel</button>
    </div>}</>;
  const handBack = youControl ? <>
    <button className="light-button" disabled={busy || status!.recording || status!.canRelease === false || !status!.canContinue} onClick={() => void mutate('release', { continueWork: true })}>Hand back and continue</button>
    <button disabled={busy || status!.recording || status!.canRelease === false} onClick={() => void mutate('release')}>Hand back, don’t continue</button>
    {!status!.canContinue && <small>There is no stopped task to continue. Hand back, then start a task when you are ready.</small>}
    {status!.recording && <small>Finish the demonstration before handing back.</small>}
  </> : status?.controlled && status.canRelease ? <button disabled={busy || status.recording} onClick={() => void mutate('release')}>Release {controller}’s control</button> : null;
  return <div className="modal-backdrop desktop-panel-backdrop"><section className="modal desktop-panel" role="dialog" aria-modal="true" aria-labelledby="desktop-panel-title">
    <div className="modal-heading"><h2 id="desktop-panel-title"><Monitor size={18} /> {agentName ? `${agentName}’s computer` : 'Agent computer'}</h2><button aria-label="Close computer panel" onClick={onClose}><X size={18} /></button></div>
    {status?.available && <div className="desktop-header" aria-label="Computer status">
      <span><strong>{machine?.name || 'Assigned computer'}</strong>{machine ? ` · ${(machine.local ?? machine.id === 'local') ? 'this computer' : 'paired computer'} · ${machineStatus(machine.status)}` : ''} · private agent workspace</span>
      <span className={`desktop-owner ${state}`} data-testid="computer-controller">Control: {controller}</span>
    </div>}
    {error && <p className="task-error" role="alert">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    {!status ? <p>Loading computer…</p> : status.readOnly ? <>
      <p role="status">Read-only access. You can see computer ownership and agent activity. Screen controls and the controller’s terminal are private.</p>
      <p>{name} {status.agentActive ? 'has active work.' : 'has no active work.'}</p>
      {status.controlled && <p>{controller} is in control{since ? ` since ${since}` : ''}.</p>}
      {['taking-control','handing-back','blocked'].includes(state) && <p role="status">{state === 'blocked' ? 'Computer control is blocked until recovery completes.' : state === 'taking-control' ? 'The computer is stopping agent work before human control.' : 'The computer is stopping human commands before handback.'}</p>}
      {!status.available && <p>This agent has no private desktop enabled.</p>}
    </> : !status.available ? <p>Enable Private agent desktop in Agent settings → Computer to watch work, take control for sign-in, or open a workspace terminal.</p> : <>
      {!online && <p role="alert" className="task-error">Waiting for {machine?.name || 'the assigned computer'} to reconnect. The desktop and terminal are unavailable until it is back; nothing you do here is queued.</p>}
      {computerUpgrade && <p role="status">{computerUpgrade}</p>}
      <p role="status" className="desktop-ownership">{ownershipText}</p>
      {youControl && status.ready && <p className="desktop-handoff">{handoff || (status.browserSessionPreserved === true ? 'The browser and its open pages are as the agent left them.' : 'Inspect the current browser page before continuing.')}{status.shellJobsStopped ? ' Commands that were running in the workspace were stopped.' : ''}</p>}
      {status.revocation?.state === 'pending' && <p role="status" className="desktop-revocation">Revocation pending. Terminal permission for {name} was removed. Waiting for {machine?.name || 'its computer'} to confirm that its commands have stopped.</p>}
      <div className="desktop-actions">{!status.controlled ? takeControl : handBack}</div>
      <div className="desktop-tabs" role="tablist" aria-label="Computer views" onKeyDown={event=>{if(['ArrowLeft','ArrowRight','Home','End'].includes(event.key)){event.preventDefault();const next=event.key==='Home'?'desktop':event.key==='End'?'terminal':view==='desktop'?'terminal':'desktop';chooseView(next);event.currentTarget.querySelector<HTMLButtonElement>(`#computer-tab-${next}`)?.focus();}}}>
        <button role="tab" id="computer-tab-desktop" aria-controls="computer-view" aria-selected={view === 'desktop'} tabIndex={view==='desktop'?0:-1} onClick={() => chooseView('desktop')}><Monitor size={15} /> Desktop</button>
        <button role="tab" id="computer-tab-terminal" aria-controls="computer-view" aria-selected={view === 'terminal'} tabIndex={view==='terminal'?0:-1} onClick={() => chooseView('terminal')}><SquareTerminal size={15} /> Terminal</button>
      </div>
      <div id="computer-view" role="tabpanel" aria-labelledby={`computer-tab-${view}`}>
      <div className="desktop-terminal-view" style={{display:view==='terminal'?undefined:'none'}}>
        {!terminalUpgrade && youControl && status.ready && status.terminal?.ready !== false
          ? <><p><small>This shell runs inside {name}’s private workspace on {machine?.name || 'its computer'}, not on your computer. It is for you only and does not give {name} terminal access. Harness does not record what you type or the terminal’s output. Commands still running when you hand back are stopped.</small></p>
            {(view==='terminal'||terminalLease===status.leaseId)&&<WorkspaceTerminal client={client} agentId={agentId} leaseId={status.leaseId} machineName={machine?.name || 'its computer'} />}</>
          : terminalUpgrade ? <p role="status">{terminalUpgrade}</p>
          : peer ? <p>{controller} is using the shared browser. The workspace terminal opens only for the person in control.</p>
          : status.controlled && !youControl ? <p>{controller} is using this workspace. Only the person in control can open or see its terminal.</p>
          : youControl ? <p role="status">{status.terminal?.reason || 'The workspace terminal is not ready yet.'}</p>
          : <p>Take control to open your own terminal in {name}’s private workspace. Its output is shown only to the person in control.</p>}
      </div><div style={{display:view==='desktop'?undefined:'none'}}>
      <div className="desktop-watch-actions">
        <button onClick={() => setWatching(value => !value)}>{watching ? 'Stop watching' : 'Watch desktop'}</button>
        {watching && <button onClick={() => { setFrameError(''); setStreaming(value => !value); }}>{streaming ? 'Use image preview' : 'Use live desktop'}</button>}
      </div>
      {watching && streaming && <DesktopStream client={client} agentId={agentId} onFallback={fallback} overlay={<DesktopInputSurface enabled={canInput} onInput={input => void send(input)} label="Live private agent desktop" />} />}
      {watching && !streaming && <div className="desktop-screen">
        {frame ? <>{/* The image is returned over the authenticated JSON request; tokens never enter URLs. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img className="desktop-screen-media" src={frame.image} alt="Current private agent desktop" draggable={false} style={{ aspectRatio: `${frame.width} / ${frame.height}` }} />
          <DesktopInputSurface enabled={canInput} onInput={input => void send(input)} label="Private agent desktop input" />
          {frame.mock && <p className="desktop-mock-label">Test desktop preview</p>}
        </> : <p className="desktop-waiting">Waiting for the desktop image…</p>}
      </div>}
      {frameError && watching && !streaming && <p role="status">{frameError}</p>}
      {youControl && status.ready && <>
        <div className="desktop-key-row">
          {(['Tab', 'Shift+Tab', 'Enter', 'Escape', 'Backspace', 'Control+l', 'Control+a'] as const).map(key => <button key={key} disabled={busy} onClick={() => void send({ type: 'key', key })}>{key === 'Control+l' ? 'Address bar' : key === 'Control+a' ? 'Select all' : key}</button>)}
          <button disabled={busy} onClick={() => void send({ type: 'scroll', direction: 'up', amount: 3 })}>Scroll up</button><button disabled={busy} onClick={() => void send({ type: 'scroll', direction: 'down', amount: 3 })}>Scroll down</button>
        </div>
        <form className="desktop-text-form" onSubmit={event => { event.preventDefault(); void send({ type: 'text', text }).then(result => { if (result) setText(''); }); }}>
          <label>Text for the focused field<input type="password" autoComplete="off" aria-label="Text for desktop" value={text} maxLength={4000} onChange={event => setText(event.target.value)} /></label>
          <button disabled={busy || !text} type="submit">Type into desktop</button>
        </form>
        <p><small>Use this hidden field for passwords and sign-in codes. Typed text is excluded from recordings, and screen previews are live and not saved by Open Harness.</small></p>
        <button disabled={busy} onClick={() => void mutate(status.recording ? 'record-stop' : 'record-start')}>{status.recording ? `Finish demonstration (${status.steps} steps)` : 'Record demonstration'}</button>
        {status.recording && <p role="status">Recording clicks, navigation keys, and scrolling. Typed values, URLs, and screenshots are omitted. Finish to review the draft.</p>}
      </>}
      </div>
      </div>
      {draft && <section className="desktop-draft">
        <h3>Review the demonstrated workflow</h3><p>Describe the controls and expected results. Replace omitted values with safe parameters; never include passwords.</p>
        <label>Workflow name<input aria-label="Demonstration workflow name" value={workflowName} maxLength={80} onChange={event => { setWorkflowName(event.target.value); setSaved(false); }} /></label>
        <label>Draft instructions<textarea aria-label="Demonstration draft" value={draft} rows={12} onChange={event => { setDraft(event.target.value); setSaved(false); }} /></label>
        {status.controlled && <p>Hand back control before saving or testing this workflow.</p>}
        <div className="desktop-draft-actions"><button disabled={busy || saved || status.controlled || !workflowName.trim() || !draft.trim()} onClick={() => void saveWorkflow()}>{saved ? 'Workflow draft saved' : 'Save draft for review and testing'}</button>
          <button onClick={() => { setDraft(''); setSaved(false); }}>Discard draft</button></div>
      </section>}
      <details><summary>Share browser logins with teammates</summary>
        <p>Each opted-in teammate can use the same browser cookies and signed-in accounts. Only one agent or human can use the shared browser at a time. Other private files and model credentials stay separate.</p>
        {status.sharedWith.length > 0 && <p>Currently shared with {status.sharedWith.map(item => item.name).join(', ')}.</p>}
        <label>Browser sharing team<select aria-label="Browser sharing team" disabled={busy} value={teamId} onChange={event => { setTeamId(event.target.value); setConsent(false); }}><option value="">Private to this agent</option>{status.teams.map(team => <option key={team.id} value={team.id}>{team.name}</option>)}</select></label>
        {teamId && <label className="desktop-consent"><input type="checkbox" disabled={busy} checked={consent} onChange={event => setConsent(event.target.checked)} /> I allow opted-in members of this team to use the same browser logins.</label>}
        <p><small>Joining starts with the team browser profile. Existing private browser sessions are preserved. Leaving returns this agent to its private profile; shared account sessions remain available to teammates.</small></p>
        <button disabled={busy || status.controlled || teamId === status.browserSessionTeamId || Boolean(teamId && !consent)} onClick={() => void mutate('configure-sharing', { teamId, consent, revision: status.revision })}>Save browser sharing</button>
      </details>
    </>}
  </section></div>;
}
