import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {generateKeyPairSync,randomUUID,webcrypto} from 'node:crypto';
import {once} from 'node:events';
import {chmodSync,existsSync,mkdirSync,mkdtempSync,readFileSync,readdirSync,rmSync,statSync,writeFileSync} from 'node:fs';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import test from 'node:test';

test('a stopped Node runner is adopted with its original key, queued receipts, private files and credentials',{timeout:30_000},async(t)=>{
  const root=mkdtempSync(join(tmpdir(),'oh-adopt-'));chmodSync(root,0o755);
  const {privateKey,publicKey}=generateKeyPairSync('rsa',{modulusLength:2048});
  const publicJwk=publicKey.export({format:'jwk'}),privateJwk=privateKey.export({format:'jwk'});
  const name='machine-adopt',token=randomUUID(),run=randomUUID(),command=randomUUID(),event=randomUUID(),store=randomUUID();
  const sent=[],queued=[];
  let pub;
  const server=createServer(async(req,res)=>{
    const chunks=[];for await(const c of req)chunks.push(c);
    const body=chunks.length?JSON.parse(Buffer.concat(chunks).toString()):{};
    assert.notEqual(req.url,'/v1/runner/pair');
    assert.equal(req.headers.authorization,'Bearer '+token);
    assert.equal(req.headers['x-open-harness-machine'],name);
    const send=v=>res.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify(v));
    if(req.url==='/v1/runner/heartbeat'){pub=JSON.parse(body.encryptionPublicKey);return send({ok:true});}
    if(req.url==='/v1/runner/commands')return send({commands:queued.splice(0)});
    sent.push([req.url,body]);send({ok:true});
  });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const old={coordinator:`http://127.0.0.1:${server.address().port}`,machineId:name,token,encryptionPublicKey:JSON.stringify(publicJwk),encryptionPrivateKey:JSON.stringify(privateJwk)};
  const save=(p,v)=>writeFileSync(join(root,p),JSON.stringify(v),{mode:0o600});
  save('connection.json',old);save('secrets.json',{controlToken:'legacy-local-token',OLD_KEY:'legacy-key'});
  writeFileSync(join(root,'secrets.backend'),'file',{mode:0o600});
  mkdirSync(join(root,'agents/a/private'),{recursive:true});writeFileSync(join(root,'agents/a/private/kept.txt'),'keep');
  mkdirSync(join(root,'spool'));
  const completion={id:'complete-'+command,path:`/v1/runner/commands/${command}/complete`,body:{result:{text:'saved'}}};
  const record={id:event,path:`/v1/runner/commands/${command}/events`,body:{eventId:event,runId:run,event:{type:'message.delta',payload:{text:'saved'}}}};
  save('spool/'+completion.id+'.json',completion);save('spool/'+record.id+'.json',record);
  const children=[];
  const start=()=>{
    const c=spawn(process.env.OPEN_HARNESS_RUST_RUNNER,[],{env:{...process.env,OPEN_HARNESS_RUNNER_STATE_DIR:root,OPEN_HARNESS_MOCK:'1'},stdio:['ignore','ignore','pipe']});children.push(c);return c;
  };
  const halt=async(c)=>{if(!c.signalCode&&c.exitCode===null){c.kill('SIGTERM');await once(c,'exit');}};
  t.after(async()=>{for(const c of children) await halt(c);server.closeAllConnections();await new Promise(done=>server.close(done));rmSync(root,{recursive:true,force:true});});
  const wait=async(fn)=>{for(let n=0;n<80;n++){let v=fn();if(v)return v;await delay(100);}assert.fail('Missing adopted worker delivery');};
  const first=start();
  await wait(()=>sent.length===2 && pub);
  assert.equal(pub.n,publicJwk.n);assert.equal(pub.e,publicJwk.e);
  assert.deepEqual(sent,[[record.path,record.body],[completion.path,completion.body]]);
  assert.equal(statSync(root).mode&0o777,0o700);
  assert.deepEqual(JSON.parse(readFileSync(join(root,'connection.json'))),old);
  assert.equal(readFileSync(join(root,'agents/a/private/kept.txt'),'utf8'),'keep');
  assert.equal(readdirSync(join(root,'spool/rust-adopted')).length,2);
  // A real RSA-OAEP encrypted command for the former Node identity must decrypt after adoption.
  const rsa=await webcrypto.subtle.importKey('jwk',publicJwk,{name:'RSA-OAEP',hash:'SHA-256'},false,['encrypt']);
  const aes=await webcrypto.subtle.generateKey({name:'AES-GCM',length:256},true,['encrypt']);
  const iv=webcrypto.getRandomValues(new Uint8Array(12)), b64=v=>Buffer.from(v).toString('base64');
  const encrypted={version:1,iv:b64(iv),key:b64(await webcrypto.subtle.encrypt({name:'RSA-OAEP'},rsa,await webcrypto.subtle.exportKey('raw',aes))),
    data:b64(await webcrypto.subtle.encrypt({name:'AES-GCM',iv},aes,new TextEncoder().encode('rotated-fixture-key')))};
  queued.push({id:store,kind:'store-secret',agentId:null,payload:{name:'NEW_KEY',encrypted}});
  await wait(()=>sent.find(([p])=>p.endsWith(store+'/complete')));
  assert.deepEqual(JSON.parse(readFileSync(join(root,'rust-runner-secrets.json'))),{NEW_KEY:'rotated-fixture-key'});
  assert.ok(existsSync(join(root,'secrets.json')));
  await halt(first);pub=null;start();await wait(()=>pub);await delay(1100);
  assert.equal(sent.length,3);
});
