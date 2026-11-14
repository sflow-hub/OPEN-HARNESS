import { createHash, randomBytes } from 'node:crypto';
import type { Credentials } from './credentials';
import { CredentialError } from './credentials';
import { credentialHttp, type CredentialTransport } from './credential-http';

type Pending = { ref: string; session: string; verifier: string; callback: string; expires: number; config: string };
export class CredentialOAuth {
  private pending = new Map<string, Pending>();
  private generations = new Map<string, number>();
  private refreshing = new Map<string, Promise<void>>();
  constructor(private credentials: Credentials, private transport: CredentialTransport = credentialHttp) {}
  private config(ref: string) { return JSON.parse(this.credentials.row(ref).config); }
  private configuration(ref: string) { return createHash('sha256').update(JSON.stringify([this.credentials.row(ref).config, this.credentials.fields(ref).clientSecret || ''])).digest('hex'); }
  async connect(ref: string, session: string, callback: string) {
    const row = this.credentials.row(ref), config = this.config(ref);
    if (row.type !== 'oauth2') throw new CredentialError('This credential does not use OAuth2.');
    if (config.grantType === 'client_credentials') { await this.refresh(ref, true); return { connected: true }; }
    for (const [state, item] of this.pending) if (item.expires < Date.now() || item.ref === ref && item.session === session) this.pending.delete(state);
    if (this.pending.size >= 100) throw new CredentialError('Too many sign-in attempts. Try again shortly.', 429);
    const state = randomBytes(32).toString('base64url'), verifier = randomBytes(32).toString('base64url');
    this.pending.set(state, { ref, session, verifier, callback, expires: Date.now() + 10 * 60_000, config: this.configuration(ref) });
    const url = new URL(config.authorizationUrl);
    for (const [key, value] of Object.entries(JSON.parse(config.authorizationParams || '{}'))) url.searchParams.set(key, String(value));
    for (const [key, value] of Object.entries({ response_type: 'code', client_id: config.clientId, redirect_uri: callback, scope: config.scopes || '', state, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' })) url.searchParams.set(key, value);
    return { authorizationUrl: url.toString(), callbackUrl: callback };
  }
  async callback(ref: string, input: URLSearchParams, callback: string) {
    const state = input.get('state') || '', pending = this.pending.get(state);
    this.pending.delete(state);
    if (!pending || pending.ref !== ref || pending.callback !== callback || pending.expires < Date.now() || this.configuration(ref) !== pending.config) throw new CredentialError('This sign-in attempt expired or was already used. Connect again.');
    if (input.has('error') || !input.get('code')) throw new CredentialError('Sign-in was cancelled or refused. Connect again.');
    await this.exchange(ref, { grant_type: 'authorization_code', code: input.get('code')!, code_verifier: pending.verifier, redirect_uri: pending.callback });
  }
  disconnect(ref: string) {
    if (this.credentials.row(ref).type !== 'oauth2') throw new CredentialError('This credential does not use OAuth2.');
    this.generations.set(ref, (this.generations.get(ref) || 0) + 1);
    for (const [state, item] of this.pending) if (item.ref === ref) this.pending.delete(state);
    this.credentials.updateFields(ref, { accessToken: '', refreshToken: '', expiresAt: '', grantedScopes: '' });
    this.credentials.setStatus(ref, 'needs-reconnection');
  }
  async ready(ref: string) {
    const row = this.credentials.row(ref);
    if (row.type !== 'oauth2') return;
    if (row.connection_status === 'needs-reconnection') throw new CredentialError('Reconnect this OAuth2 credential before using it.', 409);
    const fields = this.credentials.fields(ref);
    if (fields.accessToken && (!fields.expiresAt || Number(fields.expiresAt) > Date.now() + 60_000)) return;
    await this.refresh(ref);
  }
  private refresh(ref: string, force = false) {
    const existing = this.refreshing.get(ref); if (existing) return existing;
    const task = (async () => {
      const config = this.config(ref), fields = this.credentials.fields(ref);
      if (!force && fields.accessToken && (!fields.expiresAt || Number(fields.expiresAt) > Date.now() + 60_000)) return;
      if (config.grantType === 'client_credentials') await this.exchange(ref, { grant_type: 'client_credentials', scope: config.scopes || '' });
      else if (fields.refreshToken) await this.exchange(ref, { grant_type: 'refresh_token', refresh_token: fields.refreshToken });
      else { this.credentials.setStatus(ref, 'needs-reconnection'); throw new CredentialError('Reconnect this OAuth2 credential before using it.', 409); }
    })().finally(() => this.refreshing.delete(ref));
    this.refreshing.set(ref, task); return task;
  }
  private async exchange(ref: string, parameters: Record<string, string>) {
    const row = this.credentials.row(ref), config = this.config(ref), fields = this.credentials.fields(ref), generation = this.generations.get(ref) || 0;
    const body = new URLSearchParams(parameters), headers: Record<string, string> = { 'Content-Type': 'application/x-www-form-urlencoded' };
    if (config.clientAuth === 'basic') headers.Authorization = `Basic ${Buffer.from(`${encodeURIComponent(config.clientId)}:${encodeURIComponent(fields.clientSecret || '')}`).toString('base64')}`;
    else { body.set('client_id', config.clientId); if (config.clientAuth !== 'none') body.set('client_secret', fields.clientSecret || ''); }
    // An outage, timeout, rate limit or server error says nothing about the grant itself, so it
    // leaves the credential retryable rather than demanding a manual reconnect.
    const unavailable = () => { if ((this.generations.get(ref) || 0) === generation) this.credentials.setStatus(ref, 'failed'); return new CredentialError('The OAuth2 token endpoint is unavailable right now. Try again shortly.', 409); };
    let response;
    try { response = await this.transport(new URL(config.tokenUrl), { method: 'POST', headers, body: body.toString(), allowPrivate: config.allowPrivateNetwork === 'true' }); } catch { throw unavailable(); }
    if (response.status === 408 || response.status === 429 || response.status >= 500) throw unavailable();
    // A disconnect or edit while the request is in flight must not reconnect it, and that change already set the status.
    if (this.credentials.row(ref).config !== row.config || JSON.stringify(this.credentials.fields(ref)) !== JSON.stringify(fields) || (this.generations.get(ref) || 0) !== generation) throw new CredentialError('This credential changed while it was connecting. Try again.', 409);
    try {
      const tokens = JSON.parse(response.body);
      if (response.status >= 400 || typeof tokens.access_token !== 'string' || !tokens.access_token || tokens.access_token.length > 10000 || /[\r\n]/.test(tokens.access_token) || tokens.token_type && String(tokens.token_type).toLowerCase() !== 'bearer') throw new Error('invalid token response');
      if (tokens.refresh_token !== undefined && (typeof tokens.refresh_token !== 'string' || tokens.refresh_token.length > 10000)) throw new Error('invalid refresh token');
      if (tokens.expires_in !== undefined && (!Number.isFinite(Number(tokens.expires_in)) || Number(tokens.expires_in) <= 0)) throw new Error('invalid expiry');
      if (this.credentials.row(ref).config !== row.config || JSON.stringify(this.credentials.fields(ref)) !== JSON.stringify(fields) || (this.generations.get(ref) || 0) !== generation) throw new CredentialError('This credential changed while it was connecting. Try again.', 409);
      this.credentials.updateFields(ref, { accessToken: tokens.access_token, refreshToken: tokens.refresh_token ?? fields.refreshToken ?? '', expiresAt: tokens.expires_in === undefined ? '' : String(Date.now() + Number(tokens.expires_in) * 1000) });
      this.credentials.setStatus(ref, 'connected');
    } catch (error) {
      if (this.credentials.has(ref) && this.credentials.row(ref).config === row.config && (this.generations.get(ref) || 0) === generation && !(error instanceof CredentialError)) this.credentials.setStatus(ref, 'needs-reconnection');
      throw error instanceof CredentialError ? error : new CredentialError('OAuth2 could not obtain a token. Check the connection settings and reconnect.', 409);
    }
  }
}
