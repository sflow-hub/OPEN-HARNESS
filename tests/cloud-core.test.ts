import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { PGlite } from '@electric-sql/pglite';
import type { Database, Sql } from '../control-plane/database';
import { CloudWorkspaces } from '../control-plane/workspaces';
import {Operations} from '../control-plane/operations';
import { UsageLedger } from '../control-plane/usage';
import { Identity, tokenHash } from '../control-plane/identity';
import { Provisioning, type WorkspaceMachine, type WorkspaceProvider } from '../control-plane/providers';
import { relayPathAllowed } from '../control-plane/relay';
import {ModelGateway} from '../control-plane/model-gateway';
import {generateKeyPair,exportJWK} from 'jose';
import {connectionCookies,connectionResponseCookies} from '../control-plane/server';
import type {ServerResponse} from 'node:http';

async function fixture() {
  const pg=new PGlite(); await pg.exec(await readFile(new URL('../control-plane/schema.sql',import.meta.url),'utf8'));
  const adapt=(source:Pick<PGlite,'query'>):Sql=>({query:async (sql,values)=>{const result=await source.query(sql,values);return {rows:result.rows as never[],rowCount:result.affectedRows};}});
  const db:Database={...adapt(pg),transaction:work=>pg.transaction(tx=>work(adapt(tx as unknown as PGlite)))};
  await db.query("INSERT INTO accounts(id,subject,email) VALUES('alice','issuer|alice','alice@example.com'),('bob','issuer|bob','bob@example.com')");
  const workspaces=new CloudWorkspaces(db),workspace=await workspaces.create('alice','Test workspace');return {pg,db,workspaces,workspace};
}
test('PostgreSQL membership and native token exchange fail closed across workspaces and roles',async()=>{
  const f=await fixture();try{
    await assert.rejects(f.workspaces.member(f.workspace.id,'bob'),/access/);
    await assert.rejects(f.workspaces.changeMember(f.workspace.id,'alice','alice','viewer',false),/at least one owner/);
    await f.workspaces.changeMember(f.workspace.id,'alice','bob','viewer',false);assert.equal((await f.workspaces.member(f.workspace.id,'bob')).role,'viewer');await assert.rejects(f.workspaces.member(f.workspace.id,'bob','operator'),/access/);
    await f.workspaces.changeMember(f.workspace.id,'alice','bob','operator',true);await assert.rejects(f.workspaces.member(f.workspace.id,'bob'),/access/);
    const identity=new Identity(f.db,{issuer:'http://localhost:8180/realms/test',clientId:'open-harness',clientSecret:'server-only',publicOrigin:'http://localhost:4400',nativeRedirects:['openharness://auth'],allowInsecureDevelopment:true});
    const code='a'.repeat(43),verifier='b'.repeat(64),challenge=createHash('sha256').update(verifier).digest('base64url');await f.db.query('INSERT INTO native_codes VALUES($1,$2,$3,$4,$5)',[tokenHash(code),'alice',challenge,'openharness://auth',new Date(Date.now()+60000)]);
    await assert.rejects(identity.nativeExchange(code,'c'.repeat(64),'openharness://auth'),/invalid/);
    const token=await identity.nativeExchange(code,verifier,'openharness://auth'),session=await identity.session(token.token,'native');assert.equal(session.accountId,'alice');await assert.rejects(identity.session(token.token,'browser'),/expired/);await assert.rejects(identity.nativeExchange(code,verifier,'openharness://auth'),/already used/);
    const rotated=await identity.rotate(session);await assert.rejects(identity.session(token.token,'native'),/expired/);assert.equal((await identity.session(rotated.token,'native')).accountId,'alice');
  }finally{await f.pg.close();}
});
test('usage ledger reserves hard limits transactionally, settles once, and holds uncertain charges',async()=>{
  const f=await fixture();try{
    const ledger=new UsageLedger(f.db);await ledger.credit('stripe','paid-event',f.workspace.id,10000,'receipt-hash');assert.equal((await ledger.credit('stripe','paid-event',f.workspace.id,10000,'receipt-hash')).duplicate,true);await assert.rejects(ledger.credit('stripe','paid-event',f.workspace.id,20000,'receipt-hash'),/conflicts/);
    await ledger.limits(f.workspace.id,1000);await f.db.query("INSERT INTO model_rates VALUES('reference','rate-1',1000000,2000000,500,true)");
    const input={workspaceId:f.workspace.id,runId:'run-1',requestId:'request-1',requestHash:'payload-1',model:'reference',inputTokenBound:100,outputTokenBound:400};
    const reservation=await ledger.reserve(input);assert.equal(BigInt(reservation.maximum),BigInt(900));assert.equal((await ledger.reserve(input)).id,reservation.id);
    await assert.rejects(ledger.reserve({...input,requestId:'request-2'}),/hard spending limit/);await ledger.dispatch(reservation.id);await assert.rejects(ledger.dispatch(reservation.id),/already/);await ledger.uncertain(reservation.id);await assert.rejects(ledger.releaseUndispatched(reservation.id),/reconciliation/);
    await ledger.settle(reservation.id,50,100,'provider-result-1');await ledger.settle(reservation.id,50,100,'provider-result-1');const summary=await ledger.summary(f.workspace.id);assert.equal(BigInt(summary.wallet.balance),BigInt(9750));assert.equal(BigInt(summary.wallet.reserved),BigInt(0));assert.equal(summary.wallet.auto_recharge,false);
    await assert.rejects(ledger.settle(reservation.id,70,100,'conflicting-result'),/conflicts/);
    const remaining=await ledger.reserve({...input,requestId:'request-3',outputTokenBound:100});await ledger.releaseUndispatched(remaining.id);assert.equal(BigInt((await ledger.summary(f.workspace.id)).wallet.reserved),BigInt(0));
  }finally{await f.pg.close();}
});
test('provider lifecycle is idempotent, dedicated Linux only, and cannot open an unaccepted production gate',async()=>{
  const f=await fixture();try{
    let provisions=0;const machine:WorkspaceMachine={id:'dedicated-vm',workspaceId:f.workspace.id,state:'running',dedicated:true,platform:'linux'};
    const provider:WorkspaceProvider={id:'contract-test-only',productionAccepted:false,provision:async()=>{provisions++;return machine;},inspect:async()=>machine,suspend:async()=>({...machine,state:'suspended'}),resume:async()=>machine,snapshot:async()=>({id:'snapshot-1',workspaceId:f.workspace.id,encrypted:true,createdAt:new Date().toISOString()}),restore:async()=>machine,destroy:async()=>{}};
    assert.throws(()=>new Provisioning(f.db,provider,true),/Select and accept/);const jobs=new Provisioning(f.db,provider),job=await jobs.enqueue(f.workspace.id,'provision','provision-once');assert.equal((await jobs.enqueue(f.workspace.id,'provision','provision-once')).id,job.id);await assert.rejects(jobs.enqueue(f.workspace.id,'destroy','provision-once'),/another operation/);assert.equal((await jobs.next())?.state,'completed');assert.equal(provisions,1);assert.equal(await jobs.next(),null);
    await jobs.enqueue(f.workspace.id,'suspend','suspend-once');await jobs.next();assert.equal((await f.db.query('SELECT state FROM cloud_workspaces WHERE id=$1',[f.workspace.id])).rows[0].state,'suspended');
    assert.equal(relayPathAllowed('/v1/actions/action-id/execute'),true);for(const path of ['/internal/handoff','/v1/bootstrap','/v1/runner/pair','//evil.example/','/v1/files/%2e%2e/secret','/v1/files/%2fsecret'])assert.equal(relayPathAllowed(path),false,path);
  }finally{await f.pg.close();}
});
test('model gateway keeps provider keys server-side, reconciles actual usage, and revokes ended run leases',async()=>{
  const f=await fixture();try{
    const ledger=new UsageLedger(f.db);await ledger.credit('included','test-only-credit',f.workspace.id,100000,'fixture');await ledger.limits(f.workspace.id,100000);await f.db.query("INSERT INTO model_rates VALUES('reference','rate-1',1000000,2000000,500,true)");
    let dispatched=0;const request=(async(_url:string|URL|Request,input?:RequestInit)=>{assert.equal(new Headers(input?.headers).get('Authorization'),'Bearer platform-key-never-in-container');dispatched++;return new Response(JSON.stringify({id:'provider-receipt',choices:[{message:{content:'Actual response'}}],usage:{prompt_tokens:100,completion_tokens:20}}));}) as typeof fetch;
    await f.db.query("UPDATE cloud_workspaces SET state='running' WHERE id=$1",[f.workspace.id]);
    const pair=await generateKeyPair('EdDSA',{extractable:true}),gateway=new ModelGateway(f.db,'https://control.example',await exportJWK(pair.privateKey),[{model:'reference',upstreamModel:'provider-model',endpoint:'https://provider.example/chat/completions',apiKey:'platform-key-never-in-container'}],request),lease=await gateway.lease(f.workspace.id,'alice','task-1');assert.doesNotMatch(JSON.stringify(lease),/platform-key-never/);
    const output:string[]=[];const response={destroyed:false,headersSent:false,writeHead(){output.push('response-started');},write(value:unknown){output.push(String(value));},end(){}} as unknown as ServerResponse;
    await gateway.complete(lease.token,{model:'reference',messages:[{role:'user',content:'Task'}],max_tokens:100},response,'model-request-1');assert.equal(dispatched,1);assert.match(output.join(''),/Actual response/);assert.equal(BigInt((await ledger.summary(f.workspace.id)).wallet.balance),BigInt(99860));await assert.rejects(gateway.complete(lease.token,{model:'reference',messages:[{role:'user',content:'Task'}],max_tokens:100},response,'model-request-1'),/already/);assert.equal(dispatched,1);
    await gateway.release(f.workspace.id,'task-1');await assert.rejects(gateway.models(lease.token),/invalid or expired/);
  }finally{await f.pg.close();}
});
test('refunds cannot erase reserved usage or duplicate adjustments; new usage stays frozen for reconciliation',async()=>{
  const f=await fixture();try{const ledger=new UsageLedger(f.db);await ledger.credit('apple','purchase-1',f.workspace.id,10000,'verified-receipt');await ledger.limits(f.workspace.id,10000);await f.db.query("INSERT INTO model_rates VALUES('reference','v1',1000000,2000000,500,true)");const reservation=await ledger.reserve({workspaceId:f.workspace.id,runId:'task',requestId:'request',requestHash:'same',model:'reference',inputTokenBound:100,outputTokenBound:400});await ledger.dispatch(reservation.id);await ledger.refund('apple','refund-1','purchase-1',10000);const wallet=(await ledger.summary(f.workspace.id)).wallet;assert.equal(BigInt(wallet.balance),BigInt(900));assert.equal(BigInt(wallet.reserved),BigInt(900));assert.equal(BigInt(wallet.debt),BigInt(900));assert.equal(wallet.frozen,true);assert.equal((await ledger.refund('apple','refund-1','purchase-1',10000)).duplicate,true);await ledger.settle(reservation.id,50,100,'already-dispatched-provider-receipt');await assert.rejects(ledger.reserve({workspaceId:f.workspace.id,runId:'another',requestId:'new',requestHash:'new',model:'reference',inputTokenBound:1,outputTokenBound:1}),/billing adjustment/);}finally{await f.pg.close();}
});
test('workspace relays forward only account-authorization binding cookies',()=>{
  const binding=`oh_oauth_${'a'.repeat(20)}=${'b'.repeat(43)}`;assert.equal(connectionCookies(`oh_session=private-cloud-session; ${binding}; other=value`),binding);const result=connectionResponseCookies({'set-cookie':['oh_session=attacker; Path=/',`${binding}; Domain=evil.example; SameSite=None; Path=/`]},'; Secure');assert.equal(result.length,1);assert.doesNotMatch(result[0],/Domain=|evil|SameSite=None/);assert.match(result[0],/HttpOnly; SameSite=Lax; Path=\/; Max-Age=600; Secure/);
});


test('service-operator reconciliation retains provider evidence and cannot unfreeze outstanding debt or unknown usage',async()=>{
  const f=await fixture();try{const ledger=new UsageLedger(f.db),ops=new Operations(f.db);await ledger.credit('included','ops-fixture',f.workspace.id,10000,'fixture');await ledger.limits(f.workspace.id,10000);await f.db.query("INSERT INTO model_rates VALUES('reference','v1',1000000,2000000,500,true)");const held=await ledger.reserve({workspaceId:f.workspace.id,runId:'task',requestId:'ops',requestHash:'ops',model:'reference',inputTokenBound:100,outputTokenBound:100});await ledger.dispatch(held.id);await ledger.uncertain(held.id);await f.db.query('UPDATE wallets SET frozen=true WHERE workspace_id=$1',[f.workspace.id]);await assert.rejects(ops.unfreeze(f.workspace.id,'operator','Checked billing'),/uncertain usage/);await ops.reconcile({reservationId:held.id,inputTokens:10,outputTokens:10,providerReceipt:'receipt-ops',evidence:'Independent provider account receipt',operator:'service-operator'});await assert.rejects(ledger.settle(held.id,10,10,'another-receipt'),/conflicts/);await f.db.query('UPDATE wallets SET debt=1 WHERE workspace_id=$1',[f.workspace.id]);await assert.rejects(ops.unfreeze(f.workspace.id,'operator','Checked billing'),/outstanding billing debt/);await f.db.query('UPDATE wallets SET debt=0 WHERE workspace_id=$1',[f.workspace.id]);assert.equal((await ops.unfreeze(f.workspace.id,'operator','Provider receipt and billing adjustment checked')).autoRecharge,false);assert.equal((await ledger.summary(f.workspace.id)).wallet.frozen,false);assert.ok((await f.db.query("SELECT 1 FROM audit_metadata WHERE operation='usage.reconcile'")).rows.length);}finally{await f.pg.close();}
});
