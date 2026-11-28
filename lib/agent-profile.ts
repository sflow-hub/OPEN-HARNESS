import type { HarnessChoice, HarnessInfo } from './harness';
import type { Agent } from './types';
import type { CredentialRecord } from './credentials';

export type ModelChoice = { provider: string; model: string; credentialRef: string; baseUrl: string };
export type CredentialGrant = { credentialRef: string; allowedOrigins: string[]; allowedMethods: string[]; allowPrivateNetwork?: boolean };
export type CredentialBinding = { credentialRef: string; field: string; env: string };
export function bindingSecretName(binding: CredentialBinding) { return `OH_CREDENTIAL_${binding.credentialRef}_${binding.field.toUpperCase()}`; }
export type ConnectorConfig = { credentialBindings?: CredentialBinding[]; id: string; name: string; command: string; args: string[]; secretRef: string; enabled: boolean };
export type ComputerAccess = 'private' | 'folders' | 'direct';
export type NetworkMode = 'none' | 'allowlist' | 'open';
export type NetworkPolicy = { mode: NetworkMode; allow: string[] };
export const DEFAULT_NETWORK: NetworkPolicy = { mode: 'open', allow: [] };
export type DesktopMode = 'none' | 'virtual' | 'existing';
// Legacy values stay readable so operators can repair saved profiles without losing drafts.
export const UNSANDBOXED_COMPUTER_MESSAGE = 'Direct access to the signed-in computer is not sandboxed and is disabled. Open Agent settings → Computer and choose a private workspace or private agent desktop.';
export function isSandboxedComputer(computer: ComputerConfig) { return ['private', 'folders'].includes(computer.access) && ['none', 'virtual'].includes(computer.desktop); }
// `scope: 'project'` marks a grant a project made for one run; it is never stored on a profile.
export type FolderGrant = { id: string; name: string; path: string; mode: 'read' | 'write'; scope?: 'project' };
// A folder shared from a list (a project's, or the workspace's), with each agent's access to it.
// Anyone absent from `agents` has no access. `machineId` says which computer a workspace folder is on.
export type SharedFolder = { id: string; name: string; path: string; mode: 'read' | 'write'; agents: Record<string, 'read' | 'write'>; machineId?: string };
export const FOLDER_NAME = /^[a-z0-9][a-z0-9._-]{0,39}$/;
export const PERSONAL_FOLDER_ROOT = '/workspace/folders', PROJECT_FOLDER_ROOT = '/workspace/project';
export function folderName(path: string, taken: Iterable<string> = []) {
  const used = new Set(taken), base = (path.split(/[\\/]/).filter(Boolean).pop() || 'folder').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[^a-z0-9]+/, '').slice(0, 32) || 'folder';
  for (let n = 1; ; n++) { const name = n === 1 ? base : `${base}-${n}`; if (!used.has(name)) return name; }
}
// Grants saved before folders had names keep loading: each gets a name from its path. Names
// need only be unique under their own mount root: a workspace "docs" and a project "docs" are
// different paths, and renaming one here would mount it somewhere the agent was never told.
export function namedFolders<T extends { path: string; name?: string; scope?: 'project' }>(folders: T[]): Array<T & { name: string }> {
  const taken = { personal: new Set<string>(), project: new Set<string>() };
  return folders.map(folder => {
    const used = taken[folder.scope === 'project' ? 'project' : 'personal'];
    const name = folder.name && FOLDER_NAME.test(folder.name) && !used.has(folder.name) ? folder.name : folderName(folder.path, used);
    used.add(name); return { ...folder, name };
  });
}
// Names are the mount point, so each grant is reachable at a path the agent is told about
// and that survives reordering, unlike the positional folder-N it replaces.
export function folderTarget(grant: Pick<FolderGrant, 'name' | 'scope'>) { return `${grant.scope === 'project' ? PROJECT_FOLDER_ROOT : PERSONAL_FOLDER_ROOT}/${grant.name}`; }
// Personal folders apply to every run; a project adds only what it granted this agent.
export function runComputer(computer: ComputerConfig, grants: FolderGrant[]): ComputerConfig {
  // Named once here, so the notice, the working directory and the mounts all read the same names.
  const folders = namedFolders([...(computer.access === 'folders' ? computer.folders : []), ...grants]);
  return { ...computer, access: folders.length ? 'folders' : computer.access, folders };
}
export function runCwd(computer: ComputerConfig) {
  const project = computer.access === 'folders' ? computer.folders.filter(folder => folder.scope === 'project') : [];
  return project.length === 1 && project[0].mode === 'write' ? folderTarget(project[0]) : '/workspace/shared';
}
export function folderNotice(computer: ComputerConfig, projectName = '') {
  if (computer.access !== 'folders' || !computer.folders.length) return '';
  return ['## Folders you can use', 'These host folders are mounted in your workspace. Nothing else on the host computer is available to you.',
    ...computer.folders.map(folder => `- ${folderTarget(folder)} (${folder.mode === 'write' ? 'read and write' : 'read only'}): ${folder.scope === 'project' ? `project folder "${folder.name}"${projectName ? ` of ${projectName}` : ''}` : `your folder "${folder.name}"`}`)].join('\n');
}
export type ComputerConfig = {
  machineId: string;
  access: ComputerAccess;
  folders: FolderGrant[];
  desktop: DesktopMode;
  reserveMachine: boolean;
  browserSessionTeamId?: string;
  network: NetworkPolicy;
  resources: { cpu: number; memoryMb: number; concurrency: number };
};
export type MachineInfo = {
  folderExports?: Array<{ path: string; mode: 'read' | 'write' }>;
  id: string; name: string; platform: 'linux' | 'darwin' | 'win32' | 'unknown'; arch: string;
  status: 'online' | 'offline' | 'pairing' | 'revoked'; lastSeenAt: string | null;
  local: boolean; reservedAgentId: string | null; assignedAgents: number;
  capabilities: { container: boolean; direct: boolean; desktop: boolean; virtualDesktop: boolean; detail?: string;protocol?:number;features?:string[];harnesses?:HarnessInfo[];installedHarnessBytes?:number };
};
// Spread these defaults over whatever is stored rather than testing the stored object
// directly: profiles saved before a permission existed must keep loading and saving.
export type BoardPermissions = { assignOthers: boolean; dispatch: boolean; manageProjects: boolean };
export const DEFAULT_BOARD: BoardPermissions = { assignOthers: false, dispatch: false, manageProjects: false };
export type AgentProfile = {
  harness?: HarnessChoice;
  id: string; revision: number; name: string; role: string; description: string; tone: number;
  prompt: { enabled: boolean; text: string };
  model: ModelChoice & { inherit: boolean };
  allowedTools: string[];
  board: BoardPermissions;
  connectors: ConnectorConfig[];
  credentialGrants?: CredentialGrant[];
  computer: ComputerConfig;
};
export type ToolInfo = { id: string; name: string; group: string; description: string; available: boolean; reason?: string };
export type ToolCatalog = { tools: ToolInfo[]; source: 'runtime' | 'cached' | 'unavailable' | 'mock'; error?: string };
export type ModelCatalog = { models: Array<{ id: string; provider: string; label: string }>; error?: string };
export type ProfileResponse = { profile: AgentProfile; effectiveModel: ModelChoice; activeRevision: number | null; pending: boolean; secretNames: string[]; credentials: CredentialRecord[]; machine?: MachineInfo; transfer?: { state: string; detail: string } | null };
export const BUNDLED_MODEL: ModelChoice = { provider: 'local', model: 'atlas-linux', credentialRef: '', baseUrl: 'http://atlas-model:8080/v1' };
export const DEFAULT_MODEL: ModelChoice = { provider: 'xai', model: 'grok-4.6', credentialRef: 'XAI_API_KEY', baseUrl: '' };
export const DEFAULT_COMPUTER: ComputerConfig = { machineId: 'local', access: 'private', folders: [], desktop: 'none', reserveMachine: false, network: { ...DEFAULT_NETWORK, allow: [] }, resources: { cpu: 2, memoryMb: 4096, concurrency: 4 } };
export const TOOL_GROUPS = [
  ['terminal', 'Terminal & processes', 'Run commands and manage processes. Terminal can also read files and access the network.'],
  ['code', 'Code execution', 'Execute code and use tools from code.'],
  ['files', 'Files', 'Read, search, create, and edit workspace files.'],
  ['web', 'Web', 'Search the web and extract information from pages.'],
  ['browser', 'Browser', 'Navigate pages, interact with websites, and take screenshots.'],
  ['desktop', 'Desktop control', 'Control the selected graphical desktop. Requires Desktop access in this agent’s Computer settings.'],
  ['memory', 'Memory', 'Recall and update durable preferences and context.'],
  ['skills', 'Skills', 'Discover, use, and save reusable skills.'],
  ['recall', 'Session recall', 'Find relevant information from earlier conversations.'],
  ['delegation', 'Delegation', 'Create temporary subagents and hand work to named agents.'],
  ['scheduling', 'Scheduling', 'Create routines for background work.'],
  ['mcp', 'MCP connections', 'Use tools supplied by your configured connections.'],
  ['other', 'Other tools', 'Additional tools discovered in this Hermes runtime.'],
] as const;
// Hermes registers every MCP tool under `mcp__<server>__<tool>` (its MCP_TOOL_NAME_PREFIX),
// and the managed policy extension decides what the model may see by matching a granted name
// against that registry name exactly. Open Harness named the same tools with single
// underscores, so no grant ever matched: the policy stripped the task, hand-off and routine
// tools from every request, and a container agent was told they did not exist. The same
// mismatch silently removed every tool from a user's own MCP connection.
export const MCP_PREFIX = 'mcp__';
export const COORDINATION_SERVER = 'open_harness';
export function mcpToolId(server: string, tool: string) { return `${MCP_PREFIX}${server}__${tool}`; }
export function mcpServerOf(id: string) {
  if (!id.startsWith(MCP_PREFIX)) return null;
  const server = id.slice(MCP_PREFIX.length).split('__')[0];
  return server || null;
}
export const API_TOOL = mcpToolId(COORDINATION_SERVER, 'api_request');
export const TASK_TOOL = mcpToolId(COORDINATION_SERVER, 'task');
export const MESSAGE_TOOL = 'mcp__open_harness__post_message';
export const HANDOFF_TOOL = mcpToolId(COORDINATION_SERVER, 'delegate_named_agent');
export const ROUTINE_TOOL = mcpToolId(COORDINATION_SERVER, 'create_open_harness_routine');
export const COMPUTER_TOOL = mcpToolId(COORDINATION_SERVER, 'computer');
export const PROJECT_TOOL = mcpToolId(COORDINATION_SERVER, 'project');
export const ROUTINES_TOOL = mcpToolId(COORDINATION_SERVER, 'routines');
export const DIRECTORY_TOOL = mcpToolId(COORDINATION_SERVER, 'directory');
export const RUNS_TOOL = mcpToolId(COORDINATION_SERVER, 'runs');
export const DECIDE_TOOL = mcpToolId(COORDINATION_SERVER, 'decide');
// Workspace features an agent reaches through Open Harness itself. Each is one tool grant, off
// until a person turns it on; the labels are shared with the coordinator's refusals so an agent
// can tell the user exactly which switch to turn on.
export const WORKSPACE_PERMISSIONS: ReadonlyArray<readonly [id: string, label: string, description: string]> = [
  [PROJECT_TOOL, 'Projects', "Create projects and change their name, details, stages and archive state. It can't delete projects, share folders, or change when tasks start automatically."],
  [ROUTINES_TOOL, 'Routines', "See, edit, pause, resume, run now and delete this agent's own routines."],
  [DIRECTORY_TOOL, 'Teams and agents', "See its teams and teammates' names, roles and status — never their instructions or credentials."],
  [RUNS_TOOL, 'Runs and conversations', 'See its own runs and work it delegated, read results, and stop them.'],
  [DECIDE_TOOL, 'Decisions', 'Ask the workspace decision model to choose, rank, label, score or check, and get back IDs with confidence. Works only while decisions are on in the workspace; the question, context and option text are sent to the decision service.'],
];
export const workspacePermissionLabel = (id: string) => WORKSPACE_PERMISSIONS.find(([tool]) => tool === id)?.[1] || id;
// The old "Create and change projects" switch granted less than the Projects permission does,
// so it is retired rather than carried over: a person turns Projects on deliberately.
export const boardPermissions = (stored?: Partial<BoardPermissions> | null): BoardPermissions => ({ ...DEFAULT_BOARD, ...(stored || {}), manageProjects: false });
const LEGACY_TOOL_IDS: Record<string, string> = {
  mcp_open_harness_task: TASK_TOOL,
  mcp_open_harness_delegate_named_agent: HANDOFF_TOOL,
  mcp_open_harness_create_open_harness_routine: ROUTINE_TOOL,
};
// Grants written before the naming was corrected. Rewritten wherever a profile is read or
// saved so an existing agent keeps exactly the access it was given: this renames tools, it
// never adds one. A single-underscore name that matches no connection is left alone, and
// runToolGrants then drops it, because guessing where the server name ends could widen access.
export function normalizeToolIds(ids: string[], connectorNames: string[] = []): string[] {
  return ids.map(id => {
    if (LEGACY_TOOL_IDS[id]) return LEGACY_TOOL_IDS[id];
    if (id.startsWith(MCP_PREFIX) || !id.startsWith('mcp_')) return id;
    const server = connectorNames.find(name => id.startsWith(`mcp_${name}_`));
    return server ? mcpToolId(server, id.slice(`mcp_${server}_`.length)) : id;
  });
}

// Command execution and desktop access require an explicit per-agent grant. Existing
// profiles retain their saved selections; changing defaults must not rewrite consent.
export const DEFAULT_TOOLS = [
  TASK_TOOL,
  'read_file', 'write_file', 'patch', 'search_files',
  'execute_code',
  'memory', 'session_search',
  'skills_list', 'skill_view', 'skill_manage',
  'web_search', 'web_extract',
  'clarify',
];

export function draftProfile(agent: Agent): AgentProfile {
  if (agent.profile) return { ...agent.profile, allowedTools: [...new Set([...normalizeToolIds(agent.profile.allowedTools || [], (agent.profile.connectors || []).map(connector => connector.name)), TASK_TOOL])], board: boardPermissions(agent.profile.board), computer: { ...DEFAULT_COMPUTER, ...agent.profile.computer, resources: { ...DEFAULT_COMPUTER.resources, ...agent.profile.computer?.resources }, network: { ...DEFAULT_NETWORK, ...agent.profile.computer?.network, allow: [...(agent.profile.computer?.network?.allow || [])] } } };
  return { id: agent.id, revision: 0, name: agent.name, role: agent.role, description: agent.description, tone: agent.tone,
    prompt: { enabled: true, text: agent.instructions }, model: { ...DEFAULT_MODEL, inherit: true }, allowedTools: [...DEFAULT_TOOLS], board: { ...DEFAULT_BOARD }, connectors: [], computer: { ...DEFAULT_COMPUTER, network: { ...DEFAULT_NETWORK, allow: [] }, resources: { ...DEFAULT_COMPUTER.resources } } };
}
export function profileAgent(profile: AgentProfile, memory: string[] = []): Agent {
  return { id: profile.id, name: profile.name, role: profile.role, description: profile.description, tone: profile.tone, instructions: profile.prompt.text, memory, profile };
}
export function runToolGrants(profile: AgentProfile): string[] {
  const servers = new Set([COORDINATION_SERVER, ...profile.connectors.filter(connector => connector.enabled).map(connector => connector.name)]);
  const desktop = isSandboxedComputer(profile.computer) && profile.computer.desktop === 'virtual';
  return [...new Set(normalizeToolIds(profile.allowedTools, profile.connectors.map(connector => connector.name)).map(id => id === 'computer_use' ? COMPUTER_TOOL : id).filter(id =>
    (desktop || id !== COMPUTER_TOOL) && (!desktop || !id.startsWith('browser_')) &&
    (!id.startsWith('mcp_') || servers.has(mcpServerOf(id) || ''))
  ))];
}
