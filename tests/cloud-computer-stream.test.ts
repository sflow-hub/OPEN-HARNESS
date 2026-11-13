import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGlite } from '@electric-sql/pglite';
import { exportJWK, generateKeyPair, jwtVerify } from 'jose';
import { WebSocket, WebSocketServer } from 'ws';
import type { Database, Sql } from '../control-plane/database';
import { cloudServer } from '../control-plane/server';
import { CloudWorkspaces } from '../control-plane/workspaces';
import { tokenHash } from '../control-plane/identity';
import { relayStreamKind, relayStreamFrame } from '../control-plane/relay';
import { startWorkspaceRelay } from '../runtime/workspace-relay';

const origin='http://localhost:4400';
async function listen(server:Server){server.listen(0,'127.0.0.1');await once(server,'listening');return (server.address() as {port:number}).port;}
async function connect(url:string,requestOrigin=origin){const ws=new WebSocket(url,{headers:{Origin:requestOrigin}});ws.on('error',()=>{});await new Promise<void>(resolve=>{ws.once('open',()=>resolve());ws.once('close',()=>resolve());});return ws;}
async function rejected(url:string,requestOrigin=origin){const ws=await connect(url,requestOrigin);if(ws.readyState!==WebSocket.CLOSED)await once(ws,'close');assert.equal(ws.readyState,WebSocket.CLOSED);}
async function fixture(t:test.TestContext){
  const root=mkdtempSync(join(tmpdir(),'cloud-computer-stream-')),pg=new PGlite();await pg.exec(await readFile(new URL('../control-plane/schema.sql',import.meta.url),'utf8'));
  const adapt=(source:Pick<PGlite,'query'>):Sql=>({query:async(sql,values)=>{const value=await source.query(sql,values);return {rows:value.rows as never[],rowCount:value.affectedRows};}});
  const db:Database={...adapt(pg),transaction:work=>pg.transaction(tx=>work(adapt(tx as unknown as PGlite)))};
  await db.query("INSERT INTO accounts(id,subject,email) VALUES('alice','issuer|alice','alice@example.com'),('bob','issuer|bob','bob@example.com')");
  const workspaces=new CloudWorkspaces(db),workspace=await workspaces.create('alice','Streaming fixture','self-hosted');await workspaces.changeMember(workspace.id,'alice','bob','operator',false);
  const relayToken=randomBytes(32).toString('base64url'),alice=randomBytes(32).toString('base64url'),bob=randomBytes(32).toString('base64url');
  for(const [actor,token] of [['alice',alice],['bob',bob]])await db.query("INSERT INTO sessions(token_hash,account_id,csrf_hash,kind,expires_at) VALUES($1,$2,'unused','native',$3)",[tokenHash(token),actor,new Date(Date.now()+60000)]);
  await db.query("UPDATE cloud_workspaces SET state='running',relay_hash=$1 WHERE id=$2",[tokenHash(relayToken),workspace.id]);
  const pair=await generateKeyPair('EdDSA',{extractable:true}),cloud=await cloudServer(db,{issuer:'http://localhost:8180',clientId:'fixture',clientSecret:'unused',publicOrigin:origin,nativeRedirects:['openharness://auth'],allowInsecureDevelopment:true},await exportJWK(pair.privateKey));
  const upstream=new WebSocketServer({noServer:true}),inputs:Array<{path:string;binary:boolean;text:string}>=[],contexts:string[]=[],upgrades:string[]=[],closures:Array<Promise<unknown[]>>=[];let mismatched=false;
  const control=createServer((req,res)=>{if(typeof req.headers['x-open-harness-context']==='string')contexts.push(req.headers['x-open-harness-context']);const terminal=req.url?.endsWith('/terminal'),desktop=req.url?.endsWith('/desktop/stream');res.setHeader('Content-Type','application/json');res.statusCode=terminal||desktop?201:200;res.end(JSON.stringify(terminal||desktop?{path:`/v1/${mismatched?(terminal?'desktop':'terminal'):terminal?'terminal':'desktop'}-stream?ticket=${randomBytes(32).toString('base64url')}`,expiresIn:30}:{ok:true}));});
  control.on('upgrade',(req,socket,head)=>{assert.equal(req.headers.authorization,undefined);assert.equal(req.headers.cookie,undefined);assert.ok(relayStreamKind(req.url));upgrades.push(req.url!);upstream.handleUpgrade(req,socket,head,ws=>{ws.on('error',()=>{});closures.push(once(ws,'close'));ws.on('message',(data,binary)=>{inputs.push({path:req.url!,binary,text:String(data)});ws.send(data,{binary});});});});
  const controlPort=await listen(control),cloudPort=await listen(cloud.server),stop=startWorkspaceRelay({url:`ws://127.0.0.1:${cloudPort}/relay/workspace`,relayToken,root,controlPort,allowInsecureDevelopment:true});
  t.after(async()=>{stop();cloud.server.emit('graceful-stop');for(const ws of upstream.clients)ws.terminate();upstream.close();control.closeAllConnections();control.close();cloud.server.closeAllConnections();await new Promise<void>(resolve=>cloud.server.close(()=>resolve()));await pg.close();rmSync(root,{recursive:true,force:true});});
  for(let attempt=0;;attempt++){try{await cloud.relay.request(workspace.id,'alice','owner','GET','/v1/client-status');break;}catch(error){if(attempt===100)throw error;await new Promise(resolve=>setTimeout(resolve,10));}}
  const request=async(kind:'desktop'|'terminal',token=alice)=>fetch(`http://127.0.0.1:${cloudPort}/cloud/v1/workspaces/${workspace.id}/runtime/v1/agents/atlas/${kind==='desktop'?'desktop/stream':'terminal'}`,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({leaseId:'coordinator-validates-this'})});
  const ticket=async(kind:'desktop'|'terminal',token=alice)=>{const response=await request(kind,token);assert.equal(response.status,201);const value=await response.json() as {path:string};assert.match(value.path,new RegExp(`^/cloud/${kind}-stream\\?ticket=[A-Za-z0-9_-]{43}$`));return `ws://127.0.0.1:${cloudPort}${value.path}`;};
  return {db,workspace,alice,bob,contexts,publicKey:pair.publicKey,request,ticket,inputs,upgrades,closures,disconnect:()=>cloud.relay.disconnect(workspace.id),mismatch:()=>{mismatched=true;}};
}

test('managed computer streams preserve terminal text and desktop bytes and check current membership before input',{timeout:30000},async t=>{
  const f=await fixture(t),terminal=await connect(await f.ticket('terminal',f.bob)),desktop=await connect(await f.ticket('desktop'));
  t.after(()=>{terminal.terminate();desktop.terminate();});
  const terminalReply=once(terminal,'message');terminal.send(JSON.stringify({type:'input',data:'printf synthetic\\r'}));const [text,textBinary]=await terminalReply;assert.equal(textBinary,false);assert.deepEqual(JSON.parse(String(text)),{type:'input',data:'printf synthetic\\r'});
  const desktopReply=once(desktop,'message');desktop.send(Buffer.from([0,1,255,7]));const [bytes,bytesBinary]=await desktopReply;assert.equal(bytesBinary,true);assert.deepEqual(bytes,Buffer.from([0,1,255,7]));assert.deepEqual(f.inputs.map(value=>value.binary),[false,true]);
  const count=f.upgrades.length;await rejected(await f.ticket('terminal'));assert.equal(f.upgrades.length,count,'The third stream must not reach the coordinator');
  const received=f.inputs.length;await f.db.query("UPDATE memberships SET revoked=true WHERE workspace_id=$1 AND account_id='bob'",[f.workspace.id]);const closed=once(terminal,'close');terminal.send(JSON.stringify({type:'input',data:'must not run'}));await closed;await f.closures[0];assert.equal(f.inputs.length,received,'Revoked membership must be checked before forwarding new input');
  const stillDesktop=once(desktop,'message');desktop.send(Buffer.from('still-authorized'));assert.equal(String((await stillDesktop)[0]),'still-authorized');
  const disconnected=once(desktop,'close');f.disconnect();await disconnected;await f.closures[1];
});

test('managed stream tickets bind their kind, origin, membership and one-use identity',{timeout:30000},async t=>{
  const f=await fixture(t);
  const crossed=await f.ticket('terminal');await rejected(crossed.replace('/cloud/terminal-stream','/cloud/desktop-stream'));await rejected(crossed);assert.equal(f.upgrades.length,0);
  const wrongOrigin=await f.ticket('terminal');await rejected(wrongOrigin,'http://unrelated.example');await rejected(wrongOrigin);assert.equal(f.upgrades.length,0);
  const used=await f.ticket('terminal'),live=await connect(used);t.after(()=>live.terminate());const echoed=once(live,'message');live.send('{"type":"resize","cols":80,"rows":24}');await echoed;await rejected(used);assert.equal(f.upgrades.length,1);
  const revoked=await f.ticket('terminal',f.bob);await f.db.query("UPDATE memberships SET revoked=true WHERE workspace_id=$1 AND account_id='bob'",[f.workspace.id]);await rejected(revoked);assert.equal(f.upgrades.length,1);
  await f.db.query("UPDATE memberships SET revoked=false,role='viewer' WHERE workspace_id=$1 AND account_id='bob'",[f.workspace.id]);assert.equal((await f.request('terminal',f.bob)).status,403);
  f.mismatch();assert.equal((await f.request('terminal')).status,500,'A coordinator desktop ticket cannot become a terminal ticket');
});

test('stream path and frame decoding keep the terminal protocol explicit and retain legacy desktop frames',()=>{
  for(const path of ['/v1/runner/duplex?ticket='+'a'.repeat(43),'/v1/terminal-stream?ticket=short','/v1/terminal-stream?ticket='+'a'.repeat(43)+'&extra=1'])assert.equal(relayStreamKind(path),null);
  assert.equal(relayStreamKind('/v1/terminal-stream?ticket='+'a'.repeat(43)),'terminal');
  assert.equal(relayStreamFrame({data:'eA=='},'desktop',100).binary,true);assert.throws(()=>relayStreamFrame({data:'eA=='},'terminal',100));assert.throws(()=>relayStreamFrame({data:'eA==',binary:'false'},'terminal',100));assert.throws(()=>relayStreamFrame({data:'garbage!',binary:false},'terminal',100));assert.throws(()=>relayStreamFrame({data:'eA==',binary:false},'terminal',3));
});


test('empty terminal frames cannot accumulate while cloud membership verification is waiting',{timeout:30000},async t=>{
  const f=await fixture(t),terminal=await connect(await f.ticket('terminal'));
  const initial=once(terminal,'message');terminal.send('ready');await initial;
  let release!:()=>void,entered!:()=>void;const gate=new Promise<void>(resolve=>{release=resolve;}),waiting=new Promise<void>(resolve=>{entered=resolve;}),query=f.db.query;
  f.db.query=async(sql,values)=>{if(sql.startsWith('SELECT m.role,w.state,w.generation')){entered();await gate;}return query(sql,values);};
  try{
    const received=f.inputs.length,closed=once(terminal,'close');terminal.send('');await waiting;for(let i=0;i<64;i++)terminal.send('');
    const [code]=await closed;assert.equal(code,1013);assert.equal(f.inputs.length,received,'No waiting frame may reach the coordinator');await f.closures[0];
  }finally{release();f.db.query=query;terminal.terminate();}
});

test('workspace startup limits empty frames before the local WebSocket handshake completes',{timeout:10000},async t=>{
  const root=mkdtempSync(join(tmpdir(),'workspace-stream-start-')),cloud=createServer(),wss=new WebSocketServer({server:cloud}),control=createServer(),sockets=new Set<import('node:stream').Duplex>();
  let admitted!:()=>void;const handshake=new Promise<void>(resolve=>{admitted=resolve;});
  control.on('upgrade',(_req,socket)=>{sockets.add(socket);socket.on('end',()=>socket.destroy());socket.on('close',()=>sockets.delete(socket));admitted();});
  const cloudPort=await listen(cloud),controlPort=await listen(control),connected=once(wss,'connection'),stop=startWorkspaceRelay({url:`ws://127.0.0.1:${cloudPort}`,relayToken:'synthetic-token',root,controlPort,allowInsecureDevelopment:true});
  const [peer]=await connected as [WebSocket];peer.on('error',()=>{});
  t.after(()=>{stop();peer.terminate();for(const socket of sockets)socket.destroy();wss.close();cloud.close();control.close();rmSync(root,{recursive:true,force:true});});
  peer.send(JSON.stringify({kind:'stream.open',id:'pending-terminal',path:'/v1/terminal-stream?ticket='+'a'.repeat(43)}));await handshake;
  const closed=once(peer,'message',{signal:AbortSignal.timeout(5000)});for(let i=0;i<65;i++)peer.send(JSON.stringify({kind:'stream.data',id:'pending-terminal',data:'',binary:false}));
  assert.deepEqual(JSON.parse(String((await closed)[0])),{kind:'stream.close',id:'pending-terminal'});
});


test('cloud relay signs only the saved display name and omits it for older accounts',{timeout:30000},async t=>{
  const f=await fixture(t);await f.db.query("UPDATE accounts SET display_name='Alice <&>' WHERE id='alice'");assert.equal((await f.request('terminal')).status,201);
  const {payload}=await jwtVerify(f.contexts.at(-1)!,f.publicKey,{issuer:origin,audience:`open-harness:${f.workspace.id}`});assert.equal(payload.sub,'alice');assert.equal(payload.role,'owner');assert.equal(payload.displayName,'Alice <&>');assert.equal(payload.email,undefined);
  assert.equal((await f.request('terminal',f.bob)).status,201);const bob=(await jwtVerify(f.contexts.at(-1)!,f.publicKey,{issuer:origin,audience:`open-harness:${f.workspace.id}`})).payload;assert.equal(bob.sub,'bob');assert.equal(bob.displayName,undefined);assert.doesNotMatch(JSON.stringify(bob),/bob@example/);
});
