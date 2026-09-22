import type { AgentProfile } from "./agent-profile";
import type { Team } from "./team";
export type Agent = {
  profile?: AgentProfile;
  id: string;
  name: string;
  role: string;
  description: string;
  instructions: string;
  tone: number;
  memory: string[];
};
export type Artifact = {
  id: string;
  name: string;
  content: string;
  agentId: string;
  updatedAt: string;
  encoding?: "utf8" | "base64";
  mimeType?: string;
};
export type Activity = {
  id: string;
  name: string;
  detail: string;
  status: "running" | "done" | "error";
};
export type Message = {
  id: string;
  runId?: string;
  eventCursor?: number;
  role: "user" | "assistant";
  content: string;
  activities?: Activity[];
  error?: boolean;
};
export type Conversation = {
  id: string;
  agentId: string;
  title: string;
  messages: Message[];
  updatedAt: string;
};
export type Workspace = {
  version: 2;
  agents: Agent[];
  teams: Team[];
  files: Artifact[];
  conversations: Conversation[];
};
export type RunEvent =
  | { type: "text"; text: string }
  | { type: "activity"; activity: Activity }
  | { type: "file"; file: Artifact }
  | { type: "memory"; memory: string[] }
  | { type: "done" }
  | { type: "error"; message: string };
export const initialWorkspace: Workspace = {
  version: 2,
  teams: [],
  files: [],
  conversations: [],
  agents: [
    {
      id: "atlas",
      name: "Atlas",
      role: "The all-rounder",
      description:
        "Turn a messy idea into a clear plan, useful files, and a finished task.",
      instructions:
        "You are Atlas, a practical generalist. Take ownership of the requested outcome. Make reasonable assumptions, use tools to create useful deliverables, and keep the user informed. Be clear and direct.",
      tone: 0,
      memory: [],
    },
    {
      id: "scout",
      name: "Scout",
      role: "The researcher",
      description:
        "Find the signal in your source material. Compare, analyze, and make sense of it.",
      instructions:
        "You are Scout, a careful research analyst. Use web, browser, terminal, and file tools when they improve the result. Separate evidence from inference, cite sources, identify gaps, and save useful research artifacts in the shared workspace.",
      tone: 1,
      memory: [],
    },
    {
      id: "scribe",
      name: "Scribe",
      role: "The wordsmith",
      description:
        "Find the right words. Draft, sharpen, and make every sentence count.",
      instructions:
        "You are Scribe, a thoughtful writer and editor. Match the audience and desired voice. Use concrete language, remove filler, and save completed drafts as Markdown files.",
      tone: 2,
      memory: [],
    },
  ],
};
