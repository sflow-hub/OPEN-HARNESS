import { randomBytes } from 'node:crypto';
import type { Server } from 'node:http';
import { WebSocketServer, createWebSocketStream } from 'ws';
import type { AgentProfile } from '../lib/agent-profile';
import { runningDesktopContainer } from './computer-runtime';
import { assertComputerOwnership } from './computer-ownership';
import { immutableContainer, startComputerStream, streamOriginAllowed, type ComputerStream, type StreamOwnership } from './computer-stream';
import type { RunnerDuplex } from './runner-duplex';
import { ProductError } from './product-error';

type Ticket = { profile: AgentProfile; ownership: StreamOwnership; containerId: string | null; createdAt: number; expiresAt: number; permitted(): boolean; source?: ComputerStream; timer?: ReturnType<typeof setTimeout>; cancelled: boolean };
type Dependencies = { remote?: Pick<RunnerDuplex, 'connect'>; current?(profile: AgentProfile): Promise<string | null>; assertOwnership?(profile: AgentProfile, ownership: StreamOwnership): void; open?(containerId: string): ComputerStream };
export class DesktopStreaming {
  private tickets = new Map<string, Ticket>();
  private sockets = new WebSocketServer({ noServer: true, maxPayload: 65536 });
  private closed = false;
  constructor(private root: string, private deps: Dependencies = {}) {}
  private assert(ticket: Ticket) {
    if (this.closed || ticket.cancelled || !ticket.permitted()) throw new ProductError('Workspace permission changed.', 403);
    if (ticket.profile.computer.machineId === 'local') (this.deps.assertOwnership || ((profile, ownership) => assertComputerOwnership(this.root, profile, ownership)))(ticket.profile, ticket.ownership);
  }
  private current(profile: AgentProfile) { return this.deps.current?.(profile) || runningDesktopContainer(profile.id, this.root, profile.computer); }
  private discard(key: string, ticket: Ticket) { this.tickets.delete(key); ticket.cancelled = true; clearTimeout(ticket.timer); ticket.source?.close(); }
  async ticket(profile: AgentProfile, permitted: () => boolean, ownership: StreamOwnership) {
    if (profile.computer.desktop !== 'virtual') throw new ProductError('Enable the private agent desktop to view its screen.', 409);
    const value: Ticket = { profile: structuredClone(profile), ownership: { ...ownership }, containerId: null, createdAt: Date.now(), expiresAt: Date.now() + 30000, permitted, cancelled: false }; this.assert(value);
    for (const [key, ticket] of this.tickets) if (ticket.expiresAt <= Date.now()) this.discard(key, ticket);
    if (this.tickets.size >= 100) throw new ProductError('Too many desktop sessions are waiting. Try again shortly.', 429);
    const key = randomBytes(32).toString('base64url'); this.tickets.set(key, value);
    value.timer = setTimeout(() => this.discard(key, value), 30000); value.timer.unref();
    try {
      if (profile.computer.machineId === 'local') value.containerId = await this.current(value.profile);
      else {
        if (!this.deps.remote) throw new ProductError('Update and reconnect this runner to stream its desktop.', 409);
        value.source = await this.deps.remote.connect(value.profile, 'desktop', value.ownership, () => !this.closed && !value.cancelled && value.permitted());
        value.containerId = value.source.containerId;
        value.source.stream.once('close', () => { if (this.tickets.get(key) === value) this.discard(key, value); });
      }
      if (!immutableContainer(value.containerId) || value.source?.stream.destroyed) throw new ProductError('Open the private desktop before viewing its screen.', 409);
      this.assert(value); value.createdAt = Date.now(); value.expiresAt = value.createdAt + 30000; clearTimeout(value.timer);
      value.timer = setTimeout(() => this.discard(key, value), 30000); value.timer.unref();
      return { path: `/v1/desktop-stream?ticket=${key}`, transport: 'noVNC', viewOnly: true, input: 'human-lease-http', expiresIn: 30, sessionSeconds: 300 };
    } catch (error) { this.discard(key, value); throw error; }
  }
  attach(server: Server) { server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url || '/', 'http://localhost'); if (url.pathname !== '/v1/desktop-stream') return;
    const key = url.searchParams.get('ticket') || '', ticket = this.tickets.get(key); this.tickets.delete(key); clearTimeout(ticket?.timer);
    if (!ticket) return socket.destroy();
    if (!immutableContainer(ticket.containerId) || ticket.expiresAt <= Date.now() || !streamOriginAllowed(req)) { this.discard(key, ticket); return socket.destroy(); }
    try { this.assert(ticket); } catch { this.discard(key, ticket); return socket.destroy(); }
    this.sockets.handleUpgrade(req, socket, head, ws => {
      let source: ComputerStream | undefined = ticket.source, stopped = false, checking = false;
      const stop = () => { if (stopped) return; stopped = true; ticket.cancelled = true; clearInterval(check); clearTimeout(lifetime); source?.close(); ws.terminate(); };
      const valid = async () => { this.assert(ticket); if (ticket.profile.computer.machineId === 'local' && await this.current(ticket.profile) !== ticket.containerId) throw new Error('The private desktop changed.'); this.assert(ticket); };
      const check = setInterval(() => { if (checking || stopped) return; checking = true; void valid().catch(stop).finally(() => { checking = false; }); }, 1000), lifetime = setTimeout(stop, Math.max(1, ticket.createdAt + 300000 - Date.now()));
      ws.on('error', () => {}); ws.once('close', stop); const stream = createWebSocketStream(ws, { highWaterMark: 65536 }); stream.on('error', stop);
      void (async () => { await valid(); if (stopped) return; source = ticket.source || (this.deps.open?.(ticket.containerId!) || startComputerStream(ticket.containerId!, 'desktop')); if (stopped) { source.close(); return; } await valid(); source.stream.on('error', stop); stream.pipe(source.stream).pipe(stream); source.stream.once('close', stop); })().catch(stop);
    });
  }); }
  close() { this.closed = true; for (const [key, value] of this.tickets) this.discard(key, value); for (const ws of this.sockets.clients) ws.terminate(); this.sockets.close(); }
}
