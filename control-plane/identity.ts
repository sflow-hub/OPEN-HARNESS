import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { Database } from './database';
import { ProductError, text } from '../runtime/product-error';
import { accountDisplayName } from '../lib/display-name';

export const tokenHash = (value: string) => createHash('sha256').update(value).digest('hex');
const opaque = () => randomBytes(32).toString('base64url');
const same = (left: string, right: string) => left.length === right.length && timingSafeEqual(Buffer.from(left), Buffer.from(right));
type Metadata = { issuer: string; authorization_endpoint: string; token_endpoint: string; jwks_uri: string };
export type CloudSession = { accountId: string; kind: 'browser' | 'native'; csrfHash: string; tokenHash: string };
export type IdentityConfig = { issuer: string; clientId: string; clientSecret: string; publicOrigin: string; nativeRedirects: string[]; allowInsecureDevelopment?: boolean };
export class Identity {
  private metadata?: Promise<Metadata>;
  constructor(private db: Database, readonly config: IdentityConfig, private request: typeof fetch = fetch) {
    for (const address of [config.issuer, config.publicOrigin]) { const url = new URL(address); if (url.protocol !== 'https:' && !(config.allowInsecureDevelopment && ['127.0.0.1','localhost'].includes(url.hostname))) throw new Error('Identity and public origins require HTTPS.'); }
  }
  private discovery() {
    return this.metadata ||= (async () => { const response = await this.request(this.config.issuer.replace(/\/$/, '') + '/.well-known/openid-configuration', { redirect: 'error', signal: AbortSignal.timeout(10000) }); if (!response.ok) throw new ProductError('Identity discovery is unavailable.', 503); const value = await response.json() as Metadata; if (value.issuer !== this.config.issuer) throw new ProductError('Identity discovery returned another issuer.', 503); for (const name of ['authorization_endpoint','token_endpoint','jwks_uri'] as const) { const url = new URL(value[name]); if (url.protocol !== 'https:' && !(this.config.allowInsecureDevelopment && ['localhost','127.0.0.1'].includes(url.hostname))) throw new Error('Insecure identity endpoint'); } return value; })().catch(error => { this.metadata = undefined; throw error; });
  }
  async start(kind: 'browser' | 'native', redirectUri?: string, challenge?: string) {
    const metadata = await this.discovery();
    if (kind === 'native' && (!redirectUri || !this.config.nativeRedirects.includes(redirectUri) || !challenge || !/^[A-Za-z0-9_-]{43}$/.test(challenge))) throw new ProductError('This native authorization request is not registered.');
    const state = opaque(), verifier = opaque() + opaque(), nonce = opaque(), binding = opaque(), callback = this.config.publicOrigin + '/auth/callback';
    await this.db.query('INSERT INTO authorization_flows VALUES($1,$2,$3,$4,$5,$6,$7,$8)', [tokenHash(state), verifier, nonce, tokenHash(binding), kind, kind === 'native' ? redirectUri : '/', kind === 'native' ? challenge : null, new Date(Date.now() + 600000)]);
    const url = new URL(metadata.authorization_endpoint); for (const [key,value] of Object.entries({ response_type: 'code', client_id: this.config.clientId, redirect_uri: callback, scope: 'openid email profile', state, nonce, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' })) url.searchParams.set(key, value);
    return { url: url.href, state, binding };
  }
  async callback(state: string, code: string, binding: string) {
    const flow = await this.db.transaction(async sql => { const row = (await sql.query('DELETE FROM authorization_flows WHERE state_hash=$1 AND binding_hash=$2 AND expires_at>now() RETURNING *', [tokenHash(state), tokenHash(binding)])).rows[0]; if (!row) throw new ProductError('Sign-in expired or did not start in this browser. Start again.', 401); return row; });
    const metadata = await this.discovery();
    const response = await this.request(metadata.token_endpoint, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000), headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'authorization_code', code: text(code, 'Authorization code', 4000), client_id: this.config.clientId, client_secret: this.config.clientSecret, redirect_uri: this.config.publicOrigin + '/auth/callback', code_verifier: flow.verifier }) });
    if (!response.ok) throw new ProductError('The identity service rejected this sign-in. Start again.', 401);
    const tokens = await response.json() as { id_token?: string }; if (!tokens.id_token) throw new ProductError('The identity service did not return an identity token.', 401);
    const { payload } = await jwtVerify(tokens.id_token, createRemoteJWKSet(new URL(metadata.jwks_uri)), { issuer: this.config.issuer, audience: this.config.clientId, algorithms: ['RS256','ES256','EdDSA'], maxTokenAge: '10m' });
    if (!payload.sub || payload.nonce !== flow.nonce || typeof payload.exp !== 'number' || (payload.email && payload.email_verified !== true)) throw new ProductError('The identity token could not be verified.', 401);
    const subject = this.config.issuer + '|' + payload.sub, id = randomUUID();
    const account = (await this.db.query('INSERT INTO accounts(id,subject,email,display_name) VALUES($1,$2,$3,$4) ON CONFLICT(subject) DO UPDATE SET email=excluded.email,display_name=excluded.display_name RETURNING id', [id, subject, typeof payload.email === 'string' ? payload.email : payload.sub, accountDisplayName(payload.name) || null])).rows[0];
    const session = await this.issue(account.id, 'browser');
    if (flow.client === 'native') { const code = opaque(); await this.db.query('INSERT INTO native_codes VALUES($1,$2,$3,$4,$5)', [tokenHash(code), account.id, flow.challenge, flow.redirect_uri, new Date(Date.now() + 60000)]); const destination = new URL(flow.redirect_uri); destination.searchParams.set('code', code); return { ...session, redirect: destination.href }; }
    return { ...session, redirect: '/' };
  }
  private async issue(accountId: string, kind: CloudSession['kind']) { const token = opaque(), csrf = opaque(); await this.db.query('INSERT INTO sessions(token_hash,account_id,csrf_hash,kind,expires_at) VALUES($1,$2,$3,$4,$5)', [tokenHash(token), accountId, tokenHash(csrf), kind, new Date(Date.now() + (kind === 'native' ? 30 * 86400000 : 12 * 3600000))]); return { token, csrf, expiresIn: kind === 'native' ? 30 * 86400 : 12 * 3600 }; }
  async nativeExchange(code: string, verifier: string, redirectUri: string) { if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) throw new ProductError('Invalid native authorization verifier.', 401); const challenge = createHash('sha256').update(verifier).digest('base64url'); return this.db.transaction(async sql => { const row = (await sql.query('DELETE FROM native_codes WHERE code_hash=$1 AND challenge=$2 AND redirect_uri=$3 AND expires_at>now() RETURNING account_id', [tokenHash(code), challenge, redirectUri])).rows[0]; if (!row) throw new ProductError('This sign-in code is invalid, expired, or already used.', 401); const token = opaque(), csrf = opaque(); await sql.query("INSERT INTO sessions VALUES($1,$2,$3,'native',$4,now())", [tokenHash(token), row.account_id, tokenHash(csrf), new Date(Date.now() + 30 * 86400000)]); return { token, expiresIn: 30 * 86400 }; }); }
  async session(token: string, kind: CloudSession['kind']): Promise<CloudSession> { if (!token || token.length > 200) throw new ProductError('Sign in to your workspace.', 401); const row = (await this.db.query('SELECT * FROM sessions WHERE token_hash=$1 AND kind=$2 AND expires_at>now()', [tokenHash(token), kind])).rows[0]; if (!row) throw new ProductError('Your session expired. Sign in again.', 401); return { accountId: row.account_id, kind: row.kind, csrfHash: row.csrf_hash, tokenHash: row.token_hash }; }
  csrf(session: CloudSession, value: string) { if (session.kind === 'browser' && !same(session.csrfHash, tokenHash(value))) throw new ProductError('Refresh this page before changing your workspace.', 403); }
  async logout(session: CloudSession) { await this.db.query('DELETE FROM sessions WHERE token_hash=$1', [session.tokenHash]); }
  async rotate(session: CloudSession) { if (session.kind !== 'native') throw new ProductError('Only native sessions use token rotation.'); return this.db.transaction(async sql => { const row = (await sql.query("DELETE FROM sessions WHERE token_hash=$1 AND kind='native' RETURNING account_id", [session.tokenHash])).rows[0]; if (!row) throw new ProductError('This session was already rotated.', 401); const token = opaque(), csrf = opaque(); await sql.query("INSERT INTO sessions VALUES($1,$2,$3,'native',$4,now())", [tokenHash(token), row.account_id, tokenHash(csrf), new Date(Date.now() + 30 * 86400000)]); return { token, expiresIn: 30 * 86400 }; }); }
  async browserBridge(accountId:string,redirect:string){if(!/^\/\?workspace=[A-Za-z0-9_-]+(?:&desktop=[A-Za-z0-9_-]+)?$/.test(redirect))throw new ProductError('Invalid workspace browser destination.');const code=opaque();await this.db.query('INSERT INTO native_codes VALUES($1,$2,$3,$4,$5)',[tokenHash(code),accountId,'browser-bridge',redirect,new Date(Date.now()+30000)]);return {url:this.config.publicOrigin+'/auth/bridge?code='+code};}
  async redeemBridge(code:string){const row=(await this.db.query("DELETE FROM native_codes WHERE code_hash=$1 AND challenge='browser-bridge' AND expires_at>now() RETURNING *",[tokenHash(code)])).rows[0];if(!row)throw new ProductError('This browser handoff expired. Open it again from the native app.',401);return {...await this.issue(row.account_id,'browser'),redirect:row.redirect_uri};}
}
