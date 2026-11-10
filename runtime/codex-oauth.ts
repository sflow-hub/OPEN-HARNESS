import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRemoteJWKSet, jwtVerify, type JWTPayload } from 'jose';
import type { Credentials } from './credentials';
import type { SecretStore } from './secrets';
import { ProductError } from './product-error';
import { CODEX_PROVIDER, type CodexAuthStatus } from '../lib/codex';

const issuer = 'https://auth.openai.com', resource = 'https://api.openai.com/v1';
const tokenUrl = `${issuer}/api/accounts/oauth/token`;
const scopes = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const jwks = createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`));
type Session = { kind: 'open-harness-codex-oauth'; owner: string; clientId: string; subject: string; email: string; accessToken: string; refreshToken: string; idToken: string; expiresAt: number; scopes: string[] };
type Attempt = CodexAuthStatus & { owner: string; verifier: string; nonce: string; callbackUrl: string; clientId: string; ref: string; subject: string; expiresAt: number };
type Dependencies = { request?: typeof fetch; verify?: (token: string, clientId: string, nonce?: string) => Promise<JWTPayload>; now?: () => number };
const text = (value: unknown, max = 16000) => typeof value === 'string' && value.length <= max ? value : '';

export class CodexOAuth {
  private attempts = new Map<string, Attempt>();
  private refreshes = new Map<string, Promise<string>>();
  private disconnecting = new Set<string>();
  private request: typeof fetch;
  private now: () => number;
  private verify: NonNullable<Dependencies['verify']>;
  private hostId: string;
  constructor(root: string, private credentials: Credentials, private secrets: Pick<SecretStore, 'environment'>, dependencies: Dependencies = {}) {
    this.request = dependencies.request || fetch; this.now = dependencies.now || Date.now;
    this.verify = dependencies.verify || (async (token, clientId, nonce) => {
      const { payload } = await jwtVerify(token, jwks, { issuer, audience: clientId, requiredClaims: ['sub','exp','iat'], clockTolerance: 5 });
      if ((nonce !== undefined && payload.nonce !== nonce) || !payload.sub) throw new Error('Invalid identity');
      return payload;
    });
    const file = join(root, 'codex-host-id');
    if (!existsSync(file)) writeFileSync(file, `urn:uuid:${randomUUID()}`, { mode: 0o600, flag: 'wx' });
    this.hostId = readFileSync(file, 'utf8').trim();
    this.credentials.db.exec('CREATE TABLE IF NOT EXISTS codex_registrations(ref TEXT PRIMARY KEY,owner TEXT NOT NULL,client_id TEXT NOT NULL,subject TEXT NOT NULL,email TEXT NOT NULL)');
  }
  start(owner: string, callbackUrl: string, ref = '') {
    for (const [id, attempt] of this.attempts) if (attempt.expiresAt <= this.now()) this.attempts.delete(id);
    if (this.attempts.size >= 50) throw new ProductError('Too many sign-in attempts. Wait a few minutes and try again.', 429);
    const callback = new URL(callbackUrl);
    if (callback.protocol !== 'http:' || callback.hostname !== '127.0.0.1' || callback.pathname !== '/auth/callback' || callback.search || callback.hash || callback.username || callback.password) throw new ProductError('Codex sign-in requires a loopback callback.');
    const registration = ref ? this.credentials.db.prepare('SELECT owner,client_id AS clientId,subject,email FROM codex_registrations WHERE ref=?').get(ref) as {owner:string;clientId:string;subject:string;email:string}|undefined : undefined;
    if (registration && registration.owner !== owner) throw new ProductError('This ChatGPT registration belongs to another account.',403);
    const saved = ref && this.secrets.environment()[ref] ? this.session(ref, owner) : registration || null;
    const id = randomBytes(32).toString('base64url'), verifier = randomBytes(48).toString('base64url'), nonce = randomBytes(32).toString('base64url');
    const attempt: Attempt = { owner, verifier, nonce, callbackUrl, clientId: saved?.clientId || '', ref, subject: saved?.subject || '', state: 'waiting', expiresAt: this.now() + 10 * 60000 };
    this.attempts.set(id, attempt);
    const url = new URL(`${issuer}/api/accounts/authorize`);
    url.search = new URLSearchParams({ client_id: attempt.clientId || 'dynamic_agent_client', ext_agent_host_id: this.hostId, ...(!saved ? { agent_name_hint: 'Open Harness' } : saved.email ? { login_hint: saved.email } : {}), response_type: 'code', redirect_uri: callbackUrl, scope: scopes, resource, state: id, nonce, code_challenge_method: 'S256', code_challenge: createHash('sha256').update(verifier).digest('base64url') }).toString();
    return { id, authorizationUrl: url.href, callbackUrl, expiresAt: attempt.expiresAt };
  }
  status(id: string, owner: string): CodexAuthStatus {
    const value = this.attempts.get(id);
    if (!value || value.owner !== owner || value.expiresAt <= this.now()) throw new ProductError('This sign-in attempt expired. Start sign-in again.', 410);
    return { state: value.state, ...(value.credentialRef ? { credentialRef: value.credentialRef } : {}), ...(value.message ? { message: value.message } : {}) };
  }
  async complete(callback: URL, owner?: string) {
    const id = callback.searchParams.get('state') || '', attempt = this.attempts.get(id);
    if (!attempt || (owner && attempt.owner !== owner) || attempt.expiresAt <= this.now() || attempt.state !== 'waiting') throw new ProductError('This sign-in attempt is invalid or expired. Start sign-in again.', 410);
    if (callback.origin + callback.pathname !== attempt.callbackUrl) throw new ProductError('This callback does not match the sign-in attempt.');
    attempt.state = 'exchanging';
    try {
      if (callback.searchParams.has('error')) throw new ProductError('ChatGPT authorization was declined. Your existing model is unchanged.');
      const clientId = text(callback.searchParams.get('client_id'), 200) || attempt.clientId;
      if (!/^oaiapp_[A-Za-z0-9_-]+$/.test(clientId) || (attempt.clientId && attempt.clientId !== clientId)) throw new ProductError('OpenAI did not return the expected client registration. Start sign-in again.');
      const code = text(callback.searchParams.get('code'));
      if (!code) throw new ProductError('The sign-in callback has no authorization code.');
      const token = await this.token({ grant_type: 'authorization_code', client_id: clientId, code, code_verifier: attempt.verifier, redirect_uri: attempt.callbackUrl, resource });
      let identity: JWTPayload;
      try { identity = await this.verify(text(token.id_token), clientId, attempt.nonce); } catch { throw new ProductError('OpenAI identity verification failed. Start sign-in again.'); }
      if (!identity.sub || (attempt.subject && identity.sub !== attempt.subject)) throw new ProductError('This is a different ChatGPT account. Add it as a new account instead.');
      const granted = text(token.scope).split(/\s+/).filter(Boolean);
      if (!granted.includes('chatgpt.tokens.use.direct')) throw new ProductError('ChatGPT plan usage was not authorized. Sign in again and allow plan usage, or choose an API-key provider.');
      const session: Session = { kind: 'open-harness-codex-oauth', owner: attempt.owner, clientId, subject: identity.sub, email: text(identity.email, 200), accessToken: text(token.access_token), refreshToken: text(token.refresh_token), idToken: text(token.id_token), expiresAt: this.expiry(token.expires_in), scopes: granted };
      if (!session.accessToken || !session.refreshToken) throw new ProductError('OpenAI returned an incomplete session. Start sign-in again.');
      if (attempt.ref) this.credentials.rotate(attempt.ref, JSON.stringify(session), true);
      else {
        const label = `ChatGPT ${session.email || 'account'}`.slice(0, 50);
        const taken = new Set(this.credentials.rows().map(row => row.label.toLowerCase()));
        let unique = label; for (let n = 2; taken.has(unique.toLowerCase()); n++) unique = `${label} ${n}`;
        attempt.ref = this.credentials.create({ label: unique, provider: CODEX_PROVIDER, value: JSON.stringify(session) }, true).ref;
      }
      attempt.state = 'connected'; attempt.credentialRef = attempt.ref; attempt.message = 'ChatGPT is connected. Choose a model, then save and test it.';
      this.credentials.db.prepare('INSERT INTO codex_registrations VALUES(?,?,?,?,?) ON CONFLICT(ref) DO UPDATE SET owner=excluded.owner,client_id=excluded.client_id,subject=excluded.subject,email=excluded.email').run(attempt.ref,session.owner,session.clientId,session.subject,session.email);
      return this.status(id, attempt.owner);
    } catch (error) {
      attempt.state = 'error'; attempt.message = error instanceof ProductError ? error.message : 'ChatGPT sign-in could not complete. Start sign-in again.';
      throw new ProductError(attempt.message);
    } finally { attempt.verifier = ''; attempt.nonce = ''; }
  }
  private expiry(value: unknown) { const seconds = Number(value); if (!Number.isFinite(seconds) || seconds <= 0 || seconds > 86400) throw new ProductError('OpenAI returned an invalid token lifetime.'); return this.now() + seconds * 1000; }
  private async token(data: Record<string,string>): Promise<Record<string,unknown>> {
    let response: Response;
    try { response = await this.request(tokenUrl, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(data), redirect: 'error', signal: AbortSignal.timeout(20000) }); }
    catch { throw new ProductError('OpenAI sign-in is temporarily unreachable. Try again shortly.', 502); }
    if (!response.ok) { await response.body?.cancel(); throw new ProductError(response.status >= 500 || response.status === 429 ? 'OpenAI sign-in is temporarily unavailable. Try again shortly.' : 'OpenAI rejected this session. Sign in with ChatGPT again.', response.status >= 500 || response.status === 429 ? 503 : 409); }
    const body = await response.text(); if (body.length > 64000) throw new ProductError('OpenAI returned an invalid sign-in response.');
    try { return JSON.parse(body); } catch { throw new ProductError('OpenAI returned an invalid sign-in response.'); }
  }
  private session(ref: string, owner: string): Session {
    if (this.credentials.row(ref).provider !== CODEX_PROVIDER) throw new ProductError('Choose a saved ChatGPT sign-in.', 409);
    let session: Session; try { session = JSON.parse(this.secrets.environment()[ref] || ''); } catch { throw new ProductError('This ChatGPT session is unavailable. Sign in again.', 409); }
    if (session.kind !== 'open-harness-codex-oauth' || session.owner !== owner) throw new ProductError('This ChatGPT sign-in belongs to another workspace account.', 403);
    return session;
  }
  async access(ref: string, owner: string, force = false): Promise<string> {
    if (this.disconnecting.has(ref)) throw new ProductError('This ChatGPT account is being disconnected.',409);
    const session = this.session(ref, owner);
    if (!session.scopes.includes('chatgpt.tokens.use.direct')) throw new ProductError('Authorize ChatGPT plan usage before running a task.', 409);
    if (!force && session.expiresAt > this.now() + 60000) return session.accessToken;
    const pending = this.refreshes.get(ref); if (pending) return pending;
    const saved = JSON.stringify(session);
    const refresh = (async () => {
      const token = await this.token({ grant_type: 'refresh_token', client_id: session.clientId, refresh_token: session.refreshToken, resource });
      const access = text(token.access_token), scopes = token.scope === undefined ? session.scopes : text(token.scope).split(/\s+/);
      if (!access || !scopes.includes('chatgpt.tokens.use.direct')) throw new ProductError('This ChatGPT session needs authorization again.', 409);
      if (token.id_token !== undefined) {
        try { const identity=await this.verify(text(token.id_token),session.clientId); if(identity.sub!==session.subject)throw new Error('Different account'); }
        catch { throw new ProductError('OpenAI session identity verification failed. Sign in again.',409); }
      }
      // A disconnect or reauthorization during the network call must win over this result.
      if (JSON.stringify(this.session(ref, owner)) !== saved) return this.session(ref, owner).accessToken;
      this.credentials.rotate(ref, JSON.stringify({ ...session, accessToken: access, refreshToken: text(token.refresh_token) || session.refreshToken, idToken: text(token.id_token) || session.idToken, expiresAt: this.expiry(token.expires_in), scopes }), true);
      return access;
    })();
    this.refreshes.set(ref, refresh); try { return await refresh; } finally { this.refreshes.delete(ref); }
  }
  async models(ref: string, owner: string) {
    const response = await this.authorized(ref, owner, '/models', {});
    const value = await response.json() as { models?: { slug?: string; visibility?: string }[]; data?: { id?: string }[] };
    return { models: Array.isArray(value.models) ? value.models.filter(row => row.visibility === 'list').map(row => row.slug).filter((id): id is string => typeof id === 'string') : (value.data || []).map(row => row.id).filter((id): id is string => typeof id === 'string') };
  }
  async disconnect(ref: string, owner: string) {
    const registration=this.credentials.db.prepare('SELECT owner FROM codex_registrations WHERE ref=?').get(ref) as {owner:string}|undefined;
    if(registration && registration.owner!==owner)throw new ProductError('This ChatGPT registration belongs to another account.',403);
    if(this.secrets.environment()[ref])this.session(ref,owner);
    this.disconnecting.add(ref);
    try {
      await this.refreshes.get(ref)?.catch(()=>{});
      const session = this.session(ref,owner);
      const discovery = await this.request(`${issuer}/.well-known/openid-configuration`,{redirect:'error',signal:AbortSignal.timeout(10000)});
      if (!discovery.ok) throw new Error('Discovery unavailable');
      const value = await discovery.json() as {revocation_endpoint?:string};
      const endpoint = new URL(value.revocation_endpoint || '');
      if (endpoint.origin !== issuer || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error('Invalid revocation endpoint');
      const response = await this.request(endpoint,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({token:session.refreshToken,token_type_hint:'refresh_token',client_id:session.clientId}),redirect:'error',signal:AbortSignal.timeout(10000)});
      await response.body?.cancel(); if(response.status!==200)throw new Error('Revocation not confirmed');
      return '';
    } catch { return 'Disconnected locally. OpenAI did not confirm session revocation. You can also disconnect Open Harness in ChatGPT Settings.'; }
    finally { this.credentials.remove(ref); this.disconnecting.delete(ref); }
  }
  async authorized(ref: string, owner: string, path: '/models' | '/responses', init: RequestInit) {
    const send = async (force: boolean) => this.request(resource + path, { ...init, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${await this.access(ref, owner, force)}` }, redirect: 'error' });
    let response = await send(false);
    if (response.status === 401) { await response.body?.cancel(); response = await send(true); }
    if (!response.ok) { await response.body?.cancel(); throw new ProductError(response.status === 429 ? 'ChatGPT usage is currently limited. Check your ChatGPT plan usage and try later.' : response.status === 401 || response.status === 403 ? 'This ChatGPT session needs authorization again.' : `ChatGPT could not complete the request (HTTP ${response.status}).`, response.status === 429 ? 429 : 409); }
    return response;
  }
  async test(ref: string, owner: string, model: string) {
    const response = await this.authorized(ref, owner, '/responses', { method: 'POST', body: JSON.stringify({ model, input: [{ role: 'user', content: 'Reply with OK.' }], stream: true, store: false }), signal: AbortSignal.timeout(30000) });
    const reader = response.body?.getReader(); let buffer = '', completed = false, size = 0;
    if (!reader) throw new ProductError('ChatGPT returned no response stream.', 502);
    try {
      const decoder = new TextDecoder();
      for (;;) { const { value, done } = await reader.read(); if (done) break; size += value.length; if (size > 1000000) throw new ProductError('The model test response was too large.', 502); buffer += decoder.decode(value, { stream: true }).replaceAll('\r\n','\n'); let end; while ((end = buffer.indexOf('\n\n')) >= 0) { const event = buffer.slice(0,end); buffer = buffer.slice(end+2); for (const line of event.split('\n')) if (line.startsWith('data: ') && line !== 'data: [DONE]') { const data = JSON.parse(line.slice(6)); if (data.type === 'response.completed' && data.response?.status === 'completed') completed = true; if (['response.failed','response.incomplete','error'].includes(data.type)) throw new ProductError('ChatGPT did not complete the model test. Check plan access or select another model.', 409); } } }
    } finally { await reader.cancel().catch(() => {}); }
    return { ok: completed, message: completed ? 'ChatGPT authenticated and the selected model completed a live test request.' : 'The model test ended before ChatGPT confirmed completion.' };
  }
}
