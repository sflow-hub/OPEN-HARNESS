import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import lock from './model-lock.json' with { type: 'json' };
import { prepareWeights } from './weights.mjs';

const cache = '/models';
const here = fileURLToPath(import.meta.url);
const nativePort = 8081;
const limit = 8 * 1024 * 1024;
const guidance = 'Perform the requested edits using the supplied functions. For every file operation, emit a native tool call using <tool_call>{"name":"FUNCTION_NAME","arguments":{...}}</tool_call> with actual JSON arguments. Start the call directly, without commentary or Markdown fences. Use a narrow search and small line ranges to read relevant code. Use the patch tool for a targeted edit and verify the changed text before finishing.';

export function guidePrivateEdit(input) {
  if (!Array.isArray(input.tools) || !input.tools.length || input.tool_choice === 'none') return;
  const lastUser = input.messages.findLastIndex(message => message?.role === 'user');
  const task = input.messages[lastUser]?.content;
  if (typeof task !== 'string' || !task.includes('Edit the private dashboard source at /workspace/private/improvement-')) return;
  const first = input.messages[0];
  if (first?.role === 'system' && typeof first.content === 'string') first.content += '\n\n' + guidance;
  else input.messages.unshift({ role: 'system', content: guidance });
  const hasResult = input.messages.slice(lastUser + 1).some(message => message?.role === 'tool');
  if (!hasResult && (!input.tool_choice || input.tool_choice === 'auto')) input.tool_choice = 'required';
}

function status(phase, message, progress) {
  return { phase, message, ...(progress === undefined ? {} : { progress }) };
}

function send(res, code, data) {
  if (res.headersSent) { res.destroy(); return; }
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(data));
}

async function serve() {
  let state;
  let catalogData;
  let child;
  let stopping = false;
  function update(value) {
    state = value;
    console.log('ATLAS_MODEL ' + JSON.stringify(value));
  }
  function fail(message) { if (!stopping) update(status('error', message)); }
  update(status('checking', 'Checking the model cache.'));
  const server = http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/health') return send(res, state.phase === 'ready' ? 200 : 503, state);
    const catalog = req.method === 'GET' && req.url === '/v1/models';
    if (!catalog && !(req.method === 'POST' && req.url === '/v1/chat/completions')) return send(res, 404, { error: { message: 'Unknown model route.' } });
    if (state.phase !== 'ready') return send(res, 503, { error: { message: state.message } });
    if (catalog) return send(res, 200, catalogData);
    try {
      const chunks = [];
      let size = 0;
      for await (const chunk of req) {
        size += chunk.length;
        if (size > limit) return send(res, 413, { error: { message: 'Request exceeds the model endpoint limit.' } });
        chunks.push(chunk);
      }
      const input = JSON.parse(Buffer.concat(chunks).toString());
      if (input?.model !== lock.name || !Array.isArray(input.messages)) return send(res, 400, { error: { message: 'Unknown model or missing messages.' } });
      guidePrivateEdit(input);
      const body = Buffer.from(JSON.stringify(input));
      const upstream = http.request({ hostname: '127.0.0.1', port: nativePort, path: '/v1/chat/completions', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': body.length } }, response => {
        res.writeHead(response.statusCode || 502, { 'content-type': response.headers['content-type'] || 'application/json', 'cache-control': 'no-store' });
        response.on('error', () => res.destroy());
        response.pipe(res);
      });
      upstream.setTimeout(600_000, () => upstream.destroy());
      upstream.on('error', () => send(res, 502, { error: { message: 'The local model connection was interrupted.' } }));
      res.once('close', () => upstream.destroy());
      upstream.end(body);
    } catch {
      send(res, 400, { error: { message: 'Could not read the model request.' } });
    }
  });
  function stop() {
    stopping = true;
    child?.kill('SIGTERM');
    server.close();
    server.closeAllConnections();
  }
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  server.listen(8080, '0.0.0.0');
  await once(server, 'listening');
  try {
    child = spawn('flock', ['--no-fork', join(cache, '.atlas.lock'), process.execPath, here, '--prepare'], { stdio: ['ignore', 'pipe', 'inherit'] });
    const lines = createInterface({ input: child.stdout });
    lines.on('line', line => { try { update(JSON.parse(line)); } catch { /* Child output is private status only. */ } });
    const [code] = await once(child, 'close');
    if (stopping) return;
    if (code !== 0) { if (state.phase !== 'error') fail('Could not prepare the model cache. Check its permissions and retry.'); return; }
    update(status('loading', 'Loading Atlas into memory.'));
    child = spawn('/opt/llama/llama-server', [
      '--model', join(cache, lock.weights.filename), '--alias', lock.name, '--host', '127.0.0.1', '--port', String(nativePort),
      '--ctx-size', String(lock.context), '--parallel', '1', '--threads', '3', '--threads-batch', '4',
      '--batch-size', '256', '--ubatch-size', '128', '--n-gpu-layers', '0', '--cache-type-k', 'q4_0', '--cache-type-v', 'q4_0',
      '--flash-attn', 'on', '--cache-ram', '128', '--jinja', '--offline', '--no-webui',
    ], { stdio: 'ignore' });
    child.once('error', () => fail('The Atlas runtime could not start. Rebuild the model image and retry.'));
    child.once('close', (code, signal) => {
      if (state.phase !== 'error') fail('The Atlas runtime stopped (' + (signal || ('exit ' + code)) + '). Check Docker memory and retry.');
    });
    while (!stopping && state.phase === 'loading') {
      const ok = await fetch('http://127.0.0.1:' + nativePort + '/health', { signal: AbortSignal.timeout(3000) })
        .then(response => { void response.body?.cancel(); return response.ok; }).catch(() => false);
      if (ok && !stopping && state.phase === 'loading') {
        const response = await fetch('http://127.0.0.1:' + nativePort + '/v1/models', { signal: AbortSignal.timeout(4000) });
        const catalog = response.ok && await response.json();
        const loaded = catalog?.data?.find(entry => entry.id === lock.name);
        if (loaded?.meta?.n_ctx !== lock.context) {
          fail('Atlas could not load its full context. Check Docker memory and retry.');
          child.kill('SIGTERM');
          break;
        }
        catalogData = { object: 'list', data: [{ ...loaded, context_length: loaded.meta.n_ctx }] };
        update(status('ready', 'Atlas is ready.'));
        break;
      }
      await delay(1000);
    }
  } catch {
    fail('The Atlas model service could not start. Check its Docker volume and retry.');
  }
}

if (process.argv[1] === here) {
  if (process.argv[2] === '--prepare') {
    const report = (phase, message, progress) => console.log(JSON.stringify(status(phase, message, progress)));
    try { await prepareWeights(cache, lock.weights, report); }
    catch (error) {
      const message = error.code === 'ENOSPC' ? 'Docker storage ran out of space. Free space and retry.'
        : error.message === 'fetch failed' || error.name === 'AbortError' ? 'The model download was interrupted. Check the connection and retry.'
        : error.message || 'Could not prepare the model cache. Check Docker storage and retry.';
      report('error', message);
      process.exitCode = 1;
    }
  } else {
    await serve();
  }
}
