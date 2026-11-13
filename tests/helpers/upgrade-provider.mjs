// Deterministic local transport fixture. No model reasoning or external provider.
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

export const TASK_TOOL='mcp__open_harness__task';
const CREDENTIALS=new Map([['Bearer upgrade-original-synthetic','original'],['Bearer upgrade-rotated-synthetic','rotated']]);
const JOB=/UPGRADE_(MAIN|DENY|APPROVE|HOLD)_(BASELINE|UPGRADED|ROLLBACK)\b/;
const advertisedTools=body=>(Array.isArray(body.tools)?body.tools:[]).map(t=>t?.function?.name??t?.name).filter(n=>typeof n==='string').sort();
export function completion(body) {
  const messages=body.messages||[],advertised=advertisedTools(body);
  // Hermes also sends tool-less auxiliary requests (titles, approval assessment). They get an inert answer, as in the
  // other real-runtime fixtures, so that only agent turns are scripted and a failure here is always a contract break.
  if(!advertised.length)return {auxiliary:true,advertised,message:{role:'assistant',content:'UPGRADE_FIXTURE_AUXILIARY_RESPONSE'},finishReason:'stop'};
  const start=messages.findLastIndex(m=>m.role==='user'&&JOB.test(String(m.content)));
  assert.ok(start>=0,'Unknown synthetic job');
  const [,kind,stage]=String(messages[start].content).match(JOB);
  const called=messages.slice(start).flatMap(m=>m.tool_calls||[]).map(t=>t.function?.name);
  // Original0.3 grants its coordination tool as mcp_open_harness_task while Hermes registers mcp__open_harness__task,
  // so its unchanged policy withholds the tool. Only the current stage, after the documented rename, uses it.
  const next=kind==='HOLD'?{name:'clarify',arguments:{question:'Keep this private desktop alive for inspection.'}}
    :['DENY','APPROVE'].includes(kind)&&!called.includes('terminal')?{name:'terminal',arguments:{command:'chmod 666 /workspace/private/approval-proof.txt'}}
    :kind==='MAIN'&&!called.includes('write_file')?{name:'write_file',arguments:{path:`/workspace/shared/upgrade-${stage.toLowerCase()}.txt`,content:`UPGRADE_FILE_${stage}\n`}}
    :kind==='MAIN'&&stage==='UPGRADED'&&!called.includes('clarify')?{name:'clarify',arguments:{question:'Which synthetic upgrade marker should be retained?'}}
    :kind==='MAIN'&&stage==='UPGRADED'&&!called.includes(TASK_TOOL)?{name:TASK_TOOL,arguments:{action:'list'}}:null;
  if(next)assert.ok(advertised.includes(next.name),`Required tool missing: ${next.name}`);
  const message=next?{role:'assistant',content:null,tool_calls:[{id:`upgrade-${kind}-${stage}-${called.length}-${next.name}`,type:'function',function:{name:next.name,arguments:JSON.stringify(next.arguments)}}]}:{role:'assistant',content:`REAL_UPGRADE_${kind}_${stage}_COMPLETE`};
  return {auxiliary:false,kind,stage,advertised,message,finishReason:next?'tool_calls':'stop'};
}
export function serve({port=3131,host='0.0.0.0'}={}) {
  // Labels only: records never contain credential values, prompts or tool arguments.
  const records=[];
  const server=createServer(async(req,res)=>{
    try {
      if(req.method==='GET'){res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(req.url==='/__fixture/requests'?records:{object:'list',data:[{id:'upgrade-fixture',object:'model',context_length:131072}]}));return;}
      const credential=CREDENTIALS.get(req.headers.authorization)||'invalid';
      if(credential==='invalid'){records.push({rejected:'credential'});res.writeHead(401,{'Content-Type':'application/json'});res.end('{"error":"Synthetic fixture credential rejected"}');return;}
      let raw='';for await(const chunk of req){raw+=chunk;if(raw.length>4_000_000)throw new Error('Request too large');}
      const body=JSON.parse(raw),result=completion(body);
      records.push({auxiliary:result.auxiliary,kind:result.kind??null,stage:result.stage??null,credential,advertised:result.advertised,tools:result.message.tool_calls?.map(t=>t.function.name)||[],finished:result.finishReason==='stop'});
      const common={id:`upgrade-${records.length}`,created:Math.floor(Date.now()/1000),model:'upgrade-fixture'};
      if(body.stream) {
        res.writeHead(200,{'Content-Type':'text/event-stream'});
        const delta=result.message.tool_calls?{role:'assistant',tool_calls:result.message.tool_calls.map(t=>({index:0,...t}))}:result.message;
        res.write(`data: ${JSON.stringify({...common,object:'chat.completion.chunk',choices:[{index:0,delta,finish_reason:null}]})}\n\n`);
        res.end(`data: ${JSON.stringify({...common,object:'chat.completion.chunk',choices:[{index:0,delta:{},finish_reason:result.finishReason}]})}\n\ndata: [DONE]\n\n`);
      } else {res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({...common,object:'chat.completion',choices:[{index:0,message:result.message,finish_reason:result.finishReason}],usage:{prompt_tokens:20,completion_tokens:10,total_tokens:30}}));}
    } catch(error) {records.push({failure:String(error?.message||error).slice(0,200)});if(!res.headersSent)res.writeHead(500,{'Content-Type':'application/json'});res.end('{"error":"Synthetic fixture contract failed"}');}
  });
  server.listen(port,host);return {server,records};
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {const {server}=serve();process.once('SIGTERM',()=>{server.close(()=>process.exit(0));server.closeAllConnections();});}
