'use client';
import type { CredentialBinding, CredentialGrant } from '../lib/agent-profile';
import type { CredentialRecord } from '../lib/credentials';
import { credentialType } from '../lib/credential-types';
import type { ControlClient } from '../lib/control-client';
import { CredentialSelector } from './credential-editor';

export function CredentialBindings({ bindings, onChange, credentials, client, onCreated }: { bindings: CredentialBinding[]; onChange: (bindings: CredentialBinding[]) => void; credentials: CredentialRecord[]; client: ControlClient; onCreated: (credential: CredentialRecord) => void }) {
  const fields = (ref: string) => {
    const record = credentials.find(item => item.ref === ref);
    return !record ? [] : record.type === 'oauth2' ? ['accessToken'] : credentialType(record.type).fields.filter(field => field.secret).map(field => field.key);
  };
  const change = (index: number, patch: Partial<CredentialBinding>) => onChange(bindings.map((binding, i) => i === index ? { ...binding, ...patch } : binding));
  return <div className="credential-bindings"><strong>Credential fields for this MCP server</strong>{bindings.map((binding, index) => <div className="credential-binding" key={index}>
    <CredentialSelector client={client} credentials={credentials} value={binding.credentialRef} onCreated={onCreated} onSelect={credential => change(index, { credentialRef: credential?.ref || '', field: credential?.type === 'oauth2' ? 'accessToken' : credential ? credentialType(credential.type).fields.find(field => field.secret)?.key || '' : '' })} />
    <label>Secret field<select value={binding.field} onChange={event => change(index, { field: event.target.value })}><option value="">Choose a field</option>{fields(binding.credentialRef).map(field => <option key={field} value={field}>{field}</option>)}</select></label>
    <label>Environment variable<input value={binding.env} placeholder="ACCESS_TOKEN" onChange={event => change(index, { env: event.target.value })} /></label>
    <button type="button" className="subtle-button" onClick={() => onChange(bindings.filter((_, i) => i !== index))}>Remove field</button>
  </div>)}<button type="button" className="subtle-button" onClick={() => onChange([...bindings, { credentialRef: '', field: '', env: '' }])}>Add credential field</button><p className="profile-help">Only these fields reach this connection. OAuth access tokens refresh before the next task.</p></div>;
}

export function CredentialGrants({ grants, onChange, credentials, client, onCreated }: { grants: CredentialGrant[]; onChange: (grants: CredentialGrant[]) => void; credentials: CredentialRecord[]; client: ControlClient; onCreated: (credential: CredentialRecord) => void }) {
  const change = (index: number, patch: Partial<CredentialGrant>) => onChange(grants.map((grant, i) => i === index ? { ...grant, ...patch } : grant));
  return <div className="credential-grants"><h3>Account and API access</h3><p className="profile-help">Enable Authenticated API request in the tool list, then grant the account here.</p>{grants.map((grant, index) => {
    return <div key={index} className="profile-connector">
    <CredentialSelector client={client} credentials={credentials} value={grant.credentialRef} onCreated={onCreated} onSelect={credential => change(index, { credentialRef: credential?.ref || '' })} />
    <label>Allowed API origins<textarea rows={2} value={grant.allowedOrigins.join('\n')} placeholder="https://api.example.com" onChange={event => change(index, { allowedOrigins: event.target.value.split('\n') })} /><small>One exact HTTPS origin per line, without paths.</small></label>
    <div className="credential-methods">{['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'].map(method => <label key={method}><input type="checkbox" checked={grant.allowedMethods.includes(method)} onChange={event => change(index, { allowedMethods: event.target.checked ? [...grant.allowedMethods, method] : grant.allowedMethods.filter(item => item !== method) })} />{method}</label>)}</div>
    <label><input type="checkbox" checked={grant.allowPrivateNetwork || false} onChange={event => change(index, { allowPrivateNetwork: event.target.checked })} /> Allow this API on a private network</label>
    <button type="button" className="subtle-button" onClick={() => onChange(grants.filter((_, i) => i !== index))}>Remove API grant</button>
  </div>; })}<button type="button" className="subtle-button" onClick={() => onChange([...grants, { credentialRef: '', allowedOrigins: [], allowedMethods: ['GET'], allowPrivateNetwork: false }])}>Add API grant</button></div>;
}
