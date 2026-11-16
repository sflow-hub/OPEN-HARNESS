/* eslint-disable @typescript-eslint/no-explicit-any */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import type { AgentProfile } from '../lib/agent-profile';
import { FALLBACK_HARNESSES, harnessOf, type HarnessChoice, type HarnessInfo } from '../lib/harness';
import { HERMES_RELEASE } from '../lib/hermes-pin';
import { encryptRunnerSecret, decryptRunnerSecret, generateRunnerKeyPair } from '../lib/runner-crypto';
import { AgentFiles, FILE_CHUNK_BYTES, installedFilePath, fileDigest, managedWorkingFiles, type UploadRecord } from './agent-files';
import { Profiles, ProfileError, validId } from './profiles';
import { Machines } from './machines';
import { harnessCatalog, installationBytes, installCustomPackage, installOpenCode, resolveInstallation, saveInstallation, validateHarnessCapabilities, type HarnessInstallation } from './harness-registry';
import { safeWorkspacePath } from './path-safety';
import { createInstallationProbe } from './agent-runtime';
import { stopAgentContainers } from './hermes';

type Job = { id:string;agentId:string;machineId:string;kind:'install'|'test'|'delete';input:any;state:string;detail:string;commandId?:string;installation?:HarnessInstallation };
type Reply = (res:ServerResponse,status:number,value:unknown)=>unknown;
export function decodeFileChunk(data:unknown){if(typeof data!=='string'||data.length>Math.ceil(FILE_CHUNK_BYTES/3)*4||data.length%4||!/^[A-Za-z0-9+/]*={0,2}$/.test(data))throw new ProfileError('Invalid file chunk.');const bytes=Buffer.from(data,'base64');if(bytes.toString('base64')!==data)throw new ProfileError('Invalid file chunk encoding.');return bytes;}
export class AgentAssets {
  readonly files:AgentFiles;
  private running=false;
  private exportKeys=new Map<string,Awaited<ReturnType<typeof generateRunnerKeyPair>>>();
  private timer:ReturnType<typeof setInterval>;
  constructor(readonly db:DatabaseSync,readonly root:string,readonly profiles:Profiles,readonly machines:Machines,readonly guards:{busy:(id:string)=>boolean;lock:(id:string)=>void;unlock:(id:string)=>void;discard:(id:string)=>Promise<void>}){
    this.files=new AgentFiles(db,root,id=>id==='local'?installationBytes(root):machines.get(id).capabilities.installedHarnessBytes||0);
    db.exec('CREATE TABLE IF NOT EXISTS harness_jobs(id TEXT PRIMARY KEY,json TEXT NOT NULL)');
    // Local image operations are restartable; remote jobs retain their durable command identity.
    for(const j of this.jobs())if(j.state==='running'&&!j.commandId){this.files.releaseInstallation(j.id);this.saveJob({...j,state:'failed',detail:'Installation was interrupted. Retry the operation; the previous version was preserved.'});}
    this.timer=setInterval(()=>void this.tick(),2000);this.timer.unref();
  }
  close(){clearInterval(this.timer);}
  blocksAgent(id:string){return this.files.uploads(id).some(u=>['assembling','uploaded','waiting-machine','delivering','verifying'].includes(u.state))||this.jobs().some(j=>j.agentId===id&&['queued','running'].includes(j.state));}
  private jobs(){return(this.db.prepare('SELECT json FROM harness_jobs ORDER BY rowid').all() as {json:string}[]).map(r=>JSON.parse(r.json) as Job);}
  private saveJob(j:Job){this.db.prepare('INSERT OR REPLACE INTO harness_jobs VALUES(?,?)').run(j.id,JSON.stringify(j));return j;}
  async catalog(machineId:string):Promise<HarnessInfo[]>{const m=this.machines.get(machineId);if(m.status==='revoked')throw new ProfileError('This computer has been revoked.',409);if(machineId==='local')return(await harnessCatalog(this.root)).map(h=>({...h,machineId}));const list=m.capabilities.harnesses;if(list)return list.map(h=>({...h,machineId,available:m.status==='online'&&h.available,reason:m.status==='online'?h.reason:'Reconnect this computer to check its harness.'}));return FALLBACK_HARNESSES.map(h=>({...h,machineId,version:h.kind==='hermes'?HERMES_RELEASE:'',available:h.kind==='hermes'&&m.capabilities.container,reason:h.kind==='hermes'?undefined:'Update this runner to install additional harnesses.'}));}
  async validateChoice(profile:AgentProfile, moving=false){const choice=harnessOf(profile),info=(await this.catalog(profile.computer.machineId)).find(h=>h.kind===choice.kind)||(moving?(await this.catalog(this.profile(profile.id).computer.machineId)).find(h=>h.kind===choice.kind):undefined);if(!info)throw new ProfileError('This harness is not installed on the selected computer.',409);validateHarnessCapabilities(profile,this.profiles.effective(profile),info);if(!moving&&choice.version&&info.versions&&!info.versions.includes(choice.version))throw new ProfileError('Choose an installed harness version.',409);if(choice.configRevision){const file=this.files.file(choice.configRevision,profile.id);if(file.destination!=='configuration'||(!moving&&!this.files.hasDelivery(file.id,profile.computer.machineId)))throw new ProfileError('Deliver this configuration to the assigned computer first.',409);}profile.harness={...choice,...(!choice.version&&info.available&&info.version?{version:info.version}:{})};return info;}
  async resolveHarness(profile:AgentProfile):Promise<HarnessChoice>{const info=await this.validateChoice(profile);if(!info.available)throw new ProfileError(info.reason||'Install this harness on the assigned computer first.',409);if(profile.computer.machineId!=='local'&&harnessOf(profile).kind!=='hermes'&&!this.machines.get(profile.computer.machineId).capabilities.features?.includes('agent-harnesses'))throw new ProfileError('Update this runner before using another harness.',409);if(profile.computer.machineId!=='local'&&harnessOf(profile).kind==='opencode'&&!this.machines.get(profile.computer.machineId).capabilities.features?.includes('opencode-policy-v2'))throw new ProfileError('Update this runner before using OpenCode tool authorization.',409);return {...harnessOf(profile),version:harnessOf(profile).version||info.version};}
  private profile(id:string){const p=this.profiles.get(validId(id));if(!p)throw new ProfileError('Agent not found.',404);return p;}
  private binding(u:UploadRecord,machineId=u.machineId){if(u.migrationId){const transfer=this.db.prepare("SELECT * FROM agent_transfers WHERE id=? AND agent_id=? AND destination_machine_id=? AND state IN ('exporting','importing','verifying')").get(u.migrationId,u.agentId,machineId) as {source_machine_id:string}|undefined;if(transfer&&this.profile(u.agentId).computer.machineId===transfer.source_machine_id&&this.machines.get(machineId).status!=='revoked')return this.profile(u.agentId);throw new ProfileError('This computer move is no longer authorized.',403);}const p=this.profile(u.agentId);if(p.computer.machineId!==machineId)throw new ProfileError('This upload belongs to the agent’s previous computer. Start a new upload for its current assignment.',409);if(this.machines.get(machineId).status==='revoked')throw new ProfileError('This computer was revoked.',403);return p;}
  private requireRunner(machineId:string){const m=this.machines.get(machineId);if(m.status==='revoked')throw new ProfileError('This computer has been revoked.',409);if(machineId!=='local'&&!m.capabilities.features?.includes('agent-files'))throw new ProfileError('Update this runner before uploading files.',409);return m;}
  async runnerHandle(req:IncomingMessage,res:ServerResponse,url:URL,machineId:string,reply:Reply,body:(req:IncomingMessage,limit?:number)=>Promise<any>){
    if(await this.exportHandle(req,res,url,machineId,reply,body))return true;
    const match=url.pathname.match(/^\/v1\/runner\/files\/([^/]+)(?:\/chunks\/(\d+))?$/);if(!match)return false;if(req.method!=='GET')throw new ProfileError('Unsupported file delivery operation.',405);
    const u=this.files.get(match[1]);this.binding(u);if(u.machineId!==machineId||!['uploaded','waiting-machine','delivering','verifying','ready'].includes(u.state))throw new ProfileError('This runner cannot access that upload.',403);
    const key=this.machines.encryptionKey(machineId);if(!key)throw new ProfileError('Reconnect the runner to publish its encryption key.',409);
    if(url.searchParams.get('phase')==='verifying'&&u.state==='delivering')this.files.update(u,'verifying','Verifying the delivered bytes.');
    const content=match[2]!==undefined?{...await this.files.chunk(u.id,Number(match[2])),index:Number(match[2])}:{file:u,chunkBytes:FILE_CHUNK_BYTES};
    reply(res,200,{encrypted:await encryptRunnerSecret(key,JSON.stringify({purpose:'agent-file/v1',uploadId:u.id,agentId:u.agentId,machineId,...content}))});return true;
  }
  async handle(req:IncomingMessage,res:ServerResponse,url:URL,body:(req:IncomingMessage,limit?:number)=>Promise<any>,reply:Reply):Promise<boolean>{
    if(req.method==='GET'&&url.pathname==='/v1/harnesses'){reply(res,200,{harnesses:await this.catalog(url.searchParams.get('machineId')||'local')});return true;}
    const jobMatch=url.pathname.match(/^\/v1\/harness-jobs\/([^/]+)$/);if(jobMatch&&req.method==='GET'){const j=this.jobs().find(j=>j.id===jobMatch[1]);if(!j)throw new ProfileError('Harness job not found.',404);reply(res,200,j);return true;}
    const installation=url.pathname.match(/^\/v1\/machines\/([^/]+)\/harnesses\/(install|test)$/);
    if(installation&&req.method==='POST'){
      const machineId=validId(installation[1]),input=await body(req),p=this.profile(String(input.agentId||''));if(p.computer.machineId!==machineId)throw new ProfileError('Choose the agent’s assigned computer.',409);this.requireRunner(machineId);
      if(input.kind!=='opencode'&&!String(input.kind||'').startsWith('custom:'))throw new ProfileError('Choose OpenCode or a custom harness.');
      if(installation[2]==='install'&&input.kind!=='opencode'){const file=this.files.file(String(input.fileId||''),p.id);if(file.destination!=='package'||file.machineId!==machineId)throw new ProfileError('Upload a harness package for this agent and computer first.');}
      const job=this.saveJob({id:randomUUID(),agentId:p.id,machineId,kind:installation[2] as 'install'|'test',input:{kind:input.kind,fileId:input.fileId,version:input.version},state:'queued',detail:'Waiting for this agent to finish.'});reply(res,202,job);void this.tick();return true;
    }
    const route=url.pathname.match(/^\/v1\/agents\/([^/]+)\/(uploads|files)(?:\/([^/]+))?(?:\/(chunks)(?:\/(\d+))?|\/(finalize|cancel|retry))?$/);if(!route)return false;
    const p=this.profile(route[1]),id=route[3],collection=route[2],index=route[5]===undefined?undefined:Number(route[5]),action=route[6];
    if(!id&&req.method==='GET'){reply(res,200,collection==='uploads'?{uploads:this.files.uploads(p.id)}:{files:this.files.list(p.id).filter(f=>f.machineId===p.computer.machineId),maximumBytes:this.files.maximum,quotaBytes:this.files.quota});return true;}
    if(!id&&collection==='uploads'&&req.method==='POST'){this.requireRunner(p.computer.machineId);if(this.machines.transferring(p.id))throw new ProfileError('Wait for this agent’s computer move to finish.',409);const input=await body(req);if(input.machineId!==undefined&&input.machineId!==p.computer.machineId)throw new ProfileError('Save this agent’s computer change before uploading files.',409);reply(res,201,this.files.create(p.id,p.computer.machineId,input));return true;}
    if(!id)throw new ProfileError('Unsupported file operation.',405);
    if(collection==='files'){
      const f=this.files.file(id,p.id);if(f.machineId!==p.computer.machineId)throw new ProfileError('This file belongs to a different computer assignment.',409);
      if(req.method==='GET'&&index!==undefined){reply(res,200,await this.files.chunk(id,index));return true;}
      if(req.method==='GET'){reply(res,200,{...f,chunkBytes:FILE_CHUNK_BYTES});return true;}
      if(req.method==='DELETE'){if(this.guards.busy(p.id)||this.machines.transferring(p.id)||this.blocksAgent(p.id))throw new ProfileError('Wait for this agent to finish before deleting files.',409);if(this.profiles.list().some(a=>harnessOf(a).configRevision===id)||this.db.prepare("SELECT 1 FROM run_profiles WHERE json_extract(json,'$.harness.configRevision')=? LIMIT 1").get(id))throw new ProfileError('Select another harness configuration before deleting this file.',409);if(f.destination==='package'&&this.jobs().some(j=>j.input.fileId===id&&j.state==='completed'))throw new ProfileError('This package is retained by an installed harness.',409);this.guards.lock(p.id);try{await this.guards.discard(p.id);if(p.computer.machineId==='local')rmSync(installedFilePath(this.root,f),{force:true});else{this.requireRunner(p.computer.machineId);const job=this.saveJob({id:randomUUID(),agentId:p.id,machineId:p.computer.machineId,kind:'delete',input:{file:f},state:'queued',detail:'Waiting for computer.'});reply(res,202,job);return true;}this.files.remove(id,p.id);reply(res,200,{ok:true});}finally{this.guards.unlock(p.id);}return true;}
    }
    const u=this.files.get(id,p.id);
    if(req.method==='GET'&&!route[4]&&!action){reply(res,200,this.files.inspect(id,p.id));return true;}
    if(action!=='cancel')this.binding(u);
    if(req.method==='PUT'&&index!==undefined){const input=await body(req,1600000);await this.files.put(id,index,decodeFileChunk(input.data),String(input.checksum));reply(res,200,{ok:true});return true;}
    if(req.method==='POST'&&action==='finalize'){reply(res,202,this.files.queueFinalize(id));void this.tick();return true;}
    if(req.method==='POST'&&action==='retry'){reply(res,202,this.files.retry(id));void this.tick();return true;}
    if(req.method==='POST'&&action==='cancel'){reply(res,200,this.files.cancel(id));return true;}
    throw new ProfileError('Unsupported file operation.',405);
  }
  private stageMove(transfer:{id:string;agentId:string;destinationMachineId:string},input:{path:string;destination:'work'|'configuration'|'package';size:number;checksum:string}){
    const prior=this.files.list(transfer.agentId).find(f=>f.machineId===transfer.destinationMachineId&&f.path.toLowerCase()===input.path.toLowerCase()&&f.destination===input.destination);
    const created=this.files.create(transfer.agentId,transfer.destinationMachineId,{...input,replaceExisting:true,...(prior?{replaceId:prior.id}:{})});return this.files.update({...created,migrationId:transfer.id},'uploading');
  }
  private async exportHandle(req:IncomingMessage,res:ServerResponse,url:URL,machineId:string,reply:Reply,body:(req:IncomingMessage,limit?:number)=>Promise<any>){
    const match=url.pathname.match(/^\/v1\/runner\/file-exports\/([^/]+)\/(manifest|chunks|finalize)(?:\/([^/]+)(?:\/(\d+))?)?$/);if(!match)return false;
    const key=this.exportKeys.get(match[1]),row=this.db.prepare("SELECT * FROM agent_transfers WHERE id=? AND source_machine_id=? AND state='exporting'").get(match[1],machineId) as {agent_id:string;destination_machine_id:string}|undefined;
    if(req.method!=='POST'||!key||!row||this.profile(row.agent_id).computer.machineId!==machineId)throw new ProfileError('This file export is no longer authorized.',403);
    const input=await body(req,2100000),value=JSON.parse(await decryptRunnerSecret(key.privateKey,input.encrypted));if(value.purpose!=='agent-file-export/v1'||value.transferId!==match[1]||value.agentId!==row.agent_id||value.machineId!==machineId)throw new ProfileError('File export binding mismatch.',403);
    if(match[2]==='manifest'){const file=this.stageMove({id:match[1],agentId:row.agent_id,destinationMachineId:row.destination_machine_id},{path:value.path,size:value.size,checksum:value.checksum,destination:'work'});reply(res,201,{id:file.id});return true;}
    const u=this.files.get(match[3],row.agent_id);if(u.migrationId!==match[1]||u.id!==value.uploadId)throw new ProfileError('File belongs to another computer move.',403);
    if(match[2]==='chunks'){const index=Number(match[4]);if(value.index!==index)throw new ProfileError('Chunk binding mismatch.',403);await this.files.put(u.id,index,decodeFileChunk(value.data),value.checksum);reply(res,200,{ok:true});}
    else{
      if(u.state==='uploading'){this.files.queueFinalize(u.id);void this.files.finalize(u.id).catch(error=>this.files.update(this.files.get(u.id),'failed',error instanceof Error?error.message:'File verification failed.'));}
      const current=this.files.get(u.id);if(current.state==='failed')throw new ProfileError(current.detail,409);reply(res,202,{ok:true,state:current.state});
    }return true;
  }
  async moveFiles(transfer:{id:string;agentId:string;sourceMachineId:string;destinationMachineId:string;pendingProfile?:AgentProfile},wait:(id:string)=>Promise<any>){
    const pending=transfer.pendingProfile!;const start=(this.db.prepare('SELECT id FROM managed_uploads').all() as {id:string}[]).map(r=>r.id);
    try{
      if(transfer.sourceMachineId==='local'){
        for(const file of managedWorkingFiles(this.root,transfer.agentId)){const source=safeWorkspacePath(this.root,`agents/${transfer.agentId}/files/work/${file.path}`),u=this.stageMove(transfer,{...file,destination:'work',checksum:await fileDigest(source)}),handle=await open(source,'r');try{for(let index=0;index<Math.ceil(u.size/FILE_CHUNK_BYTES);index++){const bytes=Buffer.alloc(Math.min(FILE_CHUNK_BYTES,u.size-index*FILE_CHUNK_BYTES));if((await handle.read(bytes,0,bytes.length,index*FILE_CHUNK_BYTES)).bytesRead!==bytes.length)throw new Error('Source file changed during transfer.');await this.files.put(u.id,index,bytes,createHash('sha256').update(bytes).digest('hex'));}}finally{await handle.close();}await this.files.finalize(u.id);}
      }else if(this.machines.get(transfer.sourceMachineId).capabilities.features?.includes('agent-files')){
        const key=await generateRunnerKeyPair();this.exportKeys.set(transfer.id,key);await wait(this.machines.enqueue(transfer.sourceMachineId,transfer.agentId,'file-export',{transferId:transfer.id,publicKey:key.publicKey,profile:this.profile(transfer.agentId)}).id);
      }else if(this.files.list(transfer.agentId).some(f=>f.machineId===transfer.sourceMachineId))throw new Error('Update the source runner before moving uploaded files.');
      const originals=this.files.list(transfer.agentId).filter(f=>f.machineId===transfer.sourceMachineId&&f.destination!=='work');
      for(const original of originals){const u=this.stageMove(transfer,{...original});for(let index=0;index<Math.ceil(u.size/FILE_CHUNK_BYTES);index++){const chunk=await this.files.chunk(original.id,index);await this.files.put(u.id,index,Buffer.from(chunk.data,'base64'),chunk.checksum);}await this.files.finalize(u.id);if(pending.harness?.configRevision===original.id)pending.harness={...pending.harness,configRevision:u.id};}
      const moved=this.files.uploads(transfer.agentId).filter(u=>u.migrationId===transfer.id);
      if(moved.length&&transfer.destinationMachineId!=='local')this.requireRunner(transfer.destinationMachineId);
      for(const u of moved){if(transfer.destinationMachineId==='local')await this.files.publishLocal(u.id);else{const result=await wait(this.machines.enqueue(transfer.destinationMachineId,transfer.agentId,'file-delivery',{uploadId:u.id,profile:pending}).id);if(result.checksum!==u.checksum)throw new Error('Destination file checksum mismatch.');this.files.publish(u.id);}}
      const choice=harnessOf(pending);
      if(choice.kind!=='hermes'){
        const info=(await this.catalog(transfer.destinationMachineId)).find(h=>h.kind===choice.kind),installed=info?.available&&(!choice.version||info.versions?.includes(choice.version));
        if(!installed){const sourceJob=this.jobs().find(j=>j.state==='completed'&&j.installation?.kind===choice.kind&&(!choice.version||j.installation.version===choice.version));const sourcePackage=sourceJob?.input.fileId?this.files.get(sourceJob.input.fileId):null;const file=moved.find(u=>u.destination==='package'&&sourcePackage?.checksum===u.checksum);if(choice.kind!=='opencode'&&!file)throw new Error('The custom harness package must be retained before moving this agent.');
          if(transfer.destinationMachineId==='local'){const item=choice.kind==='opencode'?await installOpenCode(this.root):await installCustomPackage(this.root,installedFilePath(this.root,file!),this.files.quota);await testHarnessInstallation(this.root,item,randomUUID());}
          else await wait(this.machines.enqueue(transfer.destinationMachineId,transfer.agentId,'harness-install',{jobId:randomUUID(),kind:choice.kind,action:'install',fileId:file?.id,profile:pending}).id);
        }
      }
      // Verification still occurs before Profiles.applyTransferredProfile changes assignment.
      await this.resolveHarness(pending);
    }catch(error){for(const u of this.files.uploads(transfer.agentId).filter(u=>u.migrationId===transfer.id&&!start.includes(u.id))){this.db.prepare('DELETE FROM managed_files WHERE id=?').run(u.id);this.files.update(u,'failed','Computer move failed; source data was preserved.');}throw error;}
    finally{this.exportKeys.delete(transfer.id);}
  }
  async tick(){if(this.running)return;this.running=true;try{
    this.files.expire();
    const rows=this.db.prepare('SELECT json FROM managed_uploads').all() as {json:string}[],handled=new Set<string>();
    for(const row of rows){let u=JSON.parse(row.json) as UploadRecord;if(handled.has(u.agentId)||u.migrationId||!['assembling','uploaded','waiting-machine','delivering','verifying'].includes(u.state))continue;
      if(this.guards.busy(u.agentId)||this.machines.transferring(u.agentId))continue;
      handled.add(u.agentId);this.guards.lock(u.agentId);
      try{this.binding(u);if(u.state==='assembling'){await this.files.finalize(u.id);u=this.files.get(u.id);}await this.guards.discard(u.agentId);this.files.assertPublication(u.id);const m=this.requireRunner(u.machineId);if(m.status!=='online'){this.files.update(u,'waiting-machine','Waiting for the assigned computer.');continue;}
        if(u.machineId==='local'){this.files.update(u,'verifying');await this.files.publishLocal(u.id);}
        else {let command=this.db.prepare("SELECT id,state,result_json FROM runner_commands WHERE kind='file-delivery' AND agent_id=? AND json_extract(payload_json,'$.uploadId')=? AND COALESCE(json_extract(payload_json,'$.attempt'),0)=? ORDER BY rowid DESC LIMIT 1").get(u.agentId,u.id,u.deliveryAttempt||0) as {id:string;state:string;result_json:string|null}|undefined;if(!command){const item=this.machines.enqueue(u.machineId,u.agentId,'file-delivery',{uploadId:u.id,attempt:u.deliveryAttempt||0,profile:this.profile(u.agentId)});command={id:item.id,state:'queued',result_json:null};}if(command.state==='completed'){const result=JSON.parse(command.result_json||'{}');if(result.checksum!==u.checksum)throw new Error('Destination checksum did not match.');this.files.publish(u.id);}else if(command.state==='failed')throw new Error(JSON.parse(command.result_json||'{}').error||'File delivery failed.');else this.files.update(u,'delivering','Delivering to the assigned computer.');}
      }catch(e){u=this.files.get(u.id);this.files.update(u,'failed',e instanceof Error?e.message:'Delivery failed.');}finally{this.guards.unlock(u.agentId);}
    }
    for(const job of this.jobs().filter(j=>['queued','running'].includes(j.state))){if(this.guards.busy(job.agentId)||this.machines.transferring(job.agentId))continue;this.guards.lock(job.agentId);try{
      const p=this.profile(job.agentId);if(p.computer.machineId!==job.machineId)throw new Error('The agent changed computers. Start this operation on its current computer.');const m=this.requireRunner(job.machineId);if(m.status!=='online')continue;await this.guards.discard(job.agentId);
      if(job.machineId!=='local'){
        if(!job.commandId){const quotaBytes=job.kind==='install'&&job.input.kind!=='opencode'?this.files.reserveInstallation(job.id,job.machineId):undefined;const cmd=this.machines.enqueue(job.machineId,job.agentId,job.kind==='delete'?'file-delete':'harness-install',{jobId:job.id,action:job.kind,...job.input,quotaBytes,profile:p});this.saveJob({...job,state:'running',commandId:cmd.id,detail:'Running on the assigned computer.'});continue;}
        const command=this.machines.command(job.commandId);if(command?.state==='completed'){this.files.releaseInstallation(job.id);if(job.kind==='delete')this.files.remove(job.input.file.id,job.agentId);this.saveJob({...job,state:'completed',installation:(command.result as any)?.installation,detail:'Ready.'});}else if(command?.state==='failed')throw new Error(String((command.result as any)?.error||'Runner operation failed.'));continue;
      }
      this.saveJob({...job,state:'running',detail:job.kind==='test'?'Testing harness.':'Installing harness.'});
      let item:HarnessInstallation;
      if(job.kind==='delete'){rmSync(installedFilePath(this.root,job.input.file),{force:true});this.files.remove(job.input.file.id,job.agentId);this.saveJob({...job,state:'completed',detail:'Deleted.'});continue;}
      if(job.kind==='test')item=resolveInstallation(this.root,{kind:job.input.kind,version:job.input.version});else if(job.input.kind==='opencode')item=await installOpenCode(this.root);else{const budget=this.files.reserveInstallation(job.id,job.machineId);try{item=await installCustomPackage(this.root,installedFilePath(this.root,this.files.file(job.input.fileId,job.agentId)),budget);}finally{this.files.releaseInstallation(job.id);}}
      await testHarnessInstallation(this.root,item,job.id);this.saveJob({...job,state:'completed',installation:item,detail:'Installed and tested. Ready to select.'});
    }catch(e){this.files.releaseInstallation(job.id);this.saveJob({...job,state:'failed',detail:e instanceof Error?e.message:'Installation failed.'});}finally{this.guards.unlock(job.agentId);}}
  }finally{this.running=false;}}
}
export async function testHarnessInstallation(root:string,item:HarnessInstallation,id:string){const agentId=`harness-probe-${id}`,gateway=await createInstallationProbe(root,item,agentId);try{await gateway.start();if(item.protocol==='acp/v1'){const session=await gateway.request('session.create',{cwd:'/workspace/private'},30000);await gateway.request('session.interrupt',{session_id:session.session_id},10000);}if(item.protocol==='open-harness-runtime/v1'&&process.env.OPEN_HARNESS_MOCK!=='1'){const result=await gateway.request('runtime.selfTest',{allowedTools:[],leaseActive:false},10000);if(!result?.deniedTool||!result?.deniedExpiredLease||!result?.cancellation)throw new Error('Adapter permission and cancellation self-tests failed.');}}finally{try{await gateway.stop();}finally{await stopAgentContainers(agentId,root);}}item.tested=true;saveInstallation(root,item);}
