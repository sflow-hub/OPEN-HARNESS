import { createAgentRuntime, type AgentRuntime } from './agent-runtime';
import { resolveInstallation, harnessCatalog, harnessToolCatalog } from './harness-registry';
import { harnessOf } from '../lib/harness';
import { spawn } from 'node:child_process';
import { copyFileSync, mkdirSync, chmodSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { API_TOOL, bindingSecretName, COMPUTER_TOOL, folderNotice, folderTarget, HANDOFF_TOOL, ROUTINE_TOOL, runCwd, TASK_TOOL, WORKSPACE_PERMISSIONS, runToolGrants, type AgentProfile, type ModelChoice, type ToolCatalog, type ToolInfo } from '../lib/agent-profile';
import { dockerStatusCached, ensureContainerAsync } from './hermes';
import { WORKSPACE_TOOL } from '../lib/product';
import { profileMemory } from './profile-memory';
import { assertSandboxedComputer } from './computer-validation';
import { UNSANDBOXED_COMPUTER_MESSAGE } from '../lib/agent-profile';
import { atomicWorkspaceWrite as atomic } from './path-safety';
import { modelEndpointIssue } from './model-validation';
import { GROUP_CHAT_TOOL } from '../lib/group-chat';
import { CODEX_PROVIDER, isCodexSession } from '../lib/codex';

export const COORDINATION_TOOLS: ToolInfo[] = [
  { id: COMPUTER_TOOL, name: 'Managed computer', group: 'desktop', description: 'See and control the private managed browser. Human takeover keeps its current page. Existing headless browser permissions do not enable this tool; select it explicitly.', available: true },
  { id: WORKSPACE_TOOL, name: 'Workspace coordination', group: 'delegation', description: 'Track delegated work, record checkpoints, and propose bounded responsibilities.', available: true },
  { id: GROUP_CHAT_TOOL, name: 'Group conversations', group: 'delegation', description: 'Read and message teammates in shared group conversations.', available: true },
  { id: API_TOOL, name: 'Authenticated API request', group: 'other', description: 'Call explicitly granted API origins with saved credentials.', available: true },
  { id: TASK_TOOL, name: 'Task board', group: 'other', description: 'Read and update assigned board tasks.', available: true },
  { id: HANDOFF_TOOL, name: 'Hand off to another agent', group: 'delegation', description: 'Assign explicit task context to a named agent on a shared team.', available: true },
  { id: ROUTINE_TOOL, name: 'Create a routine', group: 'scheduling', description: 'Schedule work through Open Harness.', available: true },
  // Workspace access: Agent settings lists these apart from the runtime's own tools.
  ...WORKSPACE_PERMISSIONS.map(([id, name, description]) => ({ id, name, group: 'workspace', description, available: true })),
];
const mockTools: ToolInfo[] = [
  ['terminal', 'terminal'], ['process_manage', 'terminal'], ['execute_code', 'code'], ['read_file', 'files'], ['write_file', 'files'], ['search_files', 'files'],
  ['web_search', 'web'], ['web_extract', 'web'], ['browser_navigate', 'browser'], ['browser_screenshot', 'browser'], ['memory', 'memory'], ['skills_list', 'skills'], ['skill_manage', 'skills'], ['session_search', 'recall'], ['delegate_task', 'delegation'],
].map(([id, group]) => ({ id, group, name: id.replaceAll('_', ' '), description: 'Deterministic test runtime tool.', available: true }));
export function groupTool(tool: ToolInfo): ToolInfo {
  const group = ({ file: 'files', terminal: 'terminal', process: 'terminal', code_execution: 'code', execute_code: 'code', web: 'web', browser: 'browser', computer_use: 'desktop', memory: 'memory', skills: 'skills', session_search: 'recall', delegation: 'delegation', delegate: 'delegation', cronjob: 'scheduling' } as Record<string, string>)[tool.group] || (tool.id.startsWith('mcp_') ? 'mcp' : tool.group);
  return { ...tool, group };
}
export function runtimeToolCatalog(tools: ToolInfo[], profile?: AgentProfile): ToolInfo[] {
  return [...tools.filter(tool => tool.group !== 'cronjob' && tool.id !== 'computer_use' && tool.id !== COMPUTER_TOOL).map(tool => {
    const value = groupTool(tool);
    return profile?.computer.desktop === 'virtual' && tool.id.startsWith('browser_') ? { ...value, available: false, reason: 'This private desktop uses Managed computer. Enable that permission explicitly to use its visible browser.' } : value;
  }), ...COORDINATION_TOOLS];
}
export function containerBaseUrl(value: string) {
  const issue = modelEndpointIssue(value); if (issue) throw new Error(issue);
  const url = new URL(value);
  if (['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) url.hostname = 'host.docker.internal';
  return url.toString().replace(/\/$/, '');
}
export function runtimeProbe(container: string, input: object): Promise<Record<string, unknown>> {
  const probe = input as { action?: string; baseUrl?: string };
  const request = probe.action === 'connection' && probe.baseUrl ? { ...probe, baseUrl: containerBaseUrl(probe.baseUrl) } : input;
  return new Promise((resolve, reject) => {
    const child = spawn('docker', ['exec', '-i', container, 'python', '/opt/open-harness/inspect_runtime.py'], { stdio: ['pipe', 'pipe', 'pipe'] });
    let output = ''; const timer = setTimeout(() => { child.kill(); reject(new Error('Runtime connection check timed out.')); }, 25000);
    child.stdout.on('data', part => { output += part; if (output.length > 5_000_000) child.kill(); }); child.stderr.resume();
    child.on('error', () => { clearTimeout(timer); reject(new Error('Docker could not start the runtime check.')); });
    child.on('close', code => { clearTimeout(timer); try { const value = JSON.parse(output.trim()); if (code || value.error) reject(new Error(value.error || 'Runtime check failed.')); else resolve(value); } catch { reject(new Error('Runtime check returned an invalid response. Rebuild the Hermes image.')); } });
    child.stdin.end(JSON.stringify(request) + '\n');
  });
}
export async function probeAgentRuntime(root:string,profile:AgentProfile,input:object):Promise<Record<string,unknown>> {
  if(harnessOf(profile).kind==='hermes')return runtimeProbe(await ensureContainerAsync(profile.id,root,profile.computer),input);
  const runtime=await createAgentRuntime(root,profile,[]);
  if(harnessOf(profile).kind==='opencode')return runtimeProbe(runtime.container,input);
  try{await runtime.start();return await runtime.request('runtime.probe',input as Record<string,unknown>,25000);}finally{await runtime.stop();}
}
export function nativeRuntimeProbe(..._input: unknown[]): never { void _input; throw new Error(UNSANDBOXED_COMPUTER_MESSAGE); }
export async function discoverTools(agentId: string, root: string, profile?: AgentProfile): Promise<ToolCatalog> {
  assertSandboxedComputer(profile?.computer);
  if (process.env.OPEN_HARNESS_MOCK === '1' && (!profile || harnessOf(profile).kind === 'hermes')) return { source: 'mock', tools: runtimeToolCatalog(mockTools, profile) };
  if (profile && harnessOf(profile).kind !== 'hermes') {
    const info=(await harnessCatalog(root)).find(h=>h.kind===harnessOf(profile).kind);
    if(!info?.available)return {source:'unavailable',tools:[],error:info?.reason||'Install this harness first.'};
    const installation=resolveInstallation(root,harnessOf(profile));
    const native = installation.kind==='opencode' ? mockTools.filter(t=>['terminal','read_file','write_file','search_files','web_search','web_extract'].includes(t.id)) : installation.manifest?.tools || [];
    return {source:'runtime',tools:harnessToolCatalog([...native,...(info.features.mcp?COORDINATION_TOOLS:[])],info)};
  }
  const status = await dockerStatusCached(); if (!status.available) return { source: 'unavailable', tools: [], error: status.message };
  try { const result = await runtimeProbe(await ensureContainerAsync(agentId, root, profile?.computer), { action: 'catalog' }); return { source: 'runtime', tools: runtimeToolCatalog(result.tools as ToolInfo[], profile) }; }
  catch (error) { return { source: 'unavailable', tools: [], error: error instanceof Error ? error.message : 'Tool inventory is unavailable.' }; }
}
export type PrepareProfileOptions = { cwd?: string; coordinationCommand?: string; controlUrl?: string; controlSocket?: string; idle?: boolean;reviewUnclassified?:boolean };
// Every harness receives the same text: SOUL.md for Hermes, instructions.md for the others.
// Identity, folders and API grants are runtime context, so they are written even when the
// operator's instructions are switched off; otherwise the agent cannot know its own name.
export function agentInstructions(profile: AgentProfile & { projectName?: string }) {
  const grants = profile.allowedTools.includes(API_TOOL) && profile.credentialGrants?.length ? '## API access\nUse api_request with these credential references and permitted origins/methods:\n' + profile.credentialGrants.map(grant => `${grant.credentialRef}: ${grant.allowedOrigins.join(', ')} (${grant.allowedMethods.join(', ')})`).join('\n') : '';
  const identity = ['## Who you are', `Your name is ${profile.name}.${profile.role ? ` Your role: ${profile.role}.` : ''}`, profile.description.trim()].filter(Boolean).join('\n');
  return [identity, profile.prompt.enabled ? profile.prompt.text : '', folderNotice(profile.computer, profile.projectName), grants].filter(Boolean).join('\n\n');
}
export function prepareProfile(root: string, profile: AgentProfile & { projectName?: string }, effective: ModelChoice, secrets: { environment(): Record<string,string> }, token: string, runId: string, options: PrepareProfileOptions = {}) {
  assertSandboxedComputer(profile.computer);
  const allowedTools = runToolGrants(profile);
  const baseUrl = effective.baseUrl ? containerBaseUrl(effective.baseUrl) : '';
  const dir = join(root, 'agents', profile.id), home = join(dir, 'profile'), managed = join(dir, 'managed');
  for (const path of [home, managed, join(dir, 'private')]) mkdirSync(path, { recursive: true });
  profileMemory(root, profile.id);
  const mcp: Record<string, unknown> = {};
  // The agent image bakes its own copy of coordination.mjs, which goes stale the moment the
  // checkout adds a tool: the pinned image's copy predates the task tool, so task boards were
  // unreachable from inside a container no matter what the profile granted. The checkout's copy
  // is placed in the agent's managed directory, which the container already mounts read-only, so
  // the runtime always speaks the coordination protocol this build implements.
  const coordination = join(managed, 'coordination.mjs');
  copyFileSync(join(import.meta.dirname, 'hermes', 'coordination.mjs'), coordination);
  chmodSync(coordination, 0o600);
  for (const name of ['gateway-entry.mjs','model-proxy.mjs']) { const target = join(managed,name); copyFileSync(join(import.meta.dirname,'hermes',name),target); chmodSync(target,0o600); }
  const coordinationEnv = { OPEN_HARNESS_AGENT_ID: profile.id, OPEN_HARNESS_AGENT_TOKEN: token, OPEN_HARNESS_RUN_ID: runId, OPEN_HARNESS_RUN_LEASE: '/run/open-harness/run-lease.json', ...(options.controlUrl ? { OPEN_HARNESS_CONTROL_URL: options.controlUrl } : {}), ...(options.controlSocket ? { OPEN_HARNESS_CONTROL_SOCKET: options.controlSocket } : {}) };
  // Hermes caches each MCP server's tool schemas under a fingerprint of its command and args only,
  // never its environment, so a schema change would otherwise never reach an existing agent.
  const schema = createHash('sha256').update(readFileSync(coordination)).digest('hex').slice(0, 12);
  if (allowedTools.some(id => COORDINATION_TOOLS.some(t => t.id === id))) mcp.open_harness = { command: 'node', args: [options.coordinationCommand || '/run/open-harness/coordination.mjs', `--schema=${schema}`], env: coordinationEnv };
  const env: Record<string, string> = {};
  const secretValues = Object.fromEntries(Object.entries(secrets.environment()).filter(([,value]) => !isCodexSession(value)));
  const codex = effective.provider === CODEX_PROVIDER;
  if (codex) {
    env.OPEN_HARNESS_SCOPED_MODEL_TOKEN = 'open-harness-scoped-model';
  }
  // A custom or local endpoint is any OpenAI-compatible server: Ollama, LM Studio, vLLM,
  // a gateway, or a hosted provider behind its own URL. Hermes deliberately refuses to send
  // OPENAI_API_KEY to a host that is not OpenAI's (GHSA-76xc-57q6-vm5m), so aliasing the
  // credential to that name silently sends "no-key-required" and the provider answers 401.
  // The supported route is a providers: entry naming the env var to read.
  // Any explicit endpoint is a custom endpoint, whichever provider the user picked: Hermes
  // ignores base_url on its native providers (a proxy for xAI still resolved to api.x.ai)
  // and only the custom path honours the URL and carries the key via key_env.
  const customEndpoint = Boolean(baseUrl);
  // Hermes has no provider called "openai"; its API-key provider is "openai-api".
  const hermesProvider = codex ? 'custom:open-harness-chatgpt' : customEndpoint ? 'custom' : ({ local: 'custom', openai: 'openai-api' } as Record<string, string>)[effective.provider] || effective.provider;
  // Hermes will not hand a native provider's variable (XAI_API_KEY, OPENAI_API_KEY, ...) to a
  // custom endpoint, so a credential saved under one of those names would reach a proxy as
  // "no-key-required". Custom endpoints read the key from a name only Open Harness uses.
  const customKeyEnv = 'OPEN_HARNESS_MODEL_API_KEY';
  const hasCredential = Boolean(effective.credentialRef && secretValues[effective.credentialRef]);
  if (hasCredential) {
    env[effective.credentialRef] = secretValues[effective.credentialRef];
    if (customEndpoint) env[customKeyEnv] = secretValues[effective.credentialRef];
    const providerEnv = ({ xai: 'XAI_API_KEY', openrouter: 'OPENROUTER_API_KEY', anthropic: 'ANTHROPIC_API_KEY', openai: 'OPENAI_API_KEY', 'openai-api': 'OPENAI_API_KEY' } as Record<string, string>)[effective.provider];
    if (providerEnv && !customEndpoint) env[providerEnv] = secretValues[effective.credentialRef];
  }
  // Only the env var NAME is written here; the value stays in the profile .env.
  const providers = codex ? { 'open-harness-chatgpt': { name:'Open Harness ChatGPT',api_mode:'codex_responses',base_url:'http://127.0.0.1:1/v1',key_env:'OPEN_HARNESS_SCOPED_MODEL_TOKEN',default_model:effective.model } } : customEndpoint
    ? { custom: { name: 'custom', base_url: baseUrl, ...(hasCredential ? { key_env: customKeyEnv } : {}), ...(effective.model ? { default_model: effective.model } : {}) } }
    : undefined;
  for (const c of profile.connectors.filter(c => c.enabled)) {
    const connectorEnv = c.secretRef && secretValues[c.secretRef] ? { [c.secretRef]: secretValues[c.secretRef] } : {};
    Object.assign(env, connectorEnv);
    const mapped: Record<string, string> = c.secretRef ? { [c.secretRef]: '${' + c.secretRef + '}' } : {};
    for (const binding of c.credentialBindings || []) {
      const name = bindingSecretName(binding);
      if (secretValues[name] !== undefined) { env[name] = secretValues[name]; mapped[binding.env] = '${' + name + '}'; }
    }
    mcp[c.name] = { command: c.command, args: c.args, env: mapped };
  }
  const config = { model: { default: effective.model, provider: hermesProvider, ...(codex ? { base_url:'http://127.0.0.1:1/v1',api_mode:'codex_responses' } : effective.baseUrl ? { base_url: baseUrl } : {}) }, terminal: { backend: 'local', cwd: options.cwd || runCwd(profile.computer), home_mode: 'profile' }, approvals: { mode: 'manual', unattended_mode: 'deny', cron_mode: 'deny' }, computer_use: { permission_mode: 'standard', no_overlay: profile.computer.desktop === 'virtual' }, cron: { enabled: false }, delegation: { inherit_mcp_toolsets: false }, tools: { tool_search: { enabled: 'off' } }, plugins: { enabled: ['open_harness_policy'] }, ...(providers ? { providers } : {}), mcp_servers: mcp };
  // Hermes's Tool Search defers every MCP tool out of the model-facing array and offers
  // tool_search/tool_describe/tool_call bridges instead. Those bridges are not tools an Open
  // Harness profile grants, so the policy extension strips them, and the deferred tools are
  // then reachable by neither route: the agent is simply told they do not exist. A profile's
  // grant is already a short explicit allow-list, so deferral saves no context here and only
  // removes the tools the operator deliberately switched on.
  // plugins.enabled is an allow-LIST of plugin keys, and Hermes treats a missing or
  // non-list value as "nothing enabled". Any other shape silently gates the managed
  // policy extension off, managed_entry.py then aborts, and every run dies at startup.
  // JSON is a YAML subset; serialization prevents YAML injection from prompts, names, and endpoints.
  atomic(join(home, 'config.yaml'), JSON.stringify(config, null, 2));
  // The folder notice is runtime context, not the operator's instructions, so it is written even
  // when those are switched off: otherwise an agent cannot know where its granted folders are.
  const soul = agentInstructions(profile);
  atomic(join(home, 'SOUL.md'), soul);
  atomic(join(home, '.env'), Object.entries(env).map(([name, value]) => `${name}=${JSON.stringify(value)}`).join('\n') + '\n');
  // Pinned Hermes replaces a whole SOUL.md with a "[BLOCKED ...]" notice when any line resembles
  // prompt injection, and ordinary instructions ("pull new tasks", "check in with ...") match. The
  // read-only policy carries the hash of the file written here, so the managed entry trusts exactly
  // the operator's text and still scans a SOUL.md the agent rewrote and every project context file.
  const reviewUnclassified = options.reviewUnclassified??(process.env.OPEN_HARNESS_SCOPED_AUTONOMY!=='0'||process.env.OPEN_HARNESS_REQUIRE_RELAY_IDENTITY==='1');
  const mcpServers = Object.keys(mcp);
  atomic(join(managed, 'policy.json'), JSON.stringify({ runId, revision: profile.revision, soulSha256: createHash('sha256').update(soul).digest('hex'), modelProvider:effective.provider, allowedTools, mcpServers, coordination: coordinationEnv, reviewUnclassified }));
  if (harnessOf(profile).kind !== 'hermes') {
    const runtime = resolveInstallation(root, harnessOf(profile));
    copyFileSync(join(import.meta.dirname, 'runtime-launch.mjs'), join(managed, 'runtime-launch.mjs'));
    copyFileSync(join(import.meta.dirname, 'opencode-policy.mjs'), join(managed, 'opencode-policy.mjs'));
    copyFileSync(join(import.meta.dirname, 'opencode-policy-core.mjs'), join(managed, 'opencode-policy-core.mjs'));
    atomic(join(managed,'instructions.md'), soul + '\n\nYour uploaded working files are in /workspace/uploads. Harness configuration is in /workspace/harness-config.');
    const provider = effective.baseUrl ? 'open-harness' : effective.provider;
    const permission: Record<string,string|Record<string,string>> = { '*':'deny', task:'deny', question:'deny' };
    const toolMap: Record<string,string[]> = {terminal:['bash'],read_file:['read'],write_file:['edit','write','apply_patch'],search_files:['glob','grep','list'],web_search:['websearch'],web_extract:['webfetch']};
    const collides = (name:string) => mcpServers.filter(server=>name.startsWith(server+'_')&&name.length>server.length+1).length;
    const reviewed = (tool:string) => reviewUnclassified && !['read_file','write_file','patch','search_files','web_search','web_extract','session_search','skills_list','skill_view','clarify'].includes(tool) && !/^mcp__open_harness__(workspace|group_chat|task|delegate_named_agent|create_open_harness_routine|computer)$/.test(tool);
    for (const tool of allowedTools) for (const name of toolMap[tool] || []) if(!collides(name))permission[name] = reviewed(tool)?'allow':'ask';
    for (const tool of allowedTools.filter(id=>id.startsWith('mcp__'))) {
      const name=tool.slice(5).replace('__','_');
      if(collides(name)===1&&!Object.values(toolMap).some(names=>names.includes(name)))permission[name]=reviewed(tool)?'allow':'ask';
    }
    permission.external_directory = Object.fromEntries(['/workspace/uploads','/workspace/private','/workspace/shared','/workspace/harness-config',...profile.computer.folders.map(folder=>folderTarget(folder))].flatMap(path=>[[path,'allow'],[path+'/**','allow']]));
    const opencodeMcp = Object.fromEntries(Object.entries(mcp).map(([name, value]) => {
      const c = value as {command:string;args:string[];env:Record<string,string>};
      return [name, {type:'local',command:[c.command,...c.args],environment:Object.fromEntries(Object.entries(c.env).map(([k,v])=>[k,v.startsWith('${')?env[v.slice(2,-1)]||'':v])),enabled:true}];
    }));
    const opencode = { model: provider + '/' + effective.model, autoupdate:false, share:'disabled', instructions:['/run/open-harness/instructions.md'], plugin:['file:///run/open-harness/opencode-policy.mjs'], permission, mcp:opencodeMcp,
      ...(effective.baseUrl ? {provider:{'open-harness':{npm:'@ai-sdk/openai-compatible',name:'Open Harness endpoint',options:{baseURL:baseUrl,...(hasCredential?{apiKey:secretValues[effective.credentialRef]}:{})},models:{[effective.model]:{name:effective.model}}}}} : {}) };
    atomic(join(managed,'runtime-context.json'), JSON.stringify({protocol:'open-harness-runtime/v1',model:{...effective,baseUrl},mcpServers:mcp,instructions:'/run/open-harness/instructions.md',workingFiles:'/workspace/uploads',configuration:harnessOf(profile).configRevision?'/workspace/harness-config/'+harnessOf(profile).configRevision:'/workspace/harness-config'}));
    atomic(join(managed,'runtime-command.json'), JSON.stringify({command:runtime.command, configRevision:harnessOf(profile).configRevision, ...(runtime.protocol==='acp/v1'?{opencode}:{})}));
  }
  writeRunLease(root,profile.id,options.idle?null:runId);
}
export function writeRunLease(root:string,agentId:string,runId:string|null){atomic(join(root,'agents',agentId,'managed','run-lease.json'),JSON.stringify({runId,active:Boolean(runId),expiresAt:Date.now()+86400000}));}
export async function discoverModels(gateway: AgentRuntime) {
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
