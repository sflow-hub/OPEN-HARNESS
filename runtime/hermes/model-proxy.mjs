import { createServer, request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { readFileSync } from 'node:fs';

// Only the Responses endpoint is bridged. Account tokens never enter this process.
export async function modelProxy(transport, options = {}) {
  const server = createServer(async (req, res) => {
    if (req.method !== 'POST' || !['/responses','/v1/responses'].includes(req.url)) { res.writeHead(404); res.end(); return; }
    let upstream;
    try {
      const lease = JSON.parse(readFileSync(transport.OPEN_HARNESS_RUN_LEASE || '/run/open-harness/run-lease.json','utf8'));
      if (!lease.active || !lease.runId || lease.expiresAt <= Date.now()) throw new Error('No active task');
      const parts = []; let size = 0;
      for await (const part of req) { size += part.length; if (size > 2000000) throw new Error('Request too large'); parts.push(part); }
      const body = Buffer.concat(parts);
      const headers = { 'Content-Type':'application/json', Authorization:`Bearer ${transport.OPEN_HARNESS_AGENT_TOKEN}`, 'X-Open-Harness-Agent':transport.OPEN_HARNESS_AGENT_ID, 'X-Open-Harness-Run':lease.runId };
      const path = '/internal/codex/responses';
      const routes = [{ socketPath:transport.OPEN_HARNESS_CONTROL_SOCKET || '/run/open-harness/coord.sock', path, method:'POST', headers }];
      if (transport.OPEN_HARNESS_CONTROL_URL) { const url = new URL(transport.OPEN_HARNESS_CONTROL_URL.replace(/\/$/,'') + path); routes.push({ protocol:url.protocol, hostname:url.hostname, port:url.port || undefined, path:url.pathname, method:'POST', headers }); }
      for (const route of routes) {
        try {
          upstream = await new Promise((resolve,reject) => {
            const send = route.protocol === 'https:' ? httpsRequest : httpRequest;
            let connected = false;
            const outgoing = send(route, resolve);
            outgoing.on('socket',socket=>{if(!socket.connecting)connected=true;else socket.once('connect',()=>{connected=true;});});
            outgoing.on('error',error=>reject(Object.assign(error,{unreachable:!connected && ['ENOENT','ECONNREFUSED','EHOSTUNREACH','ENETUNREACH'].includes(error.code)})));
            outgoing.setTimeout(300000,()=>outgoing.destroy(new Error('Model request timed out')));
            res.once('close',()=>outgoing.destroy()); outgoing.end(body);
          });
          break;
        } catch (error) { if (res.destroyed) return; if (!error.unreachable) throw error; }
      }
      if (!upstream) throw new Error('Coordinator unavailable');
      res.writeHead(upstream.statusCode || 502, { 'Content-Type':upstream.headers['content-type'] || 'application/json', 'Cache-Control':'no-store' });
      upstream.on('error',()=>res.destroy()); upstream.pipe(res);
    } catch { if (!res.headersSent) { res.writeHead(409,{'Content-Type':'application/json'}); res.end(JSON.stringify({ error:{ message:'The managed ChatGPT connection is unavailable. Check sign-in and retry this task.' } })); } else res.destroy(); }
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(options.port || 0,'127.0.0.1',resolve);});
  return server;
}
