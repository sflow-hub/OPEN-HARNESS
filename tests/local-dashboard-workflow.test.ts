import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { DashboardChanges } from '../runtime/dashboard-changes';

test('a failed dashboard build preserves the active edition and a retried request starts exactly one named task', async t => {
  const state = mkdtempSync(join(tmpdir(),'dashboard-build-failure-')), db = new DatabaseSync(':memory:');
  t.after(()=>{db.close();rmSync(state,{recursive:true,force:true});});
  mkdirSync(join(state,'agents','atlas','private'),{recursive:true});
  let runs = 0;
  const changes = new DashboardChanges(db,state,{
    validate: agent => assert.equal(agent,'atlas'),
    start: () => { runs++; return {id:randomUUID(),state:'queued'}; }, get:()=>undefined,
  });
  const input = {requestId:randomUUID(),agentId:'atlas',request:'Improve the dashboard heading'};
  const start = changes.start(input);
  assert.deepEqual(changes.start(input),start);
  assert.throws(()=>changes.start({...input,request:'Something different'}),/different change/);
  assert.equal(runs,1);
  const file = join(state,'agents','atlas','private',basename(changes.location(start.runId!)!),'app','page.tsx');
  const original = readFileSync(file,'utf8');
  writeFileSync(file, 'export default function Broken(');
  changes.onRun({id:start.runId!,state:'completed'});
  for (let i=0;i<200 && changes.list().items[0].state==='building';i++) await new Promise(resolve=>setTimeout(resolve,25));
  const result = changes.list();
  assert.equal(result.items[0].state,'failed'); assert.match(result.items[0].error!,/build failed/i);
  assert.equal(result.activeId,null); assert.equal(readFileSync(join(changes.source.activePath(),'app','page.tsx'),'utf8'),original);
  assert.throws(()=>changes.decide(start.id,'apply'),/successfully built/);
  await assert.rejects(changes.document(start.id,true),/successful dashboard build/);
});
