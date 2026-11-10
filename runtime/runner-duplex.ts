import { randomBytes, randomUUID } from 'node:crypto';
import type { IncomingMessage, Server } from 'node:http';
import { Duplex, Transform } from 'node:stream';
import { WebSocket, WebSocketServer, createWebSocketStream } from 'ws';
import type { AgentProfile } from '../lib/agent-profile';
import type { ComputerStream, StreamKind, StreamOwnership } from './computer-stream';
import { immutableContainer, startComputerStream } from './computer-stream';
import { assertComputerOwnership } from './computer-ownership';
import { ensureContainerAsync, runningAgentContainer } from './hermes';
import { runningDesktopContainer } from './computer-runtime';
import { assertContainerAdmission } from './container-admission';

const runnerConnections = new Map<string, Set<() => void>>();
export function closeRunnerDuplex(root: string) { for (const stop of runnerConnections.get(root) || []) stop(); runnerConnections.delete(root); }

export async function admitRunnerTerminal(agentId: string, expiresAt: number, operations: Map<string, Promise<void>>, validate: () => void, start: (ready: () => void) => Promise<void>) {
  const deadline = Math.min(expiresAt, Date.now() + 10000); let previous: Promise<void> | undefined;
  for (;;) {
    validate(); if (!Number.isFinite(deadline) || deadline <= Date.now()) throw new Error('The terminal invitation expired while the computer was busy.');
    const operation = operations.get(agentId);
    // Reserve startup in this continuation; a completed operation's finally may still be clearing its map entry.
    if (!operation || operation === previous) {
      let ready!: () => void; const startup = new Promise<void>(resolve => { ready = resolve; });
      const release = () => { if (operations.get(agentId) === startup) operations.delete(agentId); ready(); };
      operations.set(agentId, startup);
      try { return await start(release); } finally { release(); }
    }
    previous = operation; let timer: ReturnType<typeof setTimeout> | undefined;
    try { await Promise.race([operation, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('The computer is still busy. Reconnect the terminal and retry.')), deadline - Date.now()); })]); }
    finally { clearTimeout(timer); }
  }
}

export type DuplexCommand = { id: string; agentId: string; kind: 'duplex'; payload: { path: string; kind: StreamKind; profile: AgentProfile; ownership: StreamOwnership; expiresAt: number } };
type Pending = { machineId: string; command: DuplexCommand; sent: boolean; permitted(): boolean; resolve(value: ComputerStream): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> };

// Only connection invitations are polled. Terminal bytes and frames never enter the durable command spool.
export class RunnerDuplex {
  private pending = new Map<string, Pending>();
  private sockets = new WebSocketServer({ noServer: true, maxPayload: 65536 });
  private closed = false;
  constructor(private wake: (machineId: string) => void) {}
  connect(profile: AgentProfile, kind: StreamKind, ownership: StreamOwnership, permitted: () => boolean): Promise<ComputerStream> {
    if (this.closed || !permitted()) return Promise.reject(new Error('Computer permission changed.'));
    if (this.pending.size >= 100) return Promise.reject(new Error('Too many computer connections are waiting.'));
    return new Promise((resolve, reject) => {
      const ticket = randomBytes(32).toString('base64url'), id = randomUUID(), timer = setTimeout(() => { this.pending.delete(ticket); reject(new Error('The runner did not connect. Reconnect the computer and retry.')); }, 25000);
      const command: DuplexCommand = { id, agentId: profile.id, kind: 'duplex', payload: { path: `/v1/runner/duplex?ticket=${ticket}`, kind, profile, ownership, expiresAt: Date.now() + 20000 } };
      this.pending.set(ticket, { machineId: profile.computer.machineId, command, sent: false, permitted, resolve, reject, timer }); this.wake(profile.computer.machineId);
    });
  }
  poll(machineId: string) {
    const commands: DuplexCommand[] = [];
    for (const [key, pending] of this.pending) if (pending.machineId === machineId && !pending.sent) {
      if (pending.command.payload.expiresAt <= Date.now() || !pending.permitted()) { clearTimeout(pending.timer); this.pending.delete(key); pending.reject(new Error('The computer connection expired.')); }
      else { pending.sent = true; commands.push(pending.command); }
    }
    return commands;
  }
  attach(server: Server, authenticate: (req: IncomingMessage) => string | null | false) {
    server.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url || '/', 'http://localhost'); if (url.pathname !== '/v1/runner/duplex') return;
      const key = url.searchParams.get('ticket') || '', pending = this.pending.get(key), machineId = authenticate(req);
      if (!pending || !pending.sent || machineId !== pending.machineId || pending.command.payload.expiresAt <= Date.now() || !pending.permitted()) return socket.destroy();
      this.pending.delete(key); clearTimeout(pending.timer);
      this.sockets.handleUpgrade(req, socket, head, ws => {
        let ready = false, channel: Duplex | undefined;
        const deadline = setTimeout(() => ws.terminate(), 5000);
        const check = setInterval(() => { if (authenticate(req) !== machineId || !pending.permitted()) ws.terminate(); }, 1000);
        ws.once('close', () => { clearTimeout(deadline); clearInterval(check); channel?.destroy(); if (!ready) pending.reject(new Error('The runner connection closed before it was ready.')); });
        ws.on('error', () => {});
        ws.once('message', (data, binary) => {
          let value: { type?: unknown; containerId?: unknown };
          try { value = JSON.parse(data.toString()); } catch { ws.terminate(); return; }
          if (binary || value.type !== 'ready' || !immutableContainer(value.containerId) || !pending.permitted() || authenticate(req) !== machineId) return ws.terminate();
          ready = true; clearTimeout(deadline);
          const stream = createWebSocketStream(ws, { highWaterMark: 65536 }); stream.on('error', () => {});
          const guard = new Transform({ highWaterMark: 65536, transform(chunk: Buffer, _encoding, callback) { if (!pending.permitted() || authenticate(req) !== machineId) callback(new Error('Computer permission changed.')); else callback(null, chunk); } });
          guard.on('error', () => ws.terminate()); guard.pipe(stream);
          channel = Duplex.from({ readable: stream, writable: guard }); channel.on('error', () => {});
          ws.send(JSON.stringify({ type: 'accepted' }));
          const connection = channel; pending.resolve({ stream: connection, containerId: value.containerId, close: () => { connection.destroy(); ws.terminate(); } });
        });
      });
    });
  }
  close() { this.closed = true; for (const value of this.pending.values()) { clearTimeout(value.timer); value.reject(new Error('The coordinator is stopping.')); } this.pending.clear(); for (const ws of this.sockets.clients) ws.terminate(); this.sockets.close(); }
}

export async function executeRunnerDuplex(root: string, credentials: { coordinator: string; machineId: string; token: string }, command: DuplexCommand, admission: { validate?(): void; ready?(): void } = {}) {
  assertContainerAdmission(root);
  admission.validate?.();
  const { profile, ownership, kind, expiresAt } = command.payload;
  if (!profile || profile.id !== command.agentId || profile.computer.machineId !== credentials.machineId || !['terminal', 'desktop'].includes(kind) || typeof expiresAt !== 'number' || expiresAt <= Date.now() || !/^\/v1\/runner\/duplex\?ticket=[A-Za-z0-9_-]{43}$/.test(command.payload.path)) throw new Error('The computer invitation is invalid or expired.');
  if (kind === 'terminal' && ownership.owner !== 'human') throw new Error('Take control before opening a terminal.');
  assertComputerOwnership(root, profile, ownership);
  const containerId = kind === 'terminal' ? await ensureContainerAsync(profile.id, root, profile.computer) : await runningDesktopContainer(profile.id, root, profile.computer);
  assertComputerOwnership(root, profile, ownership);
  assertContainerAdmission(root);
  admission.validate?.();
  if (!immutableContainer(containerId) || expiresAt <= Date.now()) throw new Error('The computer is not ready.');
  const url = new URL(credentials.coordinator.replace(/\/$/, '') + command.payload.path); url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(url, { headers: { Authorization: `Bearer ${credentials.token}`, 'X-Open-Harness-Machine': credentials.machineId }, maxPayload: 65536, handshakeTimeout: 5000, perMessageDeflate: false });
  return new Promise<void>((resolve, reject) => {
    let source: ComputerStream | undefined, ended = false, checking = false;
    const finish = (error?: Error) => { if (ended) return; ended = true; clearTimeout(deadline); clearInterval(check); source?.close(); ws.terminate(); connections.delete(stop); if (!connections.size) runnerConnections.delete(root); admission.ready?.(); if (error) reject(error); else resolve(); };
    const stop = () => finish(), connections = runnerConnections.get(root) || new Set<() => void>(); connections.add(stop); runnerConnections.set(root, connections);
    const deadline = setTimeout(() => finish(new Error('The computer connection was not accepted.')), 10000);
    const check = setInterval(() => {
      if (checking || ended) return; checking = true;
      void (async () => { assertComputerOwnership(root, profile, ownership); const current = kind === 'terminal' ? await runningAgentContainer(profile.id, root) : await runningDesktopContainer(profile.id, root, profile.computer); if (current !== containerId) throw new Error('The computer changed.'); })().catch(() => finish()).finally(() => { checking = false; });
    }, 1000);
    ws.once('open', () => { try { admission.validate?.(); assertComputerOwnership(root, profile, ownership); ws.send(JSON.stringify({ type: 'ready', containerId })); } catch { finish(); } });
    ws.once('message', (data, binary) => {
      try {
        if (binary || JSON.parse(data.toString()).type !== 'accepted' || expiresAt <= Date.now()) throw new Error('The computer invitation expired.');
        admission.validate?.(); assertComputerOwnership(root, profile, ownership); clearTimeout(deadline);
        source = startComputerStream(containerId, kind);
        const stream = createWebSocketStream(ws, { highWaterMark: 65536 }); stream.on('error', () => finish());
        // Validate every incoming chunk before it can reach the private computer.
        const guard = new Transform({ highWaterMark: 65536, transform(chunk: Buffer, _encoding, callback) {
          void (async () => { assertComputerOwnership(root, profile, ownership); const current = kind === 'terminal' ? await runningAgentContainer(profile.id, root) : await runningDesktopContainer(profile.id, root, profile.computer); if (current !== containerId) throw new Error('The computer changed.'); assertComputerOwnership(root, profile, ownership); callback(null, chunk); })().catch(() => callback(new Error('Computer control changed.')));
        } });
        guard.on('error', () => finish()); stream.pipe(guard).pipe(source.stream).pipe(stream); source.stream.once('close', () => { if (!source?.stream.readableEnded) finish(); }); admission.ready?.();
      } catch { finish(new Error('The computer connection could not start.')); }
    });
    ws.once('error', () => finish(new Error('The runner computer connection failed.'))); ws.once('close', () => finish());
  });
}
