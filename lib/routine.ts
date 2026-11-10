import type { PersistentRun } from "./control-client";

export type ScheduleKind = "interval" | "cron";
// Columns arrive snake_case straight from the schedules table.
export type Routine = {
  id: string;
  agent_id: string;
  name: string;
  prompt: string;
  interval_minutes: number;
  timezone: string;
  enabled: boolean;
  next_run_at: string | null;
  last_run_at: string | null;
  created_at: string;
  updated_at: string;
  schedule_kind?: ScheduleKind;
  cron_expression?: string | null;
  misfire_policy?: string;
};
export type RoutineRun = {
  schedule_id: string;
  run_id: string;
  scheduled_for: string;
  state: PersistentRun["state"];
  result: string | null;
  error: string | null;
  updated_at: string;
};
export type RoutineInput = { name: string; prompt: string; agentId: string; intervalMinutes: number; timezone?: string; scheduleKind?: ScheduleKind; cronExpression?: string | null };

const text = (value: unknown) => typeof value === "string" ? value : value == null ? "" : String(value);
const optionalText = (value: unknown) => typeof value === "string" && value ? value : null;

// Older coordinators predate schedule_kind/cron_expression/misfire_policy, and SQLite hands
// back enabled as 0/1, so every row goes through here before the UI sees it.
export function normalizeRoutine(raw: unknown): Routine {
  const row = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const minutes = Number(row.interval_minutes);
  return {
    id: text(row.id), agent_id: text(row.agent_id), name: text(row.name), prompt: text(row.prompt),
    interval_minutes: Number.isFinite(minutes) && minutes > 0 ? minutes : 1440,
    timezone: text(row.timezone), enabled: Boolean(Number(row.enabled)),
    next_run_at: optionalText(row.next_run_at), last_run_at: optionalText(row.last_run_at),
    created_at: text(row.created_at), updated_at: text(row.updated_at),
    schedule_kind: row.schedule_kind === "cron" ? "cron" : "interval",
    cron_expression: optionalText(row.cron_expression),
    ...(typeof row.misfire_policy === "string" ? { misfire_policy: row.misfire_policy } : {}),
  };
}
