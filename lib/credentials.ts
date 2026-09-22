// A credential is a named reference. Values live only in the coordinator's SecretStore
// (OS vault, or a 0600 file); everything here is metadata safe to send to the browser.
export type CredentialUse =
  | { kind: 'workspace-default' }
  | { kind: 'agent-model'; agentId: string; agentName: string }
  | { kind: 'agent-connector'; agentId: string; agentName: string; connectorName: string; enabled: boolean };
export type CredentialUsage = { uses: CredentialUse[]; agentCount: number; activeRuns: number };
export type CredentialRecord = {
  ref: string; label: string; provider: string;
  fingerprint: string; length: number; present: boolean;
  createdAt: string; updatedAt: string; lastUsedAt: string | null;
  usage: CredentialUsage;
};
export type CredentialList = { credentials: CredentialRecord[]; backend: string };
export type CredentialDraft = { label?: string; provider?: string; value?: string; ref?: string };

// Creation caps refs at 64. SecretStore.set allows up to 81 but validateModel caps
// references at 80, so a longer name would be storable and permanently unreferenceable.
export const CREDENTIAL_REF = /^[A-Z][A-Z0-9_]{1,63}$/;
// Adoption must accept anything already stored, or an existing key becomes unmanageable.
export const CREDENTIAL_REF_LEGACY = /^[A-Z][A-Z0-9_]{1,80}$/;
export const CREDENTIAL_LABEL_MAX = 60;

export const WELL_KNOWN: Record<string, { label: string; provider: string }> = {
  XAI_API_KEY: { label: 'xAI API key', provider: 'xai' },
  OPENAI_API_KEY: { label: 'OpenAI API key', provider: 'openai' },
  OPENROUTER_API_KEY: { label: 'OpenRouter API key', provider: 'openrouter' },
  ANTHROPIC_API_KEY: { label: 'Anthropic API key', provider: 'anthropic' },
  MODEL_API_KEY: { label: 'Model API key', provider: '' },
};

export function labelFromRef(ref: string) {
  return WELL_KNOWN[ref]?.label || ref.toLowerCase().replace(/_/g, ' ').replace(/^./, c => c.toUpperCase());
}

// Labels are what people type; refs are the immutable env-var name agents resolve.
export function refFromLabel(label: string, taken: (ref: string) => boolean) {
  const slug = label.toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/_{2,}/g, '_').replace(/^_+|_+$/g, '').slice(0, 56);
  const seed = (/^[A-Z]/.test(slug) ? slug : `KEY_${slug}`.replace(/_+$/, '').slice(0, 56)) || 'CREDENTIAL';
  if (!taken(seed)) return seed;
  for (let n = 2; n < 1000; n++) if (!taken(`${seed}_${n}`)) return `${seed}_${n}`;
  throw new Error('Too many credentials share this name. Choose a different name.');
}

// '' provider means the credential is generic (connectors, custom endpoints) and fits anywhere.
export function fitsProvider(credential: { provider: string }, provider: string) {
  return !credential.provider || !provider || credential.provider === provider;
}
export function describeCredential(credential: { length: number; fingerprint: string }) {
  const parts = [credential.length ? `${credential.length} chars` : '', credential.fingerprint].filter(Boolean);
  return parts.join(' · ');
}
export function summarizeUsage(usage: CredentialUsage | undefined) {
  if (!usage) return '';
  const workspace = usage.uses.some(use => use.kind === 'workspace-default');
  if (workspace && usage.agentCount) return `Workspace default · ${usage.agentCount} agent${usage.agentCount === 1 ? '' : 's'}`;
  if (workspace) return 'Workspace default';
  if (usage.agentCount) return `Used by ${usage.agentCount} agent${usage.agentCount === 1 ? '' : 's'}`;
  return 'Not in use';
}

// Offered when naming a credential. '' keeps one usable anywhere, which is what
// connector secrets and custom endpoints need.
export const CREDENTIAL_PROVIDERS: Array<{ id: string; label: string }> = [
  { id: '', label: 'Any provider' },
  { id: 'xai', label: 'xAI' },
  { id: 'openai', label: 'OpenAI' },
  { id: 'openrouter', label: 'OpenRouter' },
  { id: 'anthropic', label: 'Anthropic' },
  { id: 'local', label: 'Local / custom server' },
  { id: 'custom', label: 'Custom' },
];
export function providerLabel(id: string) { return CREDENTIAL_PROVIDERS.find(p => p.id === id)?.label || id; }
