export type GroupChat = { id: string; teamId: string; title: string; memberAgentIds: string[]; createdAt: string; updatedAt: string };
export type GroupMessage = { id: string; groupId: string; authorAgentId: string | null; text: string; createdAt: string; runId: string | null; state?: string; recipientAgentIds: string[] };
export const GROUP_CHAT_TOOL = 'mcp__open_harness__group_chat';
