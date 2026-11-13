import {writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const [source,expected,target]=process.argv.slice(2),url=new URL(source);
if(url.protocol!=='https:'||url.hostname!=='github.com'||!/^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/releases\/download\/[^/]+\/image-lock\.json$/.test(url.pathname)||!/^[a-f0-9]{64}$/.test(expected||''))throw new Error('Supply a GitHub release image-lock.json URL and its reviewed SHA256.');
const response=await fetch(url,{signal:AbortSignal.timeout(30000)});if(!response.ok)throw new Error('The reviewed release image manifest could not be downloaded.');const data=Buffer.from(await response.arrayBuffer());if(data.length>100000||createHash('sha256').update(data).digest('hex')!==expected)throw new Error('The release image manifest did not match its reviewed checksum.');JSON.parse(data.toString());await writeFile(target,data,{flag:'wx'});
