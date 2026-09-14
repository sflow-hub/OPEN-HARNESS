"use client";

import { useEffect, useRef, useState } from "react";
import {
  ArrowUp,
  ArrowUpRight,
  Bot,
  Check,
  ChevronRight,
  Copy,
  Download,
  FileText,
  FolderOpen,
  Menu,
  MessageSquare,
  Plus,
  Search,
  Settings,
  SlidersHorizontal,
  Sparkles,
  Square,
  Trash2,
  X,
  LoaderCircle,
  Brain,
  Paperclip,
  Play,
  Cable,
  CalendarClock,
  ShieldCheck,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  initialWorkspace,
  type Workspace,
  type Agent,
  type Artifact,
  type Conversation,
  type RunEvent,
} from "../lib/types";
import { PROVIDERS, type Provider } from "../lib/provider";
import {
  ControlClient,
  type PersistentRun,
  type RuntimeStatus,
} from "../lib/control-client";

import AgentSettings from "../components/agent-settings";
import TaskManager from "../components/task-manager";
import { profileAgent, type ModelChoice } from "../lib/agent-profile";

const STORAGE_KEY = "open-harness.workspace.v1";
const SETTINGS_KEY = "open-harness.settings.v1";
type View = "home" | "chat" | "files" | "routines" | "tasks";
type ModelSettings = { provider: Provider; model: string; maxSteps?: number; baseUrl?: string };
const defaultSettings: ModelSettings = {
  provider: "xai",
  model: PROVIDERS.xai.model,
};
const uid = () => crypto.randomUUID();
const now = () => new Date().toISOString();
function download(name: string, content: string, type = "text/plain", encoding: "utf8" | "base64" = "utf8") {
  const data = encoding === "base64" ? Uint8Array.from(atob(content), char => char.charCodeAt(0)) : content;
  const url = URL.createObjectURL(new Blob([data], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function Avatar({ agent, large = false }: { agent: Agent; large?: boolean }) {
  return (
    <div className={`avatar tone-${agent.tone % 6} ${large ? "large" : ""}`}>
      {agent.name[0]}
    </div>
  );
}
function Markdown({ children }: { children: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          img: ({ src, alt }) => (
            <a
              href={typeof src === "string" ? src : undefined}
              target="_blank"
              rel="noopener noreferrer"
            >
              {alt || "Open image"}
            </a>
          ),
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}

export default function Home() {
  const [workspace, setWorkspace] = useState<Workspace>(initialWorkspace);
  const [ready, setReady] = useState(false);
  const [view, setView] = useState<View>("home");
  const lastWorkspaceView = useRef<View>("home");
  const [selectedAgent, setSelectedAgent] = useState("atlas");
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [settings, setSettings] = useState<ModelSettings>(defaultSettings);
  const [apiKey, setApiKey] = useState("");
  const [workspaceModelRevision, setWorkspaceModelRevision] = useState(0);
  const [server, setServer] = useState({
    xai: false,
    openrouter: false,
    local: false,
    localModel: "",
  });
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [editingAgent, setEditingAgent] = useState<Agent | null>(null);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [input, setInput] = useState("");
  const [search, setSearch] = useState("");
  const [running, setRunning] = useState(false);
  const [persistentRun, setPersistentRun] = useState<PersistentRun | null>(null);
  const [runtime, setRuntime] = useState<RuntimeStatus | null>(null);
  const [approval, setApproval] = useState<{ approvalId: string; detail: string } | null>(null);
  const [inputMode, setInputMode] = useState<"steer" | "followup">("steer");
  const [routines, setRoutines] = useState<Array<Record<string, unknown>>>([]);
  const [agentContext, setAgentContext] = useState<{
    memory: string;
    user: string;
    skills: string[];
    capabilities: Record<string, boolean>;
  } | null>(null);

  const [notice, setNotice] = useState("");
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [inspector, setInspector] = useState(true);
  const abortRef = useRef<AbortController | null>(null);
  const controlRef = useRef(new ControlClient());
  const runLock = useRef(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const uploadRef = useRef<HTMLInputElement>(null);
  const importRef = useRef<HTMLInputElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const agent =
    workspace.agents.find((a) => a.id === selectedAgent) || workspace.agents[0];
  const conversation = workspace.conversations.find(
    (c) => c.id === conversationId,
  );
  const file = workspace.files.find((f) => f.id === selectedFile);
  const connected = Boolean(runtime?.runtime.available);

  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      // Hydrate browser-only persistence after the server-rendered first frame.
      if (saved) {
        const parsed = JSON.parse(saved);
        if (!validWorkspace(parsed)) throw new Error();
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setWorkspace({
          ...parsed,
          conversations: parsed.conversations.map((c) => ({
            ...c,
            messages: c.messages.map((m) => ({
              ...m,
              activities: m.activities?.map((a) =>
                a.status === "running"
                  ? {
                      ...a,
                      status: "error" as const,
                      detail:
                        "Interrupted when the page closed. Send a follow-up to continue.",
                    }
                  : a,
              ),
            })),
          })),
        });
        setSelectedAgent(parsed.agents[0].id);
      }
      const prefs = localStorage.getItem(SETTINGS_KEY);
      if (prefs) {
        const p = JSON.parse(prefs);
        if (Object.hasOwn(PROVIDERS, p.provider) && typeof p.model === "string")
          setSettings({ ...defaultSettings, ...p });
      }
    } catch {
      setNotice(
        "Saved data could not be loaded. Import a workspace backup or start fresh.",
      );
    }
    setReady(true);
    fetch("/api/status")
      .then((r) => r.json())
      .then((data) => setServer(data as typeof server))
      .catch(() =>
        setNotice(
          "Could not reach the model server. You can still explore your workspace.",
        ),
      );
  }, []);
  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    const connect = async () => {
      try {
        const client = controlRef.current;
        const status = await client.bootstrap();
        if (cancelled) return;
        setRuntime(status);
        const synced = await client.request<{ agents: Agent[] }>("/v1/agents/sync", {
          method: "POST",
          body: JSON.stringify({ agents: workspace.agents }),
        });
        await client.request("/v1/migrate", {
          method: "POST",
          body: JSON.stringify(workspace),
        });
        if (!cancelled) {
          setWorkspace(current => ({ ...current, agents: synced.agents.map(agent => ({ ...agent, memory: current.agents.find(a => a.id === agent.id)?.memory || [] })) }));
          const defaults = await client.request<{ model: ModelChoice; revision: number }>("/v1/workspace/model/import", {
            method: "POST",
            body: JSON.stringify({ model: { provider: settings.provider, model: settings.model, baseUrl: settings.baseUrl || "", credentialRef: ({ xai: "XAI_API_KEY", openrouter: "OPENROUTER_API_KEY" } as Record<string, string>)[settings.provider] || "" } }),
          });
          setSettings({ provider: defaults.model.provider as Provider, model: defaults.model.model, baseUrl: defaults.model.baseUrl });
          setWorkspaceModelRevision(defaults.revision);
        }
        const [{ routines: savedRoutines }, { runs }] = await Promise.all([
          client.request<{ routines: Array<Record<string, unknown>> }>(
            "/v1/routines",
          ),
          client.request<{ runs: PersistentRun[] }>("/v1/runs"),
        ]);
        if (!cancelled) {
          setRoutines(savedRoutines);
          const live = runs.find((run) =>
            ["queued", "running", "waiting_approval", "waiting_input"].includes(
              run.state,
            ),
          );
          if (live) {
            const existing = workspace.conversations.find(
              (item) => item.id === live.conversation_id,
            );
            const existingMessage = existing?.messages.find(
              (message) => message.runId === live.id,
            );
            const messageId = existingMessage?.id || uid();
            if (!existing) {
              setWorkspace((current) => ({
                ...current,
                conversations: [
                  {
                    id: live.conversation_id,
                    agentId: live.agent_id,
                    title: live.prompt.slice(0, 52),
                    updatedAt: now(),
                    messages: [
                      { id: uid(), role: "user", content: live.prompt },
                      {
                        id: messageId,
                        runId: live.id,
                        role: "assistant",
                        content: "",
                        activities: [],
                      },
                    ],
                  },
                  ...current.conversations,
                ],
              }));
            } else if (!existingMessage) {
              updateConversation(existing.id, (current) => ({
                ...current,
                messages: [
                  ...current.messages,
                  {
                    id: messageId,
                    runId: live.id,
                    role: "assistant",
                    content: "",
                    activities: [],
                  },
                ],
              }));
            }
            setSelectedAgent(live.agent_id);
            setConversationId(live.conversation_id);
            setView("chat");
            setPersistentRun(live);
            setRunning(true);
            runLock.current = true;
            void followRun(
              live,
              live.conversation_id,
              messageId,
              live.agent_id,
              existingMessage?.eventCursor || 0,
              Boolean(existingMessage?.content),
            ).finally(() => {
              runLock.current = false;
              setRunning(false);
              setPersistentRun(null);
            });
          }
        }
      } catch (error) {
        if (!cancelled)
          setNotice(
            error instanceof Error
              ? `${error.message} Run npm run harness:doctor, then npm run dev.`
              : "The local agent runtime is unavailable.",
          );
      }
    };
    void connect();
    return () => {
      cancelled = true;
    };
    // The one-time migration intentionally snapshots the hydrated browser workspace.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);
  useEffect(() => {
    if (!runtime || !selectedAgent) return;
    let cancelled = false;
    controlRef.current
      .request<{
        memory: string;
        user: string;
        skills: string[];
        capabilities: Record<string, boolean>;
      }>(`/v1/agents/${encodeURIComponent(selectedAgent)}/context`)
      .then((value) => {
        if (!cancelled) setAgentContext(value);
      })
      .catch(() => {
        if (!cancelled) setAgentContext(null);
      });
    return () => {
      cancelled = true;
    };
  }, [runtime, selectedAgent]);
  // Surface storage failures from the external persistence operation.
  useEffect(() => {
    if (ready) {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(workspace));
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
      } catch {
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setNotice(
          "Browser storage is full or unavailable. Export a backup now to keep your work.",
        );
      }
    }
  }, [workspace, settings, ready]);
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [conversation?.messages]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === "k") {
        event.preventDefault();
        setMobileOpen(true);
        searchRef.current?.focus();
      }
      if (event.key === "Escape") {
        setSettingsOpen(false);
        setSelectedFile(null);
        setMobileOpen(false);
      }
    };
    const beforeLeave = (e: BeforeUnloadEvent) => {
      if (runLock.current) e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("beforeunload", beforeLeave);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("beforeunload", beforeLeave);
    };
  }, []);
  useEffect(() => {
    if (notice) {
      const timeout = setTimeout(() => setNotice(""), 6500);
      return () => clearTimeout(timeout);
    }
  }, [notice]);

  useEffect(() => {
    if (!settingsOpen && !editingAgent && !selectedFile) return;
    const prior = document.activeElement as HTMLElement | null;
    const trap = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const dialog = document.querySelector("[role=dialog]");
      const items = Array.from(
        dialog?.querySelectorAll<HTMLElement>(
          "button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href]",
        ) || [],
      );
      if (!items.length) return;
      const first = items[0],
        last = items[items.length - 1];
      if (
        event.shiftKey &&
        (document.activeElement === first ||
          !dialog?.contains(document.activeElement))
      ) {
        event.preventDefault();
        last.focus();
      } else if (
        !event.shiftKey &&
        (document.activeElement === last ||
          !dialog?.contains(document.activeElement))
      ) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", trap);
    return () => {
      document.removeEventListener("keydown", trap);
      prior?.focus();
    };
  }, [settingsOpen, editingAgent, selectedFile]);

  function openAgent(id: string, fresh = false) {
    setSelectedAgent(id);
    setView("chat");
    setMobileOpen(false);
    setInput("");
    setConversationId(
      fresh
        ? null
        : workspace.conversations.find((c) => c.agentId === id)?.id || null,
    );
  }
  function openTaskRun(run: PersistentRun, title: string) {
    const existing = workspace.conversations.find(item => item.id === run.conversation_id);
    const existingReply = existing?.messages.find(message => message.runId === run.id);
    const messageId = existingReply?.id || uid();
    if (!existing) {
      setWorkspace(current => ({
        ...current,
        conversations: [{
          id: run.conversation_id,
          agentId: run.agent_id,
          title,
          updatedAt: now(),
          messages: [
            { id: uid(), role: "user", content: run.prompt },
            { id: messageId, runId: run.id, role: "assistant", content: run.result || run.error || "", error: Boolean(run.error), activities: [] },
          ],
        }, ...current.conversations],
      }));
    }
    setSelectedAgent(run.agent_id);
    setConversationId(run.conversation_id);
    setView("chat");
    if (!runLock.current && ["queued", "running", "waiting_approval", "waiting_input"].includes(run.state)) {
      runLock.current = true;
      setRunning(true);
      setPersistentRun(run);
      void followRun(run, run.conversation_id, messageId, run.agent_id, existingReply?.eventCursor || 0, Boolean(existingReply?.content)).finally(() => {
        runLock.current = false;
        setRunning(false);
        setPersistentRun(null);
      });
    }
  }
  function newAgent() {
    setEditingAgent({
      id: uid(),
      name: "",
      role: "",
      description: "",
      instructions: "",
      memory: [],
      tone: workspace.agents.length % 3,
    });
  }
  function updateConversation(
    id: string,
    update: (c: Conversation) => Conversation,
  ) {
    setWorkspace((w) => ({
      ...w,
      conversations: w.conversations.map((c) => (c.id === id ? update(c) : c)),
    }));
  }
  function handleEvent(
    event: RunEvent,
    cid: string,
    mid: string,
    agentId: string,
  ) {
    if (event.type === "file")
      setWorkspace((w) => ({
        ...w,
        files: [...w.files.filter((f) => f.id !== event.file.id), event.file],
      }));
    else if (event.type === "memory")
      setWorkspace((w) => ({
        ...w,
        agents: w.agents.map((a) =>
          a.id === agentId ? { ...a, memory: event.memory } : a,
        ),
      }));
    else if (
      event.type === "text" ||
      event.type === "activity" ||
      event.type === "error"
    )
      updateConversation(cid, (c) => ({
        ...c,
        messages: c.messages.map((m) =>
          m.id !== mid
            ? m
            : event.type === "text"
              ? { ...m, content: m.content + event.text }
              : event.type === "error"
                ? {
                    ...m,
                    content: m.content + `\n\n${event.message}`,
                    error: true,
                    activities: m.activities?.map((a) =>
                      a.status === "running" ? { ...a, status: "error" } : a,
                    ),
                  }
                : {
                    ...m,
                    activities: [
                      ...(m.activities || []).filter(
                        (a) => a.id !== event.activity.id,
                      ),
                      event.activity,
                    ],
                  },
        ),
      }));
  }
  async function refreshRuntimeFiles() {
    if (!runtime) return;
    const result = await controlRef.current.request<{
      files: Array<{ name: string; size: number; updatedAt: string; encoding: "utf8" | "base64"; mimeType: string }>;
    }>("/v1/files?scope=shared");
    const loaded: Artifact[] = [];
    for (const meta of result.files.slice(0, 40)) {
      if (meta.size > 1_000_000) continue;
      const record = await controlRef.current.request<{
        name: string;
        content: string;
        encoding: "utf8" | "base64";
        mimeType: string;
      }>(`/v1/files?scope=shared&name=${encodeURIComponent(meta.name)}`);
      const existing = workspace.files.find((item) => item.name === meta.name);
      loaded.push({
        id: existing?.id || uid(),
        name: meta.name,
        content: record.encoding === "base64" ? record.content : record.content.slice(0, 100_000),
        agentId: existing?.agentId || "runtime",
        updatedAt: meta.updatedAt,
        encoding: record.encoding,
        mimeType: record.mimeType,
      });
    }
    setWorkspace((current) => ({ ...current, files: loaded }));
  }
  async function followRun(
    run: PersistentRun,
    cid: string,
    mid: string,
    agentId: string,
    startCursor = 0,
    hasExistingText = false,
  ) {
    let cursor = startCursor;
    let receivedStreamText = hasExistingText;
    while (true) {
      const snapshot = await controlRef.current.events(run.id, cursor);
      setPersistentRun(snapshot.run);
      for (const item of snapshot.events) {
        cursor = Math.max(cursor, item.seq);
        const payload = item.payload || {};
        if (item.type === "message.delta") {
          const text = String(payload.text || payload.delta || payload.content || "");
          if (text) { receivedStreamText = true; handleEvent({ type: "text", text }, cid, mid, agentId); }
        } else if (item.type === "message.complete") {
          const text = String(payload.text || payload.content || "");
          if (text && !receivedStreamText) {
            receivedStreamText = true;
            handleEvent({ type: "text", text }, cid, mid, agentId);
          }
        } else if (
          item.type === "tool.start" ||
          item.type === "tool.generating" ||
          item.type === "tool.progress"
        ) {
          handleEvent(
            {
              type: "activity",
              activity: {
                id: String(payload.tool_call_id || payload.id || item.id),
                name: String(payload.name || payload.tool || "Hermes tool"),
                detail: String(payload.preview || payload.detail || "Running…"),
                status: "running",
              },
            },
            cid,
            mid,
            agentId,
          );
        } else if (item.type === "tool.complete") {
          handleEvent(
            {
              type: "activity",
              activity: {
                id: String(payload.tool_call_id || payload.id || item.id),
                name: String(payload.name || payload.tool || "Hermes tool"),
                detail: String(payload.result || payload.preview || "Complete"),
                status: payload.error ? "error" : "done",
              },
            },
            cid,
            mid,
            agentId,
          );
        } else if (item.type === "approval.request") {
          setApproval({
            approvalId: String(payload.approvalId),
            detail: String(
              payload.command || payload.description || "Hermes requests approval.",
            ),
          });
        } else if (item.type === "run.failed" || item.type === "run.interrupted") {
          handleEvent(
            { type: "error", message: String(payload.error || "Run interrupted.") },
            cid,
            mid,
            agentId,
          );
        } else if (item.type === "run.completed" && payload.result && !receivedStreamText) {
          receivedStreamText = true;
          handleEvent(
            { type: "text", text: String(payload.result) },
            cid,
            mid,
            agentId,
          );
        }
      }
      if (snapshot.events.length) {
        updateConversation(cid, current => ({
          ...current,
          messages: current.messages.map(message =>
            message.id === mid ? { ...message, eventCursor: cursor } : message),
        }));
      }
      if (["completed", "failed", "interrupted", "cancelled"].includes(snapshot.run.state)) {
        await refreshRuntimeFiles().catch(() => {});
        return snapshot.run;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  async function send(text = input, guided = false) {
    if (!text.trim() || !ready) return;
    if (running && !guided && persistentRun) {
      try {
        if (inputMode === "steer") {
          await controlRef.current.request(`/v1/runs/${persistentRun.id}/steer`, {
            method: "POST",
            body: JSON.stringify({ text: text.trim() }),
          });
          setNotice("Guidance queued for the next tool boundary.");
        } else {
          await controlRef.current.createRun({
            agentId: agent.id,
            conversationId: conversationId || undefined,
            prompt: text.trim(),
          });
          setNotice("Follow-up queued behind the current task.");
        }
        setInput("");
      } catch (error) {
        setNotice(error instanceof Error ? error.message : "Could not send guidance.");
      }
      return;
    }
    if (runLock.current) return;
    if (!guided && !connected) {
      setNotice(
        runtime?.runtime.message ||
          "Start the local Hermes runtime before sending a task.",
      );
      return;
    }
    runLock.current = true;
    setRunning(true);
    setInput("");
    const cid = conversationId || uid();
    const mid = uid();
    const agentId = agent.id;
    const userMessage = {
      id: uid(),
      role: "user" as const,
      content: text.trim(),
    };
    const messages = [...(conversation?.messages || []), userMessage];
    if (!conversationId) {
      setWorkspace((w) => ({
        ...w,
        conversations: [
          {
            id: cid,
            agentId,
            title: text.trim().slice(0, 52),
            messages: [
              ...messages,
              { id: mid, role: "assistant", content: "", activities: [] },
            ],
            updatedAt: now(),
          },
          ...w.conversations,
        ],
      }));
      setConversationId(cid);
    } else
      updateConversation(cid, (c) => ({
        ...c,
        messages: [
          ...messages,
          { id: mid, role: "assistant", content: "", activities: [] },
        ],
        updatedAt: now(),
      }));
    const controller = new AbortController();
    abortRef.current = controller;
    const emit = (event: RunEvent) => handleEvent(event, cid, mid, agentId);
    try {
      if (guided) {
        const wait = async () => {
          await new Promise((r) => setTimeout(r, 450));
          controller.signal.throwIfAborted();
        };
        emit({
          type: "text",
          text: "This is a **guided run**, using a fixed example without a model call. I’ll create a real file in your workspace so you can try the full handoff.\n\n",
        });
        const activityId = uid();
        emit({
          type: "activity",
          activity: {
            id: activityId,
            name: "write_file",
            detail: "Creating your first deliverable…",
            status: "running",
          },
        });
        await wait();
        const existing = workspace.files.find(
          (f) => f.name === "first-handoff.md",
        );
        emit({
          type: "file",
          file: {
            id: existing?.id || uid(),
            name: "first-handoff.md",
            agentId,
            updatedAt: now(),
            content:
              "# Your first handoff\n\n## A useful first task\nGive your agent a clear outcome and the relevant source material.\n\nExample: “Read my notes and turn them into a one-page project brief. Save the result as project-brief.md.”\n\n## Make the agent yours\n1. Edit its name, role, and instructions.\n2. Connect an xAI, OpenRouter, or local model in Settings.\n3. Attach a text or Markdown file for context.\n4. Send a task and watch the tool activity.\n5. Download the result from Files.\n\n## What persists\nAgent profiles, runs, memories, skills, and shared files persist in the local control service. Closing this page does not stop a task. Credentials are stored only on the server with restricted permissions and are excluded from normal exports. Use Agent settings to choose each agent’s model, instructions, and tools.\n\nThis file was created by the guided example. No AI model was called.\n",
          },
        });
        emit({
          type: "activity",
          activity: {
            id: activityId,
            name: "write_file",
            detail: "Saved first-handoff.md",
            status: "done",
          },
        });
        await wait();
        emit({
          type: "text",
          text: "**Your first file is ready.** Open `first-handoff.md` in the workspace panel, or find it in **Files**.\n\nTo run your own task, connect a model in **Settings**. You can also edit my instructions with the settings button above.",
        });
      } else {
        const run = await controlRef.current.createRun({
          agentId,
          conversationId: cid,
          prompt: text.trim(),
        });
        setPersistentRun(run);
        updateConversation(cid, (c) => ({
          ...c,
          messages: c.messages.map((message) =>
            message.id === mid ? { ...message, runId: run.id } : message,
          ),
        }));
        await followRun(run, cid, mid, agentId);
      }
    } catch (error) {
      emit({
        type: "error",
        message: controller.signal.aborted
          ? "Stopped. Your completed work is saved."
          : error instanceof Error
            ? error.message
            : "Something went wrong.",
      });
    } finally {
      runLock.current = false;
      setRunning(false);
      setPersistentRun(null);
      abortRef.current = null;
    }
  }
  async function upload(files: FileList | null) {
    if (!files) return;
    const additions: Artifact[] = [];
    for (const f of Array.from(files)) {
      if (
        !/\.(txt|md|csv|json|html|css|js|ts|tsx|py|yaml|yml|xml|log)$/i.test(
          f.name,
        ) ||
        f.size > 100000
      ) {
        setNotice(
          "Upload text, Markdown, code, JSON, or CSV files up to 100 KB each.",
        );
        continue;
      }
      if (
        !/^[a-zA-Z0-9][a-zA-Z0-9._ -]*$/.test(f.name) ||
        f.name.includes("..")
      ) {
        setNotice(
          "Use filenames with letters, numbers, spaces, dots, dashes, or underscores.",
        );
        continue;
      }
      additions.push({
        id: uid(),
        name: f.name,
        content: await f.text(),
        agentId: "user",
        updatedAt: now(),
      });
    }
    setWorkspace((w) => {
      const merged = [...w.files];
      for (const f of additions) {
        if (merged.some((old) => old.name === f.name)) {
          setNotice(
            `A file named ${f.name} already exists. Rename the upload first.`,
          );
          continue;
        }
        if (merged.length >= 40) {
          setNotice("Workspace limit reached: 40 files.");
          break;
        }
        merged.push(f);
      }
      return { ...w, files: merged };
    });
    if (runtime)
      for (const file of additions)
        void controlRef.current
          .request("/v1/files?scope=shared", {
            method: "POST",
            body: JSON.stringify({ name: file.name, content: file.content }),
          })
          .catch((error) =>
            setNotice(error instanceof Error ? error.message : "Upload failed."),
          );
    if (uploadRef.current) uploadRef.current.value = "";
  }
  async function importWorkspace(upload: File | undefined) {
    if (!upload) return;
    try {
      if (upload.size > 5000000) throw new Error();
      const parsed = JSON.parse(await upload.text());
      if (!validWorkspace(parsed)) throw new Error();
      if (
        confirm(
          "Replace this browser’s workspace with this backup? Export your current workspace first if you want to keep it.",
        )
      ) {
        setWorkspace({
          ...parsed,
          conversations: parsed.conversations.map((c) => ({
            ...c,
            messages: c.messages.map((m) => ({
              ...m,
              activities: m.activities?.map((a) =>
                a.status === "running"
                  ? {
                      ...a,
                      status: "error" as const,
                      detail:
                        "Interrupted when the page closed. Send a follow-up to continue.",
                    }
                  : a,
              ),
            })),
          })),
        });
        setSelectedAgent(parsed.agents[0].id);
        setConversationId(null);
        setView("home");
        setNotice("Workspace imported.");
      }
    } catch {
      setNotice("That file is not a valid Open Harness backup (maximum 5 MB).");
    }
    if (importRef.current) importRef.current.value = "";
  }
  const recent = workspace.conversations
    .filter(
      (c) =>
        !search ||
        c.title.toLowerCase().includes(search.toLowerCase()) ||
        c.messages.some((m) =>
          m.content.toLowerCase().includes(search.toLowerCase()),
        ),
    )
    .slice(0, 12);

  return (
    <div className="app-shell">
      {mobileOpen && (
        <button
          className="mobile-overlay"
          aria-label="Close navigation"
          onClick={() => setMobileOpen(false)}
        />
      )}
      <aside className={`sidebar ${mobileOpen ? "open" : ""}`}>
        <button
          className="brand"
          onClick={() => {
            setView("home");
            setMobileOpen(false);
          }}
        >
          <span className="brand-mark">h</span> open harness{" "}
          <span className="version">/ 01</span>
        </button>
        <button className="new-button" onClick={newAgent} disabled={running}>
          <Plus size={15} /> New agent
        </button>
        <div className="search-box">
          <Search size={13} />
          <input
            ref={searchRef}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search conversations"
            aria-label="Search conversations"
          />
          <kbd>⌘ K</kbd>
        </div>
        <div className="nav-label">WORKSPACE</div>
        <button
          className={`nav-item ${view === "home" ? "active" : ""}`}
          onClick={() => {
            setView("home");
            setMobileOpen(false);
          }}
        >
          <Bot size={16} /> Agents <span>{workspace.agents.length}</span>
        </button>
        <button
          className={`nav-item ${view === "files" ? "active" : ""}`}
          onClick={() => {
            setView("files");
            setMobileOpen(false);
          }}
        >
          <FolderOpen size={16} /> Files{" "}
          <span>{workspace.files.length || ""}</span>
        </button>
        <button
          className={`nav-item ${view === "routines" ? "active" : ""}`}
          onClick={() => {
            setView("routines");
            setMobileOpen(false);
          }}
        >
          <CalendarClock size={16} /> Routines <span>{routines.length || ""}</span>
        </button>
        <div className="nav-label">YOUR AGENTS</div>
        <div className="sidebar-scroll">
          {workspace.agents
            .filter(
              (a) =>
                !search ||
                (a.name + a.role).toLowerCase().includes(search.toLowerCase()),
            )
            .map((a) => (
              <button
                className={`agent-row ${view === "chat" && a.id === selectedAgent ? "selected" : ""}`}
                key={a.id}
                onClick={() => openAgent(a.id)}
                disabled={running && a.id !== selectedAgent}
              >
                <Avatar agent={a} />
                <div>
                  <strong>{a.name}</strong>
                  <small>{a.role}</small>
                </div>
                {running && a.id === selectedAgent && (
                  <LoaderCircle className="spin" size={12} />
                )}
              </button>
            ))}
          {recent.length > 0 && (
            <>
              <div className="nav-label">
                {search ? "SEARCH RESULTS" : "RECENT CONVERSATIONS"}
              </div>
              {recent.map((c) => (
                <button
                  disabled={running}
                  className={`recent ${c.id === conversationId && view === "chat" ? "selected" : ""}`}
                  key={c.id}
                  onClick={() => {
                    setSelectedAgent(c.agentId);
                    setConversationId(c.id);
                    setView("chat");
                    setMobileOpen(false);
                  }}
                >
                  <MessageSquare size={12} />
                  <span>{c.title}</span>
                </button>
              ))}
            </>
          )}
          {search && !recent.length && (
            <p className="muted small">No matching conversations.</p>
          )}
        </div>
        <div className="sidebar-bottom">
          <span className="status-dot" />
          {connected ? "Model configured" : "Connect a model to begin"}
          <button onClick={() => setSettingsOpen(true)}>
            <Settings size={15} /> Settings <span>↗</span>
          </button>
          <div className="local-note">Saved on this device</div>
        </div>
      </aside>
      <main className="main">
        <header>
          <button
            className="mobile-menu"
            aria-label="Open navigation"
            onClick={() => setMobileOpen(true)}
          >
            <Menu size={20} />
          </button>
          <span>
            Workspace{" "}
            <span className="breadcrumb">
              /{" "}
              {view === "home"
                ? "Agents"
                : view === "files"
                  ? "Files"
                  : view === "routines"
                    ? "Routines"
                    : view === "tasks"
                      ? "Tasks"
                      : agent.name}
            </span>
          </span>
          <nav className="top-tabs" aria-label="Main workspace">
            <button className={view !== "tasks" ? "active" : ""} onClick={() => { if (view === "tasks") setView(lastWorkspaceView.current); }}>Workspace</button>
            <button className={view === "tasks" ? "active" : ""} onClick={() => { if (view !== "tasks") lastWorkspaceView.current = view; setView("tasks"); }}>Tasks</button>
          </nav>
          <span className="badge">Open source · Yours to shape</span>
        </header>
        {view === "tasks" && <TaskManager agents={workspace.agents} client={controlRef.current} onOpenRun={openTaskRun} />}
        {view === "home" && (
          <section className="home-content">
            <div className="eyebrow">YOUR PERSONAL AGENT WORKSPACE</div>
            <h1>
              A little direction.
              <br />
              <span>A lot done.</span>
            </h1>
            <p className="intro">
              Give your agents a job. They keep the context,
              <br />
              use their tools, and bring the work back to you.
            </p>
            <div className="section-heading">
              <h2>
                Your agents{" "}
                <span>{String(workspace.agents.length).padStart(2, "0")}</span>
              </h2>
              <button onClick={newAgent} disabled={running}>
                <Plus size={13} /> Create agent
              </button>
            </div>
            <div className="agent-grid">
              {workspace.agents.map((a) => (
                <div className="agent-card-shell" key={a.id}>
                <button
                  className="agent-card"
                  onClick={() => openAgent(a.id)}
                  disabled={running && a.id !== selectedAgent}
                >
                  <Avatar agent={a} large />
                  <ArrowUpRight className="card-arrow" size={17} />
                  <h3>{a.name}</h3>
                  <div className="role">{a.role}</div>
                  <p>
                    {a.description ||
                      "Your custom agent. Give it a task and make it your own."}
                  </p>
                  <div className="card-footer">
                    <span className="status-dot" />
                    {running && a.id === selectedAgent
                      ? "Working on your task"
                      : "Ready when you are"}
                    <span>→</span>
                  </div>
                </button>
                <button className="agent-card-settings" onClick={() => setEditingAgent({ ...a })} aria-label={`Edit ${a.name} profile`} title="Agent settings"><SlidersHorizontal size={16} /></button>
                </div>
              ))}
            </div>
            <div className="start-panel">
              <Sparkles className="spark" size={31} />
              <div>
                <h3>Start small. Make it yours.</h3>
                <p>
                  Choose an agent, give it one real task, and take it from
                  there.
                </p>
              </div>
              <button
                className="light-button"
                onClick={() => openAgent(workspace.agents[0].id)}
              >
                Meet {workspace.agents[0].name} <ArrowUpRight size={13} />
              </button>
            </div>
            <div className="home-footer">
              <span>YOUR MODELS. YOUR INSTRUCTIONS. YOUR WORK.</span>
              <button onClick={() => setSettingsOpen(true)}>
                Built to be opened up ↗
              </button>
            </div>
          </section>
        )}
        {view === "chat" && (
          <div className={`chat-layout ${inspector ? "" : "no-inspector"}`}>
            <section className="chat-main">
              <div className="chat-toolbar">
                <Avatar agent={agent} />
                <div>
                  <strong>{agent.name}</strong>
                  <small>{agent.role}</small>
                </div>
                <div className="toolbar-actions">
                  <button
                    title="New conversation"
                    aria-label="New conversation"
                    disabled={running}
                    onClick={() => openAgent(agent.id, true)}
                  >
                    <Plus size={18} />
                  </button>
                  <button
                    title="Agent settings"
                    aria-label="Agent settings"
                    onClick={() => setEditingAgent({ ...agent })}
                  >
                    <SlidersHorizontal size={17} />
                  </button>
                  <button
                    title="Toggle workspace panel"
                    aria-label="Toggle workspace panel"
                    onClick={() => setInspector(!inspector)}
                  >
                    <FolderOpen size={18} />
                  </button>
                </div>
              </div>
              <div className="transcript" aria-live="polite">
                {!conversation?.messages.length ? (
                  <div className="chat-welcome">
                    <Avatar agent={agent} large />
                    <div className="eyebrow">{agent.role}</div>
                    <h2>What are we working on?</h2>
                    <p>{agent.description}</p>
                    <div className="prompt-grid">
                      {(agent.id === "scout"
                        ? [
                            "Compare the files in my workspace",
                            "Find the gaps in my project notes",
                          ]
                        : agent.id === "scribe"
                          ? [
                              "Turn my notes into a clear first draft",
                              "Write a concise project announcement",
                            ]
                          : [
                              "Help me turn an idea into a project brief",
                              "Read my files and create an action plan",
                            ]
                      ).map((p) => (
                        <button key={p} onClick={() => setInput(p)}>
                          {p}
                          <ArrowUpRight size={14} />
                        </button>
                      ))}
                    </div>
                    <button
                      className="guided-button"
                      disabled={running}
                      onClick={() => send("Show me how a handoff works", true)}
                    >
                      <Play size={12} /> Try a guided run{" "}
                      <span>No API key needed</span>
                    </button>
                  </div>
                ) : (
                  conversation.messages.map((m) => (
                    <article className={`message ${m.role}`} key={m.id}>
                      <div className="message-heading">
                        {m.role === "assistant" ? (
                          <Avatar agent={agent} />
                        ) : (
                          <div className="user-avatar">Y</div>
                        )}
                        <strong>
                          {m.role === "assistant" ? agent.name : "You"}
                        </strong>
                        {m.role === "assistant" && m.content && (
                          <button
                            aria-label="Copy response"
                            title="Copy response"
                            onClick={() =>
                              navigator.clipboard
                                .writeText(m.content)
                                .then(() => setNotice("Response copied."))
                                .catch(() =>
                                  setNotice(
                                    "Clipboard unavailable. Select the text to copy it.",
                                  ),
                                )
                            }
                          >
                            <Copy size={12} />
                          </button>
                        )}
                      </div>
                      {m.activities && m.activities.length > 0 && (
                        <details
                          className="activity-list"
                          open={
                            running &&
                            m ===
                              conversation.messages[
                                conversation.messages.length - 1
                              ]
                          }
                        >
                          <summary>
                            <Cable size={12} />
                            {
                              m.activities.filter((a) => a.status === "done")
                                .length
                            }{" "}
                            steps completed <ChevronRight size={12} />
                          </summary>
                          {m.activities.map((a) => (
                            <div className={`activity ${a.status}`} key={a.id}>
                              {a.status === "running" ? (
                                <LoaderCircle className="spin" size={12} />
                              ) : a.status === "error" ? (
                                <X size={12} />
                              ) : (
                                <Check size={12} />
                              )}
                              <div>
                                <strong>{a.name.replaceAll("_", " ")}</strong>
                                <p>{a.detail}</p>
                              </div>
                            </div>
                          ))}
                        </details>
                      )}
                      <div className={m.error ? "message-error" : ""}>
                        <Markdown>{m.content}</Markdown>
                      </div>
                      {!m.content && running && (
                        <div className="working">
                          <LoaderCircle size={13} className="spin" />
                          Working on it…
                        </div>
                      )}
                    </article>
                  ))
                )}
                <div ref={bottomRef} />
              </div>
              <div className="composer-wrap">
                <form
                  className="composer"
                  onSubmit={(e) => {
                    e.preventDefault();
                    send();
                  }}
                >
                  <textarea
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    placeholder={`Message ${agent.name}…`}
                    aria-label={`Message ${agent.name}`}
                    maxLength={30000}
                    rows={3}
                    onKeyDown={(e) => {
                      if (
                        e.key === "Enter" &&
                        !e.shiftKey &&
                        !e.nativeEvent.isComposing
                      ) {
                        e.preventDefault();
                        send();
                      }
                    }}
                  />
                  <div className="composer-bottom">
                    <button
                      type="button"
                      aria-label="Attach text files"
                      title="Attach text files"
                      disabled={running}
                      onClick={() => uploadRef.current?.click()}
                    >
                      <Paperclip size={17} />
                    </button>
                    <button
                      type="button"
                      className="model-choice"
                      onClick={() => setSettingsOpen(true)}
                    >
                      <span className="status-dot" />
                      {connected
                        ? `Hermes ${runtime?.hermes.release}`
                        : "Start local runtime"}
                      <ChevronRight size={12} />
                    </button>
                    {running ? (
                      <>
                        <button
                          className={`run-mode ${inputMode === "steer" ? "active" : ""}`}
                          type="button"
                          onClick={() => setInputMode("steer")}
                        >
                          Steer
                        </button>
                        <button
                          className={`run-mode ${inputMode === "followup" ? "active" : ""}`}
                          type="button"
                          onClick={() => setInputMode("followup")}
                        >
                          Follow-up
                        </button>
                        <button
                          className="send-button"
                          type="submit"
                          disabled={!input.trim()}
                          aria-label={`Send ${inputMode}`}
                        >
                          <ArrowUp size={18} />
                        </button>
                        <button
                          className="send-button stop"
                          type="button"
                          aria-label="Stop run"
                          onClick={() => {
                            if (persistentRun)
                              void controlRef.current.request(
                                `/v1/runs/${persistentRun.id}/stop`,
                                { method: "POST" },
                              );
                          }}
                        >
                          <Square size={14} fill="currentColor" />
                        </button>
                        <button
                          className="run-mode"
                          type="button"
                          aria-label="Stop all runs"
                          onClick={() =>
                            void controlRef.current.request("/v1/runs/stop-all", {
                              method: "POST",
                            })
                          }
                        >
                          Stop all
                        </button>
                      </>
                    ) : (
                      <button
                        className="send-button"
                        type="submit"
                        disabled={!input.trim() || !ready}
                        aria-label="Send message"
                      >
                        <ArrowUp size={18} />
                      </button>
                    )}
                  </div>
                </form>
                <div className="composer-note">
                  {running
                    ? "This task continues if you close the browser. Send guidance or queue a follow-up."
                    : "Enter to send · Shift + Enter for a new line · Files are shared with all your agents"}
                </div>
                {approval && persistentRun && (
                  <div className="approval-banner" role="alert">
                    <ShieldCheck size={18} />
                    <div>
                      <strong>Approval required</strong>
                      <p>{approval.detail}</p>
                    </div>
                    <button
                      className="subtle-button"
                      onClick={async () => {
                        await controlRef.current.request(
                          `/v1/runs/${persistentRun.id}/approval`,
                          {
                            method: "POST",
                            body: JSON.stringify({
                              approvalId: approval.approvalId,
                              decision: "deny",
                            }),
                          },
                        );
                        setApproval(null);
                      }}
                    >
                      Deny
                    </button>
                    <button
                      className="light-button"
                      onClick={async () => {
                        await controlRef.current.request(
                          `/v1/runs/${persistentRun.id}/approval`,
                          {
                            method: "POST",
                            body: JSON.stringify({
                              approvalId: approval.approvalId,
                              decision: "approve",
                            }),
                          },
                        );
                        setApproval(null);
                      }}
                    >
                      Approve once
                    </button>
                  </div>
                )}
              </div>
            </section>
            {inspector && (
              <aside className="inspector">
                <div className="inspector-heading">
                  Agent workspace{" "}
                  <button
                    aria-label="Close workspace panel"
                    onClick={() => setInspector(false)}
                  >
                    <X size={15} />
                  </button>
                </div>
                <div className="inspector-label">
                  <FileText size={13} /> FILES{" "}
                  <span>{workspace.files.length}</span>
                </div>
                {workspace.files.length ? (
                  workspace.files.map((f) => (
                    <button
                      className="file-mini"
                      key={f.id}
                      onClick={() => setSelectedFile(f.id)}
                    >
                      <FileText size={16} />
                      <div>
                        <strong>{f.name}</strong>
                        <small>
                          {(f.content.length / 1000).toFixed(1)} KB ·{" "}
                          {f.agentId === "user" ? "Uploaded" : "Agent file"}
                        </small>
                      </div>
                      <ChevronRight size={12} />
                    </button>
                  ))
                ) : (
                  <div className="panel-empty">
                    <FolderOpen size={26} />
                    <p>A place for the finished work.</p>
                    <small>
                      Files your agent creates will appear here. Add your own
                      for context.
                    </small>
                  </div>
                )}
                <button
                  className="subtle-button"
                  disabled={running}
                  onClick={() => uploadRef.current?.click()}
                >
                  <Plus size={12} /> Add a file
                </button>
                <div className="inspector-label">
                  <Brain size={13} /> MEMORY{" "}
                  <span>{agentContext?.memory ? "HERMES" : agent.memory.length}</span>
                </div>
                {agentContext?.memory ? (
                  <>
                    <div className="memory-item">{agentContext.memory}</div>
                    <button
                      className="subtle-button"
                      onClick={async () => {
                        const memory = window.prompt(
                          `Edit ${agent.name}’s durable memory`,
                          agentContext.memory,
                        );
                        if (memory === null) return;
                        await controlRef.current.request(
                          `/v1/agents/${encodeURIComponent(agent.id)}/context`,
                          { method: "PUT", body: JSON.stringify({ memory }) },
                        );
                        setAgentContext({ ...agentContext, memory });
                      }}
                    >
                      Edit memory
                    </button>
                  </>
                ) : agent.memory.length ? (
                  agent.memory.map((m, i) => (
                    <div className="memory-item" key={i}>
                      {m}
                    </div>
                  ))
                ) : (
                  <p className="panel-help">
                    Ask {agent.name} to remember a preference. It will carry
                    into future conversations.
                  </p>
                )}
                <div className="inspector-label">
                  <Sparkles size={13} /> SKILLS{" "}
                  <span>{agentContext?.skills.length || 0}</span>
                </div>
                {agentContext?.skills.length ? (
                  <div className="tool-chips">
                    {agentContext.skills.map((skill) => (
                      <span className="skill-control" key={skill}>
                        <button onClick={() => setInput(`/${skill} `)} title={`Invoke ${skill}`}>/{skill}</button>
                        <button
                          onClick={async () => {
                            const path = `/v1/agents/${encodeURIComponent(agent.id)}/context/skills/${encodeURIComponent(skill)}`;
                            const current = await controlRef.current.request<{ content: string }>(path);
                            const content = window.prompt(`Edit ${skill}/SKILL.md`, current.content);
                            if (content !== null) await controlRef.current.request(path, { method: "PUT", body: JSON.stringify({ content }) });
                          }}
                          title={`Inspect or edit ${skill}`}
                        >Edit</button>
                        <button
                          onClick={async () => {
                            if (!window.confirm(`Remove the ${skill} skill?`)) return;
                            await controlRef.current.request(`/v1/agents/${encodeURIComponent(agent.id)}/context/skills/${encodeURIComponent(skill)}`, { method: "DELETE" });
                            setAgentContext({ ...agentContext, skills: agentContext.skills.filter(item => item !== skill) });
                          }}
                          title={`Remove ${skill}`}
                        >×</button>
                      </span>
                    ))}
                  </div>
                ) : (
                  <p className="panel-help">
                    Hermes can create and improve reusable skills as it works.
                  </p>
                )}
                <div className="inspector-label"><Cable size={13} /> PROFILE TOOLS <span>{agent.profile?.allowedTools.length || 0}</span></div>
                <p className="panel-help">{agent.profile?.allowedTools.length ? `${agent.profile.allowedTools.length} tools selected. Open Agent settings to check availability or change access.` : "No tools selected. Choose the capabilities this agent needs."}</p>
                <button className="subtle-button" onClick={() => setEditingAgent({ ...agent })}><SlidersHorizontal size={13} /> Agent settings</button>
                <div className="scope-note">
                  {runtime?.runtime.available
                    ? "Hermes is ready in this agent’s isolated workspace. External actions still follow the approval policy."
                    : runtime?.runtime.message ||
                      "Run npm run harness:doctor to connect the local Hermes runtime."}
                </div>
              </aside>
            )}
          </div>
        )}
        {view === "files" && (
          <section className="files-page">
            <div className="eyebrow">THE WORK, ALL IN ONE PLACE</div>
            <div className="files-title">
              <div>
                <h1>Workspace files</h1>
                <p className="intro">
                  Source material and deliverables, shared across your agents.
                </p>
              </div>
              <button
                className="light-button"
                disabled={running}
                onClick={() => uploadRef.current?.click()}
              >
                <Plus size={14} /> Add files
              </button>
            </div>
            {!workspace.files.length ? (
              <div className="files-empty">
                <FolderOpen size={40} />
                <h2>Your first deliverable belongs here.</h2>
                <p>
                  Add text files for context, or ask an agent to create
                  something.
                </p>
                <button
                  className="subtle-button"
                  onClick={() => openAgent(agent.id)}
                >
                  Start a conversation <ArrowUpRight size={14} />
                </button>
              </div>
            ) : (
              <div className="file-table">
                {workspace.files.map((f) => (
                  <div className="file-table-row" key={f.id}>
                    <button
                      className="file-name"
                      onClick={() => setSelectedFile(f.id)}
                    >
                      <FileText size={20} />
                      <span>
                        {f.name}
                        <small>
                          {workspace.agents.find((a) => a.id === f.agentId)
                            ?.name || "You"}{" "}
                          · {new Date(f.updatedAt).toLocaleDateString()}
                        </small>
                      </span>
                    </button>
                    <span className="muted small">
                      {(f.content.length / 1000).toFixed(1)} KB
                    </span>
                    <button
                      aria-label={`Download ${f.name}`}
                      onClick={() => download(f.name, f.content, f.mimeType, f.encoding)}
                    >
                      <Download size={16} />
                    </button>
                    <button
                      aria-label={`Delete ${f.name}`}
                      disabled={running}
                      onClick={() => {
                        if (!confirm(`Delete ${f.name}?`)) return;
                        if (runtime)
                          void controlRef.current.request(
                            `/v1/files?scope=shared&name=${encodeURIComponent(f.name)}`,
                            { method: "DELETE" },
                          );
                        setWorkspace((w) => ({
                          ...w,
                          files: w.files.filter((x) => x.id !== f.id),
                        }));
                      }}
                    >
                      <Trash2 size={15} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </section>
        )}
        {view === "routines" && (
          <section className="files-page">
            <div className="eyebrow">BACKGROUND WORK</div>
            <div className="files-title">
              <div>
                <h1>Routines</h1>
                <p className="intro">
                  Durable tasks that run through Hermes while the browser is closed.
                </p>
              </div>
              <button
                className="light-button"
                disabled={!runtime}
                onClick={async () => {
                  const name = window.prompt("Routine name");
                  if (!name) return;
                  const task = window.prompt("What should the agent do?");
                  if (!task) return;
                  const minutes = Number(
                    window.prompt("Repeat every how many minutes?", "1440"),
                  );
                  try {
                    await controlRef.current.request("/v1/routines", {
                      method: "POST",
                      body: JSON.stringify({
                        name,
                        prompt: task,
                        agentId: agent.id,
                        intervalMinutes: Number.isFinite(minutes) ? minutes : 1440,
                        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
                      }),
                    });
                    const result = await controlRef.current.request<{
                      routines: Array<Record<string, unknown>>;
                    }>("/v1/routines");
                    setRoutines(result.routines);
                  } catch (error) {
                    setNotice(error instanceof Error ? error.message : "Could not create routine.");
                  }
                }}
              >
                <Plus size={14} /> New routine
              </button>
            </div>
            {!routines.length ? (
              <div className="files-empty">
                <CalendarClock size={40} />
                <h2>No routines yet.</h2>
                <p>Create a recurring handoff for any of your agents.</p>
              </div>
            ) : (
              <div className="file-table">
                {routines.map((routine) => (
                  <div className="file-table-row" key={String(routine.id)}>
                    <div className="file-name">
                      <CalendarClock size={20} />
                      <span>
                        {String(routine.name)}
                        <small>
                          {workspace.agents.find(
                            (item) => item.id === routine.agent_id,
                          )?.name || "Agent"}{" "}
                          · every {String(routine.interval_minutes)} minutes · next{" "}
                          {new Date(String(routine.next_run_at)).toLocaleString()}
                        </small>
                      </span>
                    </div>
                    <span className="muted small">
                      {routine.enabled ? "Enabled" : "Paused"}
                    </span>
                    <button
                      className="subtle-button"
                      onClick={async () => {
                        await controlRef.current.request(
                          `/v1/routines/${String(routine.id)}/run`,
                          { method: "POST" },
                        );
                        setNotice("Routine queued now.");
                      }}
                    >
                      Run now
                    </button>
                    <button
                      onClick={async () => {
                        await controlRef.current.request(
                          `/v1/routines/${String(routine.id)}/toggle`,
                          { method: "POST" },
                        );
                        const result = await controlRef.current.request<{
                          routines: Array<Record<string, unknown>>;
                        }>("/v1/routines");
                        setRoutines(result.routines);
                      }}
                    >
                      {routine.enabled ? "Pause" : "Enable"}
                    </button>
                  </div>
                ))}
              </div>
            )}
          </section>
        )}
      </main>
      <input
        type="file"
        hidden
        multiple
        ref={uploadRef}
        accept=".txt,.md,.csv,.json,.html,.css,.js,.ts,.tsx,.py,.yaml,.yml,.xml,.log"
        onChange={(e) => upload(e.target.files)}
      />
      <input
        type="file"
        hidden
        ref={importRef}
        accept=".json"
        onChange={(e) => importWorkspace(e.target.files?.[0])}
      />
      {notice && (
        <div className="toast" role="status">
          {notice}
          <button
            aria-label="Dismiss notification"
            onClick={() => setNotice("")}
          >
            <X size={14} />
          </button>
        </div>
      )}
      {settingsOpen && (
        <div className="modal-backdrop" onClick={() => setSettingsOpen(false)}>
          <section
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="settings-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-heading">
              <div>
                <div className="eyebrow">MAKE IT YOURS</div>
                <h2 id="settings-title">Workspace settings</h2>
              </div>
              <button
                aria-label="Close settings"
                autoFocus
                onClick={() => setSettingsOpen(false)}
              >
                <X size={19} />
              </button>
            </div>
            <p className="muted">
              Connect a model that supports tool calling. Your agents bring the
              instructions and tools.
            </p>
            <fieldset>
              <label>
                Provider
                <select
                  value={settings.provider}
                  onChange={(e) => {
                    const provider = e.target.value as Provider;
                    setSettings((s) => ({
                      ...s,
                      provider,
                      model:
                        provider === "local"
                          ? server.localModel
                          : PROVIDERS[provider].model,
                    }));
                    setApiKey("");
                  }}
                >
                  {Object.entries(PROVIDERS).map(([id, p]) => (
                    <option value={id} key={id}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Model ID
                <input
                  value={settings.model}
                  onChange={(e) =>
                    setSettings((s) => ({ ...s, model: e.target.value }))
                  }
                  placeholder="Enter the exact model ID from your provider"
                  maxLength={200}
                />
              </label>
              {settings.provider !== "local" && (
                <label>
                  API key
                  <input
                    type="password"
                    autoComplete="off"
                    value={apiKey}
                    onChange={(e) => setApiKey(e.target.value)}
                    placeholder={
                      server[settings.provider]
                        ? "Server key configured — optional override"
                        : "Paste your provider API key"
                    }
                    maxLength={1000}
                  />
                  <small>
                    Stored by the local service with restricted permissions. Secret values are never included in exports.
                  </small>
                </label>
              )}
              {settings.provider === "local" && <label>Model API base URL<input value={settings.baseUrl || ""} onChange={e => setSettings(current => ({ ...current, baseUrl: e.target.value }))} placeholder="http://host.docker.internal:11434/v1" /><small>Use an address reachable from the agent container.</small></label>}
              <p className="muted small">Only agents using “Use workspace default” follow these changes. Agents with their own model keep it.</p>
            </fieldset>
            <div className="settings-divider" />
            <h3>Your data stays with you</h3>
            <p className="muted small">
              Hermes state, skills, schedules, run events, and working files are
              saved by the local control service. Browser history remains
              exportable for portability. Active tasks continue after this tab
              closes.
            </p>
            <div className="button-row">
              <button
                className="subtle-button"
                onClick={() =>
                  download(
                    "open-harness-backup.json",
                    JSON.stringify(workspace, null, 2),
                    "application/json",
                  )
                }
              >
                <Download size={14} /> Export workspace
              </button>
              <button
                className="subtle-button"
                disabled={running}
                onClick={() => importRef.current?.click()}
              >
                <FolderOpen size={14} /> Import backup
              </button>
            </div>
            <div className="modal-footer">
              <span className="muted small">
                MIT licensed · Open Harness v0.2 · Hermes {runtime?.hermes.release}
              </span>
              <button
                className="light-button"
                onClick={async () => {
                  try {
                    if (apiKey && runtime) {
                      const name =
                        settings.provider === "xai"
                          ? "XAI_API_KEY"
                          : settings.provider === "openrouter"
                            ? "OPENROUTER_API_KEY"
                            : "MODEL_API_KEY";
                      await controlRef.current.request("/v1/secrets", {
                        method: "POST",
                        body: JSON.stringify({ name, value: apiKey }),
                      });
                      setApiKey("");
                    }
                    const saved = await controlRef.current.request<{ revision: number }>("/v1/workspace/model", {
                      method: "PUT", body: JSON.stringify({ revision: workspaceModelRevision, model: { provider: settings.provider, model: settings.model, baseUrl: settings.baseUrl || "", credentialRef: settings.provider === "xai" ? "XAI_API_KEY" : settings.provider === "openrouter" ? "OPENROUTER_API_KEY" : "" } }),
                    });
                    setWorkspaceModelRevision(saved.revision);
                    setSettingsOpen(false);
                    setNotice("Hermes settings saved.");
                  } catch (error) {
                    setNotice(
                      error instanceof Error
                        ? error.message
                        : "Could not save settings.",
                    );
                  }
                }}
              >
                Done <Check size={14} />
              </button>
            </div>
          </section>
        </div>
      )}
      {editingAgent && <AgentSettings key={editingAgent.id} agent={editingAgent} client={controlRef.current} onClose={() => setEditingAgent(null)} onSaved={profile => {
        setWorkspace(current => ({ ...current, agents: current.agents.some(a => a.id === profile.id)
          ? current.agents.map(a => a.id === profile.id ? profileAgent(profile, a.memory) : a)
          : [...current.agents, profileAgent(profile)] }));
      }} />}
      {file && (
        <div className="modal-backdrop" onClick={() => setSelectedFile(null)}>
          <section
            className="modal file-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="file-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-heading">
              <h2 id="file-title">
                <FileText size={19} /> {file.name}
              </h2>
              <div className="button-row">
                <button
                  aria-label="Download file"
                  onClick={() => download(file.name, file.content, file.mimeType, file.encoding)}
                >
                  <Download size={17} />
                </button>
                <button
                  autoFocus
                  aria-label="Close file"
                  onClick={() => setSelectedFile(null)}
                >
                  <X size={19} />
                </button>
              </div>
            </div>
            {file.encoding === "base64" && file.mimeType?.startsWith("image/") ? (
              // Runtime screenshots are local data URLs and cannot use the image optimizer.
              // eslint-disable-next-line @next/next/no-img-element
              <img className="file-image" src={`data:${file.mimeType};base64,${file.content}`} alt={file.name} />
            ) : file.name.endsWith(".md") ? (
              <Markdown>{file.content}</Markdown>
            ) : (
              <pre className="file-content">{file.content}</pre>
            )}
          </section>
        </div>
      )}
    </div>
  );
}

function validWorkspace(value: unknown): value is Workspace {
  if (!value || typeof value !== "object") return false;
  const w = value as Workspace;
  return (
    w.version === 1 &&
    Array.isArray(w.agents) &&
    w.agents.length > 0 &&
    w.agents.length <= 50 &&
    w.agents.every(
      (a) =>
        a &&
        typeof a.id === "string" &&
        typeof a.name === "string" &&
        a.name.trim() &&
        typeof a.role === "string" &&
        typeof a.description === "string" &&
        typeof a.instructions === "string" &&
        a.instructions.length <= 12000 &&
        Number.isInteger(a.tone) &&
        a.tone >= 0 &&
        Array.isArray(a.memory) &&
        a.memory.length <= 50 &&
        a.memory.every((m) => typeof m === "string" && m.length <= 500),
    ) &&
    new Set(w.agents.map((a) => a.id)).size === w.agents.length &&
    Array.isArray(w.files) &&
    w.files.length <= 40 &&
    w.files.every(
      (f) =>
        f &&
        typeof f.id === "string" &&
        typeof f.name === "string" &&
        typeof f.content === "string" &&
        f.content.length <= 100000 &&
        typeof f.agentId === "string" &&
        typeof f.updatedAt === "string",
    ) &&
    new Set(w.files.map((f) => f.id)).size === w.files.length &&
    new Set(w.files.map((f) => f.name)).size === w.files.length &&
    Array.isArray(w.conversations) &&
    w.conversations.every(
      (c) =>
        c &&
        typeof c.id === "string" &&
        typeof c.title === "string" &&
        typeof c.updatedAt === "string" &&
        w.agents.some((a) => a.id === c.agentId) &&
        Array.isArray(c.messages) &&
        c.messages.every(
          (m) =>
            m &&
            typeof m.id === "string" &&
            ["user", "assistant"].includes(m.role) &&
            typeof m.content === "string" &&
            (!m.activities ||
              (Array.isArray(m.activities) &&
                m.activities.every(
                  (a) =>
                    a &&
                    typeof a.id === "string" &&
                    typeof a.name === "string" &&
                    typeof a.detail === "string" &&
                    ["running", "done", "error"].includes(a.status),
                ))),
        ),
    )
  );
}
