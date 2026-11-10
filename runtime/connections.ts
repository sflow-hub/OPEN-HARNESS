/* eslint-disable @typescript-eslint/no-explicit-any */
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { Actor, AppId, Connection } from '../lib/product';
import { integer, object, ProductError, text } from './product-error';

type Secrets = { set(name: string, value: string): void; delete(name: string): unknown; environment(): Record<string, string> };
type Row = { id: string; app: AppId; account: string; owner_id: string; shared_json: string; scopes_json: string; state: Connection['state']; last_error: string | null; secret_ref: string; expires_at: number; updated_at: string };
type Token = { access_token: string; refresh_token?: string; expires_at: number; token_type?: string };
export type PreparedOperation = { operation: string; resource: string; readOnly: boolean; summary: string; request: Record<string, any> };
const googleBase = 'https://www.googleapis.com/auth/';
const appScopes: Record<AppId, { read: string[]; write: string[] }> = {
  gmail: { read: [googleBase + 'gmail.readonly'], write: [googleBase + 'gmail.compose', googleBase + 'gmail.send'] },
  calendar: { read: [googleBase + 'calendar.events.readonly'], write: [googleBase + 'calendar.events'] },
  drive: { read: [googleBase + 'drive.readonly'], write: [googleBase + 'drive.file'] },
  sheets: { read: [googleBase + 'spreadsheets.readonly'], write: [googleBase + 'spreadsheets'] },
  github: { read: ['github:read'], write: ['github:write'] },
};
const operations: Record<AppId, string[]> = {
  gmail: ['gmail.list','gmail.get','gmail.drafts','gmail.draft','gmail.create_draft','gmail.send'], calendar: ['calendar.list','calendar.create'], drive: ['drive.list','drive.read','drive.create_document'], sheets: ['sheets.read','sheets.update'], github: ['github.issues','github.issue','github.pull_requests','github.comment','github.create_pull_request'],
};
const operationInputs:Record<string,string>={
  'gmail.list':'{query?: Gmail search query, limit?: 1..100}', 'gmail.get':'{messageId: string}', 'gmail.drafts':'{limit?: 1..100}', 'gmail.draft':'{draftId: string}', 'gmail.create_draft':'{to: email or email[], subject: string, body: plain text}', 'gmail.send':'{draftId: string}; the current draft recipients, subject and full message are bound to the approval',
  'calendar.list':'{calendarId?: "primary", timeMin?: ISO timestamp, limit?: 1..100}', 'calendar.create':'{calendarId?: "primary", title: string, description?: string, start: ISO timestamp with timezone, end: ISO timestamp with timezone}',
  'drive.list':'{query?: Drive files query, limit?: 1..100}', 'drive.read':'{fileId: string}', 'drive.create_document':'{title: string, content: plain text, folderId?: string}',
  'sheets.read':'{spreadsheetId: string, range: A1 range}', 'sheets.update':'{spreadsheetId: string, range: A1 range, values: rows of simple cell values}; exact reviewed cells must still match before writing',
  'github.issues':'{repo: "owner/repository"}', 'github.issue':'{repo: "owner/repository", issueNumber: integer}', 'github.pull_requests':'{repo: "owner/repository", state?: "open"|"closed"|"all"}', 'github.comment':'{repo: "owner/repository", issueNumber: integer, body: string}', 'github.create_pull_request':'{repo: "owner/repository", title: string, body: string, files: [{path: repository-relative source path, content: string}], testEvidence: observed test commands and results}; binds the current default-branch commit; creates a draft only',
};
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const equal = (left: string, right: string) => left.length === right.length && timingSafeEqual(Buffer.from(left), Buffer.from(right));
const safeId = (value: unknown, label: string, max = 200) => { const id = text(value, label, max); if (!/^[A-Za-z0-9_.@:-]+$/.test(id)) throw new ProductError(`${label} contains unsupported characters.`); return id; };
const encoded = encodeURIComponent;
const trustedOrigins = new Set(['https://oauth2.googleapis.com','https://www.googleapis.com','https://gmail.googleapis.com','https://sheets.googleapis.com','https://api.github.com','https://github.com']);

export class Connections {
  private refreshes = new Map<string, Promise<string>>();
  constructor(private db: DatabaseSync, private secrets: Secrets, private actor: () => Actor, private request: typeof fetch = fetch) {
    db.exec(`CREATE TABLE IF NOT EXISTS app_connections(id TEXT PRIMARY KEY,app TEXT NOT NULL,account TEXT NOT NULL,owner_id TEXT NOT NULL,shared_json TEXT NOT NULL,scopes_json TEXT NOT NULL,state TEXT NOT NULL,last_error TEXT,secret_ref TEXT NOT NULL,expires_at INTEGER NOT NULL,updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS app_oauth(state_hash TEXT PRIMARY KEY,app TEXT NOT NULL,actor_id TEXT NOT NULL,binding_hash TEXT NOT NULL,verifier_ref TEXT NOT NULL,scopes_json TEXT NOT NULL,shared_json TEXT NOT NULL,redirect_uri TEXT NOT NULL,expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS connection_accounts(connection_id TEXT PRIMARY KEY,subject TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS connection_cursors(connection_id TEXT PRIMARY KEY,cursor_json TEXT NOT NULL,checked_at TEXT NOT NULL,last_error TEXT);`);
    if(!(db.prepare('PRAGMA table_info(app_oauth)').all() as {name:string}[]).some(column=>column.name==='connection_id'))db.exec('ALTER TABLE app_oauth ADD COLUMN connection_id TEXT');
  }
  private map(row: Row): Connection { return { id: row.id, app: row.app, account: row.account, ownerId: row.owner_id, sharedAgentIds: JSON.parse(row.shared_json), scopes: JSON.parse(row.scopes_json), state: row.state, lastError: row.last_error, updatedAt: row.updated_at }; }
  catalog() { return Object.keys(appScopes).map(app => ({ id: app, label: ({ gmail: 'Gmail', calendar: 'Google Calendar', drive: 'Google Drive', sheets: 'Google Sheets', github: 'GitHub' } as Record<string, string>)[app], configured: Boolean(this.client(app as AppId).id && this.client(app as AppId).secret), operations: operations[app as AppId],operationInputs:Object.fromEntries(operations[app as AppId].map(operation=>[operation,operationInputs[operation]])) })); }
  list(agentId?: string) { return (this.db.prepare('SELECT * FROM app_connections ORDER BY account,app').all() as Row[]).filter(row => agentId ? JSON.parse(row.shared_json).includes(agentId) : row.owner_id === this.actor().id).map(row => this.map(row)); }
  get(id: string, agentId?: string) { return this.map(this.authorized(id, agentId)); }
  private row(id: string) { const row = this.db.prepare('SELECT * FROM app_connections WHERE id=?').get(id) as Row | undefined; if (!row) throw new ProductError('Connected account not found.', 404); return row; }
  private authorized(id: string, agentId?: string) {
    const row = this.row(id); if (this.actor().role === 'viewer' || (agentId ? !JSON.parse(row.shared_json).includes(agentId) : row.owner_id !== this.actor().id)) throw new ProductError('This account has not been shared with this actor or agent.', 403); return row;
  }
  private client(app: AppId) { const key = app === 'github' ? 'GITHUB' : 'GOOGLE'; return { id: process.env[`OPEN_HARNESS_${key}_CLIENT_ID`] || '', secret: this.secrets.environment()[`APP_${key}_CLIENT_SECRET`] || process.env[`OPEN_HARNESS_${key}_CLIENT_SECRET`] || '' }; }
  private agents(value: unknown) { const ids = Array.isArray(value) ? [...new Set(value.map(String))] : []; if (ids.length > 50 || ids.some(id => !this.db.prepare('SELECT 1 FROM agent_profiles WHERE id=?').get(id))) throw new ProductError('Choose existing agents to share this account with.'); return ids; }
  share(id: string, ids: unknown) { const row = this.row(id); if (row.owner_id !== this.actor().id || this.actor().role === 'viewer') throw new ProductError('Only this account’s owner can change its sharing.', 403); this.db.prepare('UPDATE app_connections SET shared_json=?,updated_at=? WHERE id=?').run(JSON.stringify(this.agents(ids)), new Date().toISOString(), id); return this.get(id); }
  oauthStart(app: string, input: Record<string, unknown>, redirectUri: string) {
    if (!Object.hasOwn(appScopes,app)) throw new ProductError('Choose a supported app.'); if (this.actor().role === 'viewer') throw new ProductError('Your account cannot connect an app.', 403);
    const existing=input.connectionId?this.authorized(String(input.connectionId)):null;if(existing&&existing.app!==app)throw new ProductError('Reconnect the original app for this account.');
    const client = this.client(app as AppId); if (!client.id || !client.secret) throw new ProductError('This app connection needs its OAuth registration. Ask the server owner to configure it.', 503);
    const redirect = new URL(redirectUri); if (redirect.protocol !== 'https:' && !(redirect.protocol === 'http:' && ['localhost','127.0.0.1'].includes(redirect.hostname))) throw new ProductError('App authorization requires HTTPS or a local development callback.');
    const state = randomBytes(32).toString('base64url'), binding = randomBytes(32).toString('base64url'), verifier = randomBytes(48).toString('base64url'), ref = `OAUTH_${randomUUID().replaceAll('-', '').toUpperCase()}`;
    const scopes = [...appScopes[app as AppId].read, ...(input.access === 'write' ? appScopes[app as AppId].write : [])];
    this.secrets.set(ref, verifier);
    this.db.prepare('INSERT INTO app_oauth(state_hash,app,actor_id,binding_hash,verifier_ref,scopes_json,shared_json,redirect_uri,expires_at,connection_id) VALUES(?,?,?,?,?,?,?,?,?,?)').run(hash(state), app, this.actor().id, hash(binding), ref, JSON.stringify(scopes), JSON.stringify(this.agents(input.sharedAgentIds)), redirectUri, Date.now() + 10 * 60000,existing?.id||null);
    const url = new URL(app === 'github' ? 'https://github.com/login/oauth/authorize' : 'https://accounts.google.com/o/oauth2/v2/auth');
    url.searchParams.set('client_id', client.id); url.searchParams.set('redirect_uri', redirectUri); url.searchParams.set('state', state); url.searchParams.set('response_type', 'code'); url.searchParams.set('code_challenge', createHash('sha256').update(verifier).digest('base64url')); url.searchParams.set('code_challenge_method', 'S256');
    if (app !== 'github') { url.searchParams.set('scope', ['openid','email', ...scopes].join(' ')); url.searchParams.set('access_type', 'offline'); url.searchParams.set('include_granted_scopes', 'true'); url.searchParams.set('prompt', 'consent'); }
    else url.searchParams.set('scope', 'offline_access');
    if(existing)url.searchParams.set(app==='github'?'login':'login_hint',existing.account);
    return { authorizationUrl: url.href, binding, state, expiresAt: new Date(Date.now() + 10 * 60000).toISOString() };
  }
  async oauthComplete(state: string, code: string, binding: string) {
    const row = this.db.prepare('SELECT * FROM app_oauth WHERE state_hash=?').get(hash(state)) as { app: AppId; actor_id: string; binding_hash: string; verifier_ref: string; scopes_json: string; shared_json: string; redirect_uri: string; expires_at: number;connection_id:string|null } | undefined;
    if (!row || row.expires_at <= Date.now() || !equal(hash(binding), row.binding_hash)) throw new ProductError('This account connection is invalid or expired. Start it again from your workspace.', 401);
    const member=this.db.prepare('SELECT role,revoked FROM human_members WHERE actor_id=?').get(row.actor_id) as {role:string;revoked:number}|undefined;if(!member||member.revoked||member.role==='viewer')throw new ProductError('This account no longer has permission to connect an app.',403);
    const verifier = this.secrets.environment()[row.verifier_ref]; if (!verifier) throw new ProductError('The authorization verifier is unavailable. Start again.', 409);
    this.db.prepare('DELETE FROM app_oauth WHERE state_hash=?').run(hash(state)); this.secrets.delete(row.verifier_ref);
    const client = this.client(row.app), token = await this.http(row.app === 'github' ? 'https://github.com/login/oauth/access_token' : 'https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body: new URLSearchParams({ grant_type: 'authorization_code', code: text(code, 'Authorization code', 4000), client_id: client.id, client_secret: client.secret, redirect_uri: row.redirect_uri, code_verifier: verifier }).toString() });
    if (typeof token.access_token !== 'string' || !token.access_token) throw new ProductError('The app did not return a usable account credential. Try connecting again.', 502);
    const account = await this.http(row.app === 'github' ? 'https://api.github.com/user' : 'https://www.googleapis.com/oauth2/v3/userinfo', { headers: this.headers(token.access_token, row.app) });
    if (row.app !== 'github' && account.email_verified !== true) throw new ProductError('Use a verified Google account.', 403);
    const existing=row.connection_id?this.row(row.connection_id):null,accountName=text(row.app==='github'?account.login:account.email,'Account name',250),subject=text(row.app==='github'?String(account.id||''):account.sub,'Account identity',255),previousIdentity=existing?this.db.prepare('SELECT subject FROM connection_accounts WHERE connection_id=?').get(existing.id) as {subject:string}|undefined:undefined;
    if(existing&&!previousIdentity)throw new ProductError('This saved connection needs account identity verification. Disconnect it, connect the account again, and review its agent sharing and routine grants.',409);
    if(existing&&(existing.owner_id!==row.actor_id||existing.app!==row.app||previousIdentity?.subject!==subject))throw new ProductError('Choose the original account when reconnecting, or add this account separately.',409);
    const id = existing?.id||randomUUID(), ref = existing?.secret_ref||`CONNECTION_${id.replaceAll('-', '').toUpperCase()}`, expiresAt = Date.now() + Number(token.expires_in || 3600) * 1000,previous=existing?this.secrets.environment()[existing.secret_ref]:undefined;
    const granted: string[] = row.app === 'github' ? JSON.parse(row.scopes_json) : String(token.scope || '').split(' ').filter(Boolean);
    const wanted = JSON.parse(row.scopes_json) as string[], available = wanted.filter(scope => granted.includes(scope));
    const record: Token = { access_token: token.access_token, refresh_token: token.refresh_token|| (previous?JSON.parse(previous).refresh_token:undefined), expires_at: expiresAt, token_type: token.token_type };
    this.secrets.set(ref, JSON.stringify(record));
    this.db.exec('SAVEPOINT connection_credentials');
    try { if(existing)this.db.prepare('UPDATE app_connections SET account=?,shared_json=?,scopes_json=?,state=?,last_error=NULL,secret_ref=?,expires_at=?,updated_at=? WHERE id=?').run(accountName,row.shared_json,JSON.stringify(available),wanted.every(scope=>granted.includes(scope))?'connected':'needs_authorization',ref,expiresAt,new Date().toISOString(),id);else this.db.prepare('INSERT INTO app_connections VALUES(?,?,?,?,?,?,?,NULL,?,?,?)').run(id, row.app, accountName, row.actor_id, row.shared_json, JSON.stringify(available), wanted.every(scope => granted.includes(scope)) ? 'connected' : 'needs_authorization', ref, expiresAt, new Date().toISOString());this.db.prepare('INSERT OR IGNORE INTO connection_accounts VALUES(?,?)').run(id,subject);this.db.exec('RELEASE connection_credentials'); }
    catch (error) { this.db.exec('ROLLBACK TO connection_credentials; RELEASE connection_credentials');if(previous)this.secrets.set(ref,previous);else this.secrets.delete(ref); throw error; }
    return this.map(this.row(id));
  }
  private headers(token: string, app: AppId) { return { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(app === 'github' ? { 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'Open-Harness' } : {}) }; }
  private async http(url: string, init: RequestInit = {}): Promise<any> {
    const address = new URL(url); if (!trustedOrigins.has(address.origin) || address.username || address.password) throw new ProductError('This app endpoint is not permitted.', 403);
    let response: Response;
    try { response = await this.request(address, { ...init, redirect: 'error', signal: AbortSignal.timeout(20_000) }); } catch { throw new ProductError('The connected app did not confirm its response. Check the action before retrying.', 502); }
    if (!response.ok) throw Object.assign(new ProductError(response.status === 401 ? 'This account needs authorization again.' : response.status === 429 ? 'The connected app is rate limiting requests. Try again later.' : `The connected app rejected this request (HTTP ${response.status}).`, response.status === 401 ? 401 : 502),{upstreamStatus:response.status});
    const reader = response.body?.getReader(); let size = 0, data = ''; const decoder = new TextDecoder();
    if (reader) { try { for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > 4_000_000) throw new ProductError('This app result is too large. Narrow the request.', 413); data += decoder.decode(value, { stream: true }); } data += decoder.decode(); } catch (error) { await reader.cancel().catch(() => {}); throw error; } }
    if (!data) return {};if(address.pathname.endsWith('/export')||address.searchParams.get('alt')==='media')return {text:data};try { return JSON.parse(data); } catch { return { text: data }; }
  }
  private async access(row: Row) {
    if (row.state !== 'connected') throw new ProductError('Reconnect this account before using it.', 409);
    const saved = this.secrets.environment()[row.secret_ref]; if (!saved) throw new ProductError('This account credential is unavailable. Reconnect it.', 409);
    const token = JSON.parse(saved) as Token; if (token.expires_at > Date.now() + 60000) return token.access_token;
    if (this.refreshes.has(row.id)) return this.refreshes.get(row.id)!;
    const refresh = (async () => {
      try {
        if (!token.refresh_token) throw new Error('No refresh token'); const client = this.client(row.app);
        const updated = await this.http(row.app === 'github' ? 'https://github.com/login/oauth/access_token' : 'https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' }, body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: token.refresh_token, client_id: client.id, client_secret: client.secret }).toString() });
        if (typeof updated.access_token !== 'string') throw new Error('Invalid credential');
        const current = this.row(row.id); if (current.state !== 'connected') throw new Error('Revoked');if(this.secrets.environment()[row.secret_ref]!==saved)return (JSON.parse(this.secrets.environment()[row.secret_ref]!) as Token).access_token;
        token.access_token = updated.access_token; token.refresh_token = updated.refresh_token || token.refresh_token; token.expires_at = Date.now() + Number(updated.expires_in || 3600) * 1000;
        this.secrets.set(row.secret_ref, JSON.stringify(token)); this.db.prepare('UPDATE app_connections SET expires_at=?,last_error=NULL,updated_at=? WHERE id=?').run(token.expires_at, new Date().toISOString(), row.id); return token.access_token;
      } catch { if(this.row(row.id).state==='connected'&&this.secrets.environment()[row.secret_ref]!==saved){const current=this.secrets.environment()[row.secret_ref];if(current)return (JSON.parse(current) as Token).access_token;}this.db.prepare("UPDATE app_connections SET state=CASE WHEN state='revoked' THEN state ELSE 'needs_authorization' END,last_error='Authorize this account again.',updated_at=? WHERE id=?").run(new Date().toISOString(), row.id); throw new ProductError('This account needs authorization again.', 409); }
      finally { this.refreshes.delete(row.id); }
    })(); this.refreshes.set(row.id, refresh); return refresh;
  }
  async revoke(id: string) {
    const row = this.row(id); if (row.owner_id !== this.actor().id && this.actor().role !== 'owner') throw new ProductError('Only this account’s owner or the workspace owner can disconnect it.', 403);
    this.db.prepare("UPDATE app_connections SET state='revoked',shared_json='[]',updated_at=? WHERE id=?").run(new Date().toISOString(), id);
    const saved = this.secrets.environment()[row.secret_ref]; this.secrets.delete(row.secret_ref);
    let confirmed=!saved;if(saved){try{const token=JSON.parse(saved) as Token;if(row.app==='github'){const client=this.client(row.app);await this.http(`https://api.github.com/applications/${encoded(client.id)}/token`,{method:'DELETE',headers:{Authorization:`Basic ${Buffer.from(client.id+':'+client.secret).toString('base64')}`,'Content-Type':'application/json'},body:JSON.stringify({access_token:token.access_token})});}else await this.http('https://oauth2.googleapis.com/revoke',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams({token:token.refresh_token||token.access_token}).toString()});confirmed=true;}catch{this.db.prepare("UPDATE app_connections SET last_error='Disconnected locally. The app did not confirm credential revocation.' WHERE id=?").run(id);}}
    return { ok: true,upstreamRevocationConfirmed:confirmed };
  }
  async health(id:string){const row=this.authorized(id);try{await this.api(id,row.app==='github'?'https://api.github.com/user':'https://www.googleapis.com/oauth2/v3/userinfo');this.db.prepare('UPDATE app_connections SET last_error=NULL,updated_at=? WHERE id=?').run(new Date().toISOString(),id);return {connection:this.get(id),checkedAt:new Date().toISOString()};}catch(error){this.db.prepare('UPDATE app_connections SET last_error=?,updated_at=? WHERE id=?').run(error instanceof ProductError?error.message:'This app did not confirm its health.',new Date().toISOString(),id);throw error;}}
  cleanup(){for(const row of this.db.prepare('SELECT verifier_ref FROM app_oauth WHERE expires_at<?').all(Date.now()) as {verifier_ref:string}[])this.secrets.delete(row.verifier_ref);this.db.prepare('DELETE FROM app_oauth WHERE expires_at<?').run(Date.now());}
  async api(id: string, url: string, init: RequestInit = {}, agentId?: string) { const row = this.authorized(id, agentId), token = await this.access(row); try { return await this.http(url, { ...init, headers: { ...this.headers(token, row.app), ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...init.headers } }); } catch (error) { if (error instanceof ProductError && error.status === 401) this.db.prepare("UPDATE app_connections SET state='needs_authorization',last_error='Authorize this account again.' WHERE id=?").run(id); throw error; } }
  async prepare(id: string, operation: string, input: Record<string, unknown>, agentId?: string): Promise<PreparedOperation> {
    const row = this.authorized(id, agentId); if (row.state !== 'connected') throw new ProductError('Reconnect this account before using it.', 409); if (!operations[row.app].includes(operation)) throw new ProductError('This operation does not belong to the connected app.');
    const readOnly = ['gmail.list','gmail.get','gmail.drafts','gmail.draft','calendar.list','drive.list','drive.read','sheets.read','github.issues','github.issue','github.pull_requests'].includes(operation);
    const scopes = JSON.parse(row.scopes_json) as string[], needed = readOnly ? appScopes[row.app].read : appScopes[row.app].write;
    if (!needed.every(scope => scopes.includes(scope))) throw new ProductError('This account needs additional authorization for that operation.', 409);
    const args: Record<string, any> = {}, query = input.query === undefined ? '' : text(input.query, 'Search query', 1000);
    let resource: string = row.app, summary = operation;
    if (row.app === 'gmail') {
      if(operation==='gmail.drafts')args.limit=integer(input.limit??20,'Result limit',1,100);if(operation==='gmail.draft'){args.draftId=safeId(input.draftId,'Draft');resource=args.draftId;}
      if (operation === 'gmail.list') { args.query = query; args.limit = integer(input.limit ?? 20, 'Result limit', 1, 100); }
      if (operation === 'gmail.get') { args.messageId = safeId(input.messageId, 'Message'); resource = args.messageId; }
      if (operation === 'gmail.create_draft') {
        const recipients = Array.isArray(input.to) ? input.to.map(String) : [String(input.to || '')];
        if (!recipients.length || recipients.length > 20 || recipients.some(email => !/^[A-Za-z0-9.!#$%&'*+\-/=?^_`{|}~]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(email))) throw new ProductError('Enter valid recipient email addresses.');
        args.to = recipients; args.subject = text(input.subject, 'Subject', 300); if (/[\r\n]/.test(args.subject)) throw new ProductError('The subject must be one line.'); args.body = text(input.body, 'Message body', 50000); resource = recipients.sort().join(','); summary = `Create a Gmail draft for ${resource}: ${args.subject}`;
      }
      if (operation === 'gmail.send') {
        args.draftId = safeId(input.draftId, 'Draft'); const draft = await this.api(id, `https://gmail.googleapis.com/gmail/v1/users/me/drafts/${encoded(args.draftId)}?format=full`, {}, agentId);
        const headers = draft.message?.payload?.headers || [], header = (name: string) => headers.find((value: any) => String(value.name).toLowerCase() === name)?.value || '';
        const plain: string[] = [], attachments: string[] = []; let parts = 0;
        const collect = (part: any, depth = 0) => {
          if (!part || depth > 12 || ++parts > 100) return;
          if (typeof part.filename === 'string' && part.filename) attachments.push(part.filename.slice(0,1000));
          const contentType = (part.headers || []).find((entry: any) => String(entry.name).toLowerCase() === 'content-type')?.value || '', charset = /charset\s*=\s*["']?([^;"'\s]+)/i.exec(contentType)?.[1];
          if (part.mimeType === 'text/plain' && !part.filename && (!charset || /^(?:utf-8|us-ascii)$/i.test(charset)) && typeof part.body?.data === 'string' && part.body.data.length <= 140000 && /^[A-Za-z0-9_=-]*$/.test(part.body.data)) { try { const data=part.body.data, bytes=Buffer.from(data,'base64url'); if(/^[A-Za-z0-9_-]+={0,2}$/.test(data) && bytes.toString('base64url')===data.replace(/=+$/,'') && (!data.includes('=') || data.length%4===0)) plain.push(new TextDecoder('utf-8',{fatal:true}).decode(bytes)); } catch { /* Omit a preview that cannot faithfully display the message. */ } }
          if (Array.isArray(part.parts)) for (const child of part.parts) collect(child, depth + 1);
        }; collect(draft.message?.payload);
        if (plain.length && plain.join('\n').length <= 100000) args.body = plain.join('\n');
        if (header('cc')) args.cc = header('cc'); if (header('bcc')) args.bcc = header('bcc'); if(attachments.length)args.attachments=attachments;
        args.draftHash = hash(JSON.stringify(draft.message)); args.messageId = header('message-id'); args.to = header('to'); args.subject = header('subject'); resource = String(args.to).toLowerCase(); summary = `Send the current Gmail draft to ${args.to}: ${args.subject}`;
      }
    } else if (row.app === 'calendar') {
      args.calendarId = safeId(input.calendarId || 'primary', 'Calendar'); resource = args.calendarId;
      if (operation === 'calendar.list') { args.timeMin = new Date(input.timeMin ? String(input.timeMin) : Date.now()).toISOString(); args.limit = integer(input.limit ?? 20, 'Result limit', 1, 100); }
      else { args.title = text(input.title, 'Event title', 300); args.description = String(input.description || '').slice(0, 10000); args.start = new Date(text(input.start, 'Start time', 100)).toISOString(); args.end = new Date(text(input.end, 'End time', 100)).toISOString(); if (Date.parse(args.end) <= Date.parse(args.start)) throw new ProductError('The event must end after it starts.'); summary = `Create ${args.title} on ${resource}, ${args.start}–${args.end}`; }
    } else if (row.app === 'drive') {
      if (operation === 'drive.list') { args.query = query; args.limit = integer(input.limit ?? 20, 'Result limit', 1, 100); }
      else if (operation === 'drive.read') { args.fileId = safeId(input.fileId, 'File'); resource = args.fileId; }
      else { args.title = text(input.title, 'Document title', 300); args.content = text(input.content, 'Document content', 100000); if (input.folderId) args.folderId = safeId(input.folderId, 'Folder'); resource = args.folderId || 'root'; summary = `Create Drive document ${args.title} in ${resource}`; }
    } else if (row.app === 'sheets') {
      args.spreadsheetId = safeId(input.spreadsheetId, 'Spreadsheet'); args.range = text(input.range, 'Cell range', 200); if (!/^[A-Za-z0-9_ '!:$.-]+$/.test(args.range)) throw new ProductError('Choose a valid spreadsheet range.'); resource = `${args.spreadsheetId}!${args.range}`;
      if (operation === 'sheets.update') { if (!Array.isArray(input.values) || !input.values.length || input.values.length > 100 || input.values.some(value => !Array.isArray(value) || value.length > 50 || value.some(cell => !['string','number','boolean'].includes(typeof cell) && cell !== null))) throw new ProductError('Supply up to 100 rows of simple cell values.'); args.values = input.values; const current = await this.api(id, `https://sheets.googleapis.com/v4/spreadsheets/${encoded(args.spreadsheetId)}/values/${encoded(args.range)}?valueRenderOption=UNFORMATTED_VALUE`, {}, agentId); args.beforeHash = hash(JSON.stringify(current.values || [])); summary = `Update ${input.values.length} rows in ${resource}`; }
    } else {
      args.repo = text(input.repo, 'Repository', 200); if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(args.repo)) throw new ProductError('Choose an owner/repository.'); resource = args.repo;
      if (['github.issue','github.comment'].includes(operation)) args.issueNumber = integer(input.issueNumber, 'Issue number', 1, 100000000);
      if(operation==='github.pull_requests'){args.state=String(input.state||'open');if(!['open','closed','all'].includes(args.state))throw new ProductError('Choose open, closed, or all pull requests.');}
      if (operation === 'github.comment') { args.body = text(input.body, 'Comment', 30000); summary = `Comment on ${resource}#${args.issueNumber}`; }
      if (operation === 'github.create_pull_request') { args.testEvidence=text(input.testEvidence,'Observed test commands and results',12000);const repo=await this.api(id,`https://api.github.com/repos/${args.repo}`,{},agentId);args.baseBranch=text(repo.default_branch,'Default branch',300);const head=await this.api(id,`https://api.github.com/repos/${args.repo}/git/ref/heads/${encoded(args.baseBranch)}`,{},agentId);args.baseSha=text(head.object?.sha,'Base commit',40);if(!/^[a-f0-9]{40}$/.test(args.baseSha))throw new ProductError('The repository did not confirm its base commit.',502);args.title = text(input.title, 'Pull request title', 300); args.body = text(input.body, 'Pull request description', 30000); if (!Array.isArray(input.files) || !input.files.length || input.files.length > 20) throw new ProductError('Provide 1–20 changed files.'); args.files = input.files.map(value => { const file = object(value), path = text(file.path, 'Repository file', 500); if (path.startsWith('/') || path.includes('\\') || path.split('/').some(part => !part||['..','.','.git'].includes(part)||part.startsWith('.env'))) throw new ProductError('Choose a repository-relative source path.'); return { path, content: text(file.content, 'File content', 100000) }; }); summary = `Create a draft pull request in ${resource}: ${args.title}`; }
    }
    return { operation, resource: String(resource), readOnly, summary, request: args };
  }
  async execute(id: string, operation: PreparedOperation, actionId: string, agentId?: string): Promise<any> {
    const a = operation.request, json = (value: unknown) => JSON.stringify(value), call = (url: string, method = 'GET', body?: unknown) => this.api(id, url, { method, ...(body === undefined ? {} : { body: json(body) }) }, agentId);
    switch (operation.operation) {
      case 'gmail.drafts': return call(`https://gmail.googleapis.com/gmail/v1/users/me/drafts?maxResults=${a.limit}`);
      case 'gmail.draft': return call(`https://gmail.googleapis.com/gmail/v1/users/me/drafts/${encoded(a.draftId)}?format=full`);
      case 'gmail.list': return call(`https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=${a.limit}&q=${encoded(a.query)}`);
      case 'gmail.get': return call(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encoded(a.messageId)}?format=full`);
      case 'gmail.create_draft': { const raw = Buffer.from(`To: ${a.to.join(', ')}\r\nSubject: =?UTF-8?B?${Buffer.from(a.subject).toString('base64')}?=\r\nMessage-ID: <${actionId}@open-harness.local>\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${Buffer.from(a.body).toString('base64')}`).toString('base64url'); return call('https://gmail.googleapis.com/gmail/v1/users/me/drafts', 'POST', { message: { raw } }); }
      case 'gmail.send': { const current = await call(`https://gmail.googleapis.com/gmail/v1/users/me/drafts/${encoded(a.draftId)}?format=full`); if (hash(json(current.message)) !== a.draftHash) throw new ProductError('The draft changed after approval. Review a new action.', 409); return call('https://gmail.googleapis.com/gmail/v1/users/me/drafts/send', 'POST', { id: a.draftId }); }
      case 'calendar.list': return call(`https://www.googleapis.com/calendar/v3/calendars/${encoded(a.calendarId)}/events?singleEvents=true&orderBy=startTime&timeMin=${encoded(a.timeMin)}&maxResults=${a.limit}`);
      case 'calendar.create': return call(`https://www.googleapis.com/calendar/v3/calendars/${encoded(a.calendarId)}/events`, 'POST', { id: actionId.replaceAll('-', ''), summary: a.title, description: a.description, start: { dateTime: a.start }, end: { dateTime: a.end }, extendedProperties: { private: { openHarnessAction: actionId } } });
      case 'drive.list': return call(`https://www.googleapis.com/drive/v3/files?pageSize=${a.limit}&fields=files(id,name,mimeType,webViewLink),nextPageToken${a.query ? '&q=' + encoded(a.query) : ''}`);
      case 'drive.read': { const metadata = await call(`https://www.googleapis.com/drive/v3/files/${encoded(a.fileId)}?fields=id,name,mimeType,webViewLink`); const content = await call(metadata.mimeType === 'application/vnd.google-apps.document' ? `https://www.googleapis.com/drive/v3/files/${encoded(a.fileId)}/export?mimeType=text%2Fplain` : `https://www.googleapis.com/drive/v3/files/${encoded(a.fileId)}?alt=media`); return { ...metadata, content }; }
      case 'drive.create_document': {
        const boundary = 'openharness' + actionId.replaceAll('-', ''), metadata = { name: a.title, mimeType: 'application/vnd.google-apps.document', ...(a.folderId ? { parents: [a.folderId] } : {}), appProperties: { openHarnessAction: actionId } };
        return this.api(id, 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink,appProperties', { method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body: `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${json(metadata)}\r\n--${boundary}\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n${a.content}\r\n--${boundary}--` }, agentId);
      }
      case 'sheets.read': return call(`https://sheets.googleapis.com/v4/spreadsheets/${encoded(a.spreadsheetId)}/values/${encoded(a.range)}?valueRenderOption=UNFORMATTED_VALUE`);
      case 'sheets.update': { const endpoint = `https://sheets.googleapis.com/v4/spreadsheets/${encoded(a.spreadsheetId)}/values/${encoded(a.range)}?valueRenderOption=UNFORMATTED_VALUE`, current = await call(endpoint); if (hash(json(current.values || [])) !== a.beforeHash) throw new ProductError('The spreadsheet changed after review. Prepare a new action.', 409); return call(endpoint + '&valueInputOption=RAW', 'PUT', { range: a.range, majorDimension: 'ROWS', values: a.values }); }
      case 'github.pull_requests': return call(`https://api.github.com/repos/${a.repo}/pulls?state=${a.state}&per_page=100`);
      case 'github.issues': return call(`https://api.github.com/repos/${a.repo}/issues?state=open&per_page=50`);
      case 'github.issue': return call(`https://api.github.com/repos/${a.repo}/issues/${a.issueNumber}`);
      case 'github.comment': return call(`https://api.github.com/repos/${a.repo}/issues/${a.issueNumber}/comments`, 'POST', { body: `${a.body}\n\n<!-- open-harness-action:${actionId} -->` });
      case 'github.create_pull_request': {
        const base = `https://api.github.com/repos/${a.repo}`, branch = `openharness/${actionId}`;
        const head = await call(`${base}/git/ref/heads/${encoded(a.baseBranch)}`);if(head.object.sha!==a.baseSha)throw new ProductError('The repository changed after review. Prepare a new pull request action.',409);const commit = await call(`${base}/git/commits/${a.baseSha}`);
        const tree = await call(`${base}/git/trees`, 'POST', { base_tree: commit.tree.sha, tree: a.files.map((file: any) => ({ path: file.path, mode: '100644', type: 'blob', content: file.content })) });
        const created = await call(`${base}/git/commits`, 'POST', { message: a.title, tree: tree.sha, parents: [a.baseSha] });
        await call(`${base}/git/refs`, 'POST', { ref: `refs/heads/${branch}`, sha: created.sha });
        return call(`${base}/pulls`, 'POST', { title: a.title, body: `${a.body}\n\n<!-- open-harness-action:${actionId} -->`, head: branch, base: a.baseBranch, draft: true });
      }
      default: throw new ProductError('Unsupported connected action.');
    }
  }
  async verify(id: string, operation: PreparedOperation, actionId: string, receipt: any, agentId?: string): Promise<{ passed: boolean; evidence: string; result?: any }> {
    const a = operation.request, call = (url: string) => this.api(id, url, {}, agentId);
    if (operation.readOnly) return { passed: true, evidence: 'The connected app returned this read response.', result: receipt };
    switch (operation.operation) {
      case 'calendar.create': { const result = await call(`https://www.googleapis.com/calendar/v3/calendars/${encoded(a.calendarId)}/events/${actionId.replaceAll('-', '')}`); return { passed: result.extendedProperties?.private?.openHarnessAction === actionId && result.summary === a.title && (result.description||'')===a.description && Date.parse(result.start?.dateTime)===Date.parse(a.start) && Date.parse(result.end?.dateTime)===Date.parse(a.end), evidence: `Read back calendar event ${result.id}.`, result }; }
      case 'sheets.update': { const result = await call(`https://sheets.googleapis.com/v4/spreadsheets/${encoded(a.spreadsheetId)}/values/${encoded(a.range)}?valueRenderOption=UNFORMATTED_VALUE`); return { passed: JSON.stringify(result.values || []) === JSON.stringify(a.values), evidence: `Read back spreadsheet range ${operation.resource}.`, result }; }
      case 'drive.create_document': { const result = await call(`https://www.googleapis.com/drive/v3/files?q=${encoded(`trashed=false and appProperties has { key='openHarnessAction' and value='${actionId}' }`)}&fields=files(id,name,webViewLink,appProperties)`), file = result.files?.find((file: any) => file.appProperties?.openHarnessAction === actionId); const content=file?await call(`https://www.googleapis.com/drive/v3/files/${encoded(file.id)}/export?mimeType=text%2Fplain`):null,normalize=(value:string)=>value.replaceAll('\r\n','\n').replace(/\n$/,'');return { passed: Boolean(file && file.name === a.title && typeof content?.text==='string' && normalize(content.text)===normalize(a.content)), evidence: file ? `Read back Drive document ${file.id}.` : 'No matching document was confirmed.', result: file }; }
      case 'github.comment': { const result = await call(`https://api.github.com/repos/${a.repo}/issues/${a.issueNumber}/comments?per_page=100`), comment = Array.isArray(result) && result.find((item: any) => item.body === `${a.body}\n\n<!-- open-harness-action:${actionId} -->`); return { passed: Boolean(comment), evidence: comment ? `Read back GitHub comment ${comment.id}.` : 'No matching comment was confirmed.', result: comment }; }
      case 'github.create_pull_request': { const result = await call(`https://api.github.com/repos/${a.repo}/pulls?state=all&head=${encoded(a.repo.split('/')[0] + ':openharness/' + actionId)}`), pr = Array.isArray(result) && result.find((item: any) => item.body?.includes(`<!-- open-harness-action:${actionId} -->`)); const files=pr?await call(`https://api.github.com/repos/${a.repo}/pulls/${pr.number}/files?per_page=100`):[],blob=(content:string)=>createHash('sha1').update(`blob ${Buffer.byteLength(content)}\0${content}`).digest('hex');return { passed: Boolean(pr && pr.draft===true && pr.base?.sha===a.baseSha && Array.isArray(files) && files.length===a.files.length && a.files.every((file:any)=>files.some((actual:any)=>actual.filename===file.path&&actual.sha===blob(file.content)))), evidence: pr ? `Read back pull request and file hashes ${pr.html_url}.` : 'No matching pull request was confirmed.', result: pr }; }
      case 'gmail.create_draft': { if (receipt?.id) { const result = await call(`https://gmail.googleapis.com/gmail/v1/users/me/drafts/${encoded(String(receipt.id))}?format=full`); const marker = result.message?.payload?.headers?.find((header: any) => String(header.name).toLowerCase() === 'message-id')?.value; return { passed: marker === `<${actionId}@open-harness.local>`, evidence: `Read back Gmail draft ${receipt.id}.`, result }; } return { passed: false, evidence: 'A draft receipt is needed before this creation can be confirmed.' }; }
      case 'gmail.send': { if (!a.messageId) return { passed: false, evidence: 'The draft had no stable Message-ID. Inspect the Sent folder before retrying.' }; const result = await call(`https://gmail.googleapis.com/gmail/v1/users/me/messages?q=${encoded(`in:sent rfc822msgid:${a.messageId}`)}`); return { passed: Boolean(result.messages?.length === 1), evidence: result.messages?.length === 1 ? `Confirmed message ${result.messages[0].id} in Sent.` : 'The sent message could not be confirmed.', result }; }
      default: return { passed: false, evidence: 'Inspect the destination before retrying.' };
    }
  }
}
