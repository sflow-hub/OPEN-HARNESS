import { createServer, type RequestListener } from 'node:http';
import { chmodSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, rmSync, symlinkSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';

// The managed directory is mounted only in its owning agent's container. A Unix
// socket reaches the local service without publishing a host network port.
export async function coordinationSocket(directory: string, agentId: string, handler: RequestListener) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, 'coord.sock');
  if (existsSync(path)) unlinkSync(path); // stale endpoint after service restart
  // Linux sockaddr_un paths are short. The directory FD also supports long
  // workspace paths without moving the endpoint outside its private mount.
  let fd: number | undefined;
  let alias: string | undefined;
  let socketPath = path;
  const cleanup = () => {
    if (fd !== undefined) closeSync(fd);
    if (alias) rmSync(alias, { recursive: true, force: true });
  };
  const server = createServer((req, res) => {
    if (req.headers['x-open-harness-agent'] !== agentId || !['/internal/handoff', '/internal/schedule', '/internal/task'].includes(req.url || '')) {
      res.writeHead(403, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'This endpoint is scoped to its owning agent and coordination tools.' })); return;
    }
    handler(req, res);
  });
  try {
    if (process.platform === 'linux') {
      fd = openSync(directory, 'r');
    } else if (process.platform === 'darwin' && Buffer.byteLength(path) > 103) {
      // Keep the actual socket in the managed directory. Only its pathname is shortened.
      alias = mkdtempSync('/tmp/oh-coord-');
      symlinkSync(resolve(directory), join(alias, 'managed'), 'dir');
      socketPath = join(alias, 'managed', 'coord.sock');
    }
    const bindPath = fd === undefined ? socketPath : `/proc/self/fd/${fd}/coord.sock`;
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(bindPath, () => { server.off('error', reject); resolve(); }); });
    chmodSync(path, 0o600);
    let closing: Promise<void> | undefined;
    return { socketPath, close: () => closing ??= new Promise<void>((resolve, reject) => server.close(() => {
      try { cleanup(); resolve(); } catch (error) { reject(error); }
    })) };
  } catch (error) {
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
    cleanup();
    throw error;
  }
}
