import { TOOL_GROUPS, type AgentProfile, type ToolInfo } from './agent-profile';
import { CODEX_PROVIDER } from './codex';

// Client side of the per-agent harness contract (see COORDINATION.md, "harness picker").
// The coordinator owns the authoritative catalog at GET /v1/harnesses; FALLBACK_HARNESSES
// only keeps the picker usable against a coordinator that predates that endpoint, and it
// never claims OpenCode is installed.
export type HarnessKind = 'hermes' | 'opencode';
export type HarnessChoice = { kind: HarnessKind };
export type HarnessFeatures = { memory: boolean; skills: boolean; sessionRecall: boolean; scheduling: boolean; desktop: boolean; mcp: boolean; approvals: boolean; steer: boolean; clarify: boolean };
export type HarnessInfo = { kind: HarnessKind; label: string; version: string; license: string; description: string; available: boolean; reason?: string; features: HarnessFeatures; providers: string[] };
export type HarnessProfile = AgentProfile & { harness?: HarnessChoice };
export const DEFAULT_HARNESS: HarnessChoice = { kind: 'hermes' };
export const HARNESS_KINDS: HarnessKind[] = ['hermes', 'opencode'];
export function harnessOf(profile: HarnessProfile): HarnessChoice { return { ...DEFAULT_HARNESS, ...(profile.harness || {}) }; }

const ALL: HarnessFeatures = { memory: true, skills: true, sessionRecall: true, scheduling: true, desktop: true, mcp: true, approvals: true, steer: true, clarify: true };
export const FALLBACK_HARNESSES: HarnessInfo[] = [
  { kind: 'hermes', label: 'Hermes', version: '', license: 'MIT', description: 'The general-purpose agent Open Harness was built on, with durable memory, skills and a private desktop.', available: true, features: ALL, providers: [] },
  { kind: 'opencode', label: 'OpenCode', version: '', license: 'MIT', description: 'A coding-focused agent that is strong at reading, editing and running code in a project.', available: false, reason: 'This coordinator does not offer OpenCode yet. You can choose it now; it will run once the OpenCode runtime is installed.', features: { ...ALL, memory: false, skills: false, sessionRecall: false, desktop: false, steer: false, clarify: false }, providers: ['xai', 'openai', 'openrouter', 'anthropic', 'local', 'custom'] },
];
export function mergeCatalog(served: HarnessInfo[] | undefined): HarnessInfo[] {
  return HARNESS_KINDS.map(kind => served?.find(item => item.kind === kind) || FALLBACK_HARNESSES.find(item => item.kind === kind)!);
}

// Tool groups a harness can only offer when it has the matching feature. Groups not listed
// (files, terminal, web, MCP, delegation) are offered by both harnesses.
const GROUP_FEATURE: Partial<Record<(typeof TOOL_GROUPS)[number][0], keyof HarnessFeatures>> = { memory: 'memory', skills: 'skills', recall: 'sessionRecall', desktop: 'desktop', mcp: 'mcp' };
export const FEATURE_LABELS: Array<[keyof HarnessFeatures, string]> = [['memory', 'Durable memory'], ['skills', 'Skills'], ['sessionRecall', 'Session recall'], ['scheduling', 'Routines'], ['desktop', 'Private desktop'], ['mcp', 'MCP connections'], ['approvals', 'Approvals'], ['steer', 'Steer a running task'], ['clarify', 'Clarifying questions']];
export function groupSupported(group: string, harness: HarnessInfo) { const feature = GROUP_FEATURE[group as keyof typeof GROUP_FEATURE]; return !feature || harness.features[feature]; }
// Tool ids known before any catalog loads, so the review is right on a fresh editor too.
const KNOWN_GROUPS: Record<string, string> = { memory: 'memory', skills_list: 'skills', skill_view: 'skills', skill_manage: 'skills', session_search: 'recall', computer_use: 'desktop' };
export function toolGroup(id: string, catalog: ToolInfo[]) { return catalog.find(tool => tool.id === id)?.group || KNOWN_GROUPS[id] || (id.startsWith('mcp__') ? 'mcp' : 'other'); }

export type SwitchReview = { tools: string[]; provider: string | null; lostFeatures: string[]; keptData: boolean };
// What changes for this agent if it moves to `next`. Nothing here is applied silently: the
// tools are only switched off when the user saves, and switching back does not re-enable them.
export function reviewSwitch(profile: HarnessProfile, provider: string, next: HarnessInfo, current: HarnessInfo, catalog: ToolInfo[]): SwitchReview {
  const tools = profile.allowedTools.filter(id => !groupSupported(toolGroup(id, catalog), next));
  const providerFits = !next.providers.length || next.providers.includes(provider);
  const lostFeatures = FEATURE_LABELS.filter(([key]) => current.features[key] && !next.features[key]).map(([, label]) => label);
  return { tools, provider: providerFits ? null : provider === CODEX_PROVIDER ? 'Codex (ChatGPT sign-in)' : provider, lostFeatures, keptData: current.features.memory && !next.features.memory };
}
export function applySwitch<T extends HarnessProfile>(profile: T, kind: HarnessKind, review: SwitchReview): T {
  return { ...profile, harness: { kind }, allowedTools: profile.allowedTools.filter(id => !review.tools.includes(id)) };
}
