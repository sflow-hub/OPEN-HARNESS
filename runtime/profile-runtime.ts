import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, renameSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentProfile, ModelChoice, ToolCatalog, ToolInfo } from '../lib/agent-profile';
import { dockerStatus, ensureContainer, HermesGateway } from './hermes';

export const COORDINATION_TOOLS: ToolInfo[] = [
  { id: 'mcp_open_harness_delegate_named_agent', name: 'Hand off to another agent', group: 'delegation', description: 'Assign explicit task context to another named agent.', available: true },
  { id: 'mcp_open_harness_create_open_harness_routine', name: 'Create a routine', group: 'scheduling', description: 'Schedule work through Open Harness.', available: true },
];
const mockTools: ToolInfo[] = [
  ['terminal', 'terminal'], ['process', 'terminal'], ['execute_code', 'code'], ['read_file', 'files'], ['write_file', 'files'], ['search_files', 'files'],
  ['web_search', 'web'], ['web_extract', 'web'], ['browser_navigate', 'browser'], ['browser_screenshot', 'browser'], ['memory', 'memory'], ['skills_list', 'skills'], ['skill_manage', 'skills'], ['session_search', 'recall'], ['delegate_task', 'delegation'],
].map(([id, group]) => ({ id, group, name: id.replaceAll('_', ' '), description: 'Deterministic test runtime tool.', available: true }));
export function groupTool(tool: ToolInfo): ToolInfo {
  const group = ({ file: 'files', terminal: 'terminal', process: 'terminal', code_execution: 'code', execute_code: 'code', web: 'web', browser: 'browser', memory: 'memory', skills: 'skills', session_search: 'recall', delegation: 'delegation', delegate: 'delegation', cronjob: 'scheduling' } as Record<string, string>)[tool.group] || (tool.id.startsWith('mcp_') ? 'mcp' : tool.group);
  return { ...tool, group };
}
export function runtimeProbe(container: string, input: object): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', ['exec', '-i', container, 'python', '/opt/open-harness/inspect_runtime.py'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let output = ''; const timer = setTimeout(() => { child.kill(); reject(new Error('Runtime connection check timed out.')); }, 25000);
    child.stdout.on('data', part => { output += part; if (output.length > 5_000_000) child.kill(); }); child.stderr.resume();
    child.on('error', () => { clearTimeout(timer); reject(new Error('Docker could not start the runtime check.')); });
    child.on('close', code => { clearTimeout(timer); try { const value = JSON.parse(output.trim()); if (code || value.error) reject(new Error(value.error || 'Runtime check failed.')); else resolve(value); } catch { reject(new Error('Runtime check returned an invalid response. Rebuild the Hermes image.')); } });
    child.stdin.end(JSON.stringify(input) + '\n');
  });
}
export async function discoverTools(agentId: string, root: string, profile?: AgentProfile): Promise<ToolCatalog> {
  if (process.env.OPEN_HARNESS_MOCK === '1') return { source: 'mock', tools: [...mockTools, ...COORDINATION_TOOLS] };
  const status = dockerStatus(); if (!status.available) return { source: 'unavailable', tools: [], error: status.message };
  try { const result = await runtimeProbe(ensureContainer(agentId, root, profile?.computer), { action: 'catalog' }); return { source: 'runtime', tools: [...(result.tools as ToolInfo[]).filter(t => t.group !== 'cronjob').map(groupTool), ...COORDINATION_TOOLS] }; }
  catch (error) { return { source: 'unavailable', tools: [], error: error instanceof Error ? error.message : 'Tool inventory is unavailable.' }; }
}
function atomic(path: string, data: string) { writeFileSync(`${path}.tmp`, data, { mode: 0o600 }); renameSync(`${path}.tmp`, path); chmodSync(path, 0o600); }
export type PrepareProfileOptions = { cwd?: string; coordinationCommand?: string; controlUrl?: string; controlSocket?: string };
export function prepareProfile(root: string, profile: AgentProfile, effective: ModelChoice, secrets: { environment(): Record<string,string> }, token: string, runId: string, options: PrepareProfileOptions = {}) {
  const dir = join(root, 'agents', profile.id), home = join(dir, 'profile'), managed = join(dir, 'managed');
  for (const path of [home, managed, join(dir, 'private')]) mkdirSync(path, { recursive: true });
  const mcp: Record<string, unknown> = {};
  if (profile.allowedTools.some(id => COORDINATION_TOOLS.some(t => t.id === id))) mcp.open_harness = { command: 'node', args: [options.coordinationCommand || '/opt/open-harness/coordination.mjs'], env: { OPEN_HARNESS_AGENT_ID: profile.id, OPEN_HARNESS_AGENT_TOKEN: token, OPEN_HARNESS_RUN_ID: runId, ...(options.controlUrl ? { OPEN_HARNESS_CONTROL_URL: options.controlUrl } : {}), ...(options.controlSocket ? { OPEN_HARNESS_CONTROL_SOCKET: options.controlSocket } : {}) } };
  const env: Record<string, string> = {};
  const secretValues = secrets.environment();
  if (effective.credentialRef && secretValues[effective.credentialRef]) {
    env[effective.credentialRef] = secretValues[effective.credentialRef];
    const providerEnv = ({ xai: 'XAI_API_KEY', openrouter: 'OPENROUTER_API_KEY', anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY', local: 'OPENAI_API_KEY', custom: 'OPENAI_API_KEY' } as Record<string, string>)[effective.provider];
    if (providerEnv) env[providerEnv] = secretValues[effective.credentialRef];
  }
  for (const c of profile.connectors.filter(c => c.enabled)) {
    const connectorEnv = c.secretRef && secretValues[c.secretRef] ? { [c.secretRef]: secretValues[c.secretRef] } : {};
    Object.assign(env, connectorEnv);
    mcp[c.name] = { command: c.command, args: c.args, env: c.secretRef ? { [c.secretRef]: '${' + c.secretRef + '}' } : {} };
  }
  const config = { model: { default: effective.model, provider: effective.provider === 'local' ? 'custom' : effective.provider, ...(effective.baseUrl ? { base_url: effective.baseUrl } : {}) }, terminal: { backend: 'local', cwd: options.cwd || '/workspace/shared', home_mode: 'profile' }, approvals: { mode: 'smart', unattended_mode: 'deny', cron_mode: 'deny' }, computer_use: { permission_mode: 'standard', no_overlay: profile.computer.desktop === 'virtual' }, cron: { enabled: false }, delegation: { inherit_mcp_toolsets: false }, plugins: { entries: { open_harness_policy: { enabled: true } } }, mcp_servers: mcp };
  // JSON is a YAML subset; serialization prevents YAML injection from prompts, names, and endpoints.
  atomic(join(home, 'config.yaml'), JSON.stringify(config, null, 2));
  atomic(join(home, 'SOUL.md'), profile.prompt.enabled ? profile.prompt.text : '');
  atomic(join(home, '.env'), Object.entries(env).map(([name, value]) => `${name}=${JSON.stringify(value)}`).join('\n') + '\n');
  atomic(join(managed, 'policy.json'), JSON.stringify({ runId, revision: profile.revision, allowedTools: profile.allowedTools }));
}
export async function discoverModels(gateway: HermesGateway) {
  if (process.env.OPEN_HARNESS_MOCK === '1') return { models: [{ id: 'mock-atlas', provider: 'mock', label: 'Mock Atlas' }, { id: 'mock-scout', provider: 'mock', label: 'Mock Scout' }] };
  const result = await gateway.request('model.options', { refresh: true }, 30000);
  return normalizeModels(result);
}
export function normalizeModels(result: unknown) {
  const models: Array<{ id: string; provider: string; label: string }> = [];
  function walk(value: unknown, provider = '') {
    if (typeof value === 'string' && provider) { models.push({ id: value, provider, label: value }); return; }
    if (!value || typeof value !== 'object') return;
    if (Array.isArray(value)) { value.forEach(item => walk(item, provider)); return; }
    const row = value as Record<string, unknown>;
    const p = String(row.slug || row.provider_id || row.provider || provider);
    const id = row.model_id || row.model || (p && !row.models ? row.id : '');
    if (typeof id === 'string' && id && p) models.push({ id, provider: p, label: String(row.name || row.label || id) });
    for (const key of ['providers', 'models', 'options', 'items']) if (row[key]) walk(row[key], key === 'models' ? String(row.slug || row.provider_id || row.provider || row.id || provider) : p);
  }
  walk(result);
  if (!models.length) return { models, error: 'The runtime returned no model choices. Refresh or enter a custom model ID.' };
  return { models: [...new Map(models.map(m => [`${m.provider}:${m.id}`, m])).values()] };
}
