import type { DatabaseSync } from 'node:sqlite';
import { gzipSync, gunzipSync } from 'node:zlib';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { LocalImprovements } from './local-improvements';
import { compileDashboard, dashboardDocument, dashboardSourceRoot, type DashboardAssets } from './local-dashboard-build';
import { object, ProductError, text } from './product-error';
import type { LocalImprovement } from '../lib/local-improvements';

type Job = { id:string; agent:string; request:string; run:string; path:string; phase:'editing'|'building'|'ready'|'failed'; detail:string };
type Run = { id:string; state:string; error?:string|null };
type Dispatcher = { validate(agent:string):void; start(agent:string,prompt:string): Run; get(id:string): Run|undefined };

export class DashboardChanges {
  readonly source: LocalImprovements;
  readonly available = !existsSync(join(dashboardSourceRoot, 'disabled'));
  private building = new Set<string>();
  constructor(private db: DatabaseSync, stateRoot: string, private runs: Dispatcher) {
    this.source = new LocalImprovements(db, stateRoot, dashboardSourceRoot);
    db.exec(`CREATE TABLE IF NOT EXISTS dashboard_change_jobs(id TEXT PRIMARY KEY,agent TEXT NOT NULL,request TEXT NOT NULL,run TEXT UNIQUE NOT NULL,path TEXT NOT NULL,phase TEXT NOT NULL,detail TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS dashboard_change_assets(id TEXT PRIMARY KEY,assets BLOB NOT NULL)`);
  }
  location(runId: string) { return this.db.prepare('SELECT path FROM dashboard_change_jobs WHERE run=?').get(runId)?.path as string|undefined; }
  private job(id:string) {
    const row = this.db.prepare('SELECT * FROM dashboard_change_jobs WHERE id=?').get(id) as Job|undefined;
    if (!row) throw new ProductError('Local improvement not found.',404);
    return row;
  }
  private item(job:Job): LocalImprovement {
    const revision = this.source.get(job.id);
    const state = job.phase === 'ready' ? revision.state : job.phase;
    return {id:job.id,agentId:job.agent,request:job.request,runId:job.run,state,changes:revision.changes,createdAt:revision.createdAt,check:job.phase==='ready'?job.detail:'',...(state==='failed'?{error: job.detail}:{})};
  }
  list() {
    const jobs = this.db.prepare('SELECT * FROM dashboard_change_jobs ORDER BY rowid DESC LIMIT 50').all() as Job[], activeId = this.source.activeRevision();
    if (activeId && !jobs.some(job => job.id === activeId)) jobs.push(this.job(activeId));
    return { activeId, items: jobs.map(job => this.item(job)) };
  }
  start(input: unknown) {
    const fields = object(input), id=text(fields.requestId,'Request ID',36), agent=text(fields.agentId,'Agent',100), request=text(fields.request,'Requested change',4000);
    const existing = this.db.prepare('SELECT * FROM dashboard_change_jobs WHERE id=?').get(id) as Job|undefined;
    if (existing) {
      if (agent !== existing.agent || request !== existing.request) throw new ProductError('This request ID was already used for a different change.',409);
      return this.item(existing);
    }
    this.runs.validate(agent);
    this.db.exec('SAVEPOINT request_local_change');
    try {
      const { agentPath } = this.source.create(id,agent);
      const prompt = `Edit the private dashboard source at ${agentPath}.\nUse the available file tools in that folder. This is a separate copy of this installation’s browser dashboard. The entry is app/page.tsx, the Assistant home is components/assistant-workspace.tsx and the main stylesheet is app/globals.css. Edit the source implementing the requested behavior and keep unrelated work. The coordinator will independently compile your changes for the owner to preview.\n\nOwner’s request:\n${request}`;
      const run = this.runs.start(agent,prompt);
      this.db.prepare("INSERT INTO dashboard_change_jobs VALUES(?,?,?,?,?,'editing','')").run(id,agent,request,run.id,agentPath);
      this.db.exec('RELEASE request_local_change');
    } catch(error) { this.db.exec('ROLLBACK TO request_local_change; RELEASE request_local_change'); throw error; }
    return this.item(this.job(id));
  }
  recover() {
    const rows = this.db.prepare("SELECT * FROM dashboard_change_jobs WHERE phase IN ('editing','building')").all() as Job[];
    for(const job of rows) { const run=this.runs.get(job.run); if(run) this.onRun(run); else this.fail(job.id,'The original agent task is unavailable. Start a new request.'); }
  }
  onRun(run:Run) {
    if (!['completed','cancelled','interrupted','failed'].includes(run.state)) return;
    const job = this.db.prepare("SELECT * FROM dashboard_change_jobs WHERE run=? AND phase IN ('editing','building')").get(run.id) as Job|undefined;
    if (!job || this.building.has(job.id)) return;
    if(run.state !== 'completed') { this.fail(job.id, run.error || `The agent task was ${run.state}. Your dashboard is still available.`); return; }
    this.building.add(job.id);
    this.db.prepare("UPDATE dashboard_change_jobs SET phase='building' WHERE id=?").run(job.id);
    setImmediate(() => { void this.build(job.id); });
  }
  private fail(id:string,detail:string) { this.db.prepare("UPDATE dashboard_change_jobs SET phase='failed',detail=? WHERE id=?").run(detail.slice(0,4000),id); }
  private async build(id: string) {
    try {
      const { changes } = this.source.freeze(id);
      if (!changes.length) throw new ProductError('The agent finished without changing the dashboard source. Try a more specific request.');
      const assets = await compileDashboard(this.source.previewPath(id), changes.map(c => c.path), changes.filter(c => c.kind==='deleted').map(c=>c.path), this.source.basePath(id));
      // Resolve the distributable vendor bundle before offering an actionable preview.
      await dashboardDocument(assets,true);
      this.db.exec('SAVEPOINT save_local_build');
      try {
        this.db.prepare('INSERT OR REPLACE INTO dashboard_change_assets VALUES(?,?)').run(id,gzipSync(JSON.stringify(assets)));
        this.db.prepare("UPDATE dashboard_change_jobs SET phase='ready',detail=? WHERE id=?").run(assets.check,id);
        this.db.exec('RELEASE save_local_build');
      } catch(error) { this.db.exec('ROLLBACK TO save_local_build; RELEASE save_local_build'); throw error; }
    } catch(error) { this.fail(id,error instanceof Error ? error.message : 'The dashboard build failed.'); }
    finally { this.building.delete(id); }
  }
  async document(id:string,preview:boolean) {
    if(!preview && this.source.activeRevision()!==id) throw new ProductError('The active dashboard has changed. Reopen it to use the current version.',409);
    if(this.job(id).phase!=='ready') throw new ProductError('A successful dashboard build is required before preview.',409);
    const row = this.db.prepare('SELECT assets FROM dashboard_change_assets WHERE id=?').get(id) as {assets:Uint8Array}|undefined;
    if (!row) throw new ProductError('This dashboard build is unavailable. Open the original dashboard.',409);
    const assets:DashboardAssets = JSON.parse(gunzipSync(row.assets).toString());
    return {html:await dashboardDocument(assets,preview)};
  }
  decide(id:string,action:'apply'|'undo') {
    const job=this.job(id);
    if(job.phase!=='ready') throw new ProductError('Only a successfully built change can be applied.',409);
    if(action==='apply') this.source.apply(id); else this.source.undo(id);
    return this.item(job);
  }
}
