import { open } from 'node:fs/promises';
import { createReadStream, createWriteStream, mkdirSync, statfsSync } from 'node:fs';
import { dirname } from 'node:path';
import { createInflateRaw } from 'node:zlib';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { managedRelativePath } from './harness-manifest';
import { safeWorkspacePath } from './path-safety';

// Read the central directory first, including ZIP64 sizes. No archive entry is executed.
export async function extractHarnessZip(source: string, destination: string, quota: number) {
  const file = await open(source,'r');
  const read = async (offset:number,size:number) => { const data=Buffer.alloc(size); if((await file.read(data,0,size,offset)).bytesRead!==size)throw new Error('Truncated harness ZIP.'); return data; };
  const integer = (b:Buffer,at:number) => { const n=Number(b.readBigUInt64LE(at)); if(!Number.isSafeInteger(n))throw new Error('ZIP size is too large.');return n; };
  try {
    const size=(await file.stat()).size, tail=await read(Math.max(0,size-65557),Math.min(size,65557)); let end=-1;
    for(let i=tail.length-22;i>=0;i--)if(tail.readUInt32LE(i)===0x06054b50&&i+22+tail.readUInt16LE(i+20)===tail.length){end=i;break;}
    if(end<0||tail.readUInt16LE(end+4)||tail.readUInt16LE(end+6))throw new Error('Use a single-volume ZIP package.');
    let count=tail.readUInt16LE(end+10),length=tail.readUInt32LE(end+12),offset=tail.readUInt32LE(end+16);
    if(count===65535||length===0xffffffff||offset===0xffffffff){const absolute=size-tail.length+end,loc=await read(absolute-20,20);if(loc.readUInt32LE(0)!==0x07064b50)throw new Error('Invalid ZIP64 locator.');const z=await read(integer(loc,8),56);if(z.readUInt32LE(0)!==0x06064b50||z.readUInt32LE(16)||z.readUInt32LE(20))throw new Error('Invalid ZIP64 directory.');count=integer(z,32);length=integer(z,40);offset=integer(z,48);}
    if(count>10000||length>16*1024*1024||offset+length>size)throw new Error('Harness package has too many entries.');
    const central=await read(offset,length),entries:{name:string;size:number;compressed:number;offset:number;method:number;directory:boolean}[]=[],names=new Set<string>();let p=0,total=0;
    for(let i=0;i<count;i++){
      if(p+46>central.length||central.readUInt32LE(p)!==0x02014b50)throw new Error('Invalid ZIP directory.');
      const flags=central.readUInt16LE(p+8),method=central.readUInt16LE(p+10),nl=central.readUInt16LE(p+28),el=central.readUInt16LE(p+30),cl=central.readUInt16LE(p+32),mode=central.readUInt32LE(p+38)>>>16;
      if(p+46+nl+el+cl>central.length||(flags&1)||![0,8].includes(method)||(mode&0xf000)&&![0x8000,0x4000].includes(mode&0xf000))throw new Error('Package contains an encrypted, linked, or unsupported ZIP entry.');
      const raw=central.subarray(p+46,p+46+nl),name=raw.toString('utf8'),directory=name.endsWith('/');if(!raw.equals(Buffer.from(name)))throw new Error('Package filenames must be UTF-8.');managedRelativePath(directory?name.slice(0,-1):name);
      const key=name.replace(/\/$/,'').toLowerCase();if(names.has(key))throw new Error('Package contains duplicate paths.');names.add(key);
      let uncompressed=central.readUInt32LE(p+24),compressed=central.readUInt32LE(p+20),local=central.readUInt32LE(p+42);const extra=central.subarray(p+46+nl,p+46+nl+el);
      for(let e=0;e+4<=extra.length;){const tag=extra.readUInt16LE(e),n=extra.readUInt16LE(e+2);if(e+4+n>extra.length)throw new Error('Invalid ZIP extra field.');if(tag===1){let q=e+4;if(uncompressed===0xffffffff){uncompressed=integer(extra,q);q+=8;}if(compressed===0xffffffff){compressed=integer(extra,q);q+=8;}if(local===0xffffffff)local=integer(extra,q);}e+=4+n;}
      total+=uncompressed;if(total>quota||local+30+compressed>size)throw new Error('Expanded harness package exceeds available storage.');
      entries.push({name,size:uncompressed,compressed,offset:local,method,directory});p+=46+nl+el+cl;
    }
    mkdirSync(destination,{recursive:true,mode:0o700});const free=statfsSync(destination);if(free.bavail*free.bsize<total+1024*1024)throw new Error('Insufficient space to extract this package.');
    for(const entry of entries){const target=safeWorkspacePath(destination,entry.name.replace(/\/$/,''));if(entry.directory){mkdirSync(target,{recursive:true,mode:0o700});continue;}const header=await read(entry.offset,30);if(header.readUInt32LE(0)!==0x04034b50)throw new Error('Invalid local ZIP entry.');const start=entry.offset+30+header.readUInt16LE(26)+header.readUInt16LE(28);if(start+entry.compressed>offset)throw new Error('Invalid ZIP entry range.');mkdirSync(dirname(target),{recursive:true,mode:0o700});let written=0;const bounded=new Transform({transform(chunk,_encoding,done){written+=chunk.length;done(written>entry.size?new Error('ZIP expansion exceeds declared size.'):null,chunk);}});if(entry.compressed){const input=createReadStream(source,{start,end:start+entry.compressed-1});if(entry.method===8)await pipeline(input,createInflateRaw(),bounded,createWriteStream(target,{flags:'wx',mode:0o600}));else await pipeline(input,bounded,createWriteStream(target,{flags:'wx',mode:0o600}));}else{const out=await open(target,'wx',0o600);await out.close();}if(written!==entry.size)throw new Error('ZIP entry size does not match.');}
    return entries.filter(e=>!e.directory).map(e=>e.name);
  } finally { await file.close(); }
}
