// Real pinned Hermes, coordinator OAuth/JWKS checks and Responses tool loop.
// All OpenAI HTTP requests are intercepted inside the disposable coordinator;
// the provider is scripted locally and no real account or paid inference is used.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { generateKeyPair, exportJWK, SignJWT } from 'jose';
import { HERMES_IMAGE } from '../runtime/readiness.ts';

assert.equal(process.env.OPEN_HARNESS_REAL_CODEX,'1','Set OPEN_HARNESS_REAL_CODEX=1 to use the real pinned container with a local OAuth fixture.');
assert.notEqual(process.env.OPEN_HARNESS_MOCK,'1');
const runtimeImage=execFileSync('docker',['image','inspect','-f','{{.Id}}',HERMES_IMAGE],{encoding:'utf8'}).trim();
const root=mkdtempSync(join(tmpdir(),'open-harness-real-codex-')),state=join(root,'state'),repository=resolve(import.meta.dirname,'..');mkdirSync(state);
const proof=join(state,'shared','codex-oauth-proof.txt'),marker='CODEX_OAUTH_REAL_TOOL_PROOF_729';
const {privateKey,publicKey}=await generateKeyPair('RS256'),jwk={...await exportJWK(publicKey),kid:'fixture-key',alg:'RS256',use:'sig'};
let nonce='',refreshes=0,modelCalls=0,coordinator,token='',failure;const requests=[],logs=[];
const fixture=createServer(async(req,res)=>{
  try{
    if(req.url==='/jwks'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({keys:[jwk]}));return;}
    if(req.url==='/models'){assert.match(req.headers.authorization,/^Bearer fixture-codex-access-/);res.setHeader('Content-Type','application/json');res.end(JSON.stringify({models:[{slug:'fixture-codex-model',visibility:'list'}]}));return;}
    let raw='';for await(const part of req)raw+=part;
    if(req.url==='/token'){
      const data=new URLSearchParams(raw),refresh=data.get('grant_type')==='refresh_token';if(refresh)refreshes++;
      assert.equal(data.get('client_id'),'oaiapp_smoke');assert.equal(data.get('resource'),'https://api.openai.com/v1');
      const id=await new SignJWT({nonce,email:'codex-fixture@example.com'}).setProtectedHeader({alg:'RS256',kid:'fixture-key'}).setSubject('fixture-subject').setIssuer('https://auth.openai.com').setAudience('oaiapp_smoke').setIssuedAt().setExpirationTime('1h').sign(privateKey);
      res.setHeader('Content-Type','application/json');res.end(JSON.stringify({access_token:`fixture-codex-access-${refreshes}`,refresh_token:`fixture-codex-refresh-${refreshes}`,id_token:id,scope:'openid email profile offline_access resource.invoke chatgpt.tokens.use.direct',expires_in:refresh?3600:1}));return;
    }
    if(req.url==='/responses'){
      const input=JSON.parse(raw);assert.match(req.headers.authorization,/^Bearer fixture-codex-access-/);assert.equal(input.store,false);assert.equal(input.stream,true);assert.equal(input.model,'fixture-codex-model');requests.push(input);modelCalls++;
      const tools=input.tools || [],isTask=tools.some(tool=>tool.type==='function'&&tool.name==='write_file'),call=isTask&&!existsSync(proof);
      const item=call?{id:`fc_${modelCalls}`,type:'function_call',status:'completed',call_id:`call_${modelCalls}`,name:'write_file',arguments:JSON.stringify({path:'/workspace/shared/codex-oauth-proof.txt',content:marker})}:{id:`msg_${modelCalls}`,type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:isTask?'CODEX_OAUTH_SMOKE_COMPLETE':'OK',annotations:[]}]};
      const response={id:`resp_${modelCalls}`,object:'response',created_at:Math.floor(Date.now()/1000),model:input.model,status:'completed',output:[item],usage:{input_tokens:100,output_tokens:20,total_tokens:120,input_tokens_details:{cached_tokens:0},output_tokens_details:{reasoning_tokens:0}}};
      res.writeHead(200,{'Content-Type':'text/event-stream'});let sequence=0;
      const event=(type,value)=>res.write(`event: ${type}\ndata: ${JSON.stringify({type,sequence_number:sequence++,...value})}\n\n`);
      event('response.created',{response:{...response,status:'in_progress',output:[]}});event('response.output_item.added',{output_index:0,item:call?{...item,arguments:''}:item});
      if(call)event('response.function_call_arguments.done',{item_id:item.id,output_index:0,arguments:item.arguments});else event('response.output_text.delta',{item_id:item.id,output_index:0,content_index:0,delta:item.content[0].text});
      event('response.output_item.done',{output_index:0,item});event('response.completed',{response});res.end();return;
    }
    if(req.url==='/discovery'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({revocation_endpoint:'https://auth.openai.com/revoke'}));return;}
    if(req.url==='/revoke'){res.writeHead(200);res.end();return;}
    throw new Error('Unexpected fixture endpoint');
  }catch(error){failure=error;res.writeHead(500);res.end('Fixture failed');}
});
await new Promise(resolve=>fixture.listen(0,'127.0.0.1',resolve));const fixtureUrl=`http://127.0.0.1:${fixture.address().port}`;
const hook=join(root,'fixture-fetch.mjs');writeFileSync(hook,`const original=globalThis.fetch;const mapping=${JSON.stringify({'https://auth.openai.com/.well-known/jwks.json':'/jwks','https://auth.openai.com/api/accounts/oauth/token':'/token','https://auth.openai.com/.well-known/openid-configuration':'/discovery','https://auth.openai.com/revoke':'/revoke','https://api.openai.com/v1/models':'/models','https://api.openai.com/v1/responses':'/responses'})};globalThis.fetch=(input,init)=>{const value=String(input),path=mapping[value];if(path)return original(${JSON.stringify(fixtureUrl)}+path,init);if(value.startsWith('https://auth.openai.com')||value.startsWith('https://api.openai.com'))throw new Error('Unmapped OpenAI fixture request');return original(input,init);};`);
const reservation=createServer();await new Promise(resolve=>reservation.listen(0,'127.0.0.1',resolve));const port=reservation.address().port;await new Promise(resolve=>reservation.close(resolve));const base=`http://127.0.0.1:${port}`;
async function api(path,method='GET',body){const response=await fetch(base+path,{method,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});const value=await response.json();assert.ok(response.ok,JSON.stringify(value));return value;}
try{
  coordinator=spawn(process.execPath,['--import',hook,'--import','tsx','runtime/service.ts'],{cwd:repository,env:{...process.env,OPEN_HARNESS_MOCK:'0',OPEN_HARNESS_HERMES_IMAGE:runtimeImage,OPEN_HARNESS_PORT:String(port),OPEN_HARNESS_STATE_DIR:state,OPEN_HARNESS_DISABLE_OS_VAULT:'1'},stdio:'pipe'});coordinator.stdout.on('data',part=>logs.push(String(part)));coordinator.stderr.on('data',part=>logs.push(String(part)));
  const deadline=Date.now()+30000;while(Date.now()<deadline){try{const response=await fetch(base+'/v1/bootstrap');if(response.ok){token=(await response.json()).token;break;}}catch{}await new Promise(resolve=>setTimeout(resolve,100));}assert.ok(token,'Coordinator did not start');
  const flow=await api('/v1/codex/auth','POST',{});nonce=new URL(flow.authorizationUrl).searchParams.get('nonce');const callback=new URL(flow.callbackUrl);callback.search=new URLSearchParams({state:flow.id,code:'fixture-code',client_id:'oaiapp_smoke'}).toString();const accepted=await fetch(callback);assert.equal(accepted.status,200,await accepted.text());
  const connected=await api(`/v1/codex/auth/${flow.id}`);assert.equal(connected.state,'connected');const ref=connected.credentialRef;
  const list=await api(`/v1/models?provider=openai-codex&credentialRef=${ref}`);assert.deepEqual(list.models,['fixture-codex-model']);assert.equal(refreshes,1,'Expiring access must refresh through the coordinator');
  const defaults=await api('/v1/workspace/model');const tested=await api('/v1/onboarding/model-test','POST',{model:{provider:'openai-codex',model:'fixture-codex-model',baseUrl:'',credentialRef:ref},save:true,revision:defaults.revision});assert.equal(tested.ok,true);
  const id=`codex-smoke-${process.pid}`;await api('/v1/agents/sync','POST',{agents:[{id,name:'Codex smoke',role:'Fixture',description:'',tone:0,instructions:'',memory:[]}]});const {profile}=await api(`/v1/agents/${id}/profile`);await api(`/v1/agents/${id}/profile`,'PUT',{...profile,allowedTools:['write_file'],model:{inherit:true,provider:'openai-codex',model:'fixture-codex-model',credentialRef:ref,baseUrl:''}});
  const run=await api('/v1/runs','POST',{agentId:id,prompt:'CODEX_OAUTH_SMOKE: use write_file to save the requested proof, then report completion.',conversationId:'codex-smoke'});let snapshot;
  const until=Date.now()+120000;while(Date.now()<until){snapshot=await api(`/v1/runs/${run.id}/events?after=0`);if(['completed','failed','interrupted','cancelled'].includes(snapshot.run.state))break;await new Promise(resolve=>setTimeout(resolve,250));}
  assert.equal(snapshot?.run.state,'completed',JSON.stringify(snapshot));assert.match(snapshot.run.result,/CODEX_OAUTH_SMOKE_COMPLETE/);assert.equal(readFileSync(proof,'utf8'),marker);
  const metadata=JSON.stringify(await api('/v1/credentials'));assert.doesNotMatch(metadata,/fixture-codex-access-|fixture-codex-refresh-/);
  for(const file of ['.env','config.yaml'])assert.doesNotMatch(readFileSync(join(state,'agents',id,'profile',file),'utf8'),/fixture-codex-access-|fixture-codex-refresh-/);
  if(failure)throw failure;
  const result={ok:true,runtimeImage,fixture:'Real pinned Hermes and coordinator; scripted local OAuth/Responses provider; no paid inference',signedIdentity:true,serializedRefresh:refreshes,modelRequests:modelCalls,realFileTool:true,accountTokensExcludedFromAgent:true,evidence:root};writeFileSync(join(root,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}catch(error){writeFileSync(join(root,'coordinator.log'),logs.join(''));console.error(`Codex integration evidence: ${root}`);throw error;}
finally{
  if(coordinator?.exitCode===null){const exited=new Promise(resolve=>coordinator.once('exit',resolve));coordinator.kill('SIGTERM');await exited;}
  const name=`open-harness-codex-smoke-${process.pid}`;let owned;
  try{[owned]=JSON.parse(execFileSync('docker',['inspect',name],{encoding:'utf8',stdio:['ignore','pipe','ignore']}));}catch{}
  if(owned){assert.ok(owned.Mounts.some(mount=>mount.Destination==='/home/hermes/.hermes'&&mount.Source===join(state,'agents',`codex-smoke-${process.pid}`,'profile')));execFileSync('docker',['rm','-f',owned.Id],{stdio:'ignore'});}
  fixture.closeAllConnections();await new Promise(resolve=>fixture.close(resolve));
}
