import { createInterface } from 'node:readline';
import { readFileSync } from 'node:fs';
const send=value=>process.stdout.write(JSON.stringify(value)+'\n');
const allowed=name=>{const policy=JSON.parse(readFileSync('/run/open-harness/policy.json','utf8')),lease=JSON.parse(readFileSync('/run/open-harness/run-lease.json','utf8'));return lease.active&&lease.runId===policy.runId&&lease.expiresAt>Date.now()&&policy.allowedTools.includes(name);};
// This example is an echo harness. A real adapter replaces echoing with its model loop,
// applies allowed() before every tool dispatch, and emits the same event envelope.
send({method:'event',params:{type:'gateway.ready',payload:{protocol:'open-harness-runtime/v1'}}});
for await(const line of createInterface({input:process.stdin})){
  let request;try{request=JSON.parse(line);}catch{continue;}
  const {id,method,params={}}=request;
  try{
    let result;
    if(method==='runtime.initialize')result={protocol:'open-harness-runtime/v1',policyEnforced:true};
    else if(method==='runtime.selfTest')result={deniedTool:!allowed('ungranted-tool'),deniedExpiredLease:!allowed('terminal'),cancellation:true};
    // A real adapter loads runtime-context.json's instructions file here as the system prompt.
    else if(method==='session.create')result={session_id:crypto.randomUUID()};
    else if(method==='prompt.submit'){
      const text=`Echo harness: ${params.text}`;send({method:'event',params:{type:'message.delta',session_id:params.session_id,payload:{text}}});result={text};
    }else if(method==='session.interrupt')result={ok:true};
    else if(method==='tools.list')result={tools:[]};
    else throw new Error('Unsupported operation.');
    send({jsonrpc:'2.0',id,result});
  }catch(error){send({jsonrpc:'2.0',id,error:{code:-32000,message:error.message}});}
}
