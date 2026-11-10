'use client';
import { useEffect, useState } from 'react';
import type { ControlClient } from '../lib/control-client';
import type { AttentionPreference } from '../lib/attention-preferences';

// Only completion pushes can be silenced; approvals, questions and failures always notify.
export default function AssistantAttention({ client, writable }: { client: ControlClient; writable: boolean }) {
  const [saved, setSaved] = useState<AttentionPreference | null>(null), [draft, setDraft] = useState<boolean | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  useEffect(() => { let live = true; client.request<AttentionPreference>('/v1/assistant/preferences').then(value => { if (live) setSaved(value); }).catch(() => {}); return () => { live = false; }; }, [client]);
  if (!saved) return null;
  const value = draft ?? saved.completionNotifications;
  const save = async (next: boolean) => { setDraft(next); setBusy(true); setError(''); try { setSaved(await client.request<AttentionPreference>('/v1/assistant/preferences', { method: 'PATCH', body: JSON.stringify({ revision: saved.revision, completionNotifications: next }) })); setDraft(null); } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not save this preference.'); } finally { setBusy(false); } };
  return <div className="assistant-attention">
    <label className="connection-choice"><input type="checkbox" checked={value} disabled={busy || !writable} onChange={event => void save(event.target.checked)} />Notify me when tasks finish</label>
    <small>Approvals, questions and failures always notify you. Finished results stay in this inbox either way.</small>
    {error && <p role="alert" className="task-error">{error} <button onClick={() => void client.request<AttentionPreference>('/v1/assistant/preferences').then(next => { setSaved(next); setDraft(null); setError(''); })}>Reload preference</button></p>}
  </div>;
}
