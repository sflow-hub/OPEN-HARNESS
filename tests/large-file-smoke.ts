// Writes and verifies >4 GiB on disk. Run explicitly; excluded from ordinary *.test.ts.
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { AgentFiles, FILE_CHUNK_BYTES, installedFilePath, fileDigest } from '../runtime/agent-files';
const root=mkdtempSync(join(process.cwd(),'.open-harness-large-file-')),db=new DatabaseSync(join(root,'state.db'));
try{
  let files=new AgentFiles(db,root);const block=Buffer.alloc(FILE_CHUNK_BYTES,0x5a),tail=Buffer.from('beyond4'),chunks=4096,hash=createHash('sha256');
  for(let i=0;i<chunks;i++)hash.update(block);hash.update(tail);const checksum=hash.digest('hex'),blockHash=createHash('sha256').update(block).digest('hex');
  const upload=files.create('large-fixture','local',{path:'over-four-gib.bin',destination:'work',size:chunks*FILE_CHUNK_BYTES+tail.length,checksum});const baseline=process.memoryUsage().rss;let peak=baseline;
  for(let i=0;i<chunks;i++){if(i===2048){files=new AgentFiles(db,root);assert.equal(files.inspect(upload.id).received.length,2048);}await files.put(upload.id,i,block,blockHash);peak=Math.max(peak,process.memoryUsage().rss);if(i%1024===0)console.log(`${i/1024} GiB received; RSS ${Math.round(peak/1024**2)} MiB`);}
  await files.put(upload.id,chunks,tail,createHash('sha256').update(tail).digest('hex'));await files.finalize(upload.id);await files.publishLocal(upload.id);const path=installedFilePath(root,files.file(upload.id));assert.equal(statSync(path).size,upload.size);assert.equal(await fileDigest(path),checksum);assert.ok(peak-baseline<256*1024**2,'Upload memory must remain bounded rather than scale with file size');console.log(JSON.stringify({ok:true,bytes:upload.size,resumedAfterBytes:2048*FILE_CHUNK_BYTES,baselineRss:baseline,peakRss:peak,checksum}));
}finally{db.close();rmSync(root,{recursive:true,force:true});}
