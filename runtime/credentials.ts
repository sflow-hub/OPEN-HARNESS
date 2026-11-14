import { createHmac } from 'node:crypto';
import { credentialType, type CredentialType } from '../lib/credential-types';
import type { DatabaseSync } from 'node:sqlite';
import type { SecretStore } from './secrets';
import { validateModel } from './profiles';
import { CREDENTIAL_LABEL_MAX, CREDENTIAL_REF, CREDENTIAL_REF_LEGACY, labelFromRef, refFromLabel, WELL_KNOWN, type CredentialDraft, type CredentialRecord } from '../lib/credentials';
import { CODEX_PROVIDER } from '../lib/codex';

export class CredentialError extends Error { constructor(message: string, readonly status = 400) { super(message); } }
export type CredentialRow = { type: CredentialType; config: string; connection_status: 'untested' | 'connected' | 'failed' | 'needs-reconnection'; ref: string; label: string; provider: string; model: string; base_url: string; fingerprint: string; length: number; created_at: string; updated_at: string; last_used_at: string | null };

const VALUE_MAX = 10000;

// SQLite holds metadata only. Structured fields use a private SecretStore namespace;
// legacy single keys stay flat so older profile references continue to resolve.
export class Credentials {
  constructor(readonly db: DatabaseSync, private secrets: SecretStore) {
    db.exec(`CREATE TABLE IF NOT EXISTS credentials(ref TEXT PRIMARY KEY, label TEXT NOT NULL, provider TEXT NOT NULL DEFAULT '', fingerprint TEXT NOT NULL DEFAULT '', length INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_used_at TEXT);
      CREATE UNIQUE INDEX IF NOT EXISTS credentials_label ON credentials(label COLLATE NOCASE);
      CREATE INDEX IF NOT EXISTS credentials_provider ON credentials(provider);`);
    const columns = new Set((db.prepare('PRAGMA table_info(credentials)').all() as { name: string }[]).map(column => column.name));
    if (!columns.has('model')) db.exec("ALTER TABLE credentials ADD COLUMN model TEXT NOT NULL DEFAULT ''");
    if (!columns.has('base_url')) db.exec("ALTER TABLE credentials ADD COLUMN base_url TEXT NOT NULL DEFAULT ''");
    if (!columns.has('type')) { db.exec("ALTER TABLE credentials ADD COLUMN type TEXT NOT NULL DEFAULT 'api-key'"); db.exec("UPDATE credentials SET type='model-api-key' WHERE provider<>''"); }
    if (!columns.has('config')) db.exec("ALTER TABLE credentials ADD COLUMN config TEXT NOT NULL DEFAULT '{}'");
    if (!columns.has('connection_status')) db.exec("ALTER TABLE credentials ADD COLUMN connection_status TEXT NOT NULL DEFAULT 'untested'");
    this.adopt();
    db.exec("UPDATE credentials SET type='model-api-key' WHERE provider<>'' AND type='api-key' AND config='{}'");
  }
  get backend() { return this.secrets.backend; }

  // Keyed so it cannot be reversed or matched across installs, unlike a last-4 excerpt.
  // It only has to answer "is this the same key I stored somewhere else?".
  private fingerprint(value: string) { return value ? createHmac('sha256', this.secrets.token).update(value).digest('hex').slice(0, 6) : ''; }

  // Values written by an older binary, restored from a backup, or seeded through the legacy
  // POST /v1/secrets route become manageable credentials instead of invisible orphans.
  private adopt() {
    const known = new Set(this.rows().map(row => row.ref));
    const values = this.secrets.environment(), stamp = new Date().toISOString();
    for (const ref of this.secrets.names()) {
      if (known.has(ref) || !CREDENTIAL_REF_LEGACY.test(ref)) continue;
      const meta = WELL_KNOWN[ref], value = values[ref] || '';
      this.db.prepare('INSERT OR IGNORE INTO credentials(ref,label,provider,fingerprint,length,created_at,updated_at,last_used_at) VALUES(?,?,?,?,?,?,?,NULL)')
        .run(ref, this.freeLabel(meta?.label || labelFromRef(ref)), meta?.provider || '', this.fingerprint(value), value.length, stamp, stamp);
    }
  }
  private freeLabel(base: string) {
    const trimmed = base.slice(0, CREDENTIAL_LABEL_MAX).trim() || 'Credential';
    if (!this.labelTaken(trimmed)) return trimmed;
    for (let n = 2; n < 1000; n++) { const candidate = `${trimmed.slice(0, CREDENTIAL_LABEL_MAX - 4)} ${n}`; if (!this.labelTaken(candidate)) return candidate; }
    return `${trimmed.slice(0, CREDENTIAL_LABEL_MAX - 9)} ${Date.now() % 100000}`;
  }
  private labelTaken(label: string, except = '') {
    return Boolean(this.db.prepare('SELECT ref FROM credentials WHERE label=? COLLATE NOCASE AND ref<>?').get(label, except));
  }
  private checkLabel(input: unknown, except = '') {
    const label = String(input ?? '').trim();
    if (!label) throw new CredentialError('Give this credential a name.');
    if (label.length > CREDENTIAL_LABEL_MAX) throw new CredentialError(`Names must be at most ${CREDENTIAL_LABEL_MAX} characters.`);
    if (this.labelTaken(label, except)) throw new CredentialError('Another credential already uses that name.', 409);
    return label;
  }
  private checkProvider(input: unknown) {
    const provider = String(input ?? '').trim();
    if (provider && !/^[a-z0-9][a-z0-9_-]{0,99}$/.test(provider)) throw new CredentialError('Invalid provider.');
    return provider;
  }
  private checkValue(input: unknown, oauth = false) {
    const value = String(input ?? '');
    if (!value.trim()) throw new CredentialError('Paste the credential value.');
    if (value.length > (oauth ? 64000 : VALUE_MAX)) throw new CredentialError('That value is too long to store.');
    return value;
  }

  rows(): CredentialRow[] { return this.db.prepare('SELECT * FROM credentials ORDER BY label COLLATE NOCASE').all() as CredentialRow[]; }
  row(ref: string): CredentialRow {
    const row = this.db.prepare('SELECT * FROM credentials WHERE ref=?').get(ref) as CredentialRow | undefined;
    if (!row) throw new CredentialError('That credential no longer exists.', 404);
    return row;
  }
  has(ref: string) { return Boolean(this.db.prepare('SELECT ref FROM credentials WHERE ref=?').get(ref)); }
  fields(ref: string): Record<string, string> { return { ...this.secrets.credentialFields(ref), ...(this.secrets.has(ref) ? { value: this.secrets.environment()[ref] } : {}) }; }
  present(ref: string) {
    const row = this.row(ref), fields = this.fields(ref);
    return credentialType(row.type).fields.filter(field => field.secret && field.required).every(field => Boolean(fields[field.key])) && (row.type !== 'oauth2' || row.connection_status !== 'needs-reconnection' && Boolean(fields.accessToken));
  }
  metadata(row: CredentialRow): Pick<CredentialRecord, 'type' | 'config' | 'connectionStatus' | 'fieldPresence' | 'account'> {
    const fields = this.fields(row.ref);
    return { type: row.type, config: JSON.parse(row.config) as Record<string, string>, connectionStatus: row.connection_status, fieldPresence: Object.fromEntries([...credentialType(row.type).fields.filter(field => field.secret).map(field => field.key), ...(row.type === 'oauth2' ? ['accessToken', 'refreshToken'] : [])].map(key => [key, Boolean(fields[key])])) };
  }
  setStatus(ref: string, status: CredentialRow['connection_status']) { this.db.prepare('UPDATE credentials SET connection_status=? WHERE ref=?').run(status, ref); }
  updateFields(ref: string, fields: Record<string, string>) {
    this.row(ref); this.secrets.setCredentialFields(ref, { ...this.fields(ref), ...fields });
  }
  private typed(typeId: string, inputConfig: unknown, inputFields: unknown, existing: Record<string, string> = {}) {
    let type; try { type = credentialType(typeId); } catch { throw new CredentialError('Choose a supported credential type.'); }
    const object = (input: unknown): Record<string, string> => {
      if (input === undefined) return {};
      if (!input || typeof input !== 'object' || Array.isArray(input) || Object.values(input).some(value => typeof value !== 'string' || value.length > VALUE_MAX)) throw new CredentialError('Credential fields must be text values of at most 10000 characters.');
      return input as Record<string, string>;
    };
    const config = object(inputConfig), changes = object(inputFields);
    if (Object.keys(config).some(key => !type.fields.some(field => field.key === key && !field.secret)) || Object.keys(changes).some(key => !type.fields.some(field => field.key === key && field.secret))) throw new CredentialError('Unknown credential field.');
    const safe = Object.fromEntries(type.fields.filter(field => !field.secret).map(field => [field.key, config[field.key] ?? field.default ?? '']));
    const fields = { ...existing, ...changes };
    for (const field of type.fields) {
      const value = field.secret ? fields[field.key] : safe[field.key];
      if (field.required && !value?.trim()) throw new CredentialError(`${field.label} is required.`);
      if (field.options && !field.options.includes(value)) throw new CredentialError(`Choose a valid ${field.label.toLowerCase()}.`);
    }
    for (const name of ['testUrl', 'authorizationUrl', 'tokenUrl']) if (safe[name]) {
      let url; try { url = new URL(safe[name]); } catch { throw new CredentialError('Enter a valid HTTPS URL.'); }
      if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new CredentialError('Credential URLs must use HTTPS without embedded credentials or fragments.');
    }
    if (type.id === 'api-key' && !/^[!#$%&'*+.^_`|~0-9a-zA-Z-]+$/.test(safe.parameterName)) throw new CredentialError('Enter a valid header or query name.');
    if (type.id === 'basic' && fields.username.includes(':')) throw new CredentialError('Basic authentication usernames cannot contain a colon.');
    if (type.id === 'oauth2' && safe.grantType === 'authorization_code' && !safe.authorizationUrl) throw new CredentialError('Authorization URL is required for browser sign-in.');
    if (type.id === 'oauth2' && safe.clientAuth !== 'none' && !fields.clientSecret) throw new CredentialError('Client secret is required for this client authentication method.');
    for (const [name, value] of [['headers', fields.headers], ['authorizationParams', safe.authorizationParams]]) if (value) {
      let parsed; try { parsed = JSON.parse(value); } catch { throw new CredentialError(`${name} must be a JSON object.`); }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || Object.values(parsed).some(value => typeof value !== 'string') || Object.keys(parsed).length > 50) throw new CredentialError(`${name} must be an object of at most 50 text values.`);
      if (name === 'headers' && Object.entries(parsed).some(([key, value]) => !/^[!#$%&'*+.^_`|~0-9a-zA-Z-]+$/.test(key) || /[\r\n]/.test(String(value)) || ['host', 'cookie', 'content-length', 'transfer-encoding', 'connection', 'proxy-authorization'].includes(key.toLowerCase()))) throw new CredentialError('Invalid authentication header.');
      if (name === 'authorizationParams' && Object.keys(parsed).some(key => ['state', 'redirect_uri', 'client_id', 'response_type', 'code_challenge', 'code_challenge_method', 'scope', 'client_secret'].includes(key))) throw new CredentialError('Authorization parameters cannot override OAuth security fields.');
    }
    return { config: safe, fields };
  }

  create(draft: CredentialDraft, oauth = false): CredentialRow {
    const provider = this.checkProvider(draft.provider ?? WELL_KNOWN[String(draft.ref ?? '')]?.provider);
    if (provider === CODEX_PROVIDER && !oauth) throw new CredentialError('Use Sign in with ChatGPT to add this provider.');
    const type = draft.type || (provider ? 'model-api-key' : 'api-key');
    const typed = this.typed(type, draft.config, { ...draft.fields, ...(draft.value !== undefined ? { value: this.checkValue(draft.value, oauth) } : {}) });
    const value = typed.fields.value || JSON.stringify(typed.fields);
    const model = draft.model ?? '';
    const connection = validateModel({ provider: provider || 'custom', model: model === '' ? 'unspecified' : model, baseUrl: draft.baseUrl ?? '', credentialRef: '' });
    const label = this.checkLabel(draft.label || labelFromRef(String(draft.ref ?? '')));
    const ref = draft.ref ? String(draft.ref) : refFromLabel(label, candidate => this.has(candidate) || this.secrets.has(candidate));
    if (!CREDENTIAL_REF.test(ref)) throw new CredentialError('Credential references use uppercase letters, digits, and underscores, and are at most 64 characters.');
    if (this.has(ref)) throw new CredentialError('A credential with that reference already exists.', 409);
    const stamp = new Date().toISOString();
    if (typed.fields.value !== undefined) this.secrets.set(ref, typed.fields.value);
    else this.secrets.setCredentialFields(ref, typed.fields);
    try { this.db.prepare('INSERT INTO credentials(ref,label,provider,fingerprint,length,created_at,updated_at,model,base_url) VALUES(?,?,?,?,?,?,?,?,?)').run(ref, label, provider, this.fingerprint(value), value.length, stamp, stamp, draft.model ? connection.model.trim() : '', connection.baseUrl); }
    catch (error) { this.secrets.delete(ref); this.secrets.deleteCredentialFields(ref); throw error; }
    this.db.prepare('UPDATE credentials SET type=?,config=? WHERE ref=?').run(type, JSON.stringify(typed.config), ref);
    return this.row(ref);
  }
  // The ref never moves, so every agent and connector referencing it keeps working.
  relabel(ref: string, patch: CredentialDraft): CredentialRow {
    const current = this.row(ref);
    if (patch.type && patch.type !== current.type) throw new CredentialError('Create a new credential to change its type.');
    const typed = this.typed(current.type, { ...JSON.parse(current.config), ...patch.config }, patch.fields, this.fields(ref));
    const label = patch.label === undefined ? current.label : this.checkLabel(patch.label, ref);
    const provider = patch.provider === undefined ? current.provider : this.checkProvider(patch.provider);
    if ((provider === CODEX_PROVIDER || current.provider === CODEX_PROVIDER) && provider !== current.provider) throw new CredentialError('A ChatGPT sign-in cannot be converted to an API key. Add a new credential instead.');
    const model = patch.model ?? current.model, baseUrl = patch.baseUrl ?? current.base_url;
    validateModel({ provider: provider || 'custom', model: model === '' ? 'unspecified' : model, baseUrl, credentialRef: '' });
    const oauthChanged = current.type === 'oauth2' && (JSON.stringify(typed.config) !== current.config || Object.entries(patch.fields || {}).some(([key, value]) => value !== this.fields(ref)[key]));
    if (oauthChanged) { typed.fields.accessToken = ''; typed.fields.refreshToken = ''; typed.fields.expiresAt = ''; typed.fields.grantedScopes = ''; }
    if (patch.fields !== undefined || oauthChanged) {
      if (typed.fields.value !== undefined) this.secrets.set(ref, typed.fields.value);
      else this.secrets.setCredentialFields(ref, typed.fields);
    }
    const secretValue = typed.fields.value || JSON.stringify(typed.fields);
    const changed = Boolean(patch.config && JSON.stringify(typed.config) !== current.config || patch.fields && Object.keys(patch.fields).length || provider !== current.provider || model !== current.model || baseUrl !== current.base_url);
    this.db.prepare('UPDATE credentials SET label=?,provider=?,model=?,base_url=?,config=?,connection_status=?,fingerprint=?,length=?,updated_at=? WHERE ref=?').run(label, provider, model.trim(), baseUrl, JSON.stringify(typed.config), oauthChanged ? 'needs-reconnection' : changed ? 'untested' : current.connection_status, patch.fields && Object.keys(patch.fields).length ? this.fingerprint(secretValue) : current.fingerprint, patch.fields && Object.keys(patch.fields).length ? secretValue.length : current.length, new Date().toISOString(), ref);
    return this.row(ref);
  }
  rotate(ref: string, input: unknown, oauth = false): CredentialRow {
    const row = this.row(ref);
    if (row.provider === CODEX_PROVIDER && !oauth) throw new CredentialError('Sign in with ChatGPT again to replace this session.');
    if (!['api-key', 'model-api-key'].includes(row.type)) throw new CredentialError('Edit the secret fields to replace this credential.');
    const value = this.checkValue(input, oauth);
    this.secrets.set(ref, value);
    this.db.prepare("UPDATE credentials SET fingerprint=?,length=?,updated_at=?,connection_status='untested' WHERE ref=?").run(this.fingerprint(value), value.length, new Date().toISOString(), ref);
    return this.row(ref);
  }
  remove(ref: string) {
    this.row(ref);
    this.secrets.delete(ref); this.secrets.deleteCredentialFields(ref);
    this.db.prepare('DELETE FROM credentials WHERE ref=?').run(ref);
  }
  touch(refs: string[]) {
    const stamp = new Date().toISOString();
    for (const ref of new Set(refs.filter(Boolean))) { try { this.db.prepare('UPDATE credentials SET last_used_at=? WHERE ref=?').run(stamp, ref); } catch {} }
  }
}
