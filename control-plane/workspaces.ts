import { randomUUID } from 'node:crypto';
import type { Database, Sql } from './database';
import type { WorkspaceRole } from '../lib/product';
import { ProductError, text } from '../runtime/product-error';
export class CloudWorkspaces {
  constructor(private db: Database) {}
  async member(workspaceId: string, actorId: string, required: WorkspaceRole = 'viewer', sql: Sql = this.db) { const row = (await sql.query('SELECT m.role,w.state,w.generation FROM memberships m JOIN cloud_workspaces w ON w.id=m.workspace_id WHERE m.workspace_id=$1 AND m.account_id=$2 AND m.revoked=false', [workspaceId, actorId])).rows[0]; if (!row || ({ viewer: 0, operator: 1, owner: 2 }[row.role as WorkspaceRole] < { viewer: 0, operator: 1, owner: 2 }[required])) throw new ProductError('Your account does not have access to this workspace operation.', 403); return { role: row.role as WorkspaceRole, state: row.state as string, generation: Number(row.generation) }; }
  async list(actorId: string) { return (await this.db.query('SELECT w.id,w.name,w.state,w.edition,m.role FROM cloud_workspaces w JOIN memberships m ON m.workspace_id=w.id WHERE m.account_id=$1 AND m.revoked=false ORDER BY w.created_at', [actorId])).rows; }
  async create(actorId: string, name: string,edition='managed') { if(!['managed','self-hosted'].includes(edition))throw new ProductError('Choose managed or self-hosted.');return this.db.transaction(async sql => { const id = randomUUID(),state=edition==='managed'?'pending':'awaiting_pairing'; await sql.query('INSERT INTO cloud_workspaces(id,name,edition,state) VALUES($1,$2,$3,$4)', [id, text(name, 'Workspace name', 100),edition,state]); await sql.query("INSERT INTO memberships VALUES($1,$2,'owner',false)", [id, actorId]); await sql.query('INSERT INTO wallets(workspace_id) VALUES($1)', [id]); await this.audit(sql, id, actorId, 'workspace.create', id); return { id, name, state, role: 'owner' }; }); }
  async members(workspaceId: string, actorId: string) { await this.member(workspaceId, actorId, 'owner'); return (await this.db.query('SELECT m.account_id AS id,a.email,m.role,m.revoked FROM memberships m JOIN accounts a ON a.id=m.account_id WHERE workspace_id=$1', [workspaceId])).rows; }
  async changeMember(workspaceId: string, actorId: string, targetId: string, role: unknown, revoked: boolean) {
    if (!['owner','operator','viewer'].includes(String(role))) throw new ProductError('Choose owner, operator, or viewer.');
    return this.db.transaction(async sql => {
      await sql.query('SELECT id FROM cloud_workspaces WHERE id=$1 FOR UPDATE', [workspaceId]); await this.member(workspaceId, actorId, 'owner', sql);
      const old = (await sql.query('SELECT * FROM memberships WHERE workspace_id=$1 AND account_id=$2', [workspaceId, targetId])).rows[0];
      if (old?.role === 'owner' && !old.revoked && (revoked || role !== 'owner')) { const owners = (await sql.query("SELECT account_id FROM memberships WHERE workspace_id=$1 AND role='owner' AND revoked=false", [workspaceId])).rows; if (owners.length < 2) throw new ProductError('Keep at least one owner in this workspace.', 409); }
      if (!(await sql.query('SELECT 1 FROM accounts WHERE id=$1', [targetId])).rows.length) throw new ProductError('Ask this person to sign in before adding their account.', 404);
      await sql.query('INSERT INTO memberships VALUES($1,$2,$3,$4) ON CONFLICT(workspace_id,account_id) DO UPDATE SET role=excluded.role,revoked=excluded.revoked', [workspaceId, targetId, role, revoked]); await this.audit(sql, workspaceId, actorId, revoked ? 'member.revoke' : 'member.grant', targetId); return { ok: true };
    });
  }
  async audit(sql: Sql, workspaceId: string, actorId: string, operation: string, resource: string) { await sql.query('INSERT INTO audit_metadata(id,workspace_id,actor_id,operation,resource) VALUES($1,$2,$3,$4,$5)', [randomUUID(), workspaceId, actorId, operation, resource]); }
}
