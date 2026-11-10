import {createCipheriv,createDecipheriv,createHash,randomBytes,randomUUID} from 'node:crypto';
import {createReadStream,createWriteStream,constants} from 'node:fs';
import {chmod,link,lstat,mkdir,open,readdir,rename,rm,stat,writeFile} from 'node:fs/promises';
import {dirname,join,relative,resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {Worker} from 'node:worker_threads';
import {Readable,Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {createGzip,createGunzip} from 'node:zlib';
import {createInterface} from 'node:readline';
import type {DatabaseSync} from 'node:sqlite';
import {S3Client,PutObjectCommand,GetObjectCommand,ListObjectsV2Command,DeleteObjectCommand} from '@aws-sdk/client-s3';
import {getSignedUrl} from '@aws-sdk/s3-request-presigner';
import {safeWorkspacePath} from './path-safety';
import {ProductError} from './product-error';
import {SCHEMA_VERSION} from './db';

const maximumFile=16_000_000,maximumWorkspace=256_000_000;
const fileLimit=(path:string)=>path==='state.db'?128_000_000:maximumFile;
const digest=(value:Buffer|string)=>createHash('sha256').update(value).digest('hex');
async function fileDigest(path:string){const hash=createHash('sha256');for await(const chunk of createReadStream(path))hash.update(chunk);return hash.digest('hex');}
const omitted=new Set(['.config','.cache','.local','.ssh','.gnupg','.aws','.azure','.docker','.kube','.git-credentials','.netrc','.npmrc','.pypirc','.bash_history','.zsh_history']);
export function portableBackupPath(path:string){if(path==='state.db')return true;if(!/^(?:shared\/|agents\/[A-Za-z0-9_-]+\/(?:private\/|profile\/(?:skills|memories)\/))/.test(path))return false;const parts=path.split('/');return !path.includes('\\')&&!parts.some(part=>!part||part==='.'||part==='..'||part.includes(':')||part.startsWith('.env')||omitted.has(part))&&!/\.git\/(?:config|hooks)(?:\/|$)/.test(path);}
const databaseWorker=String.raw`
const {parentPort,workerData}=require('node:worker_threads');
const {DatabaseSync}=require('node:sqlite');
try{
 const source=new DatabaseSync(workerData.source,{readOnly:true});source.prepare('VACUUM INTO ?').run(workerData.target);source.close();
 const db=new DatabaseSync(workerData.target);const has=name=>Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
 db.exec('BEGIN IMMEDIATE');
 for(const table of ['runtime_processes','app_oauth','browser_pairings','machine_pairings','model_lease_releases','runner_commands','terminal_permission_revocations','cli_cleanup_commands','desktop_continuations'])if(has(table))db.exec('DELETE FROM '+table);
 if(has('app_connections'))db.exec("UPDATE app_connections SET secret_ref='',state='needs_authorization',shared_json='[]',expires_at=0,last_error='Authorize this account on the destination workspace.'");
 if(has('runs'))db.exec("UPDATE runs SET state='interrupted',error='Restored work was not replayed. Inspect saved results before continuing.' WHERE state IN ('queued','running','waiting_approval','waiting_input')");
 if(has('approvals'))db.exec("UPDATE approvals SET state='expired' WHERE state IN ('pending','submitting','submitted')");
 if(has('run_inputs'))db.exec("UPDATE run_inputs SET state='expired' WHERE state IN ('pending','submitting','submitted')");
 if(has('schedules'))db.exec('UPDATE schedules SET enabled=0');
 if(has('workflow_routines'))db.exec('UPDATE workflow_routines SET enabled=0,webhook_hash=NULL');
 if(has('responsibilities'))db.exec("UPDATE responsibilities SET state='paused',active_run_id=NULL,last_error='Restored responsibilities require connection and readiness review.' WHERE state!='completed'");
 if(has('action_intents'))db.exec("UPDATE action_intents SET state=CASE WHEN state='dispatching' THEN 'uncertain' ELSE 'denied' END WHERE state IN ('dispatching','awaiting_approval','approved')");
 if(has('action_grants'))db.exec('UPDATE action_grants SET revoked=1');
 if(has('human_members'))db.exec("DELETE FROM human_members WHERE actor_id!='local-owner'");
 if(has('machines')){const columns=db.prepare('PRAGMA table_info(machines)').all().map(row=>row.name);if(columns.includes('revoked_at'))db.exec("UPDATE machines SET revoked_at=datetime('now'),credential_hash=NULL,status='revoked' WHERE id!='local'");}
 if(has('agent_profiles')){for(const row of db.prepare('SELECT id,json FROM agent_profiles').all()){const profile=JSON.parse(row.json),computer={...profile.computer,machineId:'local',access:'private',folders:[],desktop:'none',browserSessionTeamId:undefined,reserveMachine:false};if(JSON.stringify(computer)===JSON.stringify(profile.computer))continue;profile.computer=computer;profile.revision++;const json=JSON.stringify(profile);db.prepare('UPDATE agent_profiles SET json=?,revision=? WHERE id=?').run(json,profile.revision,row.id);if(has('profile_revisions'))db.prepare('INSERT INTO profile_revisions VALUES(?,?,?)').run(row.id,profile.revision,json);}}
 if(workerData.workspaceId&&has('workspace_identity'))db.prepare('UPDATE workspace_identity SET id=?,edition=?').run(workerData.workspaceId,workerData.edition||'self-hosted');
 db.exec('COMMIT');db.exec('PRAGMA wal_checkpoint(TRUNCATE)');db.close();parentPort.postMessage({ok:true});
}catch{parentPort.postMessage({ok:false});}
`;
async function sanitizedDatabase(source:string,target:string,workspaceId?:string,edition?:string){await new Promise<void>((resolve,reject)=>{const worker=new Worker(databaseWorker,{eval:true,workerData:{source,target,workspaceId,edition}}),timer=setTimeout(()=>{void worker.terminate();reject(new ProductError('Workspace snapshot exceeded its time limit.',503));},60000);worker.once('message',value=>{clearTimeout(timer);if(value.ok)resolve();else reject(new ProductError('The workspace database could not be prepared for migration.',503));});worker.once('error',()=>{clearTimeout(timer);reject(new ProductError('The workspace snapshot worker failed.',503));});});await chmod(target,0o600);}
export function backupKey(value:string){if(!/^[a-f0-9]{64}$/i.test(value))throw new ProductError('Use a 64-character hexadecimal backup recovery key.');return Buffer.from(value,'hex');}
export function generateBackupKey(){return randomBytes(32).toString('hex');}
export async function createBackup(input:{root:string;target:string;key:string;workspaceId:string}){
  const root=resolve(input.root),temporary=join(tmpdir(),`oh-backup-${randomUUID()}`);await mkdir(temporary,{mode:0o700});const database=join(temporary,'state.db'),iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',backupKey(input.key),iv),manifest:{version:1;workspaceId:string;createdAt:string;schema:number;files:number;bytes:number}={version:1,workspaceId:input.workspaceId,createdAt:new Date().toISOString(),schema:SCHEMA_VERSION,files:0,bytes:0};
  await mkdir(dirname(resolve(input.target)),{recursive:true,mode:0o700});const output=resolve(input.target),staged=output+`.${randomUUID()}.tmp`;
  try{
    await sanitizedDatabase(join(root,'state.db'),database);
    async function* records(){yield JSON.stringify({manifest})+'\n';const visit=async function*(directory:string):AsyncGenerator<string>{let names:string[];try{names=await readdir(directory);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}for(const name of names.sort()){const path=join(directory,name),relativePath=relative(root,path).replaceAll('\\','/'),info=await lstat(path);if(info.isSymbolicLink())continue;if(info.isDirectory()){if(!omitted.has(name)&&!name.startsWith('.env'))yield*visit(path);continue;}if(!info.isFile()||!portableBackupPath(relativePath))continue;yield relativePath;}};
      const paths=['state.db'];for await(const path of visit(join(root,'shared')))paths.push(path);for await(const path of visit(join(root,'agents')))paths.push(path);
      if(paths.length>10000)throw new ProductError('This workspace exceeds the 10,000-file backup limit.');
      for(const path of paths){const target=path==='state.db'?database:safeWorkspacePath(root,path),handle=await open(target,constants.O_RDONLY|(constants.O_NOFOLLOW||0)|(constants.O_NONBLOCK||0));let data:Buffer;try{const info=await handle.stat();if(!info.isFile()||info.size>fileLimit(path))throw new ProductError(`Backup file exceeds its ${fileLimit(path)/1000000} MB limit: ${path}`);manifest.bytes+=info.size;if(manifest.bytes>maximumWorkspace)throw new ProductError('This workspace exceeds the 256 MB backup limit.');data=await handle.readFile();}finally{await handle.close();}manifest.files++;yield JSON.stringify({path,checksum:digest(data),data:data.toString('base64')})+'\n';}
      yield JSON.stringify({complete:manifest})+'\n';
    }
    await writeFile(staged,Buffer.concat([Buffer.from('OHB1'),iv]),{mode:0o600,flag:'wx'});
    await pipeline(Readable.from(records()),createGzip(),cipher,createWriteStream(staged,{flags:'a',mode:0o600}));
    const handle=await open(staged,'a');try{await handle.write(cipher.getAuthTag());await handle.sync();}finally{await handle.close();}
    await link(staged,output);return {...manifest,checksum:await fileDigest(output),path:output};
  }finally{await rm(temporary,{recursive:true,force:true});await rm(staged,{force:true});}
}
export async function restoreBackup(input:{archive:string;target:string;key:string;workspaceId?:string;edition?:'managed'|'self-hosted'}){
  const target=resolve(input.target);try{await stat(target);throw new ProductError('Restore into a new folder so existing workspace data stays intact.',409);}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  const staged=target+`.restore-${randomUUID()}`,temporary=join(tmpdir(),`oh-restore-${randomUUID()}`);await mkdir(temporary,{mode:0o700});const compressed=join(temporary,'verified.gz');
  try{
    const archive=await open(input.archive,'r');let header:Buffer,tag:Buffer,size:number;try{size=(await archive.stat()).size;if(size<33||size>maximumWorkspace*2)throw new ProductError('Invalid workspace backup size.');header=Buffer.alloc(16);tag=Buffer.alloc(16);await archive.read(header,0,16,0);await archive.read(tag,0,16,size-16);}finally{await archive.close();}if(header.subarray(0,4).toString()!=='OHB1')throw new ProductError('This is not a supported workspace backup.');
    const decipher=createDecipheriv('aes-256-gcm',backupKey(input.key),header.subarray(4));decipher.setAuthTag(tag);
    try{await pipeline(createReadStream(input.archive,{start:16,end:size-17}),decipher,createWriteStream(compressed,{flags:'wx',mode:0o600}));}catch{throw new ProductError('The backup could not be authenticated. Check its recovery key and integrity.');}
    await mkdir(staged,{mode:0o700,recursive:true});let total=0,count=0,complete=false,manifest:{version:number;workspaceId:string;schema:number}|undefined;const seen=new Set<string>();
    const source=new Transform({transform(chunk,_encoding,callback){total+=chunk.length;if(total>maximumWorkspace*1.5+10000000)callback(new ProductError('The decompressed backup exceeds its limit.'));else callback(null,chunk);}}),lines=createInterface({input:source,crlfDelay:Infinity});
    let sourceError:unknown;source.on('error',()=>lines.close());const unpack=pipeline(createReadStream(compressed),createGunzip(),source).catch(error=>{sourceError=error;lines.close();});
    try{for await(const line of lines){if(complete)throw new ProductError('Backup contains data after its manifest.');const value=JSON.parse(line);if(value.manifest){if(manifest||count)throw new ProductError('Duplicate backup manifest.');manifest=value.manifest;if(manifest?.version!==1||!manifest.workspaceId||manifest.schema>SCHEMA_VERSION)throw new ProductError('This backup requires a compatible Open Harness release.');}else if(value.complete){if(!manifest||value.complete.files!==count||value.complete.workspaceId!==manifest.workspaceId)throw new ProductError('Backup manifest did not match its contents.');complete=true;}else{if(!manifest||!portableBackupPath(value.path)||seen.has(value.path)||count>=10000||typeof value.data!=='string'||value.data.length>fileLimit(value.path)*1.4)throw new ProductError('Invalid or repeated backup file.');const data=Buffer.from(value.data,'base64');if(data.length>fileLimit(value.path)||digest(data)!==value.checksum)throw new ProductError('Backup file checksum did not match.');seen.add(value.path);count++;const path=safeWorkspacePath(staged,value.path);await mkdir(dirname(path),{recursive:true,mode:0o700});await writeFile(path,data,{mode:0o600,flag:'wx'});}}
    }finally{lines.close();source.destroy();await unpack;}if(sourceError)throw sourceError;if(!complete||!seen.has('state.db'))throw new ProductError('The backup is incomplete.');
    const db=join(temporary,'destination.db');await sanitizedDatabase(join(staged,'state.db'),db,input.workspaceId,input.edition);await rename(db,join(staged,'state.db'));await rename(staged,target);return {workspaceId:input.workspaceId||manifest!.workspaceId,files:count,path:target,reauthorizationRequired:true,routinesPaused:true};
  }finally{await rm(temporary,{recursive:true,force:true});await rm(staged,{recursive:true,force:true});}
}
export class S3Backups{
  private client:S3Client;
  constructor(private bucket:string,private prefix:string,config:NonNullable<ConstructorParameters<typeof S3Client>[0]>){if(!bucket||!prefix||prefix.includes('..'))throw new Error('Configure a dedicated backup bucket and workspace prefix.');this.client=new S3Client(config);}
  private key(name:string){if(!/^[A-Za-z0-9_.-]+\.ohb$/.test(name))throw new ProductError('Invalid backup object name.');return this.prefix.replace(/\/$/,'')+'/'+name;}
  async put(name:string,path:string){const info=await stat(path);await this.client.send(new PutObjectCommand({Bucket:this.bucket,Key:this.key(name),Body:createReadStream(path),ContentLength:info.size,ContentType:'application/octet-stream'}));}
  async get(name:string,path:string){const object=await this.client.send(new GetObjectCommand({Bucket:this.bucket,Key:this.key(name)}));if(!object.Body||Number(object.ContentLength)>maximumWorkspace*2)throw new ProductError('Invalid backup object.');await pipeline(object.Body as Readable,createWriteStream(path,{mode:0o600,flags:'wx'}));}
  async download(name:string){return {url:await getSignedUrl(this.client,new GetObjectCommand({Bucket:this.bucket,Key:this.key(name),ResponseContentDisposition:`attachment; filename="${name}"`}),{expiresIn:300}),expiresIn:300};}
  async retain(days:number){if(!Number.isInteger(days)||days<1||days>365)throw new ProductError('Choose 1–365 backup retention days.');let continuation:string|undefined;do{const result=await this.client.send(new ListObjectsV2Command({Bucket:this.bucket,Prefix:this.prefix.replace(/\/$/,'')+'/',ContinuationToken:continuation}));for(const item of result.Contents||[])if(item.Key&&item.LastModified&&item.Key.endsWith('.ohb')&&item.LastModified.getTime()<Date.now()-days*86400000)await this.client.send(new DeleteObjectCommand({Bucket:this.bucket,Key:item.Key}));continuation=result.NextContinuationToken;}while(continuation);}
}
export function applyRetention(db:DatabaseSync,eventsDays=30,auditDays=365){const cutoff=new Date(Date.now()-eventsDays*86400000).toISOString(),auditCutoff=new Date(Date.now()-auditDays*86400000).toISOString();db.prepare("DELETE FROM events WHERE created_at<? AND run_id IN (SELECT id FROM runs WHERE state IN ('completed','failed','interrupted','cancelled'))").run(cutoff);db.prepare('DELETE FROM human_audit WHERE created_at<?').run(auditCutoff);}
export class WorkspaceBackups{
  constructor(private db:DatabaseSync,private root:string,private workspaceId:string,private deps:{key():string;begin():Promise<void>;end():void;storage?:S3Backups}){db.exec('CREATE TABLE IF NOT EXISTS workspace_backups(id TEXT PRIMARY KEY,request_id TEXT UNIQUE NOT NULL,state TEXT NOT NULL,detail TEXT NOT NULL,filename TEXT NOT NULL,checksum TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL)');db.prepare("UPDATE workspace_backups SET state='interrupted',detail='Backup was interrupted. Existing data was preserved.' WHERE state IN ('queued','running')").run();}
  list(){return this.db.prepare('SELECT id,state,detail,filename,checksum,created_at AS createdAt,updated_at AS updatedAt FROM workspace_backups ORDER BY created_at DESC LIMIT 100').all();}
  start(requestId:string){if(!this.deps.key())throw new ProductError('Set a backup recovery key before creating a backup.',409);if(typeof requestId!=='string'||!requestId||requestId.length>100)throw new ProductError('A backup request identity is required.');const prior=this.db.prepare('SELECT id FROM workspace_backups WHERE request_id=?').get(requestId) as {id:string}|undefined;if(prior)return prior;const active=this.db.prepare("SELECT 1 FROM workspace_backups WHERE state IN ('queued','running')").get();if(active)throw new ProductError('A workspace backup is already being prepared.',409);const id=randomUUID(),stamp=new Date().toISOString(),filename=stamp.replaceAll(':','-')+'_'+id+'.ohb';this.db.prepare("INSERT INTO workspace_backups VALUES(?,?,'queued','Waiting for a workspace snapshot.',?,NULL,?,?)").run(id,requestId,filename,stamp,stamp);queueMicrotask(()=>void this.perform(id,filename));return {id};}
  path(id:string){const row=this.db.prepare("SELECT filename FROM workspace_backups WHERE id=? AND state='completed'").get(id) as {filename:string}|undefined;if(!row)throw new ProductError('This backup is not ready to download.',409);return safeWorkspacePath(this.root,`backups/${row.filename}`);}
  async link(id:string){const path=this.path(id);if(!this.deps.storage)throw new ProductError('Remote backup downloads need the workspace’s S3-compatible backup storage. A local owner can use the backup command.',409);return this.deps.storage.download(path.split(/[\\/]/).at(-1)!);}
  private async perform(id:string,filename:string){let admitted=false;try{await this.deps.begin();admitted=true;this.db.prepare("UPDATE workspace_backups SET state='running',detail='Encrypting a consistent workspace snapshot.',updated_at=? WHERE id=?").run(new Date().toISOString(),id);const result=await createBackup({root:this.root,target:join(this.root,'backups',filename),key:this.deps.key(),workspaceId:this.workspaceId});if(this.deps.storage)await this.deps.storage.put(filename,result.path);this.db.prepare("UPDATE workspace_backups SET state='completed',checksum=?,detail='Encrypted backup verified. Credentials were omitted; restored routines remain paused.',updated_at=? WHERE id=?").run(result.checksum,new Date().toISOString(),id);}catch(error){this.db.prepare("UPDATE workspace_backups SET state='failed',detail=?,updated_at=? WHERE id=?").run(error instanceof Error?error.message:'The workspace backup could not complete.',new Date().toISOString(),id);}finally{if(admitted)this.deps.end();}}
  async retain(days:number){if(this.deps.storage)await this.deps.storage.retain(days);const cutoff=new Date(Date.now()-days*86400000).toISOString(),expired=this.db.prepare("SELECT id,filename FROM workspace_backups WHERE created_at<? AND state IN ('completed','failed','interrupted')").all(cutoff) as {id:string;filename:string}[];for(const row of expired){await rm(safeWorkspacePath(this.root,`backups/${row.filename}`),{force:true});this.db.prepare('DELETE FROM workspace_backups WHERE id=?').run(row.id);}}
}
