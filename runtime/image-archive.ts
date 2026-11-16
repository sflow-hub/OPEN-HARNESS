import { open } from 'node:fs/promises';
import { managedRelativePath } from './harness-manifest';

// Loading an archive must not retag another agent's runtime. Only untagged, ordinary
// Docker/OCI archives are admitted; layer tarballs remain opaque payloads to Docker.
export async function validateImageArchive(path:string){
  const file=await open(path,'r'),total=(await file.stat()).size,names=new Set<string>();let offset=0,manifest=false;
  const read=async(at:number,size:number)=>{const value=Buffer.alloc(size);if((await file.read(value,0,size,at)).bytesRead!==size)throw new Error('Truncated image archive.');return value;};
  const text=(b:Buffer)=>b.toString('utf8').split('\0')[0];
  try{
    while(offset+512<=total){const header=await read(offset,512);if(header.every(b=>b===0))break;
      // Docker's Go reader uses the prefix field only for POSIX ustar headers and reads it shorter
      // for star headers. Any other format would name an entry differently there than here, so a
      // second manifest.json could carry tags past this check.
      if(header.subarray(257,265).toString('latin1')!=='ustar\u000000'||header.subarray(508,512).toString('latin1')==='tar\u0000')throw new Error('Image archives must use standard POSIX tar headers. Export the image again with docker save.');
      const stored=text(header.subarray(148,156)).trim();let unsigned=0,signed=0;header.forEach((b,i)=>{const v=i>=148&&i<156?32:b;unsigned+=v;signed+=v>127?v-256:v;});
      if(!/^[0-7]+$/.test(stored)||![unsigned,signed].includes(parseInt(stored,8)))throw new Error('Image archive header checksum failed.');
      const field=header.subarray(124,136);let size=0;
      if(field[0]&128){let n=BigInt(field[0]&127);for(const byte of field.subarray(1))n=(n<<BigInt(8))+BigInt(byte);size=Number(n);}else{const value=text(field).trim();if(!/^[0-7]*$/.test(value))throw new Error('Invalid image archive size.');size=parseInt(value||'0',8);}
      if(!Number.isSafeInteger(size)||size<0||offset+512+size>total)throw new Error('Invalid image archive range.');
      const prefix=text(header.subarray(345,500)),raw=(prefix?prefix+'/':'')+text(header.subarray(0,100)),name=raw.replace(/\/$/,'');managedRelativePath(name);
      const type=header[156];if(![0,48,53].includes(type)||names.has(name))throw new Error('Image archives cannot contain links, duplicate paths, or extended tar headers.');names.add(name);
      if(['manifest.json','index.json','repositories'].includes(name)){
        if(size>2*1024*1024)throw new Error('Image archive metadata is too large.');const value=JSON.parse((await read(offset+512,size)).toString('utf8'));
        if(name==='manifest.json'){if(!Array.isArray(value)||!value.length||value.some(m=>m.RepoTags!=null&&(!Array.isArray(m.RepoTags)||m.RepoTags.length)))throw new Error('Remove repository tags from the image archive before uploading it.');manifest=true;}
        if(name==='index.json'){if(!Array.isArray(value.manifests)||!value.manifests.length)throw new Error('Invalid OCI image index.');for(const item of[value,...value.manifests])if(item.annotations&&(item.annotations['io.containerd.image.name']||item.annotations['org.opencontainers.image.ref.name']))throw new Error('OCI image archives must not name repository tags.');manifest=true;}
        if(name==='repositories'&&Object.keys(value).length)throw new Error('Image archive contains repository tags.');
      }
      offset+=512+Math.ceil(size/512)*512;
    }
    if(!manifest)throw new Error('Use an uncompressed Docker or OCI image archive without repository tags.');
  }finally{await file.close();}
}
