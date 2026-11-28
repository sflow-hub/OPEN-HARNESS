import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { importJWK, jwtVerify, type JWK } from 'jose';
import type { Actor, Workspace, WorkspaceRole } from '../lib/product';
import { ProductError, integer, text } from './product-error';
import { accountDisplayName } from '../lib/display-name';

export const actorContext = new AsyncLocalStorage<Actor>();
const roles = new Set<WorkspaceRole>(['owner', 'operator', 'viewer']);
export class Workspaces {
  readonly id: string;
  constructor(private db: DatabaseSync, stateRoot: string) {
    db.exec(`CREATE TABLE IF NOT EXISTS workspace_identity(id TEXT PRIMARY KEY,name TEXT NOT NULL,edition TEXT NOT NULL,events_days INTEGER NOT NULL DEFAULT 30,audit_days INTEGER NOT NULL DEFAULT 365,backups_days INTEGER NOT NULL DEFAULT 30);
      CREATE TABLE IF NOT EXISTS human_members(actor_id TEXT PRIMARY KEY,role TEXT NOT NULL,revoked INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS human_run_owners(run_id TEXT PRIMARY KEY,actor_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS human_audit(id TEXT PRIMARY KEY,actor_id TEXT NOT NULL,operation TEXT NOT NULL,resource TEXT NOT NULL,created_at TEXT NOT NULL);`);
    if (!(db.prepare('PRAGMA table_info(human_members)').all() as { name: string }[]).some(column => column.name === 'valid_until')) db.exec('ALTER TABLE human_members ADD COLUMN valid_until INTEGER');
    if (!(db.prepare('PRAGMA table_info(human_members)').all() as { name: string }[]).some(column => column.name === 'display_name')) db.exec('ALTER TABLE human_members ADD COLUMN display_name TEXT');
    const saved = db.prepare('SELECT id FROM workspace_identity LIMIT 1').get() as { id: string } | undefined;
    this.id = saved?.id || process.env.OPEN_HARNESS_WORKSPACE_ID || `local-${createHash('sha256').update(stateRoot).digest('hex').slice(0, 20)}`;
    if (saved && process.env.OPEN_HARNESS_WORKSPACE_ID && saved.id !== process.env.OPEN_HARNESS_WORKSPACE_ID) throw new ProductError('This data folder belongs to another workspace. Startup stopped.', 409);
    if (!saved) db.prepare('INSERT INTO workspace_identity(id,name,edition) VALUES(?,?,?)').run(this.id, 'My workspace', process.env.OPEN_HARNESS_EDITION === 'managed' ? 'managed' : 'self-hosted');
    db.prepare("INSERT OR IGNORE INTO human_members(actor_id,role,revoked,created_at) VALUES('local-owner','owner',0,?)").run(new Date().toISOString());
    if(!saved)db.prepare("INSERT OR IGNORE INTO human_run_owners SELECT id,'local-owner' FROM runs").run();
  }
  localOwner(): Actor { return { id: 'local-owner', workspaceId: this.id, role: 'owner', source: 'local' }; }
  actor(): Actor { return actorContext.getStore() || this.localOwner(); }
  controllerName(id:string) { const row=this.db.prepare('SELECT display_name FROM human_members WHERE actor_id=?').get(id) as {display_name:string|null}|undefined;return accountDisplayName(row?.display_name)||(id===this.actor().id?'You':id==='local-owner'?'Workspace owner':'Workspace operator'); }
  async relayActor(assertion: unknown): Promise<Actor> {
    if (typeof assertion !== 'string' || assertion.length > 12000) throw new ProductError('A workspace identity assertion is required.', 401);
    const issuer = process.env.OPEN_HARNESS_RELAY_ISSUER, publicKey = process.env.OPEN_HARNESS_RELAY_PUBLIC_JWK;
    if (!issuer || !publicKey) throw new ProductError('Workspace relay identity is not configured.', 503);
    try {
      const key = await importJWK(JSON.parse(publicKey) as JWK, 'EdDSA');
      const { payload } = await jwtVerify(assertion, key, { algorithms: ['EdDSA'], issuer, audience: `open-harness:${this.id}`, maxTokenAge: '60s' });
      if (payload.workspaceId !== this.id || typeof payload.sub !== 'string' || !payload.sub || !roles.has(payload.role as WorkspaceRole) || typeof payload.exp !== 'number' || typeof payload.iat !== 'number' || payload.exp <= payload.iat || payload.exp - payload.iat > 60) throw new Error('Invalid actor');
      const revoked = this.db.prepare('SELECT revoked FROM human_members WHERE actor_id=?').get(payload.sub) as { revoked: number } | undefined;
      if (revoked?.revoked) throw new Error('Revoked');
      this.db.prepare('INSERT INTO human_members(actor_id,role,revoked,created_at,valid_until,display_name) VALUES(?,?,0,?,?,?) ON CONFLICT(actor_id) DO UPDATE SET role=excluded.role,valid_until=excluded.valid_until,display_name=COALESCE(excluded.display_name,human_members.display_name)').run(payload.sub, payload.role as string, new Date().toISOString(), payload.exp * 1000, accountDisplayName(payload.displayName) || null);
      return { id: payload.sub, workspaceId: this.id, role: payload.role as WorkspaceRole, source: 'oidc' };
    } catch { throw new ProductError('Workspace identity is invalid, expired, or revoked.', 401); }
  }
  get(): Workspace {
    const row = this.db.prepare('SELECT * FROM workspace_identity WHERE id=?').get(this.id) as { name: string; edition: Workspace['edition']; events_days: number; audit_days: number; backups_days: number };
    return { id: this.id, name: row.name, edition: row.edition, actor: this.actor(), retention: { eventsDays: row.events_days, auditDays: row.audit_days, backupsDays: row.backups_days } };
  }
  update(input: Record<string, unknown>) {
    this.requireOwner(); const current = this.get();
    const retention = input.retention as Record<string, unknown> | undefined;
    this.db.prepare('UPDATE workspace_identity SET name=?,events_days=?,audit_days=?,backups_days=? WHERE id=?').run(input.name === undefined ? current.name : text(input.name, 'Workspace name', 100), retention?.eventsDays === undefined ? current.retention.eventsDays : integer(retention.eventsDays, 'Event retention', 1, 3650), retention?.auditDays === undefined ? current.retention.auditDays : integer(retention.auditDays, 'Audit retention', 1, 3650), retention?.backupsDays === undefined ? current.retention.backupsDays : integer(retention.backupsDays, 'Backup retention', 1, 365), this.id);
    this.audit('workspace.update', this.id); return this.get();
  }
  requireOwner() { if (this.actor().role !== 'owner') throw new ProductError('Only the workspace owner can change these settings.', 403); }
  requireWrite() { if (this.actor().role === 'viewer') throw new ProductError('This workspace is read-only for your account.', 403); }
  authorize(method: string, path: string) {
    const actor = this.actor(); if (actor.role === 'owner') return;
    if (/^\/internal\//.test(path)) throw new ProductError('Agent tools require their own run identity.', 403);
    if (method === 'GET' && /^\/v1\/(?:agents$|routines\/[^/]+\/history$)/.test(path)) return;
    if (actor.role === 'operator' && method === 'GET' && path === '/v1/approvals') return;
    if (actor.role === 'operator' && /^(POST|DELETE)$/.test(method) && /^\/v1\/conversations(?:\/|$)/.test(path)) return;
    if (method === 'GET' && /^\/v1\/(?:client-status$|client-agents$|capabilities|workspace(?:\/model)?$|assistant(?:\/(?:starters|preferences))?$|readiness$|runs(?:\/|$)|conversations(?:\/|$)|routines$|tasks(?:\/|$)|boards(?:\/|$)|teams(?:\/|$)|groups(?:\/|$)|responsibilities(?:\/|$)|workflow-drafts(?:\/|$)|workflows(?:\/|$)|files(?:\/|$)|metrics$|actions(?:\/|$)|connections(?:\/|$))/.test(path)) return;
    if (method === 'GET' && /^\/v1\/agents\/[^/]+\/desktop\/status$/.test(path)) return;
    if (actor.role === 'operator' && /^\/v1\/connections(?:\/|$)/.test(path) && /^(POST|PATCH|DELETE)$/.test(method)) return;
    if(actor.role==='operator'&&method==='POST'&&/^\/v1\/agents\/[^/]+\/terminal$/.test(path))return;
    if(actor.role==='operator'&&method==='GET'&&/^\/v1\/agents\/[^/]+\/desktop\/(?:status|frame)$/.test(path))return;
    if(actor.role==='operator'&&(/^\/v1\/delivery\/(?:native|subscriptions)$/.test(path)&&['POST','DELETE'].includes(method)||path==='/v1/delivery'&&method==='GET'))return;
    if (actor.role === 'operator' && /^(POST|PATCH)$/.test(method) && /^\/v1\/(runs(?:\/|$)|responsibilities(?:\/|$)|assistant(?:\/|$)|actions(?:\/|$)|workflow-drafts(?:\/|$)|workflows(?:\/|$)|groups(?:\/|$)|tasks(?:\/|$)|approvals(?:\/|$)|agents\/[^/]+\/desktop\/(?:take-control|release|input|record-start|record-stop|stream)(?:\/|$))/.test(path)) return;
    throw new ProductError('Your workspace role does not permit this operation.', 403);
  }
  ownRun(runId: string) { this.db.prepare('INSERT OR IGNORE INTO human_run_owners VALUES(?,?)').run(runId, this.actor().id); }
  runActor(runId: string): Actor {
    const owner=this.db.prepare('SELECT actor_id FROM human_run_owners WHERE run_id=?').get(runId) as {actor_id:string}|undefined;if(!owner)throw new ProductError('This task has no current workspace permission.',403);return this.memberActor(owner.actor_id);
  }
  memberActor(id:string):Actor{
    const row = this.db.prepare('SELECT * FROM human_members WHERE actor_id=?').get(id) as { actor_id: string; role: WorkspaceRole; revoked: number; valid_until: number | null } | undefined;
    if (!row || row.revoked || row.role === 'viewer' || (process.env.OPEN_HARNESS_REQUIRE_RELAY_IDENTITY === '1' && (row.actor_id === 'local-owner' || !row.valid_until || row.valid_until <= Date.now()))) throw new ProductError('The person who started this task needs an active workspace permission.', 403);
    return { id: row.actor_id, workspaceId: this.id, role: row.role, source: row.actor_id === 'local-owner' ? 'local' : 'oidc' };
  }
  synchronize(input: Record<string, unknown>) {
    this.requireOwner(); if (this.actor().source !== 'oidc') throw new ProductError('Membership renewal requires the authenticated relay.', 403);
    if (!Array.isArray(input.members) || input.members.length > 200) throw new ProductError('Invalid workspace membership renewal.');
    const validUntil = integer(input.validUntil, 'Permission expiry', Date.now(), Date.now() + 65000);
    for (const value of input.members as { id: string; role: WorkspaceRole; revoked: boolean }[]) { if (!roles.has(value.role)) throw new ProductError('Invalid human workspace role.'); this.db.prepare('INSERT INTO human_members(actor_id,role,revoked,created_at,valid_until) VALUES(?,?,?,?,?) ON CONFLICT(actor_id) DO UPDATE SET role=excluded.role,revoked=excluded.revoked,valid_until=excluded.valid_until').run(text(value.id,'Member identity',200),value.role,value.revoked?1:0,new Date().toISOString(),validUntil); }
    return { ok: true };
  }
  audit(operation: string, resource: string) { this.db.prepare('INSERT INTO human_audit VALUES(?,?,?,?,?)').run(randomUUID(), this.actor().id, operation.slice(0, 100), resource.slice(0, 200), new Date().toISOString()); }
}
