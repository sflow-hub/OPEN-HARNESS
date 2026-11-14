'use client';
import { useCallback, useEffect, useState } from 'react';
import { KeyRound, X } from 'lucide-react';
import type { ControlClient } from '../lib/control-client';
import type { CredentialRecord } from '../lib/credentials';

type Settings = { enabled: boolean; credentialRef: string; origin: string; model: string; dailyLimit: number };
type Status = { settings: Settings; revision: number; usedToday: number; sends: string };
type Entry = { id: string; createdAt: string; caller: string; agentId: string | null; op: string; outcome: string; result: unknown; redacted: boolean };
// The coordinator accepts only keys it sends as `Authorization: Bearer`.
const KEY_TYPES = ['bearer', 'model-api-key'];
const OUTCOMES: Record<string, string> = { decided: 'Decided', undecided: 'Not confident, left to a person', failed: 'Failed', pending: 'In progress' };
const summary = (result: unknown) => Array.isArray(result) ? result.join(', ') : typeof result === 'boolean' ? (result ? 'yes' : 'no') : result && typeof result === 'object' ? Object.entries(result).map(([id, value]) => `${id}: ${value}`).join(', ') : '';

// Its own dialog with its own save, so Workspace settings' draft is never mixed with this one.
export default function DecisionSettings({ client, credentials, onClose, onManageCredentials }: {
  client: ControlClient; credentials: CredentialRecord[]; onClose: () => void; onManageCredentials: () => void;
}) {
  const [status, setStatus] = useState<Status | null>(null), [draft, setDraft] = useState<Settings | null>(null), [log, setLog] = useState<Entry[]>([]);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [message, setMessage] = useState(''), [confirmClose, setConfirmClose] = useState(false);
  const load = useCallback(async () => {
    const [next, recent] = await Promise.all([client.request<Status>('/v1/decisions/settings'), client.request<{ decisions: Entry[] }>('/v1/decisions?limit=10')]);
    setStatus(next); setDraft(next.settings); setLog(recent.decisions);
  }, [client]);
  useEffect(() => { let cancelled = false; void Promise.resolve().then(load).catch(cause => { if (!cancelled) setError(cause instanceof Error ? cause.message : 'Could not load decision settings.'); }); return () => { cancelled = true; }; }, [load]);
  const dirty = Boolean(status && draft && JSON.stringify(draft) !== JSON.stringify(status.settings));
  const keys = credentials.filter(item => KEY_TYPES.includes(item.type));
  const set = (patch: Partial<Settings>) => setDraft(current => current && { ...current, ...patch });
  const close = () => { if (busy) return; if (dirty) setConfirmClose(true); else onClose(); };
  async function save() {
    if (!draft || !status) return;
    setBusy(true); setError(''); setMessage('');
    try { const next = await client.request<Status>('/v1/decisions/settings', { method: 'PUT', body: JSON.stringify({ settings: draft, revision: status.revision }) }); setStatus(next); setDraft(next.settings); setMessage(next.settings.enabled ? 'Saved. Decisions are on.' : 'Saved. Decisions are off.'); }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not save decision settings. Your changes are still here.'); }
    finally { setBusy(false); }
  }
  async function reload() {
    setBusy(true); setError(''); setMessage('');
    try { await load(); } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not load decision settings.'); } finally { setBusy(false); }
  }
  return <div className="modal-backdrop credential-backdrop" onClick={close}>
    <section className="modal credential-modal decision-modal" role="dialog" aria-modal aria-label="Decisions" onClick={event => event.stopPropagation()}>
      <header className="modal-heading"><div><div className="eyebrow">ADVISORY DECISIONS</div><h2>Decisions</h2></div><button aria-label="Close decisions" onClick={close}><X size={19} /></button></header>
      <p className="profile-help">A decision model chooses, ranks, labels, scores or checks, and answers with IDs and confidence. Its answers are advice: they never start work, change cards or answer approvals. Each agent also needs <strong>Decisions</strong> turned on in its settings under Tools → Workspace access.</p>
      {status && <div className="decision-disclosure" role="note"><strong>What is sent</strong><p className="muted small">{status.sends}</p></div>}
      {confirmClose && <div role="alertdialog" aria-label="Discard decision changes" className="profile-discard"><h3>Discard your changes?</h3><p>Your saved decision settings will stay as they are.</p><div className="task-discard-actions"><button type="button" autoFocus onClick={() => setConfirmClose(false)}>Keep editing</button><button type="button" className="task-primary" onClick={onClose}>Discard changes</button></div></div>}
      {error && <div className="profile-error" role="alert">{error}{/changed elsewhere/.test(error) && <> <button type="button" className="subtle-button" onClick={() => void reload()}>Reload saved settings</button></>}</div>}
      {message && <p role="status">{message}</p>}
      {!draft ? !error && <p>Loading decision settings…</p> : <>
        <label className="settings-feature-toggle"><input type="checkbox" checked={draft.enabled} disabled={busy} onChange={event => set({ enabled: event.target.checked })} /><span><strong>Turn on decisions</strong><small>Nothing is sent until a key is chosen and this is on.</small></span></label>
        <fieldset disabled={busy}>
          <label>Decision service key<select value={draft.credentialRef} onChange={event => set({ credentialRef: event.target.value })}>
            <option value="">Choose a saved credential</option>
            {keys.map(item => <option key={item.ref} value={item.ref}>{item.label}{item.present ? '' : ' (no saved value)'}</option>)}
            {draft.credentialRef && !keys.some(item => item.ref === draft.credentialRef) && <option value={draft.credentialRef}>{draft.credentialRef} (unavailable)</option>}
          </select><small>Save the TypeSafe API key as a Bearer token credential.</small></label>
          <div className="button-row"><button type="button" className="subtle-button" onClick={onManageCredentials}><KeyRound size={14} /> Saved credentials</button></div>
          <label>Service address<input value={draft.origin} inputMode="url" onChange={event => set({ origin: event.target.value })} /></label>
          <label>Model<input value={draft.model} onChange={event => set({ model: event.target.value })} /></label>
          <label>Daily request limit<input type="number" min={1} max={100000} value={draft.dailyLimit} onChange={event => set({ dailyLimit: Number(event.target.value) })} /><small>{status && `Used today: ${status.usedToday} of ${status.settings.dailyLimit} requests. Each agent run may also make at most 30 decisions.`}</small></label>
        </fieldset>
        <div className="settings-divider" />
        <h3>Recent decisions</h3>
        {!log.length ? <p className="muted small">No decisions yet.</p> : <ul className="decision-log" aria-label="Recent decisions">{log.map(entry => <li key={entry.id}>
          <span>{new Date(entry.createdAt).toLocaleString()}</span><span>{entry.caller === 'agent' ? entry.agentId : 'You'}</span><span>{entry.op}</span><span>{OUTCOMES[entry.outcome] || entry.outcome}</span>
          {summary(entry.result) && <span>{summary(entry.result)}</span>}{entry.redacted && <span>Secret text removed before sending</span>}
        </li>)}</ul>}
        <p className="muted small">This log keeps IDs and outcomes only, never the text that was sent.</p>
      </>}
      <div className="modal-footer"><button type="button" className="light-button" disabled={!dirty || busy} onClick={() => void save()}>{busy ? 'Saving…' : 'Save decision settings'}</button></div>
    </section>
  </div>;
}
