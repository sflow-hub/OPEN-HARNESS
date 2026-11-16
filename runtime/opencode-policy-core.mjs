import { readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import http from 'node:http';
import https from 'node:https';

const aliases = { bash:'terminal', read:'read_file', write:'write_file', edit:'write_file', apply_patch:'write_file', grep:'search_files', glob:'search_files', list:'search_files', webfetch:'web_extract', websearch:'web_search' };
const classified = new Set(['read_file','write_file','patch','search_files','web_search','web_extract','session_search','skills_list','skill_view','clarify']);
const coordination = new Set(['workspace','group_chat','task','delegate_named_agent','create_open_harness_routine','computer']);

export function toolIdentity(tool, policy) {
  const matches = policy.mcpServers.filter(server => tool.startsWith(server + '_') && tool.length > server.length + 1);
  if (Object.hasOwn(aliases, tool)) return matches.length ? null : aliases[tool];
  if (matches.length !== 1) return null;
  return `mcp__${matches[0]}__${tool.slice(matches[0].length + 1)}`;
}
export function grantedIdentity(tool, policy) {
  const identity = toolIdentity(tool, policy);
  return identity && policy.allowedTools.includes(identity) ? identity : null;
}
export function needsReview(identity) {
  return !classified.has(identity) && !(identity.startsWith('mcp__open_harness__') && coordination.has(identity.slice('mcp__open_harness__'.length)));
}
function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])]));
  return value;
}
function digest(value) { return createHash('sha256').update(JSON.stringify(stable(value)) ?? 'null').digest('hex'); }
function preview(value) {
  const secret = /token|secret|password|credential|authorization|api.?key|private.?key|cookie|text/i;
  function redact(item, key = '') {
    if (secret.test(key)) return '[redacted]';
    if (Array.isArray(item)) return item.map(entry => redact(entry));
    if (item && typeof item === 'object') return Object.fromEntries(Object.entries(item).map(([name, entry]) => [name, redact(entry, name)]));
    if (typeof item === 'string') return item.replace(/(Bearer\s+|(?:token|secret|password|api[_-]?key)\s*[=:]\s*)[^\s,;]+/gi, '$1[redacted]').replace(/\b(?:sk|xai|ghp|github_pat)[-_][A-Za-z0-9_.-]{12,}/gi,'[redacted]');
    return item;
  }
  return JSON.stringify(redact(value)).slice(0, 4000);
}
function validLease(policy, readLease) {
  const lease = JSON.parse(readLease());
  if (!lease.active || lease.runId !== policy.runId || !Number.isFinite(lease.expiresAt) || lease.expiresAt <= Date.now()) throw new Error('This run no longer owns its tools.');
}
async function coordinatorPost(policy, path, payload, transport) {
  const config = policy.coordination;
  const endpoint = config.OPEN_HARNESS_CONTROL_URL;
  const socket = config.OPEN_HARNESS_CONTROL_SOCKET;
  if (!socket && !endpoint) throw new Error('The coordinator is unavailable.');
  const body = JSON.stringify(payload);
  async function send(route) {
    if (transport) return transport(route, path, payload);
    const url = route === 'url' ? new URL(path, endpoint) : null;
    const client = url?.protocol === 'https:' ? https : http;
    return new Promise((resolve, reject) => {
      const request = client.request({ ...(route === 'socket' ? { socketPath:socket, path, method:'POST' } : { protocol:url.protocol, hostname:url.hostname, port:url.port, path:url.pathname + url.search, method:'POST' }),
        headers:{ authorization:`Bearer ${config.OPEN_HARNESS_AGENT_TOKEN}`, 'x-open-harness-agent':config.OPEN_HARNESS_AGENT_ID, 'x-open-harness-run':policy.runId, 'content-type':'application/json', 'content-length':Buffer.byteLength(body) },
        timeout:10000,
      }, response => {
        let data = '';
        response.on('data', chunk => { data += chunk; if (data.length > 100000) request.destroy(new Error('Coordinator response is too large.')); });
        response.on('end', () => { try { const result = JSON.parse(data); if (response.statusCode !== 200) reject(Object.assign(new Error('The coordinator rejected the tool review.'),{coordinatorResponse:true})); else resolve(result); } catch { reject(Object.assign(new Error('The coordinator returned an invalid tool review.'),{coordinatorResponse:true})); } });
      });
      request.on('timeout', () => request.destroy(new Error('The coordinator timed out.')));
      request.on('error', reject);
      request.end(body);
    });
  }
  if (socket) { try { return await send('socket'); } catch (error) { if (!endpoint || error.coordinatorResponse) throw error; } }
  return send('url');
}
export function createManagedPolicy(policy, deps = {}) {
  if (!policy || typeof policy.runId !== 'string' || !Array.isArray(policy.allowedTools) || !Array.isArray(policy.mcpServers) || !policy.coordination) throw new Error('Invalid managed tool policy.');
  const readLease = deps.readLease || (() => readFileSync('/run/open-harness/run-lease.json','utf8'));
  const post = deps.post || ((path, payload) => coordinatorPost(policy, path, payload, deps.transport));
  const pause = deps.pause || (ms => new Promise(resolve => setTimeout(resolve, ms)));
  const outstanding = new Map();
  return {
    'tool.execute.before': async (input, output) => {
      validLease(policy, readLease);
      const identity = grantedIdentity(input.tool, policy);
      if (!identity) throw new Error(`Tool ${input.tool} is disabled in this agent profile.`);
      if (!policy.reviewUnclassified || !needsReview(identity)) return;
      if (outstanding.size) throw new Error('An earlier reviewed tool has no confirmed receipt. Its outcome must be checked before another dispatch.');
      const requestId = randomUUID();
      const args = output?.args ?? {};
      const request = { requestId, tool:identity, argumentHash:digest(args), summary:preview(args) };
      for (;;) {
        validLease(policy, readLease);
        let result;
        try { result = await post('/internal/review-tool', request); }
        catch { throw new Error('The coordinator could not review this tool.'); }
        validLease(policy, readLease);
        if (result?.state === 'approved') { outstanding.set(`${input.sessionID}:${input.callID}`, requestId); return; }
        if (result?.state !== 'pending') throw new Error('The coordinator denied this tool.');
        await pause(1000);
      }
    },
    'tool.execute.after': async (input, output) => {
      const key = `${input.sessionID}:${input.callID}`;
      const requestId = outstanding.get(key);
      if (!requestId) return;
      try { await post('/internal/tool-receipt', { requestId, resultHash:digest(output) }); }
      catch { throw new Error('The coordinator could not confirm this tool receipt. Further reviewed tools are blocked.'); }
      outstanding.delete(key);
    },
    'command.execute.before': async () => { throw new Error('Harness commands are disabled. Use the granted tools.'); },
    'experimental.chat.system.transform': async (_input, output) => { output.system.push(readFileSync('/run/open-harness/instructions.md','utf8')); },
  };
}
