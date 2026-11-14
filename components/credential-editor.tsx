'use client';
import { useState } from 'react';
import type { ControlClient } from '../lib/control-client';
import { CREDENTIAL_LABEL_MAX, CREDENTIAL_PROVIDERS, type CredentialRecord } from '../lib/credentials';
import { CREDENTIAL_TYPES, credentialType, modelCredential, type CredentialType } from '../lib/credential-types';
import { CODEX_PROVIDER } from '../lib/codex';
import ModelPicker from './model-picker';

// ChatGPT (Codex) sign-ins have their own flow in the credential screen; this edits every other type.
export function CredentialEditor({ client, credential, provider = '', modelOnly = false, mode = 'edit', onSaved, onCancel }: {
  client: ControlClient; credential?: CredentialRecord; provider?: string; modelOnly?: boolean; mode?: 'edit' | 'rotate'; onSaved: (credential: CredentialRecord) => void; onCancel: () => void;
}) {
  const [label, setLabel] = useState(credential?.label || '');
  const [type, setType] = useState<CredentialType>(credential?.type || 'model-api-key');
  const [selectedProvider, setProvider] = useState(credential?.provider || (provider === CODEX_PROVIDER ? '' : provider));
  const [model, setModel] = useState(credential?.model || '');
  const [baseUrl, setBaseUrl] = useState(credential?.baseUrl || '');
  const [config, setConfig] = useState<Record<string, string>>(credential?.config || {});
  const [fields, setFields] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const definition = credentialType(type);
  async function save() {
    setBusy(true); setError('');
    try {
      const secretFields = Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== ''));
      const body = { label, type, provider: definition.modelCompatible ? selectedProvider : '', model: definition.modelCompatible ? model : '', baseUrl: definition.modelCompatible ? baseUrl : '', config, fields: secretFields };
      const saved = await client.request<CredentialRecord>(credential ? `/v1/credentials/${encodeURIComponent(credential.ref)}` : '/v1/credentials', { method: credential ? 'PUT' : 'POST', body: JSON.stringify(body) });
      setFields({}); onSaved(saved);
    } catch (cause) { setError(cause instanceof Error ? cause.message : 'Could not save this credential.'); }
    finally { setBusy(false); }
  }
  return <div className="credential-editor profile-advanced">
    <strong>{credential ? `${mode === 'rotate' ? 'Replace secrets for' : 'Edit'} ${credential.label}` : 'Add a credential'}</strong>
    <fieldset disabled={busy}>
      {mode !== 'rotate' && <><label>Name<input aria-label="Name" value={label} maxLength={CREDENTIAL_LABEL_MAX} onChange={event => setLabel(event.target.value)} placeholder="Work OpenAI account" /></label>
        <label>Credential type<select value={type} disabled={Boolean(credential)} onChange={event => { const type = event.target.value as CredentialType; setType(type); setConfig({}); setFields({}); }}>{CREDENTIAL_TYPES.filter(item => !modelOnly || item.modelCompatible).map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
        {definition.modelCompatible && <label>Provider<select aria-label="Provider" value={selectedProvider} onChange={event => { setProvider(event.target.value); setModel(''); setBaseUrl(''); }}>{[...CREDENTIAL_PROVIDERS.filter(item => item.id !== CODEX_PROVIDER), ...(!CREDENTIAL_PROVIDERS.some(item => item.id === selectedProvider) ? [{ id: selectedProvider, label: selectedProvider }] : [])].map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>}
      </>}
      {definition.fields.filter(field => mode !== 'rotate' || field.secret).map(field => <label key={field.key}>{field.label}
        {field.options ? <select value={config[field.key] ?? field.default ?? ''} onChange={event => setConfig(current => ({ ...current, [field.key]: event.target.value }))}>{field.options.map(option => <option key={option} value={option}>{option}</option>)}</select>
          : <input type={field.secret ? 'password' : 'text'} autoComplete={field.secret ? 'new-password' : 'off'} value={field.secret ? fields[field.key] || '' : config[field.key] ?? field.default ?? ''} placeholder={field.secret && credential?.fieldPresence[field.key] ? 'Saved — leave blank to keep' : field.help || ''} onChange={event => field.secret ? setFields(current => ({ ...current, [field.key]: event.target.value })) : setConfig(current => ({ ...current, [field.key]: event.target.value }))} />}
        {field.help && <small>{field.help}</small>}
      </label>)}
      {definition.modelCompatible && mode !== 'rotate' && <><label>Model API base URL<input type="url" value={baseUrl} onChange={event => setBaseUrl(event.target.value)} placeholder="Optional custom endpoint" /></label>
        <ModelPicker client={client} provider={selectedProvider} credentialRef={credential?.ref} apiKey={fields.value} baseUrl={baseUrl} value={model} label="Default model" onChange={setModel} />
        <p className="profile-help">Optional starting model. Each agent keeps its own model choice.</p>
      </>}
    </fieldset>
    {error && <p role="alert" className="profile-error">{error}</p>}
    <div className="profile-actions"><button type="button" disabled={busy} className="subtle-button" onClick={onCancel}>Cancel</button><button type="button" disabled={busy || !label.trim()} className="light-button" onClick={() => void save()}>{busy ? 'Saving…' : credential ? mode === 'rotate' ? 'Replace value' : 'Save changes' : 'Save credential'}</button></div>
  </div>;
}

// Codex sign-in tokens stay on the coordinator, so they are offered only where a model is chosen.
export function CredentialSelector({ client, credentials, value, onSelect, onCreated, provider = '', modelOnly = false, allowCodex = modelOnly, onManage, label = 'Saved credential' }: {
  client: ControlClient; credentials: CredentialRecord[]; value: string; onSelect: (credential: CredentialRecord | null) => void; onCreated?: (credential: CredentialRecord) => void; provider?: string; modelOnly?: boolean; allowCodex?: boolean; onManage?: () => void; label?: string;
}) {
  const [creating, setCreating] = useState(false);
  const options = credentials.filter(item => (!modelOnly || modelCredential(item)) && (allowCodex || item.provider !== CODEX_PROVIDER));
  return <div className="credential-selector"><label>{label}<select value={value} onChange={event => {
    if (event.target.value === '__create') setCreating(true);
    else if (event.target.value === '__manage') onManage?.();
    else onSelect(credentials.find(item => item.ref === event.target.value) || null);
  }}><option value="">None / local endpoint</option>{options.map(item => <option key={item.ref} value={item.ref}>{item.label}{item.present ? '' : ' — missing'}</option>)}{value && !options.some(item => item.ref === value) && <option value={value}>{value} — missing</option>}<option value="__create">＋ Create credential…</option>{onManage && <option value="__manage">＋ Manage credentials…</option>}</select></label>
    {creating && <div className="credential-inline" role="dialog" aria-label="Create credential"><CredentialEditor client={client} provider={provider} modelOnly={modelOnly} onCancel={() => setCreating(false)} onSaved={credential => { onCreated?.(credential); onSelect(credential); setCreating(false); }} /></div>}
  </div>;
}
