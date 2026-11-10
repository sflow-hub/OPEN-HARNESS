import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('Codex OAuth routes require operator authorization and the model bridge rejects requests without an owning live run',async()=>{
  const root=mkdtempSync(join(tmpdir(),'harness-codex-service-')),port=14378,base=`http://127.0.0.1:${port}`;
  const child:ChildProcess=spawn(process.execPath,['--import','tsx','runtime/service.ts'],{cwd:join(import.meta.dirname,'..'),env:{...process.env,OPEN_HARNESS_MOCK:'1',OPEN_HARNESS_PORT:String(port),OPEN_HARNESS_STATE_DIR:root,OPEN_HARNESS_DISABLE_OS_VAULT:'1'},stdio:'pipe'});
  try{
    let token='';const deadline=Date.now()+30000;
    while(Date.now()<deadline){try{const response=await fetch(base+'/v1/bootstrap');if(response.ok){token=(await response.json() as {token:string}).token;break;}}catch{}await new Promise(resolve=>setTimeout(resolve,50));}
    assert.ok(token,'Coordinator did not start');
    const headers={Authorization:`Bearer ${token}`,'Content-Type':'application/json'};
    assert.equal((await fetch(base+'/v1/codex/auth',{method:'POST',body:'{}'})).status,401);
    const response=await fetch(base+'/v1/codex/auth',{method:'POST',headers,body:'{}'});assert.equal(response.status,201);const flow=await response.json() as {id:string;authorizationUrl:string;callbackUrl:string};
    assert.equal(new URL(flow.authorizationUrl).origin,'https://auth.openai.com');assert.equal(flow.callbackUrl,base+'/auth/callback');
    assert.equal((await fetch(base+`/v1/codex/auth/${flow.id}`)).status,401);
    assert.deepEqual(await(await fetch(base+`/v1/codex/auth/${flow.id}`,{headers})).json(),{state:'waiting'});
    assert.equal((await fetch(base+'/auth/callback?state=unknown&code=bogus')).status,410);
    assert.equal((await fetch(base+'/internal/codex/responses',{method:'POST',headers,body:'{"model":"fixture"}'})).status,403);
    assert.equal((await fetch(base+'/v1/credentials',{method:'POST',headers,body:JSON.stringify({provider:'openai-codex',label:'Pasted token',value:'fixture-secret'})})).status,400);
    const models=await(await fetch(base+'/v1/models?provider=openai-codex',{headers})).json();assert.match(models.error,/Sign in with ChatGPT/);
  }finally{if(child.exitCode===null){const exited=new Promise(resolve=>child.once('exit',resolve));child.kill('SIGTERM');await exited;}}
});
