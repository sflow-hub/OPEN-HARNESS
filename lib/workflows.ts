export type WorkflowSchedule =
  | { kind: "interval"; minutes: number }
  | { kind: "calendar"; timezone: string; weekdays: number[]; time: string }
  | { kind: "webhook" };

export type WorkflowTest = {
  runId: string; revision: number; state: string; result: string | null; error: string | null;
  verdict: "pending" | "passed" | "failed"; evidence: string; createdAt: string; reviewedAt: string | null;
};
export type Workflow = {
  id: string; agentId: string; sourceRunId: string; source: "run" | "demonstration"; name: string; instructions: string; successCriteria: string;
  revision: number; reviewedRevision: number | null; publishedRevision: number | null; createdAt: string; updatedAt: string;
  tests: WorkflowTest[];
  routine: null | {
    schedule: WorkflowSchedule; revision: number; enabled: boolean; nextRunAt: string | null; lastRunAt: string | null;
    manualOverride: string | null; webhookConfigured: boolean; lastError: string | null;
  };
  history: Array<{ runId: string; revision: number; trigger: string; createdAt: string; state: string }>;
};
export type WorkflowSnapshot = { workflows: Workflow[] };
