/* eslint-disable @typescript-eslint/no-explicit-any */
import { createHash, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { Actor, ActionIntent, ActionState } from '../lib/product';
import type { Connections, PreparedOperation } from './connections';
import { integer, object, ProductError, text } from './product-error';

type Row = { id: string; actor_id: string; agent_id: string | null; run_id: string | null; connection_id: string; request_id: string; input_hash: string; prepared_json: string; state: ActionState; result_json: string; receipt_json: string; evidence: string; grant_id: string | null; created_at: string; updated_at: string };
const canonical = (value: any): string => JSON.stringify(value && typeof value === 'object' ? Array.isArray(value) ? value.map(item => JSON.parse(canonical(item))) : Object.fromEntries(Object.keys(value).sort().map(key => [key, JSON.parse(canonical(value[key]))])) : value ?? null);
const digest = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
const scope = (prepared: PreparedOperation) => ({ ...prepared.request, beforeHash: undefined, draftHash: undefined });
const editableInputs: Record<string, string[]> = {
  'gmail.create_draft': ['to', 'subject', 'body'], 'gmail.send': ['draftId'],
  'calendar.create': ['calendarId', 'title', 'description', 'start', 'end'],
  'drive.create_document': ['title', 'content', 'folderId'], 'sheets.update': ['spreadsheetId', 'range', 'values'],
  'github.comment': ['repo', 'issueNumber', 'body'], 'github.create_pull_request': ['repo', 'title', 'body', 'files', 'testEvidence'],
};
export class Actions {
  constructor(private db: DatabaseSync, private connections: Connections, private actor: () => Actor,private changed?:(intent:ActionIntent,ownerId:string)=>void) {
    db.exec(`CREATE TABLE IF NOT EXISTS action_intents(id TEXT PRIMARY KEY,actor_id TEXT NOT NULL,agent_id TEXT,run_id TEXT,connection_id TEXT NOT NULL,request_id TEXT NOT NULL,input_hash TEXT NOT NULL,prepared_json TEXT NOT NULL,state TEXT NOT NULL,result_json TEXT NOT NULL DEFAULT 'null',receipt_json TEXT NOT NULL DEFAULT 'null',evidence TEXT NOT NULL DEFAULT '',grant_id TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,UNIQUE(actor_id,request_id));
      CREATE TABLE IF NOT EXISTS action_events(id TEXT PRIMARY KEY,action_id TEXT NOT NULL,type TEXT NOT NULL,evidence TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS action_grants(id TEXT PRIMARY KEY,connection_id TEXT NOT NULL,owner_id TEXT NOT NULL,workflow_id TEXT NOT NULL,revision INTEGER NOT NULL,operation TEXT NOT NULL,resource TEXT NOT NULL,scope_hash TEXT NOT NULL,max_actions INTEGER NOT NULL,used INTEGER NOT NULL DEFAULT 0,expires_at TEXT NOT NULL,revoked INTEGER NOT NULL DEFAULT 0,source_action_id TEXT NOT NULL,created_at TEXT NOT NULL);`);
    db.prepare("UPDATE action_intents SET state='uncertain',evidence='The coordinator restarted after dispatch. Check the destination before continuing.',updated_at=? WHERE state='dispatching'").run(new Date().toISOString());
  }
  private row(id: string) { const row = this.db.prepare('SELECT * FROM action_intents WHERE id=?').get(id) as Row | undefined; if (!row) throw new ProductError('Action not found.', 404); return row; }
  private permitted(row: Row, agentId?: string) {
    const account = this.connections.get(row.connection_id, agentId);
    if (this.actor().role === 'viewer' || (agentId ? row.agent_id !== agentId : row.actor_id !== this.actor().id && account.ownerId !== this.actor().id)) throw new ProductError('This action belongs to another actor.', 403);
    if (row.run_id) { const owner = this.db.prepare('SELECT m.role,m.revoked,m.valid_until FROM human_run_owners r JOIN human_members m ON m.actor_id=r.actor_id WHERE r.run_id=?').get(row.run_id) as { role: string; revoked: number; valid_until: number | null } | undefined; if (!owner || owner.revoked || owner.role === 'viewer' || process.env.OPEN_HARNESS_REQUIRE_RELAY_IDENTITY === '1' && (!owner.valid_until || owner.valid_until <= Date.now())) throw new ProductError('The person who started this work no longer has permission.', 403); }
    return account;
  }
  private recovery(runId:string){if(this.db.prepare("SELECT 1 FROM action_intents WHERE run_id=? AND state='uncertain' LIMIT 1").get(runId)||this.db.prepare("SELECT 1 FROM sqlite_master WHERE name='unclassified_actions' AND type='table'").get()&&this.db.prepare("SELECT 1 FROM unclassified_actions WHERE run_id=? AND state='uncertain' LIMIT 1").get(runId))throw new ProductError('Reconcile this task’s uncertain destination effects before another write.',409);}
  private mapped(row: Row): ActionIntent & { evidence: string } { const prepared = JSON.parse(row.prepared_json) as PreparedOperation; return { id: row.id, runId: row.run_id, connectionId: row.connection_id, operation: prepared.operation, resource: prepared.resource, summary: prepared.summary, request: prepared.request, state: row.state, result: JSON.parse(row.result_json), evidence: row.evidence, createdAt: row.created_at, updatedAt: row.updated_at }; }
  get(id: string, agentId?: string) { const row = this.row(id); this.permitted(row, agentId); return this.mapped(row); }
  list() { return (this.db.prepare('SELECT * FROM action_intents ORDER BY created_at DESC LIMIT 200').all() as Row[]).filter(row => { try { this.permitted(row); return true; } catch { return false; } }).map(row => this.mapped(row)); }
  private record(row: Row, state: ActionState, evidence: string, result: unknown = null, receipt: unknown = null) {
    const stamp = new Date().toISOString(); this.db.prepare('UPDATE action_intents SET state=?,result_json=?,receipt_json=?,evidence=?,updated_at=? WHERE id=?').run(state, JSON.stringify(result), JSON.stringify(receipt), evidence, stamp, row.id);
    this.db.prepare('INSERT INTO action_events VALUES(?,?,?,?,?)').run(randomUUID(), row.id, state, evidence, stamp);
    return this.mapped(this.row(row.id));
  }
  async prepare(input: Record<string, unknown>, agentId?: string, runId?: string) {
    const requestId = text(input.requestId, 'Request identity', 200), connectionId = text(input.connectionId, 'Connected account', 100), operation = text(input.operation, 'App operation', 100), args = object(input.input || {}), fingerprint = digest({ connectionId, operation, args, agentId, runId });
    const existing = this.db.prepare('SELECT * FROM action_intents WHERE actor_id=? AND request_id=?').get(this.actor().id, requestId) as Row | undefined;
    if (existing) { if (existing.input_hash !== fingerprint) throw new ProductError('This request identity was already used for a different action.', 409); return this.get(existing.id, agentId); }
    const prepared = await this.connections.prepare(connectionId, operation, args, agentId), stamp = new Date().toISOString(), id = randomUUID();
    if(runId&&!prepared.readOnly)this.recovery(runId);
    let state: ActionState = prepared.readOnly ? 'approved' : 'awaiting_approval', grantId: string | null = null;
    this.db.exec('SAVEPOINT prepare_action');
    try {
      if (!prepared.readOnly && input.grantId && runId && agentId) {
        const grant = this.db.prepare('SELECT g.* FROM action_grants g JOIN workflow_runs r ON r.workflow_id=g.workflow_id AND r.revision=g.revision JOIN workflows w ON w.id=g.workflow_id AND w.revision=g.revision AND w.reviewed_revision=g.revision WHERE g.id=? AND r.run_id=? AND w.agent_id=? AND g.connection_id=? AND g.operation=? AND g.resource=? AND g.scope_hash=? AND g.revoked=0 AND g.used<g.max_actions AND g.expires_at>?').get(String(input.grantId), runId, agentId, connectionId, operation, prepared.resource, digest(scope(prepared)), stamp) as { id: string } | undefined;
        if (!grant) throw new ProductError('This routine grant is expired or does not match this tested workflow and action.', 403);
        this.db.prepare('UPDATE action_grants SET used=used+1 WHERE id=?').run(grant.id); grantId = grant.id; state = 'approved';
      }
      this.db.prepare('INSERT INTO action_intents(id,actor_id,agent_id,run_id,connection_id,request_id,input_hash,prepared_json,state,grant_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(id, this.actor().id, agentId || null, runId || null, connectionId, requestId, fingerprint, JSON.stringify(prepared), state, grantId, stamp, stamp);
      this.db.exec('RELEASE prepare_action');
    } catch (error) { this.db.exec('ROLLBACK TO prepare_action; RELEASE prepare_action'); throw error; }
    const intent=this.get(id,agentId);if(intent.state==='awaiting_approval')this.changed?.(intent,this.connections.get(connectionId,agentId).ownerId);return intent;
  }
  decide(id: string, input: Record<string, unknown>) {
    const row = this.row(id), account = this.permitted(row);
    if (account.ownerId !== this.actor().id) throw new ProductError('Only the connected account’s owner can approve this write.', 403);
    if (row.state !== 'awaiting_approval') throw new ProductError('This action is no longer waiting for approval.', 409);
    if (input.confirmation !== digest(JSON.parse(row.prepared_json))) throw new ProductError('Review the current action before approving it.', 409);
    return this.record(row, input.approved === true ? 'approved' : 'denied', input.approved === true ? 'The account owner approved this exact action.' : 'The account owner denied this action.');
  }
  async revise(id: string, input: Record<string, unknown>) {
    const original = this.row(id), actorId = this.actor().id;
    const authorize = (row: Row) => {
      const account = this.permitted(row), member = this.db.prepare('SELECT role,revoked,valid_until FROM human_members WHERE actor_id=?').get(actorId) as { role: string; revoked: number; valid_until: number | null } | undefined;
      if (this.actor().id !== actorId || account.ownerId !== actorId || !member || member.revoked || member.role === 'viewer' || process.env.OPEN_HARNESS_REQUIRE_RELAY_IDENTITY === '1' && (!member.valid_until || member.valid_until <= Date.now())) throw new ProductError('Only the connected account’s current owner can revise this write.', 403);
      if (row.agent_id) this.connections.get(row.connection_id, row.agent_id);
      if (account.state !== 'connected') throw new ProductError('Reconnect this account before revising it.', 409);
      return account;
    };
    const account = authorize(original), before = JSON.parse(original.prepared_json) as PreparedOperation;
    if (Object.keys(input).some(key => !['confirmation', 'requestId', 'input'].includes(key))) throw new ProductError('Revise only the action’s editable input; its account and operation stay the same.');
    const confirmation = text(input.confirmation, 'Action confirmation', 100), requestId = text(input.requestId, 'Request identity', 200), args = JSON.parse(JSON.stringify(object(input.input))) as Record<string, unknown>;
    const keys = editableInputs[before.operation];
    if (before.readOnly || !keys || Object.keys(args).some(key => !keys.includes(key))) throw new ProductError('This action does not support those editable fields.');
    if (confirmation !== digest(before)) throw new ProductError('Review the current action before revising it.', 409);
    const fingerprint = digest({ revisionOf: id, confirmation, args, connectionId: original.connection_id, operation: before.operation, agentId: original.agent_id, runId: original.run_id });
    const retry = () => {
      const existing = this.db.prepare('SELECT * FROM action_intents WHERE actor_id=? AND request_id=?').get(original.actor_id, requestId) as Row | undefined;
      if (!existing) return;
      if (existing.input_hash !== fingerprint) throw new ProductError('This request identity was already used for a different action.', 409);
      return this.review(existing.id);
    };
    const existing = retry(); if (existing) return existing;
    if (original.state !== 'awaiting_approval') throw new ProductError('This action is no longer waiting for approval.', 409);
    const prepared = await this.connections.prepare(original.connection_id, before.operation, args, original.agent_id || undefined);
    const current = this.row(id), currentAccount = authorize(current), repeated = retry(); if (repeated) return repeated;
    if (canonical(current) !== canonical(original) || digest({ scopes: currentAccount.scopes, shared: currentAccount.sharedAgentIds }) !== digest({ scopes: account.scopes, shared: account.sharedAgentIds })) throw new ProductError('This action or its account access changed while preparing the revision. Review it again.', 409);
    if (prepared.readOnly || prepared.operation !== before.operation) throw new ProductError('The revised action must use its original operation.', 409);
    if (original.run_id) this.recovery(original.run_id);
    const nextId = randomUUID(), stamp = new Date().toISOString();
    this.db.exec('SAVEPOINT revise_action');
    try {
      this.db.prepare("INSERT INTO action_intents(id,actor_id,agent_id,run_id,connection_id,request_id,input_hash,prepared_json,state,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,'awaiting_approval',?,?)").run(nextId, original.actor_id, original.agent_id, original.run_id, original.connection_id, requestId, fingerprint, JSON.stringify(prepared), stamp, stamp);
      this.db.prepare('INSERT INTO action_events VALUES(?,?,?,?,?)').run(randomUUID(), nextId, 'awaiting_approval', `Revised from action ${id}; fresh approval is required.`, stamp);
      this.record(original, 'denied', `Superseded by revised action ${nextId}. No action was executed.`);
      this.db.exec('RELEASE revise_action');
    } catch (error) { this.db.exec('ROLLBACK TO revise_action; RELEASE revise_action'); throw error; }
    const intent = this.review(nextId); this.changed?.(intent, actorId); return intent;
  }
  review(id: string) { const row = this.row(id); this.permitted(row); return { ...this.mapped(row), confirmation: digest(JSON.parse(row.prepared_json)) }; }
  async execute(id: string, agentId?: string) {
    const row = this.row(id); this.permitted(row, agentId);
    if (row.state === 'completed') return this.mapped(row);
    if (row.state !== 'approved') throw new ProductError(row.state === 'uncertain' || row.state === 'dispatching' ? 'Check this action’s destination before continuing. It will not be replayed automatically.' : 'This action needs approval before dispatch.', 409);
    if (Date.now() - Date.parse(row.created_at) > 86400000) throw new ProductError('This action is more than a day old. Prepare and review a fresh action.', 409);
    if(row.grant_id&&!this.db.prepare('SELECT 1 FROM action_grants g JOIN workflow_runs r ON r.workflow_id=g.workflow_id AND r.revision=g.revision JOIN workflows w ON w.id=g.workflow_id AND w.revision=g.revision AND w.reviewed_revision=g.revision WHERE g.id=? AND r.run_id=? AND w.agent_id=? AND g.revoked=0 AND g.expires_at>?').get(row.grant_id,row.run_id,row.agent_id,new Date().toISOString()))throw new ProductError('This routine grant was revoked, expired, or belongs to an earlier workflow revision. Review a fresh action.',403);
    const prepared = JSON.parse(row.prepared_json) as PreparedOperation;if(row.run_id&&!prepared.readOnly)this.recovery(row.run_id);
    if (!this.db.prepare("UPDATE action_intents SET state='dispatching',updated_at=? WHERE id=? AND state='approved'").run(new Date().toISOString(), id).changes) throw new ProductError('This action is already being dispatched.', 409);
    let receipt: unknown = null;
    try {
      receipt = await this.connections.execute(row.connection_id, prepared, id, agentId);
      // Persist a receipt before readback so a restart cannot lose the only destination identity.
      this.db.prepare('UPDATE action_intents SET receipt_json=? WHERE id=?').run(JSON.stringify(receipt), id);
      const check = await this.connections.verify(row.connection_id, prepared, id, receipt, agentId);
      return this.record(row, check.passed ? 'completed' : 'uncertain', check.evidence, check.result ?? receipt, receipt);
    } catch (error) { return this.record(row, prepared.readOnly ? 'failed' : 'uncertain', error instanceof ProductError ? error.message : 'The destination did not confirm the action. Inspect it before retrying.', null, receipt); }
  }
  async reconcile(id: string, agentId?: string) {
    const row = this.row(id); this.permitted(row, agentId); if (row.state !== 'uncertain') throw new ProductError('Only an uncertain action needs reconciliation.', 409);
    const check = await this.connections.verify(row.connection_id, JSON.parse(row.prepared_json), id, JSON.parse(row.receipt_json), agentId);
    return this.record(row, check.passed ? 'completed' : 'uncertain', check.evidence, check.result ?? null, JSON.parse(row.receipt_json));
  }
  grants() { return this.db.prepare('SELECT id,connection_id AS connectionId,workflow_id AS workflowId,revision,operation,resource,max_actions AS maxActions,used,expires_at AS expiresAt,revoked FROM action_grants WHERE owner_id=? ORDER BY created_at DESC').all(this.actor().id); }
  availableGrants(agentId:string,runId:string){return this.db.prepare('SELECT g.id,g.connection_id AS connectionId,g.operation,g.resource,g.max_actions-g.used AS remaining,g.expires_at AS expiresAt FROM action_grants g JOIN workflow_runs r ON r.workflow_id=g.workflow_id AND r.revision=g.revision JOIN workflows w ON w.id=g.workflow_id AND w.revision=g.revision AND w.reviewed_revision=g.revision WHERE r.run_id=? AND w.agent_id=? AND g.revoked=0 AND g.used<g.max_actions AND g.expires_at>?').all(runId,agentId,new Date().toISOString()).filter(row=>{try{this.connections.get(String(row.connectionId),agentId);return true;}catch{return false;}});}
  grant(input: Record<string, unknown>) {
    const row = this.row(text(input.actionId, 'Tested action', 100)), account = this.permitted(row);
    if (account.ownerId !== this.actor().id || row.state !== 'completed' || !row.run_id) throw new ProductError('Choose a verified action from your own account and a passed workflow test.', 403);
    const test = this.db.prepare("SELECT w.id,w.revision FROM workflows w JOIN workflow_tests t ON t.workflow_id=w.id AND t.revision=w.revision JOIN runs r ON r.id=t.run_id WHERE t.run_id=? AND t.verdict='passed' AND r.state='completed' AND w.reviewed_revision=w.revision").get(row.run_id) as { id: string; revision: number } | undefined;
    const prepared = JSON.parse(row.prepared_json) as PreparedOperation;
    if (!test || prepared.readOnly) throw new ProductError('Pass and review the current workflow test before granting routine writes.', 409);
    const id = randomUUID(), expiresAt = new Date(Date.now() + integer(input.days ?? 7, 'Grant duration', 1, 30) * 86400000).toISOString();
    this.db.prepare('INSERT INTO action_grants(id,connection_id,owner_id,workflow_id,revision,operation,resource,scope_hash,max_actions,expires_at,source_action_id,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(id, row.connection_id, this.actor().id, test.id, test.revision, prepared.operation, prepared.resource, digest(scope(prepared)), integer(input.maxActions ?? 10, 'Action budget', 1, 100), expiresAt, row.id, new Date().toISOString());
    return this.grants().find(grant => grant.id === id);
  }
  revokeGrant(id: string) { if (!this.db.prepare('UPDATE action_grants SET revoked=1 WHERE id=? AND owner_id=?').run(id, this.actor().id).changes) throw new ProductError('Grant not found.', 404); return { ok: true }; }
}
