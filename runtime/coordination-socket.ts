import { createServer, type RequestListener } from 'node:http';
import { chmodSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, rmSync, symlinkSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';

// The managed directory is mounted only in its owning agent's container. A Unix
// socket reaches the local service without publishing a host network port.
export async function coordinationSocket(directory: string, agentId: string, handler: RequestListener) {
  if (process.platform === 'win32') throw new Error('Windows requires authenticated HTTP coordination instead of Unix sockets.');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, 'coord.sock');
  if (existsSync(path)) unlinkSync(path); // stale endpoint after service restart
  // Linux sockaddr_un paths are short. The directory FD also supports long
  // workspace paths without moving the endpoint outside its private mount.
  let fd: number | undefined, alias: string | undefined;
  let socketPath = path;
  const cleanup = () => {
    if (fd !== undefined) { closeSync(fd); fd = undefined; }
    if (alias) { rmSync(alias, { recursive: true, force: true }); alias = undefined; }
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
      // Native MCP children share this user's PID namespace, but not its FDs.
      // Keep the owning PID explicit and the directory FD open until close().
      socketPath = `/proc/${process.pid}/fd/${fd}/coord.sock`;
    } else {
      // macOS has neither /proc/self/fd nor room for its own default temp path in
      // sockaddr_un. A private short alias leaves the socket in the managed dir.
      alias = mkdtempSync('/tmp/oh-coord-');
      chmodSync(alias, 0o700);
      symlinkSync(resolve(directory), join(alias, 'managed'), 'dir');
      socketPath = join(alias, 'managed', 'coord.sock');
    }
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socketPath, () => { server.off('error', reject); resolve(); }); });
    chmodSync(path, 0o600);
    let closing: Promise<void> | undefined;
    return { path, socketPath, close: () => closing ??= new Promise<void>(resolve => server.close(() => { cleanup(); resolve(); })) };
  } catch (error) {
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
    cleanup(); throw error;
  }
}
