import { randomUUID } from 'node:crypto';
import type { IncomingMessage, Server } from 'node:http';
import { SignJWT, importJWK, type JWK } from 'jose';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import type { Database } from './database';
import { tokenHash } from './identity';
import type { WorkspaceRole } from '../lib/product';
import { ProductError } from '../runtime/product-error';
import { accountDisplayName } from '../lib/display-name';

export type RelayReply = { status: number; headers: Record<string,string | string[]>; body: string };
export const relayPathAllowed = (path: string) => /^\/v1\/[A-Za-z0-9_/?=&%.:+!-]+$/.test(path) && !/\/v1\/(?:bootstrap|browser|install|runner)(?:\/|\?|$)/.test(path) && !/%(?:2f|5c|2e)|\.\.|\\|#|\r|\n/i.test(path);
export type RelayStreamKind = 'desktop' | 'terminal';
export const relayStreamKind = (path: unknown): RelayStreamKind | null => typeof path === 'string' ? /^\/v1\/(desktop|terminal)-stream\?ticket=[A-Za-z0-9_-]{43}$/.exec(path)?.[1] as RelayStreamKind || null : null;
export const relayStreamBytes = (data: RawData) => data instanceof ArrayBuffer ? Buffer.from(data) : Array.isArray(data) ? Buffer.concat(data) : data;
export function relayStreamFrame(message: { data?: unknown; binary?: unknown }, kind: RelayStreamKind, maximum: number) {
  if (typeof message.data !== 'string' || message.data.length > maximum || message.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(message.data) || typeof message.binary !== 'boolean' && !(kind === 'desktop' && message.binary === undefined)) throw new Error('Invalid workspace stream frame');
  const data=Buffer.from(message.data,'base64');if(data.toString('base64')!==message.data)throw new Error('Invalid workspace stream encoding');
  return { data, binary: message.binary === undefined ? true : message.binary };
}
export class WorkspaceRelay {
  private sockets = new Map<string, WebSocket>();
  private pending = new Map<string, { socket: WebSocket; resolve(reply: RelayReply): void; reject(error: unknown): void; timer: ReturnType<typeof setTimeout> }>();
  private wss = new WebSocketServer({ noServer: true, maxPayload: 8_000_000 });
  private streams=new Map<string,{socket:WebSocket;client:WebSocket;kind:RelayStreamKind;timer:ReturnType<typeof setInterval>}>();
  constructor(private db: Database, private issuer: string, private signingKey: JWK) {}
  attach(server: Server) { server.on('upgrade', (request, socket, head) => { if (new URL(request.url || '/', this.issuer).pathname !== '/relay/workspace') return; void this.authenticate(request).then(workspaceId => this.wss.handleUpgrade(request, socket, head, ws => this.connected(workspaceId, ws))).catch(() => { socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); }); }); }
  private async authenticate(request: IncomingMessage) { const token = (request.headers.authorization || '').replace(/^Bearer /, ''); if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error('Invalid relay'); const row = (await this.db.query("SELECT id FROM cloud_workspaces WHERE relay_hash=$1 AND state NOT IN ('destroyed','suspended')", [tokenHash(token)])).rows[0]; if (!row) throw new Error('Invalid relay'); return row.id as string; }
  private connected(workspaceId: string, socket: WebSocket) {
    void this.db.query("UPDATE cloud_workspaces SET state='running' WHERE id=$1 AND edition='self-hosted' AND state='awaiting_pairing'",[workspaceId]).catch(()=>socket.close(1011,'Workspace pairing could not be recorded.'));
    this.sockets.get(workspaceId)?.close(4001, 'Relay replaced'); this.sockets.set(workspaceId, socket);
    socket.on('message', data => { try { const message = JSON.parse(data.toString());if(message.kind?.startsWith('stream.')){const stream=this.streams.get(message.id);if(!stream||stream.socket!==socket)return;if(message.kind==='stream.close')stream.client.close();else if(message.kind==='stream.data'){const frame=relayStreamFrame(message,stream.kind,7000000);if(stream.client.bufferedAmount>8000000)stream.client.close(1013,'Workspace connection is too slow.');else if(stream.client.readyState===WebSocket.OPEN)stream.client.send(frame.data,{binary:frame.binary});}return;}const request = this.pending.get(message.id); if (!request || request.socket !== socket || !Number.isInteger(message.status) || message.status < 100 || message.status > 599 || typeof message.body !== 'string' || message.body.length > 7_000_000) return; clearTimeout(request.timer); this.pending.delete(message.id); const headers: Record<string,string | string[]> = {}; for (const key of ['content-type','set-cookie']) if (typeof message.headers?.[key] === 'string' || Array.isArray(message.headers?.[key]) && message.headers[key].every((value: unknown) => typeof value === 'string')) headers[key] = message.headers[key]; request.resolve({ status: message.status, body: message.body, headers }); } catch { socket.close(1008, 'Invalid relay response'); } });
    socket.on('close', () => { if (this.sockets.get(workspaceId) === socket) this.sockets.delete(workspaceId);for(const stream of this.streams.values())if(stream.socket===socket)stream.client.close(1011,'Workspace disconnected'); for (const [id, request] of this.pending) if (request.socket === socket) { clearTimeout(request.timer); this.pending.delete(id); request.reject(new ProductError('The workspace computer disconnected. Work can continue; reconnect to inspect its progress.', 503)); } });
  }
  async request(workspaceId: string, actorId: string, role: WorkspaceRole, method: string, path: string, body = '', cookies?: string): Promise<RelayReply> {
    if (!relayPathAllowed(path) || !['GET','POST','PUT','PATCH','DELETE'].includes(method) || Buffer.byteLength(body) > 5_000_000) throw new ProductError('This workspace relay request is not permitted.', 403);
    const socket = this.sockets.get(workspaceId); if (!socket || socket.readyState !== WebSocket.OPEN) throw new ProductError('This workspace computer is not connected. Its current work has not been cancelled.', 503);
    if ([...this.pending.values()].filter(item => item.socket === socket).length >= 16) throw new ProductError('This workspace has too many pending requests. Try again shortly.', 429);
    const displayName=accountDisplayName((await this.db.query('SELECT display_name FROM accounts WHERE id=$1',[actorId])).rows[0]?.display_name);
    const key = await importJWK(this.signingKey, 'EdDSA'), context = await new SignJWT({ workspaceId, role, ...(displayName?{displayName}:{}) }).setProtectedHeader({ alg: 'EdDSA' }).setIssuer(this.issuer).setSubject(actorId).setAudience(`open-harness:${workspaceId}`).setIssuedAt().setExpirationTime('60s').sign(key), id = randomUUID();
    return new Promise((resolve,reject) => { const timer = setTimeout(() => { this.pending.delete(id); reject(new ProductError('The workspace did not confirm its response. Check its state before repeating a write.', 504)); }, 35000); this.pending.set(id, { socket, resolve, reject, timer }); socket.send(JSON.stringify({ id, method, path, body, context, ...(cookies ? { cookies } : {}) }), error => { if (error) { clearTimeout(timer); this.pending.delete(id); reject(new ProductError('The workspace relay disconnected.', 503)); } }); });
  }
  disconnect(workspaceId:string){this.sockets.get(workspaceId)?.close(4001,'Workspace relay credential changed');}
  close() { for (const socket of this.sockets.values()) socket.close(1001, 'Control plane stopping'); this.wss.close(); }
  tunnel(workspaceId:string,path:string,client:WebSocket,permitted:()=>Promise<boolean>){
    const socket=this.sockets.get(workspaceId),kind=relayStreamKind(path);
    if(!kind||!socket||socket.readyState!==WebSocket.OPEN||[...this.streams.values()].filter(value=>value.socket===socket).length>=2){client.close(1013,'Workspace streaming is unavailable.');return;}
    const id=randomUUID(),timer=setInterval(()=>{void permitted().then(allowed=>{if(!allowed)client.close(1008,'Workspace permission changed.');}).catch(()=>client.close(1008,'Workspace permission could not be verified.'));},10000);
    this.streams.set(id,{socket,client,kind,timer});socket.send(JSON.stringify({kind:'stream.open',id,path}));
    let pendingBytes=0,pendingFrames=0,delivery=Promise.resolve();
    client.on('message',(data,binary)=>{
      const bytes=relayStreamBytes(data);pendingBytes+=bytes.length;pendingFrames++;
      if(pendingFrames>64||pendingBytes>65536||socket.bufferedAmount>8000000){client.close(1013,'Workspace connection is too slow.');return;}
      delivery=delivery.then(async()=>{
        if(client.readyState!==WebSocket.OPEN||!this.streams.has(id))return;
        if(!await permitted()){client.close(1008,'Workspace permission changed.');return;}
        if(client.readyState!==WebSocket.OPEN||this.sockets.get(workspaceId)!==socket||socket.readyState!==WebSocket.OPEN)return;
        socket.send(JSON.stringify({kind:'stream.data',id,data:bytes.toString('base64'),binary}));
      }).catch(()=>client.close(1008,'Workspace permission could not be verified.')).finally(()=>{pendingBytes-=bytes.length;pendingFrames--;});
    });
    client.once('close',()=>{clearInterval(timer);this.streams.delete(id);if(socket.readyState===WebSocket.OPEN)socket.send(JSON.stringify({kind:'stream.close',id}));});
  }
}
