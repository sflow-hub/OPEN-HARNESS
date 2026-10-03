"use client";

import { useEffect, useId, useState } from 'react';
import type { ControlClient } from '../lib/control-client';

export default function ModelPicker({ client, provider, credentialRef = '', baseUrl = '', apiKey = '', value, onChange, label = 'Model' }: {
  client: ControlClient; provider: string; credentialRef?: string; baseUrl?: string; apiKey?: string;
  value: string; onChange: (value: string) => void; label?: string;
}) {
  const id = useId();
  const [refresh, setRefresh] = useState(0);
  const source = JSON.stringify([provider, credentialRef, baseUrl, apiKey, refresh]);
  const [result, setResult] = useState<{ source: string; catalog: { models: string[]; error?: string } } | null>(null);
  const catalog = result?.source === source ? result.catalog : { models: [] };
  const busy = Boolean(provider || baseUrl) && result?.source !== source;
  useEffect(() => {
    let cancelled = false;
    if (!provider && !baseUrl) return;
    const timer = setTimeout(() => {
      const query = { provider, credentialRef, baseUrl };
      const result = apiKey
        ? client.request<{ models: string[]; error?: string }>('/v1/models', { method: 'POST', body: JSON.stringify({ ...query, value: apiKey }) })
        : client.request<{ models: string[]; error?: string }>(`/v1/models?${new URLSearchParams(query)}`);
      void result.then(value => { if (!cancelled) setResult({ source, catalog: value }); }, () => { if (!cancelled) setResult({ source, catalog: { models: [], error: 'Could not load models. Enter an exact model ID or try again.' } }); });
    }, 350);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [client, provider, credentialRef, baseUrl, apiKey, source]);
  return <div className="model-picker">
    <label>{label}<input aria-label={label} list={id} value={value} onChange={event => onChange(event.target.value)} placeholder="Choose a model or enter its exact ID" autoComplete="off" />
      <datalist id={id}>{catalog.models.map(model => <option key={model} value={model} />)}</datalist>
    </label>
    {catalog.models.length > 0 && <label>Available models<select aria-label="Available models" value={catalog.models.includes(value) ? value : ''} onChange={event => { if (event.target.value) onChange(event.target.value); }}><option value="">Choose a model…</option>{catalog.models.map(model => <option key={model} value={model}>{model}</option>)}</select></label>}
    <small role="status">{busy ? 'Loading models…' : catalog.error || (catalog.models.length ? `${catalog.models.length} models available. You can also enter any exact ID.` : 'Enter an exact model ID. A provider and key or endpoint can load available models.')}</small>
    <button type="button" className="subtle-button" disabled={busy} onClick={() => setRefresh(value => value + 1)}>Refresh model list</button>
  </div>;
}
