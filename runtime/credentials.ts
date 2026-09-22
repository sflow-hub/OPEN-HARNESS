import { createHmac } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { SecretStore } from './secrets';
import { CREDENTIAL_LABEL_MAX, CREDENTIAL_REF, CREDENTIAL_REF_LEGACY, labelFromRef, refFromLabel, WELL_KNOWN, type CredentialDraft } from '../lib/credentials';

export class CredentialError extends Error { constructor(message: string, readonly status = 400) { super(message); } }
export type CredentialRow = { ref: string; label: string; provider: string; fingerprint: string; length: number; created_at: string; updated_at: string; last_used_at: string | null };

const VALUE_MAX = 10000;

// Metadata lives here; values never do. SecretStore.environment() is consumed raw by the
// run pipeline, so the vault stays a flat name -> value map. The vault is authoritative for
// presence, this table for everything else, and adopt() reconciles them on every boot.
export class Credentials {
  constructor(readonly db: DatabaseSync, private secrets: SecretStore) {
    db.exec(`CREATE TABLE IF NOT EXISTS credentials(ref TEXT PRIMARY KEY, label TEXT NOT NULL, provider TEXT NOT NULL DEFAULT '', fingerprint TEXT NOT NULL DEFAULT '', length INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, last_used_at TEXT);
      CREATE UNIQUE INDEX IF NOT EXISTS credentials_label ON credentials(label COLLATE NOCASE);
      CREATE INDEX IF NOT EXISTS credentials_provider ON credentials(provider);`);
    this.adopt();
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
      this.db.prepare('INSERT OR IGNORE INTO credentials VALUES(?,?,?,?,?,?,?,NULL)')
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
  private checkValue(input: unknown) {
    const value = String(input ?? '');
    if (!value.trim()) throw new CredentialError('Paste the credential value.');
    if (value.length > VALUE_MAX) throw new CredentialError('That value is too long to store.');
    return value;
  }

  rows(): CredentialRow[] { return this.db.prepare('SELECT * FROM credentials ORDER BY label COLLATE NOCASE').all() as CredentialRow[]; }
  row(ref: string): CredentialRow {
    const row = this.db.prepare('SELECT * FROM credentials WHERE ref=?').get(ref) as CredentialRow | undefined;
    if (!row) throw new CredentialError('That credential no longer exists.', 404);
    return row;
  }
  has(ref: string) { return Boolean(this.db.prepare('SELECT ref FROM credentials WHERE ref=?').get(ref)); }
  present(ref: string) { return this.secrets.has(ref); }

  create(draft: CredentialDraft): CredentialRow {
    const value = this.checkValue(draft.value), provider = this.checkProvider(draft.provider ?? WELL_KNOWN[String(draft.ref ?? '')]?.provider);
    const label = this.checkLabel(draft.label || labelFromRef(String(draft.ref ?? '')));
    const ref = draft.ref ? String(draft.ref) : refFromLabel(label, candidate => this.has(candidate) || this.secrets.has(candidate));
    if (!CREDENTIAL_REF.test(ref)) throw new CredentialError('Credential references use uppercase letters, digits, and underscores, and are at most 64 characters.');
    if (this.has(ref)) throw new CredentialError('A credential with that reference already exists.', 409);
    const stamp = new Date().toISOString();
    this.secrets.set(ref, value);
    try { this.db.prepare('INSERT INTO credentials VALUES(?,?,?,?,?,?,?,NULL)').run(ref, label, provider, this.fingerprint(value), value.length, stamp, stamp); }
    catch (error) { this.secrets.delete(ref); throw error; }
    return this.row(ref);
  }
  // The ref never moves, so every agent and connector referencing it keeps working.
  relabel(ref: string, patch: { label?: unknown; provider?: unknown }): CredentialRow {
    const current = this.row(ref);
    const label = patch.label === undefined ? current.label : this.checkLabel(patch.label, ref);
    const provider = patch.provider === undefined ? current.provider : this.checkProvider(patch.provider);
    this.db.prepare('UPDATE credentials SET label=?,provider=?,updated_at=? WHERE ref=?').run(label, provider, new Date().toISOString(), ref);
    return this.row(ref);
  }
  rotate(ref: string, input: unknown): CredentialRow {
    this.row(ref);
    const value = this.checkValue(input);
    this.secrets.set(ref, value);
    this.db.prepare('UPDATE credentials SET fingerprint=?,length=?,updated_at=? WHERE ref=?').run(this.fingerprint(value), value.length, new Date().toISOString(), ref);
    return this.row(ref);
  }
  remove(ref: string) {
    this.row(ref);
    this.secrets.delete(ref);
    this.db.prepare('DELETE FROM credentials WHERE ref=?').run(ref);
  }
  touch(refs: string[]) {
    const stamp = new Date().toISOString();
    for (const ref of new Set(refs.filter(Boolean))) { try { this.db.prepare('UPDATE credentials SET last_used_at=? WHERE ref=?').run(stamp, ref); } catch {} }
  }
}
