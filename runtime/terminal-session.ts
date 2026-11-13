import { randomBytes } from 'node:crypto';
import type { Server } from 'node:http';
import { StringDecoder } from 'node:string_decoder';
import { Transform } from 'node:stream';
import { WebSocketServer, createWebSocketStream } from 'ws';
import type { AgentProfile } from '../lib/agent-profile';
import { isSandboxedComputer } from '../lib/agent-profile';
import { ensureContainerAsync, runningAgentContainer } from './hermes';
import { assertComputerOwnership } from './computer-ownership';
import { immutableContainer, startComputerStream, streamOriginAllowed, type ComputerStream, type StreamOwnership } from './computer-stream';
import type { RunnerDuplex } from './runner-duplex';
import { ProductError } from './product-error';

export function terminalInput(value: unknown) {
  if (!value || typeof value !== 'object') throw new Error('Choose a supported terminal action.');
  const item = value as Record<string, unknown>;
  if (item.type === 'input' && typeof item.data === 'string' && Buffer.byteLength(item.data) <= 16384) return { type: 'input', data: Buffer.from(item.data).toString('base64') };
  if (item.type === 'resize' && Number.isInteger(item.cols) && Number.isInteger(item.rows) && Number(item.cols) >= 1 && Number(item.cols) <= 500 && Number(item.rows) >= 1 && Number(item.rows) <= 200) return { type: 'resize', cols: item.cols, rows: item.rows };
  throw new Error('Terminal input is invalid or too large.');
}

export function terminalOutput() {
  let pending = '', exited = false; const decoder = new StringDecoder('utf8');
  return new Transform({
    readableHighWaterMark: 65536, writableHighWaterMark: 65536,
    transform(chunk: Buffer, _encoding, callback) {
      try {
        pending += chunk.toString('ascii'); if (pending.length > 131072) throw new Error('Invalid terminal output.');
        let end: number;
        while ((end = pending.indexOf('\n')) >= 0) {
          const line = pending.slice(0, end); pending = pending.slice(end + 1); if (!line) continue;
          const value = JSON.parse(line);
          if (exited) throw new Error('Invalid terminal output.');
          if (value.type === 'output' && typeof value.data === 'string' && value.data.length <= 32768 && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.data)) {
            const data = decoder.write(Buffer.from(value.data, 'base64')); if (data) this.push(JSON.stringify({ type: 'output', data }));
          } else if (value.type === 'exit' && Number.isInteger(value.code) && value.code >= -128 && value.code <= 255) {
            const data = decoder.end(); if (data) this.push(JSON.stringify({ type: 'output', data }));
            exited = true; this.push(JSON.stringify({ type: 'exit', code: value.code }));
          } else throw new Error('Invalid terminal output.');
        }
        callback();
      } catch { callback(new Error('The terminal returned an invalid response.')); }
    },
    flush(callback) { const data = decoder.end(); if (data) this.push(JSON.stringify({ type: 'output', data })); callback(pending ? new Error('The terminal response was interrupted.') : undefined); },
  });
}

type Ticket = { profile: AgentProfile; ownership: StreamOwnership; containerId: string | null; expiresAt: number; permitted(): boolean; source?: ComputerStream; timer?: ReturnType<typeof setTimeout>; cancelled: boolean };
type Dependencies = { remote?: Pick<RunnerDuplex, 'connect'>; ensure?(profile: AgentProfile): Promise<string>; current?(profile: AgentProfile): Promise<string | null>; assertOwnership?(profile: AgentProfile, ownership: StreamOwnership): void; open?(containerId: string): ComputerStream };
export class TerminalSessions {
  private tickets = new Map<string, Ticket>();
  private sockets = new WebSocketServer({ noServer: true, maxPayload: 65536 });
  private active = new Map<string, () => void>();
  private closed = false;
  constructor(private root: string, private deps: Dependencies = {}) {}
  private assert(ticket: Ticket) { if (this.closed || ticket.cancelled || !ticket.permitted() || ticket.ownership.owner !== 'human') throw new Error('Terminal control changed.'); if (ticket.profile.computer.machineId === 'local') (this.deps.assertOwnership || ((profile, ownership) => assertComputerOwnership(this.root, profile, ownership)))(ticket.profile, ticket.ownership); }
  private discard(key: string, ticket: Ticket) { this.tickets.delete(key); ticket.cancelled = true; clearTimeout(ticket.timer); ticket.source?.close(); }
  async ticket(profile: AgentProfile, ownership: StreamOwnership, permitted: () => boolean) {
    if (!isSandboxedComputer(profile.computer) || profile.computer.desktop !== 'virtual' || ownership.owner !== 'human') throw new ProductError('Take control of the private workspace before opening its terminal.', 409);
    const value: Ticket = { profile: structuredClone(profile), ownership: { ...ownership }, containerId: null, expiresAt: Date.now() + 30000, permitted, cancelled: false }; this.assert(value);
    for (const [key, ticket] of this.tickets) if (ticket.expiresAt <= Date.now()) this.discard(key, ticket);
    if (this.tickets.size >= 100) throw new ProductError('Too many terminal connections are waiting.', 429);
    const key = randomBytes(32).toString('base64url'); this.tickets.set(key, value);
    value.timer = setTimeout(() => this.discard(key, value), 30000); value.timer.unref();
    try {
      if (profile.computer.machineId === 'local') value.containerId = await (this.deps.ensure?.(profile) || ensureContainerAsync(profile.id, this.root, profile.computer));
      else {
        if (!this.deps.remote) throw new ProductError('Update and reconnect this runner to use its terminal.', 409);
        value.source = await this.deps.remote.connect(value.profile, 'terminal', value.ownership, () => !this.closed && !value.cancelled && value.permitted());
        value.containerId = value.source.containerId;
        value.source.stream.once('close', () => { if (this.tickets.get(key) === value) this.discard(key, value); });
      }
      if (!immutableContainer(value.containerId) || value.source?.stream.destroyed) throw new ProductError('The execution container could not be confirmed.', 409);
      this.assert(value); value.expiresAt = Date.now() + 30000; clearTimeout(value.timer);
      value.timer = setTimeout(() => this.discard(key, value), 30000); value.timer.unref();
      return { path: `/v1/terminal-stream?ticket=${key}`, expiresIn: 30 };
    } catch (error) { this.discard(key, value); throw error; }
  }
  attach(server: Server) {
    server.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url || '/', 'http://localhost'); if (url.pathname !== '/v1/terminal-stream') return;
      const key = url.searchParams.get('ticket') || '', ticket = this.tickets.get(key); this.tickets.delete(key); clearTimeout(ticket?.timer);
      if (!ticket) return socket.destroy();
      if (!immutableContainer(ticket.containerId) || ticket.expiresAt <= Date.now() || !streamOriginAllowed(req)) { this.discard(key, ticket); return socket.destroy(); }
      try { this.assert(ticket); } catch { this.discard(key, ticket); return socket.destroy(); }
      this.sockets.handleUpgrade(req, socket, head, ws => {
        let source: ComputerStream | undefined = ticket.source, ended = false, checking = false;
        const stop = () => { if (ended) return; ended = true; ticket.cancelled = true; clearInterval(lease); source?.close(); ws.terminate(); if (this.active.get(ticket.profile.id) === stop) this.active.delete(ticket.profile.id); };
        this.active.get(ticket.profile.id)?.(); this.active.set(ticket.profile.id, stop);
        const valid = async () => { this.assert(ticket); if (ticket.profile.computer.machineId === 'local' && await (this.deps.current?.(ticket.profile) || runningAgentContainer(ticket.profile.id, this.root)) !== ticket.containerId) throw new Error('The execution container changed.'); this.assert(ticket); };
        const lease = setInterval(() => { if (checking || ended) return; checking = true; void valid().catch(stop).finally(() => { checking = false; }); }, 1000);
        ws.on('error', () => {}); ws.once('close', stop);
        // Construct immediately so input arriving during runner startup is bounded by stream backpressure.
        const client = createWebSocketStream(ws, { highWaterMark: 65536, decodeStrings: false }); client.on('error', stop);
        void (async () => {
          await valid(); if (ended) return;
          source = ticket.source || (this.deps.open?.(ticket.containerId!) || startComputerStream(ticket.containerId!, 'terminal'));
          if (ended) { source.close(); return; } await valid();
          const input = new Transform({ highWaterMark: 65536, transform(chunk: Buffer, _encoding, callback) { void valid().then(() => callback(null, JSON.stringify(terminalInput(JSON.parse(chunk.toString('utf8')))) + '\n')).catch(() => callback(new Error('Terminal input is no longer permitted.'))); } });
          const output = terminalOutput(); output.setEncoding('utf8'); input.on('error', stop); output.on('error', () => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'error', message: 'The terminal connection was interrupted.' }), stop); else stop(); });
          client.pipe(input).pipe(source.stream); source.stream.pipe(output).pipe(client); source.stream.on('error', stop); source.stream.once('close', () => { if (!source?.stream.readableEnded) stop(); });
        })().catch(() => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify({ type: 'error', message: 'The terminal could not open. Check computer ownership and reconnect.' }), stop); else stop(); });
      });
    });
  }
  closeAgent(agentId: string) { this.active.get(agentId)?.(); for (const [key, value] of this.tickets) if (value.profile.id === agentId) this.discard(key, value); }
  close() { this.closed = true; for (const [key, value] of this.tickets) this.discard(key, value); for (const stop of [...this.active.values()]) stop(); this.sockets.close(); }
}
