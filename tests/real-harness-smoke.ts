// Real Docker and ACP, scripted local provider, no paid inference.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installOpenCode } from '../runtime/harness-registry';
import { testHarnessInstallation } from '../runtime/agent-assets';
import { draftProfile } from '../lib/agent-profile';
import { prepareProfile } from '../runtime/profile-runtime';
import { createAgentRuntime } from '../runtime/agent-runtime';
import { stopManagedContainers } from '../runtime/hermes';

if(process.env.OPEN_HARNESS_MOCK==='1')throw new Error('Run this acceptance test without mock mode.');
let approvals=0;
let reviewDecision:'approved'|'denied'='approved';
const reviewRequests=new Map<string,unknown>(),receipts:unknown[]=[];
const coordinator=createServer(async(req,res)=>{let body='';for await(const chunk of req)body+=chunk;const input=body?JSON.parse(body):{};res.setHeader('Content-Type','application/json');if(req.url==='/internal/review-tool'){reviewRequests.set(input.requestId,input);return res.end(JSON.stringify({state:reviewDecision}));}if(req.url==='/internal/tool-receipt'){receipts.push(input);return res.end(JSON.stringify({ok:true}));}res.writeHead(404);res.end('{}');});
const root=process.env.OPEN_HARNESS_ACCEPTANCE_STATE||mkdtempSync(join(tmpdir(),'oh-real-harness-'));
mkdirSync(root,{recursive:true});let calls=0;const requests:unknown[]=[],events:unknown[]=[];
const provider=createServer(async(req,res)=>{
  let body='';for await(const chunk of req)body+=chunk;const input=body?JSON.parse(body):{};
  if(req.url?.endsWith('/models')){res.setHeader('Content-Type','application/json');return res.end(JSON.stringify({data:[{id:'fixture-model',object:'model'}]}));}
  calls++;requests.push(input);const prompt=JSON.stringify(input.messages||[]),allowed=prompt.includes('WRITE_ALLOWED'),denied=prompt.includes('WRITE_DENIED'),reviewAllowed=prompt.includes('REVIEW_ALLOWED'),reviewDenied=prompt.includes('REVIEW_DENIED'),called=(input.messages||[]).some((m:{role:string})=>m.role==='tool');
  const tool=(allowed||denied||reviewAllowed||reviewDenied)&&!called?{id:`tool-${calls}`,type:'function',function:reviewAllowed||reviewDenied?{name:'bash',arguments:JSON.stringify({command:`printf REAL_REVIEW_PROOF > /workspace/uploads/${reviewAllowed?'reviewed':'rejected'}.txt`,description:'Write fixture marker'})}:{name:'write',arguments:JSON.stringify({filePath:allowed?'/workspace/uploads/allowed.txt':'/workspace/uploads/denied.txt',content:'REAL_WRITE_PROOF'})}}:null;
  const common={id:`fixture-${calls}`,model:'fixture-model',created:Math.floor(Date.now()/1000)};
  if(input.stream){res.writeHead(200,{'Content-Type':'text/event-stream'});res.write(`data: ${JSON.stringify({...common,object:'chat.completion.chunk',choices:[{index:0,delta:tool?{role:'assistant',tool_calls:[{index:0,...tool}]}:{role:'assistant',content:'REAL_OPENCODE_OK'},finish_reason:null}]})}\n\n`);res.write(`data: ${JSON.stringify({...common,object:'chat.completion.chunk',choices:[{index:0,delta:{},finish_reason:tool?'tool_calls':'stop'}]})}\n\n`);return res.end('data: [DONE]\n\n');}
  res.setHeader('Content-Type','application/json');res.end(JSON.stringify({...common,object:'chat.completion',choices:[{index:0,message:tool?{role:'assistant',content:null,tool_calls:[tool]}:{role:'assistant',content:'REAL_OPENCODE_OK'},finish_reason:tool?'tool_calls':'stop'}],usage:{prompt_tokens:10,completion_tokens:4,total_tokens:14}}));
});
await new Promise<void>(resolve=>provider.listen(0,'0.0.0.0',resolve));
const port=(provider.address() as {port:number}).port;
await new Promise<void>(resolve=>coordinator.listen(0,'0.0.0.0',resolve));
const controlPort=(coordinator.address() as {port:number}).port;
try{
  const item=await installOpenCode(root);await testHarnessInstallation(root,item,crypto.randomUUID());
  const profile=draftProfile({id:`opencode-check-${process.pid}`,name:'OpenCode check',role:'Fixture',description:'',tone:0,instructions:'Return the fixture result.',memory:[]});profile.harness={kind:'opencode',version:item.version};profile.allowedTools=[];profile.model={inherit:false,provider:'custom',model:'fixture-model',credentialRef:'',baseUrl:`http://host.docker.internal:${port}/v1`};
  prepareProfile(root,profile,profile.model,{environment:()=>({})},'','fixture-run');const runtime=await createAgentRuntime(root,profile,[]);
  try{await runtime.start();const session=await runtime.request('session.create',{cwd:'/workspace/private',messages:[]});const result=await runtime.submitPrompt(session.session_id,'Return the fixture result.',120000);assert.match(result.text,/REAL_OPENCODE_OK/);assert.ok(calls>0);}finally{await runtime.stop();}
  for(const allowed of [true,false]){
    profile.allowedTools=allowed?['write_file']:[];const runId=allowed?'write-allowed':'write-denied';prepareProfile(root,profile,profile.model,{environment:()=>({})},'',runId);const worker=await createAgentRuntime(root,profile,profile.allowedTools);
    worker.on('log',event=>events.push(event));worker.on('event',event=>{events.push(event);if(event.type==='approval.request'){approvals++;void worker.request('approval.respond',{request_id:event.payload.request_id,choice:'once'});}});
    try{await worker.start();const session=await worker.request('session.create',{cwd:'/workspace/private',messages:[]});await worker.submitPrompt(session.session_id,allowed?'WRITE_ALLOWED':'WRITE_DENIED',120000);}finally{await worker.stop();}
    assert.equal(existsSync(join(root,'agents',profile.id,'files/work',allowed?'allowed.txt':'denied.txt')),allowed);
  }
  assert.ok(approvals>0,'A real write must pass through the app approval channel');assert.equal(readFileSync(join(root,'agents',profile.id,'files/work/allowed.txt'),'utf8'),'REAL_WRITE_PROOF');
  profile.allowedTools=['terminal'];
  for(const approved of [true,false]){
    reviewDecision=approved?'approved':'denied';const runId=approved?'review-allowed':'review-denied';
    prepareProfile(root,profile,profile.model,{environment:()=>({})},'fixture-token',runId,{controlUrl:`http://host.docker.internal:${controlPort}`,reviewUnclassified:true});
    const worker=await createAgentRuntime(root,profile,profile.allowedTools);let nativeApprovals=0;
    worker.on('event',event=>{events.push(event);if(event.type==='approval.request')nativeApprovals++;});
    try{await worker.start();const session=await worker.request('session.create',{cwd:'/workspace/private',messages:[]});await worker.submitPrompt(session.session_id,approved?'REVIEW_ALLOWED':'REVIEW_DENIED',120000);}finally{await worker.stop();}
    assert.equal(nativeApprovals,0,'Managed review must not trigger a second native prompt');
    assert.equal(existsSync(join(root,'agents',profile.id,'files/work',approved?'reviewed.txt':'rejected.txt')),approved);
  }
  assert.equal(reviewRequests.size,2,'Each reviewed call must have one coordinator approval identity');
  assert.equal(receipts.length,1,'Only the dispatched call sends a completion receipt');
  assert.equal((receipts[0] as {requestId:string}).requestId,[...reviewRequests.keys()][0]);
  const result={ok:true,root,opencode:item.version,protocol:item.protocol,providerCalls:calls,nativeWriteApprovals:approvals,managedReviewApprovals:reviewRequests.size,managedReceipts:receipts.length,deniedTool:true,paidInference:false};writeFileSync(join(root,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}finally{writeFileSync(join(root,'requests.json'),JSON.stringify(requests,null,2));writeFileSync(join(root,'events.json'),JSON.stringify(events,null,2));await stopManagedContainers(root);await new Promise<void>(resolve=>provider.close(()=>resolve()));await new Promise<void>(resolve=>coordinator.close(()=>resolve()));}
