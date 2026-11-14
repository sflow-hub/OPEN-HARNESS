"use client";

import { useEffect, useState } from 'react';
import type { ControlClient } from '../lib/control-client';
import { CODEX_PROVIDER } from '../lib/codex';
import CodexSignIn from './codex-sign-in';

export default function ModelPicker({ client, provider, credentialRef = '', baseUrl = '', apiKey = '', value, onChange, onCredentialChange, label = 'Model' }: {
  client: ControlClient; provider: string; credentialRef?: string; baseUrl?: string; apiKey?: string;
  value: string; onChange: (value: string) => void; label?: string;
  onCredentialChange?: (ref: string) => void;
}) {
  const [search, setSearch] = useState('');
  const [custom, setCustom] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const source = JSON.stringify([provider, credentialRef, baseUrl, apiKey, refresh]);
  const [result, setResult] = useState<{ source: string; catalog: { models: string[]; modelNames?: Record<string, string>; error?: string } } | null>(null);
  const catalog = result?.source === source ? result.catalog : { models: [] };
  const busy = Boolean(provider || baseUrl) && result?.source !== source;
  useEffect(() => {
    let cancelled = false;
    if (!provider && !baseUrl) return;
    const timer = setTimeout(() => {
      const query = { provider, credentialRef, baseUrl };
      const result = apiKey
        ? client.request<{ models: string[]; modelNames?: Record<string, string>; error?: string }>('/v1/models', { method: 'POST', body: JSON.stringify({ ...query, value: apiKey }) })
        : client.request<{ models: string[]; modelNames?: Record<string, string>; error?: string }>(`/v1/models?${new URLSearchParams(query)}`);
      void result.then(value => { if (!cancelled) setResult({ source, catalog: value }); }, () => { if (!cancelled) setResult({ source, catalog: { models: [], error: 'Could not load models. Enter an exact model ID or try again.' } }); });
    }, 350);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [client, provider, credentialRef, baseUrl, apiKey, source]);
  const customMode = custom || Boolean(value && !catalog.models.includes(value));
  const choices = catalog.models.filter(model => model === value || model.toLowerCase().includes(search.toLowerCase()));
  return <div className="model-picker">
    {provider === CODEX_PROVIDER && onCredentialChange && <CodexSignIn client={client} credentialRef={credentialRef} onConnected={onCredentialChange} />}
    <label>Search models<input type="search" aria-label={`Search ${label.toLowerCase()}`} value={search} onChange={event => setSearch(event.target.value)} placeholder="Filter available models" /></label>
    <label>{label} choices<select aria-label="Available models" value={customMode ? '__custom' : value} onChange={event => {
      if (event.target.value === '__custom') setCustom(true);
      else { setCustom(false); onChange(event.target.value); }
    }}><option value="">Choose a model…</option>{choices.map(model => <option key={model} value={model}>{catalog.modelNames?.[model] || model}</option>)}<option value="__custom">Custom model ID…</option></select></label>
    {customMode && <label>{label}<input aria-label={label} value={value} onChange={event => onChange(event.target.value)} placeholder="Enter the exact model ID" autoComplete="off" /></label>}
    <small role="status">{busy ? 'Loading models…' : catalog.error || (catalog.models.length ? `${catalog.models.length} models available.` : 'No model list available. Choose Custom model ID to enter one.')}</small>
    <button type="button" className="subtle-button" disabled={busy} onClick={() => setRefresh(value => value + 1)}>Refresh model list</button>
  </div>;
}
