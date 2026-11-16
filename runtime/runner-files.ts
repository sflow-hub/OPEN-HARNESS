import { installationBytes } from './harness-registry';
import { mkdirSync, existsSync, readFileSync, statfsSync, rmSync, readdirSync, statSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';
import { decryptRunnerSecret, encryptRunnerSecret, type EncryptedRunnerSecret } from '../lib/runner-crypto';
import { FILE_CHUNK_BYTES, fileDigest, installManagedFile, installedFilePath, managedWorkingFiles, matchesRegularFile, type UploadRecord } from './agent-files';
import { atomicWorkspaceWrite, safeWorkspacePath } from './path-safety';
import { validId } from './profiles';
import { managedRelativePath } from './harness-manifest';

export function runnerManagedFileBytes(root:string){let used=installationBytes(root);const records=join(root,'delivered-files');if(existsSync(records))for(const name of readdirSync(records)){const file=JSON.parse(readFileSync(join(records,name),'utf8')) as UploadRecord;used+=file.size;}return used;}

export async function receiveRunnerFile(root:string,credentials:{machineId:string;encryptionPrivateKey:string},uploadId:string,agentId:string,request:(path:string)=>Promise<{encrypted:EncryptedRunnerSecret}>) {
  validId(uploadId);validId(agentId);
  const opened=async(path:string)=>{const response=await request(path);const value=JSON.parse(await decryptRunnerSecret(credentials.encryptionPrivateKey,response.encrypted));if(value.purpose!=='agent-file/v1'||value.uploadId!==uploadId||value.agentId!==agentId||value.machineId!==credentials.machineId)throw new Error('File delivery belongs to another agent, transfer, or computer.');return value;};
  const base=`/v1/runner/files/${uploadId}`,metadata=await opened(base),file=metadata.file as UploadRecord;
  if(!file||file.id!==uploadId||file.agentId!==agentId||file.machineId!==credentials.machineId||metadata.chunkBytes!==FILE_CHUNK_BYTES||!Number.isSafeInteger(file.size)||file.size<0||file.size>Number(process.env.OPEN_HARNESS_MAX_FILE_BYTES||20*1024**3)||!/^[a-f0-9]{64}$/.test(file.checksum))throw new Error('Invalid file delivery metadata.');managedRelativePath(file.path);
  const directory=safeWorkspacePath(root,`file-delivery/${uploadId}`);mkdirSync(directory,{recursive:true,mode:0o700});
  const completed=join(root,'delivered-files',`${uploadId}.json`);if(existsSync(completed)){const old=JSON.parse(readFileSync(completed,'utf8')) as UploadRecord;if(old.checksum!==file.checksum)throw new Error('File identity changed.');if(!await matchesRegularFile(installedFilePath(root,file),file.size,file.checksum))throw new Error('This delivered file has changed. Upload it with an explicit replacement choice.');return {checksum:file.checksum};}
  const progress=join(directory,'progress.json'),target=join(directory,'bytes');const received:Record<string,string>=existsSync(progress)?JSON.parse(readFileSync(progress,'utf8')):{};
  const free=statfsSync(directory);if(free.bavail*free.bsize<file.size*2-(existsSync(target)?Math.min(file.size,statSync(target).size):0)+FILE_CHUNK_BYTES)throw new Error('The assigned computer has insufficient free space.');
  const quota=Number(process.env.OPEN_HARNESS_MACHINE_FILE_QUOTA||100*1024**3);
  const used=runnerManagedFileBytes(root);if(used+file.size>quota)throw new Error('The assigned computer’s managed-file quota is full.');
  const handle=await open(target,existsSync(target)?'r+':'w+',0o600);
  try{for(let index=0;index<Math.ceil(file.size/FILE_CHUNK_BYTES);index++){
    const length=Math.min(FILE_CHUNK_BYTES,file.size-index*FILE_CHUNK_BYTES);
    if(received[index]){const bytes=Buffer.alloc(length);const read=await handle.read(bytes,0,length,index*FILE_CHUNK_BYTES);if(read.bytesRead===length&&createHash('sha256').update(bytes).digest('hex')===received[index])continue;}
    const chunk=await opened(`${base}/chunks/${index}`);if(chunk.index!==index||typeof chunk.data!=='string'||chunk.data.length>Math.ceil(FILE_CHUNK_BYTES/3)*4)throw new Error('Invalid delivered chunk.');const bytes=Buffer.from(chunk.data,'base64');if(bytes.length!==length||createHash('sha256').update(bytes).digest('hex')!==chunk.checksum)throw new Error('Delivered chunk failed checksum verification.');await handle.write(bytes,0,length,index*FILE_CHUNK_BYTES);await handle.sync();received[index]=chunk.checksum;atomicWorkspaceWrite(progress,JSON.stringify(received));
  }}finally{await handle.close();}
  await opened(base+'?phase=verifying');
  if(await fileDigest(target)!==file.checksum)throw new Error('Delivered file failed final checksum verification.');
  // Recheck assignment and revocation immediately before publishing.
  await opened(base);await installManagedFile(root,file,target);mkdirSync(dirname(completed),{recursive:true,mode:0o700});atomicWorkspaceWrite(completed,JSON.stringify(file));if(file.replaceId)rmSync(safeWorkspacePath(root,`delivered-files/${validId(file.replaceId)}.json`),{force:true});rmSync(directory,{recursive:true,force:true});return {checksum:file.checksum};
}

export async function exportRunnerFiles(root:string,agentId:string,machineId:string,transferId:string,publicKey:string,request:(path:string,init:{method:string;body:string})=>Promise<{id?:string;state?:string}>){
  validId(agentId);validId(transferId);
  const send=async(action:string,value:Record<string,unknown>)=>request(`/v1/runner/file-exports/${transferId}/${action}`,{method:'POST',body:JSON.stringify({encrypted:await encryptRunnerSecret(publicKey,JSON.stringify({purpose:'agent-file-export/v1',transferId,agentId,machineId,...value}))})});
  let files=0;
  for(const file of managedWorkingFiles(root,agentId)){
    const source=safeWorkspacePath(root,`agents/${agentId}/files/work/${file.path}`),checksum=await fileDigest(source),metadata=await send('manifest',{...file,checksum});if(!metadata.id)throw new Error('Coordinator did not accept the file export.');const uploadId=validId(metadata.id),handle=await open(source,'r');
    try{for(let index=0;index<Math.ceil(file.size/FILE_CHUNK_BYTES);index++){const bytes=Buffer.alloc(Math.min(FILE_CHUNK_BYTES,file.size-index*FILE_CHUNK_BYTES));if((await handle.read(bytes,0,bytes.length,index*FILE_CHUNK_BYTES)).bytesRead!==bytes.length)throw new Error('The working file changed during export.');await send(`chunks/${uploadId}/${index}`,{uploadId,index,data:bytes.toString('base64'),checksum:createHash('sha256').update(bytes).digest('hex')});}}finally{await handle.close();}
    for(;;){const result=await send(`finalize/${uploadId}`,{uploadId});if(result.state==='uploaded')break;await new Promise(resolve=>setTimeout(resolve,500));}files++;
  }
  return {files};
}

