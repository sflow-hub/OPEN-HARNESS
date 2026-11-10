export const CODEX_PROVIDER = 'openai-codex';
export const CODEX_LABEL = 'Codex (ChatGPT OAuth)';
export type CodexAuthStatus = { state: 'waiting' | 'exchanging' | 'connected' | 'error'; credentialRef?: string; message?: string };
export type CodexAuthStart = { id: string; authorizationUrl: string; callbackUrl: string; expiresAt: number };
// OAuth sessions belong to the coordinator, never an agent's environment or MCP process.
export function isCodexSession(value: string) { return value.startsWith('{"kind":"open-harness-codex-oauth",'); }
