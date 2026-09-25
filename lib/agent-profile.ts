import type { Agent } from './types';
import type { CredentialRecord } from './credentials';

export type ModelChoice = { provider: string; model: string; credentialRef: string; baseUrl: string };
export type ConnectorConfig = { id: string; name: string; command: string; args: string[]; secretRef: string; enabled: boolean };
export type ComputerAccess = 'private' | 'folders' | 'direct';
export type DesktopMode = 'none' | 'virtual' | 'existing';
export type FolderGrant = { id: string; path: string; mode: 'read' | 'write' };
export type ComputerConfig = {
  machineId: string;
  access: ComputerAccess;
  folders: FolderGrant[];
  desktop: DesktopMode;
  reserveMachine: boolean;
  resources: { cpu: number; memoryMb: number; concurrency: number };
};
export type MachineInfo = {
  id: string; name: string; platform: 'linux' | 'darwin' | 'win32' | 'unknown'; arch: string;
  status: 'online' | 'offline' | 'pairing' | 'revoked'; lastSeenAt: string | null;
  local: boolean; reservedAgentId: string | null; assignedAgents: number;
  capabilities: { container: boolean; direct: boolean; desktop: boolean; virtualDesktop: boolean; detail?: string };
};
// Spread these defaults over whatever is stored rather than testing the stored object
// directly: profiles saved before a permission existed must keep loading and saving.
export type BoardPermissions = { assignOthers: boolean; dispatch: boolean; manageProjects: boolean };
export const DEFAULT_BOARD: BoardPermissions = { assignOthers: false, dispatch: false, manageProjects: false };
export type AgentProfile = {
  id: string; revision: number; name: string; role: string; description: string; tone: number;
  prompt: { enabled: boolean; text: string };
  model: ModelChoice & { inherit: boolean };
  allowedTools: string[];
  board: BoardPermissions;
  connectors: ConnectorConfig[];
  computer: ComputerConfig;
};
export type ToolInfo = { id: string; name: string; group: string; description: string; available: boolean; reason?: string };
export type ToolCatalog = { tools: ToolInfo[]; source: 'runtime' | 'cached' | 'unavailable' | 'mock'; error?: string };
export type ModelCatalog = { models: Array<{ id: string; provider: string; label: string }>; error?: string };
export type ProfileResponse = { profile: AgentProfile; effectiveModel: ModelChoice; activeRevision: number | null; pending: boolean; secretNames: string[]; credentials: CredentialRecord[]; machine?: MachineInfo; transfer?: { state: string; detail: string } | null };
export const DEFAULT_MODEL: ModelChoice = { provider: 'xai', model: 'grok-4.6', credentialRef: 'XAI_API_KEY', baseUrl: '' };
export const DEFAULT_COMPUTER: ComputerConfig = { machineId: 'local', access: 'private', folders: [], desktop: 'none', reserveMachine: false, resources: { cpu: 2, memoryMb: 4096, concurrency: 4 } };
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
export const TASK_TOOL = mcpToolId(COORDINATION_SERVER, 'task');
export const HANDOFF_TOOL = mcpToolId(COORDINATION_SERVER, 'delegate_named_agent');
export const ROUTINE_TOOL = mcpToolId(COORDINATION_SERVER, 'create_open_harness_routine');
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

// What a new agent can do before anyone opens its settings. A fresh agent used to be granted
// only the task tool, so the first thing anyone asked it to do -- read something, write a file,
// run a command -- it truthfully answered that it could not. These are the tools for doing work
// inside its own container, named against the pinned Hermes catalogue.
//
// Deliberately absent, because they reach past that container or cost money on their own:
// desktop control, delegation, scheduling, MCP connectors, and the third-party integrations.
// Existing agents keep whatever they were given; an upgrade must not widen their access.
export const DEFAULT_TOOLS = [
  TASK_TOOL,
  'read_file', 'write_file', 'patch', 'search_files',
  'terminal', 'process_manage',
  'execute_code',
  'memory', 'session_search',
  'skills_list', 'skill_view', 'skill_manage',
  'web_search', 'web_extract',
  'clarify',
];

export function draftProfile(agent: Agent): AgentProfile {
  if (agent.profile) return { ...agent.profile, allowedTools: [...new Set([...normalizeToolIds(agent.profile.allowedTools || [], (agent.profile.connectors || []).map(connector => connector.name)), TASK_TOOL])], board: { ...DEFAULT_BOARD, ...(agent.profile.board || {}) }, computer: agent.profile.computer || { ...DEFAULT_COMPUTER, resources: { ...DEFAULT_COMPUTER.resources } } };
  return { id: agent.id, revision: 0, name: agent.name, role: agent.role, description: agent.description, tone: agent.tone,
    prompt: { enabled: true, text: agent.instructions }, model: { ...DEFAULT_MODEL, inherit: true }, allowedTools: [...DEFAULT_TOOLS], board: { ...DEFAULT_BOARD }, connectors: [], computer: { ...DEFAULT_COMPUTER, resources: { ...DEFAULT_COMPUTER.resources } } };
}
export function profileAgent(profile: AgentProfile, memory: string[] = []): Agent {
  return { id: profile.id, name: profile.name, role: profile.role, description: profile.description, tone: profile.tone, instructions: profile.prompt.text, memory, profile };
}
export function runToolGrants(profile: AgentProfile): string[] {
  const servers = new Set([COORDINATION_SERVER, ...profile.connectors.filter(connector => connector.enabled).map(connector => connector.name)]);
  return normalizeToolIds(profile.allowedTools, profile.connectors.map(connector => connector.name)).filter(id =>
    (profile.computer.desktop !== 'none' || id !== 'computer_use') &&
    (!id.startsWith('mcp_') || servers.has(mcpServerOf(id) || ''))
  );
}
