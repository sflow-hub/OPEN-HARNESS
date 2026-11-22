import {createServer} from 'node:http';
import {once} from 'node:events';

export const answer='Confirmed the headless run.';
export const key='fixture-api-key';
const sse=(res,type,v)=>res.write(`event: ${type}\ndata: ${JSON.stringify(v)}\n\n`);
export const send=(res,value)=>res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify(value));

function responses(res, model) {
  const msg={id:'msg_1',type:'message',role:'assistant',status:'completed',content:[{type:'output_text',text:answer,annotations:[]}]};
  const response={id:'resp_1',object:'response',model,created_at:1,status:'completed',output:[msg],usage:{input_tokens:1,output_tokens:5,total_tokens:6}};
  res.writeHead(200,{'content-type':'text/event-stream'});
  let seq=0;
  const event=(type,data)=>sse(res,type,{type,sequence_number:seq++,...data});
  event('response.created',{response:{...response,status:'in_progress',output:[]}});
  event('response.output_item.added',{output_index:0,item:{...msg,status:'in_progress',content:[]}});
  event('response.content_part.added',{output_index:0,item_id:msg.id,content_index:0,part:{type:'output_text',text:'',annotations:[]}});
  event('response.output_text.delta',{output_index:0,item_id:msg.id,content_index:0,delta:answer});
  event('response.output_text.done',{output_index:0,item_id:msg.id,content_index:0,text:answer});
  event('response.content_part.done',{output_index:0,item_id:msg.id,content_index:0,part:msg.content[0]});
  event('response.output_item.done',{output_index:0,item:msg});
  event('response.completed',{response});
  res.end();
}
function messages(res,model,stream) {
  const message={id:'msg_1',type:'message',model,role:'assistant',content:[{type:'text',text:answer}],stop_reason:'end_turn',stop_sequence:null,usage:{input_tokens:5,output_tokens:5}};
  if(!stream)return send(res,message);
  res.writeHead(200,{'content-type':'text/event-stream'});
  const event=(type,data)=>sse(res,type,{type,...data});
  event('message_start',{message:{...message,content:[],stop_reason:null}});
  event('content_block_start',{index:0,content_block:{type:'text',text:''}});
  event('content_block_delta',{index:0,delta:{type:'text_delta',text:answer}});
  event('content_block_stop',{index:0});
  event('message_delta',{delta:{stop_reason:'end_turn',stop_sequence:null},usage:{output_tokens:5}});
  event('message_stop',{});res.end();
}
function chat(res,model,stream) {
  const base={id:'chatcmpl-local',created:1,model};
  if(!stream)return send(res,{...base,object:'chat.completion',choices:[{index:0,message:{role:'assistant',content:answer},finish_reason:'stop'}],usage:{prompt_tokens:1,completion_tokens:5,total_tokens:6}});
  res.writeHead(200,{'content-type':'text/event-stream'});
  for(const [delta,finish_reason] of [[{role:'assistant',content:answer},null],[{},'stop']]){
    res.write(`data: ${JSON.stringify({...base,object:'chat.completion.chunk',choices:[{index:0,delta,finish_reason}]})}\n\n`);
  }
  res.end('data: [DONE]\n\n');
}
export async function serve(t,handler,host) {
  const server=createServer((req,res)=>{void (async()=>{
    const chunks=[];for await(const chunk of req)chunks.push(chunk);
    const body=chunks.length?JSON.parse(Buffer.concat(chunks).toString()):{};
    await handler(req,res,body);
  })().catch(()=>res.writeHead(500).end('{}'));});
  server.listen(0,host);await once(server,'listening');
  t.after(async()=>{server.closeAllConnections();await new Promise(done=>server.close(done));});
  return server.address().port;
}

export async function modelFixture(t) {
  const seen=new Map();
  const provider=await serve(t,(req,res,body)=>{
    const path=req.url.split('?')[0];
    seen.set(path,1+(seen.get(path)||0));
    if(path==='/v1/models') return send(res,{object:'list',data:[{id:'gpt-4o-mini',object:'model'}]});
    if(path==='/v1/messages/count_tokens') return send(res,{input_tokens:5});
    if(req.headers.authorization!=='Bearer '+key && req.headers['x-api-key']!==key) return res.writeHead(401).end('{}');
    if(path==='/v1/responses') return responses(res,body.model);
    if(path==='/v1/messages') return messages(res,body.model,body.stream);
    if(path==='/v1/chat/completions') return chat(res,body.model,body.stream);
    res.writeHead(404).end('{}');
  },process.env.OPEN_HARNESS_RUST_PROVIDER_BIND||'127.0.0.1');
  return {seen,base:`http://${process.env.OPEN_HARNESS_RUST_PROVIDER_HOST||'host.docker.internal'}:${provider}`};
}
