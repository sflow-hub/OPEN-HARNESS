import type { Agent } from './types';

export type ModelChoice = { provider: string; model: string; credentialRef: string; baseUrl: string };
export type ConnectorConfig = { id: string; name: string; command: string; args: string[]; secretRef: string; enabled: boolean };
export type AgentProfile = {
  id: string; revision: number; name: string; role: string; description: string; tone: number;
  prompt: { enabled: boolean; text: string };
  model: ModelChoice & { inherit: boolean };
  allowedTools: string[];
  connectors: ConnectorConfig[];
};
export type ToolInfo = { id: string; name: string; group: string; description: string; available: boolean; reason?: string };
export type ToolCatalog = { tools: ToolInfo[]; source: 'runtime' | 'cached' | 'unavailable' | 'mock'; error?: string };
export type ModelCatalog = { models: Array<{ id: string; provider: string; label: string }>; error?: string };
export type ProfileResponse = { profile: AgentProfile; effectiveModel: ModelChoice; activeRevision: number | null; pending: boolean; secretNames: string[] };
export const DEFAULT_MODEL: ModelChoice = { provider: 'xai', model: 'grok-4.6', credentialRef: 'XAI_API_KEY', baseUrl: '' };
export const TOOL_GROUPS = [
  ['terminal', 'Terminal & processes', 'Run commands and manage processes. Terminal can also read files and access the network.'],
  ['code', 'Code execution', 'Execute code and use tools from code.'],
  ['files', 'Files', 'Read, search, create, and edit workspace files.'],
  ['web', 'Web', 'Search the web and extract information from pages.'],
  ['browser', 'Browser', 'Navigate pages, interact with websites, and take screenshots.'],
  ['memory', 'Memory', 'Recall and update durable preferences and context.'],
  ['skills', 'Skills', 'Discover, use, and save reusable skills.'],
  ['recall', 'Session recall', 'Find relevant information from earlier conversations.'],
  ['delegation', 'Delegation', 'Create temporary subagents and hand work to named agents.'],
  ['scheduling', 'Scheduling', 'Create routines for background work.'],
  ['mcp', 'MCP connections', 'Use tools supplied by your configured connections.'],
  ['other', 'Other tools', 'Additional tools discovered in this Hermes runtime.'],
] as const;
export function draftProfile(agent: Agent): AgentProfile {
  return agent.profile || { id: agent.id, revision: 0, name: agent.name, role: agent.role, description: agent.description, tone: agent.tone,
    prompt: { enabled: true, text: agent.instructions }, model: { ...DEFAULT_MODEL, inherit: true }, allowedTools: [], connectors: [] };
}
export function profileAgent(profile: AgentProfile, memory: string[] = []): Agent {
  return { id: profile.id, name: profile.name, role: profile.role, description: profile.description, tone: profile.tone, instructions: profile.prompt.text, memory, profile };
}
