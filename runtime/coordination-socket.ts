import { createServer, type RequestListener } from 'node:http';
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

// The managed directory is mounted only in its owning agent's container. A Unix
// socket reaches the local service without publishing a host network port.
export async function coordinationSocket(directory: string, agentId: string, handler: RequestListener) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, 'coord.sock');
  if (existsSync(path)) unlinkSync(path); // stale endpoint after service restart
  // Linux sockaddr_un paths are short. The directory FD also supports long
  // workspace paths without moving the endpoint outside its private mount.
  const fd = openSync(directory, 'r');
  const socketPath = process.platform === 'linux' ? `/proc/self/fd/${fd}/coord.sock` : path;
  const server = createServer((req, res) => {
    if (req.headers['x-open-harness-agent'] !== agentId || !['/internal/handoff', '/internal/schedule'].includes(req.url || '')) {
      res.writeHead(403, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'This endpoint is scoped to its owning agent and coordination tools.' })); return;
    }
    handler(req, res);
  });
  try {
    await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); });
    chmodSync(path, 0o600);
    return { close: () => new Promise<void>(resolve => server.close(() => { closeSync(fd); resolve(); })) };
  } catch (error) { closeSync(fd); throw error; }
}
