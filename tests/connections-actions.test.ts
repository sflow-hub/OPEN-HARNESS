import test from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../runtime/db';
import { Profiles } from '../runtime/profiles';
import { Workspaces, actorContext } from '../runtime/workspaces';
import { Connections } from '../runtime/connections';
import { Actions } from '../runtime/actions';
import { WorkflowStore } from '../runtime/workflows';

function fixture() {
  const store = new Store(':memory:'); new Profiles(store.db); const workspace = new Workspaces(store.db, '/actions'); new WorkflowStore(store.db, { createRun: () => { throw new Error('unused'); }, publishSkill: () => {} });
  store.db.prepare('INSERT INTO agent_profiles VALUES(?,1,?)').run('atlas', '{}');
  const saved: Record<string,string> = { APP_GOOGLE_CLIENT_SECRET: 'oauth-client-secret' }, secrets = { set: (key: string, value: string) => { saved[key] = value; }, delete: (key: string) => { delete saved[key]; }, environment: () => ({ ...saved }) };
  let values: unknown[][] = [['before']], writes = 0, loseResponse = false,identity={sub:'google-account-1',email:'operator@example.com',email_verified:true};
  const request = (async (url: string | URL | Request, init: RequestInit = {}) => {
    const address = String(url); let result: unknown;
    if (address.includes('/token')) result = { access_token: 'private-access-token', refresh_token: 'private-refresh-token', expires_in: 3600, scope: 'https://www.googleapis.com/auth/spreadsheets.readonly https://www.googleapis.com/auth/spreadsheets' };
    else if (address.includes('/userinfo')) result = identity;
    else if (address.includes('/values/')) {
      if (init.method === 'PUT') { writes++; values = JSON.parse(String(init.body)).values; if (loseResponse) throw new Error('disconnected'); }
      result = { range: 'Sheet1!A1', values };
    } else throw new Error('Unexpected app endpoint');
    return new Response(JSON.stringify(result), { status: 200 });
  }) as typeof fetch;
  const connections = new Connections(store.db, secrets, () => workspace.actor(), request), actions = new Actions(store.db, connections, () => workspace.actor());
  const connect = async (connectionId?:string) => {
    const old = process.env.OPEN_HARNESS_GOOGLE_CLIENT_ID; process.env.OPEN_HARNESS_GOOGLE_CLIENT_ID = 'test-client';
    try { const flow = connections.oauthStart('sheets', { access: 'write', sharedAgentIds: ['atlas'],connectionId }, 'http://localhost:4317/v1/connections/callback'); return { flow, connection: await connections.oauthComplete(flow.state, 'code', flow.binding) }; }
    finally { if (old === undefined) delete process.env.OPEN_HARNESS_GOOGLE_CLIENT_ID; else process.env.OPEN_HARNESS_GOOGLE_CLIENT_ID = old; }
  };
  return { store, workspace, connections, actions, saved, connect,identify:(sub:string,email='operator@example.com')=>{identity={...identity,sub,email};}, writes: () => writes, disconnect: () => { loseResponse = true; }, change: () => { values = [['someone else changed this']]; } };
}

test('OAuth requires browser binding, consumes its verifier once, and never exposes credentials', async () => {
  const f = fixture(), { flow, connection } = await f.connect();
  await assert.rejects(f.connections.oauthComplete(flow.state, 'code', flow.binding), /invalid or expired/);
  assert.equal(Object.keys(f.saved).some(name => name.startsWith('OAUTH_')), false);
  assert.doesNotMatch(JSON.stringify(connection), /private-access|private-refresh|oauth-client-secret/);
  actorContext.run({ id: 'someone-else', workspaceId: f.workspace.id, role: 'operator', source: 'oidc' }, () => { assert.equal(f.connections.list().length, 0); assert.throws(() => f.connections.get(connection.id), /not been shared/); assert.equal(f.connections.get(connection.id, 'atlas').id, connection.id); });
  f.store.db.close();
});

test('writes require immutable approval and deduplicate completed submissions', async () => {
  const f = fixture(), { connection } = await f.connect(), input = { requestId: 'sheet-1', connectionId: connection.id, operation: 'sheets.update', input: { spreadsheetId: 'sheet-id', range: 'Sheet1!A1', values: [['after']] } };
  const action = await f.actions.prepare(input); assert.equal(action.state, 'awaiting_approval'); await assert.rejects(f.actions.execute(action.id), /approval/); assert.equal(f.writes(), 0);
  assert.throws(() => f.actions.decide(action.id, { approved: true, confirmation: 'changed' }), /current action/);
  f.actions.decide(action.id, { approved: true, confirmation: f.actions.review(action.id).confirmation });
  const completed = await f.actions.execute(action.id); assert.equal(completed.state, 'completed'); assert.match(completed.evidence, /Read back/);
  assert.equal((await f.actions.prepare(input)).id, action.id); await f.actions.execute(action.id); assert.equal(f.writes(), 1);
  await assert.rejects(f.actions.prepare({ ...input, operation: 'sheets.read' }), /different action/); f.store.db.close();
});

test('reconnecting binds the provider identity while allowing its address to change',async()=>{
  const f=fixture();try{const {connection}=await f.connect();f.identify('another-google-account');await assert.rejects(f.connect(connection.id),/original account/);assert.equal(f.connections.get(connection.id).account,'operator@example.com');f.identify('google-account-1','renamed@example.com');assert.equal((await f.connect(connection.id)).connection.account,'renamed@example.com');f.store.db.prepare('DELETE FROM connection_accounts WHERE connection_id=?').run(connection.id);await assert.rejects(f.connect(connection.id),/identity verification/);}finally{f.store.db.close();}
});

test('lost write receipts reconcile without replay and restarts preserve uncertainty', async () => {
  const f = fixture(), { connection } = await f.connect();
  const action = await f.actions.prepare({ requestId: 'lost-receipt', connectionId: connection.id, operation: 'sheets.update', input: { spreadsheetId: 'sheet-id', range: 'Sheet1!A1', values: [['done']] } });
  f.actions.decide(action.id, { approved: true, confirmation: f.actions.review(action.id).confirmation }); f.disconnect(); assert.equal((await f.actions.execute(action.id)).state, 'uncertain');
  const restarted = new Actions(f.store.db, f.connections, () => f.workspace.actor()); await assert.rejects(restarted.execute(action.id), /will not be replayed/); assert.equal((await restarted.reconcile(action.id)).state, 'completed'); assert.equal(f.writes(), 1); f.store.db.close();
});

test('changed destinations and revoked account sharing block stale writes', async () => {
  const f = fixture(), { connection } = await f.connect();
  const action = await f.actions.prepare({ requestId: 'changed-sheet', connectionId: connection.id, operation: 'sheets.update', input: { spreadsheetId: 'sheet-id', range: 'Sheet1!A1', values: [['after']] } });
  f.actions.decide(action.id, { approved: true, confirmation: f.actions.review(action.id).confirmation }); f.change(); assert.equal((await f.actions.execute(action.id)).state, 'uncertain'); assert.equal(f.writes(), 0);
  f.connections.share(connection.id, []); assert.throws(() => f.connections.get(connection.id, 'atlas'), /not been shared/); await f.connections.revoke(connection.id); await assert.rejects(f.connections.prepare(connection.id, 'sheets.read', { spreadsheetId: 'sheet-id', range: 'A1' }), /Reconnect/); f.store.db.close();
});


test('tested allowances reserve a bounded count and revocation blocks already prepared writes',async()=>{
 const f=fixture(),{connection}=await f.connect();try{const stamp=new Date().toISOString(),create=(id:string)=>{f.store.createRun({id,agent_id:'atlas',conversation_id:id,prompt:'Allowance fixture',state:'completed',depth:0,parent_run_id:null,session_id:null,result:'Fixture',error:null,created_at:stamp,updated_at:stamp});f.workspace.ownRun(id);};create('test-action');const write={connectionId:connection.id,operation:'sheets.update',input:{spreadsheetId:'sheet-id',range:'Sheet1!A1',values:[['after']]}},tested=await f.actions.prepare({...write,requestId:'tested'},'atlas','test-action');f.actions.decide(tested.id,{approved:true,confirmation:f.actions.review(tested.id).confirmation});await f.actions.execute(tested.id,'atlas');const workflow=new WorkflowStore(f.store.db,{createRun:()=>{throw new Error('unused');},publishSkill:()=>{}}).create({sourceRunId:'test-action',name:'Allowance fixture'});f.store.db.prepare('UPDATE workflows SET reviewed_revision=revision WHERE id=?').run(workflow.id);f.store.db.prepare("INSERT INTO workflow_tests(workflow_id,run_id,revision,verdict,evidence,created_at) VALUES(?,?,1,'passed','Checked dedicated fixture cells',?)").run(workflow.id,'test-action',stamp);const grant=f.actions.grant({actionId:tested.id,maxActions:1,days:1})!;create('routine-run');f.store.db.prepare("INSERT INTO workflow_runs VALUES(?,?,1,'schedule','fixture-period',?)").run(workflow.id,'routine-run',stamp);const prepared=await f.actions.prepare({...write,requestId:'allowed-once',grantId:grant.id},'atlas','routine-run');assert.equal(prepared.state,'approved');assert.equal(f.actions.availableGrants('atlas','routine-run').length,0);await assert.rejects(f.actions.prepare({...write,requestId:'exceeds-limit',grantId:grant.id},'atlas','routine-run'),/does not match/);f.actions.revokeGrant(String(grant.id));await assert.rejects(f.actions.execute(prepared.id,'atlas'),/revoked/);assert.equal(f.writes(),1);}finally{f.store.db.close();}
});
