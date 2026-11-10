import type { ActionState } from './product';

export type AssistantArtifact = { label: string; kind: 'file' | 'link'; path?: string; url?: string };
export type AssistantSource = { label: string; url: string };
export type AssistantResultReport = {
  runId: string; title: string; summary: string; artifacts: AssistantArtifact[]; sources: AssistantSource[]; updatedAt: string;
};
export type AssistantOutcome = {
  runId: string; title: string; summary: string; state: string; agentId: string; parentRunId: string | null; sourceRunId: string | null;
  createdAt: string; updatedAt: string;
  artifacts: AssistantArtifact[]; sources: AssistantSource[];
  verification: { state: 'unreviewed' | 'accepted' | 'needs_changes'; evidence: string; checkedAt: string | null };
  actions: Array<{ id: string; summary: string; state: ActionState; evidence: string }>;
  delegation: Array<{ runId: string; agentId: string; parentRunId: string | null; fromAgentId: string; state: string; summary: string }>;
};
