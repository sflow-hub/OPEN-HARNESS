import type { PersistentRun } from "./control-client";

export type WorkflowCategory = "backlog" | "ready" | "in_progress" | "review" | "done";
export type TaskPriority = "low" | "normal" | "high" | "urgent";

export type TaskStage = {
  id: string;
  boardId: string;
  name: string;
  category: WorkflowCategory;
  position: number;
};

export type TaskBoardSettings = {
  runStageId: string;
  doneStageId: string;
  autoRunOnDrop: boolean;
  allowAgentDispatch: boolean;
};

export type TaskBoard = {
  id: string;
  name: string;
  archived: boolean;
  revision: number;
  stages: TaskStage[];
  settings: TaskBoardSettings;
  createdAt: string;
  updatedAt: string;
};

export type ChecklistItem = { id: string; text: string; done: boolean; position: number };
export type TaskComment = { id: string; body: string; author: string; createdAt: string };
export type TaskActivity = { id: string; type: string; detail: string; createdAt: string };
export type TaskRun = PersistentRun & { attempt: number; startedAt: string; output: string; stopReason: string | null };

export type AgentTask = {
  id: string;
  boardId: string;
  stageId: string;
  title: string;
  description: string;
  ownerAgentId: string | null;
  collaboratorAgentIds: string[];
  priority: TaskPriority;
  labels: string[];
  dueAt: string | null;
  position: number;
  archived: boolean;
  revision: number;
  activeRunId: string | null;
  runState: PersistentRun["state"] | null;
  checklist: ChecklistItem[];
  comments: TaskComment[];
  activity: TaskActivity[];
  runs: TaskRun[];
  createdAt: string;
  updatedAt: string;
};

export type TaskSnapshot = { boards: TaskBoard[]; tasks: AgentTask[] };
