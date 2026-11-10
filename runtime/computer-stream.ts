import { spawn } from 'node:child_process';
import { Duplex } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import { DESKTOP_STREAM_HELPER } from './desktop-stream-helper';
import { TERMINAL_HELPER } from './terminal-helper';

export type StreamKind = 'terminal' | 'desktop';
export type StreamOwnership = { generation: number; owner: 'agent' | 'human' | 'idle'; identity: string };
export type ComputerStream = { stream: Duplex; containerId: string; close(): void };
export function streamOriginAllowed(req: IncomingMessage) {
  const origin = req.headers.origin;
  if (!origin || /^https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?$/.test(origin) || origin === process.env.OPEN_HARNESS_DESKTOP_ORIGIN) return true;
  try {
    const address = new URL(process.env.OPEN_HARNESS_PUBLIC_URL || '');
    return address.protocol === 'https:' && !address.username && !address.password && origin === address.origin;
  } catch { return false; }
}
export function immutableContainer(value: unknown): value is string { return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value); }
export function startComputerStream(containerId: string, kind: StreamKind): ComputerStream {
  if (!immutableContainer(containerId)) throw new Error('The computer container identity could not be confirmed.');
  const seconds = kind === 'terminal' ? 1800 : 300;
  const child = spawn('docker', ['exec', '-i', containerId, 'timeout', '--signal=TERM', '--kill-after=3s', `${seconds}s`, 'python', '-c', kind === 'terminal' ? TERMINAL_HELPER : DESKTOP_STREAM_HELPER], { stdio: ['pipe', 'pipe', 'ignore'], timeout: (seconds + 5) * 1000, killSignal: 'SIGKILL' });
  const stream = Duplex.from({ readable: child.stdout, writable: child.stdin });
  stream.on('error', () => {}); child.stdin.on('error', () => {});
  child.once('error', () => stream.destroy(new Error('The computer stream could not start.')));
  let closed = false, exited = false; child.once('close', code => { exited = true; if (!closed && code !== 0) stream.destroy(new Error('The computer stream could not continue.')); });
  const close = () => { if (closed) return; closed = true; child.stdin.end(); if (!exited) { const timer = setTimeout(() => child.kill('SIGKILL'), 2000); timer.unref(); child.once('close', () => clearTimeout(timer)); } stream.destroy(); };
  stream.once('close', close);
  return { stream, containerId, close };
}
