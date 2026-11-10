import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generateKeyPair, SignJWT, jwtVerify } from 'jose';
import { CodexOAuth } from '../runtime/codex-oauth';
import { Credentials } from '../runtime/credentials';
import { prepareProfile } from '../runtime/profile-runtime';
import { draftProfile } from '../lib/agent-profile';
import { initialWorkspace } from '../lib/types';
import { modelProxy } from '../runtime/hermes/model-proxy.mjs';
import { coordinationSocket } from '../runtime/coordination-socket';

const scope = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
async function fixture() {
  const root = mkdtempSync(join(tmpdir(),'harness-codex-')), db = new DatabaseSync(':memory:');
  const values: Record<string,string> = {}, secrets = { token:'fixture-control-token', backend:'fixture', environment:()=>({...values}), names:()=>Object.keys(values), has:(ref:string)=>Boolean(values[ref]), set:(ref:string,value:string)=>{values[ref]=value;}, delete:(ref:string)=>{delete values[ref];return true;} };
  const credentials = new Credentials(db,secrets as never);
  const {privateKey,publicKey}=await generateKeyPair('RS256');
  let now=Date.now(), refreshes=0, requests=0, refreshGate:Promise<void>|undefined;
  const state = { granted:scope, nonce:'', rejectIdentity:false, failRefresh:false, failRevocation:false, refreshIdToken:'', incomplete:false, access:'fixture-access', requests:[] as {url:string;body:URLSearchParams;authorization:string}[] };
  const request:typeof fetch=async(input,init)=>{
    const url=String(input),body=new URLSearchParams(String(init?.body||''));state.requests.push({url,body,authorization:new Headers(init?.headers).get('Authorization')||''});requests++;
    if(url.endsWith('/oauth/token')){
      if(body.get('grant_type')==='refresh_token'){
        refreshes++;await refreshGate;if(state.failRefresh)return Response.json({error:'invalid_grant',detail:'fixture-refresh-secret'},{status:400});
        state.access='fixture-new-access';return Response.json({access_token:state.access,refresh_token:'fixture-new-refresh',expires_in:3600,...(state.refreshIdToken?{id_token:state.refreshIdToken}:{})});
      }
      const id=await new SignJWT({nonce:state.rejectIdentity?'wrong-nonce':state.nonce,email:'fixture@example.com'}).setProtectedHeader({alg:'RS256'}).setSubject('fixture-subject').setIssuer('https://auth.openai.com').setAudience(body.get('client_id')!).setIssuedAt().setExpirationTime('1h').sign(privateKey);
      return Response.json({access_token:state.access,refresh_token:'fixture-refresh-secret',id_token:id,expires_in:3600,scope:state.granted});
    }
    if(url.endsWith('/models'))return Response.json({models:[{slug:'fixture-codex',visibility:'list'},{slug:'hidden-model',visibility:'hide'}]});
    if(url.endsWith('/responses')){
      const request=JSON.parse(String(init?.body));
      if(!Array.isArray(request.input))return Response.json({error:{code:'subscription_sharing_unsupported_capability',param:'input'}},{status:400});
      assert.deepEqual(request.input,[{role:'user',content:'Reply with OK.'}]);assert.equal(request.stream,true);assert.equal(request.store,false);
      return new Response(`data: ${JSON.stringify(state.incomplete?{type:'response.incomplete',response:{status:'incomplete'}}:{type:'response.completed',response:{status:'completed'}})}\n\n`,{headers:{'Content-Type':'text/event-stream'}});
    }
    if(url.endsWith('/openid-configuration'))return Response.json({revocation_endpoint:'https://auth.openai.com/revoke'});
    if(url.endsWith('/revoke'))return new Response(null,{status:state.failRevocation?503:200});
    throw new Error('Unexpected fixture request');
  };
  const oauth=new CodexOAuth(root,credentials,secrets,{request,now:()=>now,verify:async(token,clientId,nonce)=>{const {payload}=await jwtVerify(token,publicKey,{issuer:'https://auth.openai.com',audience:clientId,requiredClaims:['exp','iat','sub']});if(nonce!==undefined && payload.nonce!==nonce)throw new Error('Bad nonce');return payload;}});
  async function connect() {const flow=oauth.start('owner','http://127.0.0.1:4317/auth/callback');state.nonce=new URL(flow.authorizationUrl).searchParams.get('nonce')!;const callback=new URL(flow.callbackUrl);callback.search=new URLSearchParams({state:flow.id,code:'fixture-code',client_id:'oaiapp_fixture'}).toString();const result=await oauth.complete(callback);return {flow,callback,ref:result.credentialRef!};}
  return {root,db,values,credentials,secrets,state,oauth,connect,advance:()=>{now+=3600000;},counts:()=>({refreshes,requests}),gate:(promise:Promise<void>)=>{refreshGate=promise;}};
}

test('Codex sign-in binds PKCE, nonce and account, consumes callbacks once, and returns only metadata',async()=>{
  const f=await fixture();try{
    const {flow,callback,ref}=await f.connect(),url=new URL(flow.authorizationUrl);
    assert.equal(url.origin,'https://auth.openai.com');assert.equal(url.searchParams.get('client_id'),'dynamic_agent_client');assert.equal(url.searchParams.get('code_challenge_method'),'S256');assert.ok(url.searchParams.get('ext_agent_host_id')?.startsWith('urn:uuid:'));
    const token=f.state.requests[0].body;assert.equal(token.get('redirect_uri'),flow.callbackUrl);assert.ok(token.get('code_verifier'));
    await assert.rejects(f.oauth.complete(callback),/invalid or expired/);
    assert.throws(()=>f.oauth.status(flow.id,'another-owner'),/expired/);
    assert.doesNotMatch(JSON.stringify(f.oauth.status(flow.id,'owner')),/fixture-access|fixture-refresh-secret|id_token/);
    assert.equal(f.credentials.row(ref).provider,'openai-codex');assert.equal(f.credentials.backend,'fixture');
    const again=f.oauth.start('owner',flow.callbackUrl,ref);assert.equal(new URL(again.authorizationUrl).searchParams.get('client_id'),'oaiapp_fixture');assert.equal(new URL(again.authorizationUrl).searchParams.get('ext_agent_host_id'),url.searchParams.get('ext_agent_host_id'));
    assert.deepEqual(await f.oauth.models(ref,'owner'),{models:['fixture-codex']});assert.equal((await f.oauth.test(ref,'owner','fixture-codex')).ok,true);
    f.state.incomplete=true;await assert.rejects(f.oauth.test(ref,'owner','fixture-codex'),/did not complete/);
  }finally{f.db.close();}
});

test('Codex rejects identity mismatch, declined plan consent, foreign callback and untrusted credential writes',async()=>{
  for(const mode of ['identity','scope']){const f=await fixture();try{f.state.rejectIdentity=mode==='identity';if(mode==='scope')f.state.granted='openid email';await assert.rejects(f.connect(),mode==='identity'?/identity verification/:/plan usage/);assert.equal(f.credentials.rows().length,0);}finally{f.db.close();}}
  const f=await fixture();try{
    assert.throws(()=>f.oauth.start('owner','https://evil.example/auth/callback'),/loopback/);
    const flow=f.oauth.start('owner','http://127.0.0.1:4317/auth/callback');const callback=new URL(`http://127.0.0.1:4317/other?state=${flow.id}`);await assert.rejects(f.oauth.complete(callback),/does not match/);assert.equal(f.counts().requests,0);
    assert.throws(()=>f.credentials.create({label:'Pasted session',provider:'openai-codex',value:'not-an-oauth-session'}),/Sign in with ChatGPT/);
  }finally{f.db.close();}
});

test('Codex serializes rotating refresh tokens, survives a coordinator restart, and cannot resurrect a removed credential',async()=>{
  const f=await fixture();try{
    const {ref}=await f.connect();f.advance();
    assert.deepEqual(await Promise.all([f.oauth.access(ref,'owner'),f.oauth.access(ref,'owner')]),['fixture-new-access','fixture-new-access']);assert.equal(f.counts().refreshes,1);assert.equal(JSON.parse(f.values[ref]).refreshToken,'fixture-new-refresh');
    const restarted=new CodexOAuth(f.root,f.credentials,f.secrets);assert.equal(await restarted.access(ref,'owner'),'fixture-new-access');
    await assert.rejects(f.oauth.access(ref,'intruder'),/another workspace/);
    f.advance();let release!:()=>void;f.gate(new Promise<void>(resolve=>{release=resolve;}));const pending=f.oauth.access(ref,'owner');await new Promise(resolve=>setImmediate(resolve));f.credentials.remove(ref);release();await assert.rejects(pending,/no longer exists/);assert.equal(f.values[ref],undefined);
  }finally{f.db.close();}
});

test('Codex revokes a renewable session and reports unconfirmed remote revocation without retaining local tokens',async()=>{
  for(const failed of [false,true]){const f=await fixture();try{const {ref}=await f.connect();f.state.failRevocation=failed;const message=await f.oauth.disconnect(ref,'owner');assert.equal(Boolean(message),failed);assert.equal(f.values[ref],undefined);assert.equal(f.state.requests.at(-1)?.body.get('token_type_hint'),'refresh_token');assert.ok(f.db.prepare('SELECT ref FROM codex_registrations WHERE ref=?').get(ref));}finally{f.db.close();}}
});

test('Codex rejects an invalid refreshed identity and a different owner cannot disconnect an account',async()=>{
  const f=await fixture();try{
    const {ref}=await f.connect();await assert.rejects(f.oauth.disconnect(ref,'intruder'),/another account/);assert.ok(f.values[ref]);
    f.advance();f.state.refreshIdToken='invalid-fixture-id-token';await assert.rejects(f.oauth.access(ref,'owner'),/identity verification/);assert.equal(JSON.parse(f.values[ref]).accessToken,'fixture-access');
  }finally{f.db.close();}
});

test('Codex profiles contain only scoped bridge credentials, never the OAuth session even when selected as an MCP secret',async()=>{
  const f=await fixture();try{
    const {ref}=await f.connect(),profile=draftProfile(initialWorkspace.agents[0]);profile.model={inherit:false,provider:'openai-codex',model:'fixture-codex',credentialRef:ref,baseUrl:''};profile.connectors=[{id:'fixture',name:'fixture',enabled:true,command:'node',args:[],secretRef:ref}];
    prepareProfile(f.root,profile,profile.model,f.secrets,'fixture-agent-token','run-fixture');
    for(const file of ['profile/.env','profile/config.yaml','managed/policy.json']){const value=readFileSync(join(f.root,'agents',profile.id,file),'utf8');assert.doesNotMatch(value,/fixture-access|fixture-refresh-secret|id_token|oaiapp_fixture/);}
    assert.equal(JSON.parse(readFileSync(join(f.root,'agents',profile.id,'profile/config.yaml'),'utf8')).model.api_mode,'codex_responses');
  }finally{f.db.close();}
});

test('the agent model bridge streams through its owning socket, requires a live lease, and exposes only Responses',{skip:process.platform==='win32'},async()=>{
  const dir=mkdtempSync(join(tmpdir(),'harness-codex-bridge-')),lease=join(dir,'lease.json');writeFileSync(lease,JSON.stringify({runId:'run-1',active:true,expiresAt:Date.now()+60000}));
  let calls=0;const socket=await coordinationSocket(join(dir,'managed'),'atlas',(req,res)=>{calls++;assert.equal(req.url,'/internal/codex/responses');assert.equal(req.headers.authorization,'Bearer scoped-agent-token');assert.equal(req.headers['x-open-harness-run'],'run-1');res.writeHead(200,{'Content-Type':'text/event-stream'});res.end('data: {"type":"response.completed"}\n\n');});
  const proxy=await modelProxy({OPEN_HARNESS_CONTROL_SOCKET:socket.socketPath,OPEN_HARNESS_AGENT_ID:'atlas',OPEN_HARNESS_AGENT_TOKEN:'scoped-agent-token',OPEN_HARNESS_RUN_LEASE:lease});
  try{const address=proxy.address() as {port:number},base=`http://127.0.0.1:${address.port}`;const response=await fetch(base+'/responses',{method:'POST',body:'{"model":"fixture-codex"}'});assert.equal(response.status,200);assert.match(await response.text(),/response.completed/);assert.equal((await fetch(base+'/models')).status,404);writeFileSync(lease,JSON.stringify({active:false}));assert.equal((await fetch(base+'/responses',{method:'POST',body:'{}'})).status,409);assert.equal(calls,1);}finally{proxy.closeAllConnections();await new Promise<void>(resolve=>proxy.close(()=>resolve()));await socket.close();}
});
