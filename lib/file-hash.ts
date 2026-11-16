// Incremental SHA-256 keeps file hashing bounded to one upload chunk in browsers.
const K = new Uint32Array([0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2]);
const rotate=(n:number,b:number)=>(n>>>b)|(n<<(32-b));
export class FileHash {
  private state=new Uint32Array([0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19]);
  private block=new Uint8Array(64);
  private used=0;
  private size=0;
  private words=new Uint32Array(64);
  private finished=false;
  update(bytes:Uint8Array){if(this.finished)throw new Error('Hash is already finished.');this.size+=bytes.length;let p=0;while(p<bytes.length){const count=Math.min(64-this.used,bytes.length-p);this.block.set(bytes.subarray(p,p+count),this.used);this.used+=count;p+=count;if(this.used===64){this.compress();this.used=0;}}return this;}
  private compress(){const w=this.words,b=this.block;for(let i=0;i<16;i++)w[i]=(b[i*4]<<24)|(b[i*4+1]<<16)|(b[i*4+2]<<8)|b[i*4+3];for(let i=16;i<64;i++){const x=w[i-15],y=w[i-2];w[i]=w[i-16]+(rotate(x,7)^rotate(x,18)^(x>>>3))+w[i-7]+(rotate(y,17)^rotate(y,19)^(y>>>10));}let [a,c,d,e,f,g,h,j]=this.state;for(let i=0;i<64;i++){const t=(j+(rotate(f,6)^rotate(f,11)^rotate(f,25))+((f&g)^(~f&h))+K[i]+w[i])>>>0,u=((rotate(a,2)^rotate(a,13)^rotate(a,22))+((a&c)^(a&d)^(c&d)))>>>0;j=h;h=g;g=f;f=(e+t)>>>0;e=d;d=c;c=a;a=(t+u)>>>0;}const v=[a,c,d,e,f,g,h,j];for(let i=0;i<8;i++)this.state[i]+=v[i];}
  digest(){if(this.finished)throw new Error('Hash is already finished.');const bytes=this.size;this.update(new Uint8Array([128]));while(this.used!==56)this.update(new Uint8Array([0]));const tail=new Uint8Array(8),view=new DataView(tail.buffer);view.setUint32(0,Math.floor(bytes/0x20000000));view.setUint32(4,(bytes*8)>>>0);this.update(tail);this.finished=true;return Array.from(this.state,n=>n.toString(16).padStart(8,'0')).join('');}
}
export const hashBytes=(bytes:Uint8Array)=>new FileHash().update(bytes).digest();
export async function hashFile(file:Blob,onProgress?:(bytes:number)=>void,signal?:AbortSignal){const hash=new FileHash();for(let offset=0;offset<file.size;offset+=1048576){signal?.throwIfAborted();hash.update(new Uint8Array(await file.slice(offset,offset+1048576).arrayBuffer()));onProgress?.(Math.min(file.size,offset+1048576));}return hash.digest();}
