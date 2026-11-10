import { WebSocket } from 'ws';
import { SecretStore } from './secrets';
import { resolve, join } from 'node:path';
import { relayPathAllowed, relayStreamKind, relayStreamFrame, relayStreamBytes, type RelayStreamKind } from '../control-plane/relay';

export function startWorkspaceRelay(input: { url: string; relayToken: string; root: string; controlPort: number; allowInsecureDevelopment?: boolean }) {
  const address = new URL(input.url); if (address.protocol !== 'wss:' && !(input.allowInsecureDevelopment && address.protocol === 'ws:' && ['localhost','127.0.0.1'].includes(address.hostname))) throw new Error('The workspace relay requires an authenticated WSS connection.');
  if (!Number.isInteger(input.controlPort) || input.controlPort < 1 || input.controlPort > 65535) throw new Error('Invalid workspace coordinator port.');
  const operatorToken = new SecretStore(join(resolve(input.root), 'secrets.json')).token;
  let closed = false, socket: WebSocket, timer: ReturnType<typeof setTimeout>, retry = 1000;
  const streams=new Map<string,{socket:WebSocket;kind:RelayStreamKind;pending:Array<{data:Buffer;binary:boolean}>;pendingBytes:number}>();
  const connect = () => {
    if (closed) return; socket = new WebSocket(address, { headers: { Authorization: `Bearer ${input.relayToken}` }, maxPayload: 7_000_000 });
    socket.on('open', () => { retry = 1000; });
    socket.on('error', () => {});
    socket.on('message', data => { void (async () => {
      const message = JSON.parse(data.toString());
      if(message.kind?.startsWith('stream.')){
        if(message.kind==='stream.open'){
          const kind=relayStreamKind(message.path);
          if(!kind||typeof message.id!=='string'||message.id.length>100||streams.has(message.id)||streams.size>=2){if(socket.readyState===WebSocket.OPEN)socket.send(JSON.stringify({kind:'stream.close',id:message.id}));return;}
          const relaySocket=socket,stream=new WebSocket(`ws://127.0.0.1:${input.controlPort}${message.path}`,{maxPayload:7000000,handshakeTimeout:10000}),entry={socket:stream,kind,pending:[] as Array<{data:Buffer;binary:boolean}>,pendingBytes:0};streams.set(message.id,entry);
          stream.on('error',()=>{});
          stream.on('open',()=>{for(const frame of entry.pending){if(stream.readyState!==WebSocket.OPEN)break;stream.send(frame.data,{binary:frame.binary});}entry.pending=[];entry.pendingBytes=0;});
          stream.on('message',(value,binary)=>{const data=relayStreamBytes(value).toString('base64');if(relaySocket.readyState!==WebSocket.OPEN||relaySocket.bufferedAmount>8000000||data.length>7000000)return stream.close();relaySocket.send(JSON.stringify({kind:'stream.data',id:message.id,data,binary}));});
          stream.on('close',()=>{entry.pending=[];entry.pendingBytes=0;if(streams.get(message.id)===entry)streams.delete(message.id);if(relaySocket.readyState===WebSocket.OPEN)relaySocket.send(JSON.stringify({kind:'stream.close',id:message.id}));});
        }else if(message.kind==='stream.close')streams.get(message.id)?.socket.close();
        else if(message.kind==='stream.data'){
          const entry=streams.get(message.id);if(!entry)return;
          try{const frame=relayStreamFrame(message,entry.kind,100000);if(entry.socket.bufferedAmount>8000000)entry.socket.close();else if(entry.socket.readyState===WebSocket.OPEN)entry.socket.send(frame.data,{binary:frame.binary});else if(entry.socket.readyState===WebSocket.CONNECTING){entry.pendingBytes+=frame.data.length;if(entry.pending.length>=64||entry.pendingBytes>65536)entry.socket.close();else entry.pending.push(frame);}}catch{entry.socket.close();}
        }
        return;
      }
      if (!relayPathAllowed(message.path) || !['GET','POST','PUT','PATCH','DELETE'].includes(message.method) || typeof message.context !== 'string' || typeof message.body !== 'string' || message.body.length > 5_000_000) throw new Error('Invalid relay request');
      const response = await fetch(`http://127.0.0.1:${input.controlPort}${message.path}`, { method: message.method, headers: { Authorization: `Bearer ${operatorToken}`, 'Content-Type': 'application/json', 'X-Open-Harness-Context': message.context, ...(message.cookies ? { Cookie: String(message.cookies) } : {}) }, ...(message.method === 'GET' ? {} : { body: message.body }), redirect: 'manual', signal: AbortSignal.timeout(32000) });
      const body = Buffer.from(await response.arrayBuffer()); if (body.length > 5_000_000) throw new Error('Relay response too large');
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ id: message.id, status: response.status, headers: { 'content-type': response.headers.get('content-type') || 'application/json', 'set-cookie': response.headers.getSetCookie() }, body: body.toString('base64') }));
    })().catch(() => { /* Failed or uncertain writes are reconciled through their durable action identity. */ }); });
    socket.on('close', () => {for(const stream of streams.values())stream.socket.close();streams.clear(); if (!closed) { timer = setTimeout(connect, retry); retry = Math.min(30000, retry * 2); } });
  };
  connect(); return () => { closed = true; clearTimeout(timer); socket?.close(); };
}
if (process.argv[1] && import.meta.url === new URL(`file://${resolve(process.argv[1])}`).href) {
  const stop = startWorkspaceRelay({ url: process.env.OPEN_HARNESS_RELAY_URL || '', relayToken: process.env.OPEN_HARNESS_RELAY_TOKEN || '', root: process.env.OPEN_HARNESS_STATE_DIR || '.open-harness', controlPort: Number(process.env.OPEN_HARNESS_PORT || 4317), allowInsecureDevelopment: process.env.OPEN_HARNESS_DEVELOPMENT === '1' });
  process.once('SIGTERM', () => { stop(); process.exit(); }); process.once('SIGINT', () => { stop(); process.exit(); });
}
