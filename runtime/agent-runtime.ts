/* eslint-disable @typescript-eslint/no-explicit-any */
import { EventEmitter } from 'node:events';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { mkdirSync } from 'node:fs';
import type { AgentProfile } from '../lib/agent-profile';
import { runToolGrants } from '../lib/agent-profile';
import { harnessOf } from '../lib/harness';
import { HermesGateway, ensureContainerAsync } from './hermes';
import { resolveInstallation, type HarnessInstallation } from './harness-registry';
import { safeWorkspacePath } from './path-safety';

export interface AgentRuntime extends EventEmitter {
  readonly container: string;
  start(): Promise<void>;
  request(method: string, params?: Record<string,unknown>, timeout?: number): Promise<any>;
  submitPrompt(sessionId:string,text:string,timeout?:number):Promise<any>;
  stop():Promise<void>;
}
export async function createAgentRuntime(root:string,profile:AgentProfile,tools=runToolGrants(profile)):Promise<AgentRuntime>{
  const installation=resolveInstallation(root,harnessOf(profile));
  const payload=installation.kind.startsWith('custom:')?safeWorkspacePath(root,`harnesses/${installation.kind.slice(7)}/${installation.version}`):undefined;
  const container=await ensureContainerAsync(profile.id,root,profile.computer,false,installation.protocol==='hermes'?undefined:{image:installation.image,payload});
  if(installation.protocol==='hermes')return new HermesGateway(container,tools);
  if(installation.protocol==='acp/v1')return new AcpGateway(container,installation,tools);
  return new CustomGateway(container,installation,tools);
}
export async function createInstallationProbe(root:string,installation:HarnessInstallation,agentId:string):Promise<AgentRuntime>{
  const { draftProfile }=await import('../lib/agent-profile');
  const profile=draftProfile({id:agentId,name:'Harness test',role:'Harness test',description:'',tone:0,instructions:'',memory:[]});
  for(const name of ['managed','profile','private','files/work','files/configuration'])mkdirSync(join(root,'agents',agentId,name),{recursive:true});
  const { atomicWorkspaceWrite }=await import('./path-safety');
  atomicWorkspaceWrite(join(root,'agents',agentId,'managed','runtime-command.json'),JSON.stringify({command:installation.command}));
  atomicWorkspaceWrite(join(root,'agents',agentId,'managed','runtime-context.json'),JSON.stringify({protocol:'open-harness-runtime/v1',probe:true,model:null,mcpServers:{},configuration:null,workingFiles:'/workspace/uploads',instructions:'/run/open-harness/instructions.md'}));
  atomicWorkspaceWrite(join(root,'agents',agentId,'managed','instructions.md'),'');
  const { copyFileSync }=await import('node:fs');
  copyFileSync(join(import.meta.dirname,'runtime-launch.mjs'),join(root,'agents',agentId,'managed','runtime-launch.mjs'));
  if(installation.protocol==='acp/v1'){copyFileSync(join(import.meta.dirname,'opencode-policy.mjs'),join(root,'agents',agentId,'managed','opencode-policy.mjs'));copyFileSync(join(import.meta.dirname,'opencode-policy-core.mjs'),join(root,'agents',agentId,'managed','opencode-policy-core.mjs'));atomicWorkspaceWrite(join(root,'agents',agentId,'managed','instructions.md'),'');atomicWorkspaceWrite(join(root,'agents',agentId,'managed','runtime-command.json'),JSON.stringify({command:installation.command,opencode:{autoupdate:false,permission:{'*':'deny'},plugin:['file:///run/open-harness/opencode-policy.mjs']}}));}
  atomicWorkspaceWrite(join(root,'agents',agentId,'managed','policy.json'),JSON.stringify({allowedTools:[],mcpServers:[],coordination:{},reviewUnclassified:false,runId:'probe'}));
  atomicWorkspaceWrite(join(root,'agents',agentId,'managed','run-lease.json'),JSON.stringify({active:false,runId:null}));
  const payload=installation.kind.startsWith('custom:')?safeWorkspacePath(root,`harnesses/${installation.kind.slice(7)}/${installation.version}`):undefined;
  const container=await ensureContainerAsync(agentId,root,profile.computer,true,{image:installation.image,payload});
  return installation.protocol==='acp/v1'?new AcpGateway(container,installation,[]):new CustomGateway(container,installation,[]);
}
class CustomGateway extends HermesGateway {
  constructor(container:string,readonly installation:HarnessInstallation,tools:string[]){super(container,tools,null,['node','/run/open-harness/runtime-launch.mjs']);}
  async submitPrompt(sessionId:string,text:string,timeout?:number){const result=await super.submitPrompt(sessionId,text,timeout);if(process.env.OPEN_HARNESS_MOCK==='1')return {...result,final_response:String(result.final_response||result.text||'').replaceAll('Hermes mock',`${this.installation.kind} mock`)};return result;}
  async start(){await super.start();const answer=await this.request('runtime.initialize',{protocol:'open-harness-runtime/v1',allowedTools:this.allowedTools,policy:'/run/open-harness/policy.json',lease:'/run/open-harness/run-lease.json',configuration:'/workspace/harness-config',context:'/run/open-harness/runtime-context.json'},10000);if(process.env.OPEN_HARNESS_MOCK!=='1'&&(answer?.protocol!=='open-harness-runtime/v1'||answer?.policyEnforced!==true))throw new Error('The custom adapter did not confirm the runtime and permission contract.');}
}

export class AcpGateway extends EventEmitter implements AgentRuntime {
  private child:ChildProcessWithoutNullStreams|null=null;
  private sequence=0;
  private policyReady=false;
  private pending=new Map<string,{resolve:(value:any)=>void;reject:(error:Error)=>void;timer:NodeJS.Timeout}>();
  private approvals=new Map<string,{id:unknown;options:any[]}>();
  private histories=new Map<string,unknown[]>();
  private text=new Map<string,string>();
  private mock:HermesGateway|null=null;
  constructor(readonly container:string,readonly installation:HarnessInstallation,readonly tools:string[]){super();}
  async start(){
    if(process.env.OPEN_HARNESS_MOCK==='1'){this.mock=new HermesGateway(this.container,this.tools);this.mock.on('event',value=>this.emit('event',value));await this.mock.start();return;}
    const child=this.child=spawn('docker',['exec','-i','-e','OPEN_HARNESS_RUN_LEASE=/run/open-harness/run-lease.json',this.container,'node','/run/open-harness/runtime-launch.mjs'],{stdio:['pipe','pipe','pipe']});
    child.once('error',error=>this.failed(error));child.stdin.on('error',error=>this.failed(error));child.once('exit',code=>this.failed(Object.assign(new Error(`Harness process exited (${code}).`),{interrupted:true})));
    const lines=createInterface({input:child.stdout});let buffered=0;child.stdout.on('data',chunk=>{buffered+=chunk.length;if(buffered>8*1024*1024)this.failed(new Error('Harness protocol message is too large.'));});
    lines.on('line',line=>{buffered=0;try{this.receive(JSON.parse(line));}catch{this.emit('log',{level:'debug',message:line.slice(0,400)});}});
    createInterface({input:child.stderr}).on('line',line=>{if(line.startsWith('OPEN_HARNESS_POLICY_READY='))this.policyReady=true;else this.emit('log',{level:'debug',message:line.slice(0,400)});});
    const answer=await this.rpc('initialize',{protocolVersion:1,clientCapabilities:{fs:{readTextFile:false,writeTextFile:false},terminal:false},clientInfo:{name:'open-harness',version:'1'}},30000);
    if(answer?.protocolVersion!==1)throw new Error('This harness does not support ACP version 1.');
  }
  private failed(error:Error){for(const p of this.pending.values()){clearTimeout(p.timer);p.reject(error);}this.pending.clear();this.emit('exit',error);}
  private send(value:unknown){if(!this.child)throw new Error('Harness is not running.');this.child.stdin.write(JSON.stringify(value)+'\n');}
  private rpc(method:string,params:Record<string,unknown>,timeout=300000):Promise<any>{const id=String(++this.sequence);return new Promise((resolve,reject)=>{const timer=setTimeout(()=>{this.pending.delete(id);reject(new Error(`${method} timed out.`));},timeout);this.pending.set(id,{resolve,reject,timer});try{this.send({jsonrpc:'2.0',id,method,params});}catch(e){clearTimeout(timer);this.pending.delete(id);reject(e);}});}
  private receive(message:any){
    if(message.id!=null&&!message.method){const p=this.pending.get(String(message.id));if(p){clearTimeout(p.timer);this.pending.delete(String(message.id));if(message.error)p.reject(new Error(message.error.message||'Harness request failed.'));else p.resolve(message.result);}return;}
    const p=message.params||{};
    if(message.method==='session/request_permission'){
      const requestId=String(message.id),options=Array.isArray(p.options)?p.options:[];this.approvals.set(requestId,{id:message.id,options});this.emit('event',{type:'approval.request',session_id:p.sessionId,payload:{request_id:requestId,command:p.toolCall?.title||'Harness tool',tool:p.toolCall?.kind,preview:JSON.stringify(p.toolCall?.rawInput||{}).slice(0,2000)}});return;
    }
    if(message.method==='session/update'){
      const update=p.update||{},sessionId=p.sessionId;
      if(update.sessionUpdate==='agent_message_chunk'&&update.content?.type==='text'){const text=String(update.content.text||'');this.text.set(sessionId,(this.text.get(sessionId)||'')+text);this.emit('event',{type:'message.delta',session_id:sessionId,payload:{text}});}
      else if(update.sessionUpdate==='tool_call'||update.sessionUpdate==='tool_call_update')this.emit('event',{type:['completed','failed'].includes(update.status)?'tool.complete':'tool.start',session_id:sessionId,payload:{id:update.toolCallId,name:update.title||update.kind,result:update.content}});
      else this.emit('event',{type:'runtime.update',session_id:sessionId,payload:update});return;
    }
    if(message.id!=null)this.send({jsonrpc:'2.0',id:message.id,error:{code:-32601,message:'This client does not support that operation.'}});
  }
  async request(method:string,params:Record<string,unknown>={},timeout=300000):Promise<any>{
    if(this.mock)return this.mock.request(method,params,timeout);
    if(method==='session.create'){const session=await this.rpc('session/new',{cwd:params.cwd,mcpServers:[]},timeout);if(!session?.sessionId)throw new Error('Harness did not return a session ID.');if(this.installation.kind==='opencode'){const deadline=Date.now()+3000;while(!this.policyReady&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,25));if(!this.policyReady)throw new Error('The managed OpenCode permission policy did not load. No prompt was submitted.');}this.histories.set(session.sessionId,Array.isArray(params.messages)?params.messages:[]);return {session_id:session.sessionId};}
    if(method==='session.interrupt'){this.send({jsonrpc:'2.0',method:'session/cancel',params:{sessionId:params.session_id}});for(const [id,request]of this.approvals){this.send({jsonrpc:'2.0',id:request.id,result:{outcome:{outcome:'cancelled'}}});this.approvals.delete(id);}return {ok:true};}
    if(method==='approval.respond'){const id=String(params.request_id),request=this.approvals.get(id);if(!request)throw new Error('Permission request expired.');const allow=['once','approve','session','always'].includes(String(params.choice));const option=request.options.find(o=>o.kind===(allow?'allow_once':'reject_once'));this.send({jsonrpc:'2.0',id:request.id,result:{outcome:option?{outcome:'selected',optionId:option.optionId}:{outcome:'cancelled'}}});this.approvals.delete(id);return {ok:true};}
    if(method==='model.options')return {models:[]};
    throw new Error(`This harness does not support ${method}.`);
  }
  async submitPrompt(sessionId:string,text:string,timeout=86400000){
    if(this.mock){const result=await this.mock.submitPrompt(sessionId,text,timeout);return {...result,final_response:String(result.final_response||result.text||'').replaceAll('Hermes mock',`${this.installation.kind} mock`)};}
    const history=this.histories.get(sessionId)||[];this.histories.delete(sessionId);this.text.set(sessionId,'');
    const prompt=[...(history.length?[{type:'text',text:'Prior conversation (context):\n'+JSON.stringify(history),annotations:{audience:['assistant']}}]:[]),{type:'text',text}];
    const result=await this.rpc('session/prompt',{sessionId,prompt},timeout);const answer=this.text.get(sessionId)||'';this.text.delete(sessionId);if(result.stopReason==='cancelled')throw Object.assign(new Error('Harness work was cancelled.'),{interrupted:true});return {text:answer};
  }
  async stop(){if(this.mock){await this.mock.stop();this.mock=null;return;}const child=this.child;if(!child)return;this.child=null;child.stdin.end();const { commandAsync }=await import('./commands');const result=await commandAsync('docker',['stop','--time','2',this.container],15000);if(result.status!==0)throw new Error('Could not confirm harness cleanup.');if(child.exitCode===null)child.kill('SIGKILL');this.failed(Object.assign(new Error('Harness stopped.'),{interrupted:true}));this.approvals.clear();}
}
