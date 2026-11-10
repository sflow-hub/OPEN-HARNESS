import { createHash, randomUUID } from 'node:crypto';
import type { Database } from './database';
import { ProductError, object, text } from '../runtime/product-error';

export type WorkspaceMachine = { id: string; state: 'provisioning' | 'running' | 'suspended' | 'destroyed'; dedicated: true; platform: 'linux'; workspaceId: string };
export type WorkspaceSnapshot = { id: string; workspaceId: string; encrypted: true; createdAt: string };
export interface WorkspaceProvider {
  readonly id: string;
  readonly productionAccepted: boolean;
  provision(input: { workspaceId: string; idempotencyKey: string; generation: number }): Promise<WorkspaceMachine>;
  inspect(machineId: string): Promise<WorkspaceMachine>;
  suspend(machineId: string, idempotencyKey: string): Promise<WorkspaceMachine>;
  resume(machineId: string, idempotencyKey: string): Promise<WorkspaceMachine>;
  snapshot(machineId: string, idempotencyKey: string): Promise<WorkspaceSnapshot>;
  restore(input: { workspaceId: string; snapshotId: string; idempotencyKey: string; generation: number }): Promise<WorkspaceMachine>;
  destroy(machineId: string, idempotencyKey: string): Promise<void>;
}
export class Provisioning {
  constructor(private db: Database, private provider: WorkspaceProvider, private production = false) { if (production && !provider.productionAccepted) throw new ProductError('Select and accept a production workspace provider before enabling managed workspaces.', 503); }
  async enqueue(workspaceId: string, operation: string, requestId: string, payload: Record<string, unknown> = {}) {
    if (!['provision','inspect','suspend','resume','snapshot','restore','destroy'].includes(operation)) throw new ProductError('Unknown workspace lifecycle operation.');
    const id = randomUUID(), source = object(payload), value=operation==='restore'?{snapshotId:text(source.snapshotId,'Snapshot',300)}:{}; text(requestId, 'Provisioning request identity', 200);
    return this.db.transaction(async sql => {
      const workspace = (await sql.query('SELECT * FROM cloud_workspaces WHERE id=$1 FOR UPDATE', [workspaceId])).rows[0]; if (!workspace) throw new ProductError('Workspace not found.', 404);
      const prior = (await sql.query('SELECT * FROM provision_jobs WHERE workspace_id=$1 AND request_id=$2', [workspaceId, requestId])).rows[0];
      if (prior) { if (prior.operation !== operation || JSON.stringify(prior.payload) !== JSON.stringify(value)) throw new ProductError('This lifecycle request identity was used for another operation.', 409); return prior; }
      if (workspace.provider && workspace.provider !== this.provider.id) throw new ProductError('This workspace belongs to a different provider adapter.', 409);
      const active = (await sql.query("SELECT 1 FROM provision_jobs WHERE workspace_id=$1 AND state IN ('queued','running')", [workspaceId])).rows.length; if (active) throw new ProductError('Wait for the current workspace lifecycle operation to finish.', 409);
      return (await sql.query('INSERT INTO provision_jobs(id,workspace_id,operation,request_id,payload) VALUES($1,$2,$3,$4,$5) RETURNING *', [id, workspaceId, operation, requestId, JSON.stringify(value)])).rows[0];
    });
  }
  async retry(workspaceId:string,id:string){return this.db.transaction(async sql=>{await sql.query('SELECT id FROM cloud_workspaces WHERE id=$1 FOR UPDATE',[workspaceId]);if((await sql.query("SELECT 1 FROM provision_jobs WHERE workspace_id=$1 AND state IN ('queued','running')",[workspaceId])).rows.length)throw new ProductError('Wait for the current lifecycle operation to finish.',409);const rows=(await sql.query("UPDATE provision_jobs SET state='queued',error=NULL,updated_at=now() WHERE id=$1 AND workspace_id=$2 AND state='failed' RETURNING *",[id,workspaceId])).rows;if(!rows.length)throw new ProductError('Only a failed lifecycle job can be retried.',409);return rows[0];});}
  async next() {
    const job = await this.db.transaction(async sql => {
      const row = (await sql.query("SELECT * FROM provision_jobs WHERE state='queued' OR (state='running' AND lease_until<now()) ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1")).rows[0]; if (!row) return null;
      return (await sql.query("UPDATE provision_jobs SET state='running',attempts=attempts+1,lease_until=now()+interval '5 minutes',updated_at=now() WHERE id=$1 RETURNING *", [row.id])).rows[0];
    });
    if (!job) return null;
    const workspace = (await this.db.query('SELECT * FROM cloud_workspaces WHERE id=$1', [job.workspace_id])).rows[0];
    const heartbeat=setInterval(()=>void this.db.query("UPDATE provision_jobs SET lease_until=now()+interval '5 minutes' WHERE id=$1 AND state='running' AND attempts=$2",[job.id,job.attempts]).catch(()=>{}),60000);heartbeat.unref();
    try {
      let receipt: WorkspaceMachine | WorkspaceSnapshot | { destroyed: true };
      const key = createHash('sha256').update(job.id).digest('hex');
      if (job.operation === 'provision') receipt = await this.provider.provision({ workspaceId: workspace.id, idempotencyKey: key, generation: workspace.generation });
      else if (job.operation === 'restore') receipt = await this.provider.restore({ workspaceId: workspace.id, snapshotId: text(job.payload.snapshotId, 'Snapshot', 300), idempotencyKey: key, generation: workspace.generation + 1 });
      else {
        if (!workspace.machine_id) throw new ProductError('This workspace has no provisioned machine.', 409);
        if (job.operation === 'destroy') { await this.provider.destroy(workspace.machine_id, key); receipt = { destroyed: true }; }
        else if (job.operation === 'inspect') receipt = await this.provider.inspect(workspace.machine_id);
        else if (job.operation === 'snapshot') receipt = await this.provider.snapshot(workspace.machine_id, key);
        else if (job.operation === 'suspend') receipt = await this.provider.suspend(workspace.machine_id, key);
        else receipt = await this.provider.resume(workspace.machine_id, key);
      }
      if ('workspaceId' in receipt && receipt.workspaceId !== workspace.id) throw new Error('Provider returned another workspace');
      if ('dedicated' in receipt && (!receipt.dedicated || receipt.platform !== 'linux')) throw new Error('Provider did not establish a dedicated Linux workspace');
      await this.db.transaction(async sql => {
        // A reclaimed lease cannot overwrite the newer worker's receipt.
        const updated = await sql.query("UPDATE provision_jobs SET state='completed',receipt=$1,error=NULL,lease_until=NULL,updated_at=now() WHERE id=$2 AND state='running' AND attempts=$3 RETURNING id", [JSON.stringify(receipt), job.id, job.attempts]); if (!updated.rows.length) throw new Error('Lifecycle lease changed');
        if ('state' in receipt) await sql.query('UPDATE cloud_workspaces SET state=$1,machine_id=$2,provider=$3,generation=generation+$4 WHERE id=$5', [receipt.state, receipt.id, this.provider.id, job.operation === 'restore' ? 1 : 0, workspace.id]);
        if ('destroyed' in receipt) await sql.query("UPDATE cloud_workspaces SET state='destroyed',relay_hash=NULL WHERE id=$1", [workspace.id]);
      });
      return { id: job.id, state: 'completed', receipt };
    } catch { await this.db.query("UPDATE provision_jobs SET state='failed',error='The provider did not confirm this operation. Inspect the workspace before retrying.',lease_until=NULL,updated_at=now() WHERE id=$1 AND attempts=$2", [job.id, job.attempts]); return { id: job.id, state: 'failed' }; }finally{clearInterval(heartbeat);}
  }
}
