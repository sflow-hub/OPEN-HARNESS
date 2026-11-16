import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createManagedPolicy, grantedIdentity } from '../runtime/opencode-policy-core.mjs';
import { draftProfile, DEFAULT_MODEL } from '../lib/agent-profile';
import { prepareProfile } from '../runtime/profile-runtime';
import { saveInstallation } from '../runtime/harness-registry';

const base = { runId:'run', allowedTools:['terminal','read_file','mcp__foo_bar__baz','mcp__safe__lookup'], mcpServers:['foo','foo_bar','safe'], coordination:{}, reviewUnclassified:true };
const active = () => JSON.stringify({ runId:'run', active:true, expiresAt:Date.now()+60000 });
const call = (tool:string, callID='call') => ({ tool, callID, sessionID:'session' });

test('profile emits no native grant for ambiguous MCP names and uses native allow only for reviewed calls',t=>{
  const root=mkdtempSync(join(tmpdir(),'opencode-policy-'));t.after(()=>rmSync(root,{recursive:true,force:true}));
  saveInstallation(root,{kind:'opencode',version:'1.2.27',image:'fixture',command:['opencode','acp'],protocol:'acp/v1',tested:true});
  const profile=draftProfile({id:'atlas',name:'Atlas',role:'Agent',description:'',tone:0,instructions:'',memory:[]});
  profile.harness={kind:'opencode',version:'1.2.27'};
  profile.connectors=['foo','foo_bar','safe'].map(name=>({id:name,name,command:'fixture',args:[],secretRef:'',enabled:true}));
  profile.allowedTools=['terminal','read_file','mcp__foo_bar__baz','mcp__safe__lookup'];
  prepareProfile(root,profile,DEFAULT_MODEL,{environment:()=>({})},'token','run',{reviewUnclassified:true});
  const managed=join(root,'agents/atlas/managed');
  const policy=JSON.parse(readFileSync(join(managed,'policy.json'),'utf8'));
  const config=JSON.parse(readFileSync(join(managed,'runtime-command.json'),'utf8')).opencode;
  assert.deepEqual(policy.mcpServers,['foo','foo_bar','safe']);
  assert.equal(config.permission.foo_bar_baz,undefined);
  assert.equal(config.permission.safe_lookup,'allow');
  assert.equal(config.permission.bash,'allow');
  assert.equal(config.permission.read,'ask');
});

test('OpenCode resolves MCP grants against configured servers and denies collisions', async () => {
  assert.equal(grantedIdentity('foo_bar_baz',base),null);
  assert.equal(grantedIdentity('safe_lookup',base),'mcp__safe__lookup');
  assert.equal(grantedIdentity('safe_missing',base),null);
  const hooks=createManagedPolicy(base,{readLease:active,post:async()=>({state:'approved'})});
  await assert.rejects(hooks['tool.execute.before'](call('foo_bar_baz'),{args:{}}),/disabled/);
  await assert.rejects(hooks['tool.execute.before'](call('safe_missing'),{args:{}}),/disabled/);
});

test('reviewed dispatch sends one identity and digest, then a receipt; classified tools do not review', async () => {
  const requests:Array<{path:string;payload:Record<string,unknown>}>=[];
  const hooks=createManagedPolicy(base,{readLease:active,pause:async()=>{},post:async(path:string,payload:Record<string,unknown>)=>{requests.push({path,payload});return path.endsWith('review-tool')?{state:requests.length===1?'pending':'approved'}:{ok:true};}});
  await hooks['tool.execute.before'](call('safe_lookup'),{args:{password:'hidden',value:'visible'}});
  assert.equal(requests.length,2);
  assert.equal(requests[0].payload.tool,'mcp__safe__lookup');
  assert.match(String(requests[0].payload.summary),/\[redacted\]/);
  assert.doesNotMatch(String(requests[0].payload.summary),/hidden/);
  assert.match(String(requests[0].payload.argumentHash),/^[a-f0-9]{64}$/);
  assert.equal(requests[0].payload.requestId,requests[1].payload.requestId);
  await assert.rejects(hooks['tool.execute.before'](call('bash','second'),{args:{command:'true'}}),/no confirmed receipt/);
  await hooks['tool.execute.after'](call('safe_lookup'),{output:'ok'});
  assert.equal(requests.at(-1)?.path,'/internal/tool-receipt');
  assert.equal(requests.at(-1)?.payload.requestId,requests[0].payload.requestId);
  await hooks['tool.execute.before'](call('read','third'),{args:{filePath:'/workspace/uploads/file'}});
  assert.equal(requests.length,3);
});

test('denial, lease expiry, coordinator failure and missing completion receipt fail closed', async () => {
  const denied=createManagedPolicy(base,{readLease:active,post:async()=>({state:'denied'})});
  await assert.rejects(denied['tool.execute.before'](call('bash'),{args:{command:'true'}}),/denied/);
  const expired=createManagedPolicy(base,{readLease:()=>JSON.stringify({runId:'run',active:true,expiresAt:Date.now()-1}),post:async()=>({state:'approved'})});
  await assert.rejects(expired['tool.execute.before'](call('bash'),{args:{command:'true'}}),/no longer owns/);
  let reads=0;
  const expiresDuringReview=createManagedPolicy(base,{readLease:()=>JSON.stringify({runId:'run',active:true,expiresAt:Date.now()+(++reads<3?60000:-1)}),post:async()=>({state:'approved'})});
  await assert.rejects(expiresDuringReview['tool.execute.before'](call('bash'),{args:{command:'true'}}),/no longer owns/);
  const unavailable=createManagedPolicy(base,{readLease:active,post:async()=>{throw new Error('offline');}});
  await assert.rejects(unavailable['tool.execute.before'](call('bash'),{args:{command:'true'}}),/could not review/);
  const noReceipt=createManagedPolicy(base,{readLease:active,post:async(path:string)=>path.endsWith('review-tool')?{state:'approved'}:Promise.reject(new Error('offline'))});
  await noReceipt['tool.execute.before'](call('bash'),{args:{command:'true'}});
  await assert.rejects(noReceipt['tool.execute.after'](call('bash'),{output:'ok'}),/could not confirm/);
  await assert.rejects(noReceipt['tool.execute.before'](call('bash','next'),{args:{command:'true'}}),/no confirmed receipt/);
});

test('coordinator review falls back from an unavailable Unix socket to the configured URL',async()=>{
  const routes:string[]=[];
  const policy={...base,coordination:{OPEN_HARNESS_CONTROL_SOCKET:'/tmp/missing.sock',OPEN_HARNESS_CONTROL_URL:'http://127.0.0.1:1234',OPEN_HARNESS_AGENT_ID:'atlas',OPEN_HARNESS_AGENT_TOKEN:'test'}};
  const hooks=createManagedPolicy(policy,{readLease:active,transport:async(route:string,path:string)=>{routes.push(route+path);if(route==='socket')throw new Error('unavailable');return path==='/internal/review-tool'?{state:'approved'}:{ok:true};}});
  await hooks['tool.execute.before'](call('bash'),{args:{command:'true'}});
  await hooks['tool.execute.after'](call('bash'),{output:'ok'});
  assert.deepEqual(routes,['socket/internal/review-tool','url/internal/review-tool','socket/internal/tool-receipt','url/internal/tool-receipt']);
});
