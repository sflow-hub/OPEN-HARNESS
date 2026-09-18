import type { Agent } from './types';

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
export type AgentProfile = {
  id: string; revision: number; name: string; role: string; description: string; tone: number;
  prompt: { enabled: boolean; text: string };
  model: ModelChoice & { inherit: boolean };
  allowedTools: string[];
  connectors: ConnectorConfig[];
  computer: ComputerConfig;
};
export type ToolInfo = { id: string; name: string; group: string; description: string; available: boolean; reason?: string };
export type ToolCatalog = { tools: ToolInfo[]; source: 'runtime' | 'cached' | 'unavailable' | 'mock'; error?: string };
export type ModelCatalog = { models: Array<{ id: string; provider: string; label: string }>; error?: string };
export type ProfileResponse = { profile: AgentProfile; effectiveModel: ModelChoice; activeRevision: number | null; pending: boolean; secretNames: string[]; machine?: MachineInfo; transfer?: { state: string; detail: string } | null };
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
export function draftProfile(agent: Agent): AgentProfile {
  if (agent.profile) return { ...agent.profile, computer: agent.profile.computer || { ...DEFAULT_COMPUTER, resources: { ...DEFAULT_COMPUTER.resources } } };
  return { id: agent.id, revision: 0, name: agent.name, role: agent.role, description: agent.description, tone: agent.tone,
    prompt: { enabled: true, text: agent.instructions }, model: { ...DEFAULT_MODEL, inherit: true }, allowedTools: [], connectors: [], computer: { ...DEFAULT_COMPUTER, resources: { ...DEFAULT_COMPUTER.resources } } };
}
export function profileAgent(profile: AgentProfile, memory: string[] = []): Agent {
  return { id: profile.id, name: profile.name, role: profile.role, description: profile.description, tone: profile.tone, instructions: profile.prompt.text, memory, profile };
}
export function runToolGrants(profile: AgentProfile): string[] {
  return profile.allowedTools.filter(id =>
    (profile.computer.desktop !== 'none' || id !== 'computer_use') &&
    (!id.startsWith('mcp_') || id.startsWith('mcp_open_harness_') || profile.connectors.some(connector => connector.enabled && id.startsWith(`mcp_${connector.name}_`)))
  );
}
