"use client";

import { memo, useEffect, useRef, useState } from "react";
import {
  ArrowUp,
  ArrowUpRight,
  Bot,
  Bell,
  BellOff,
  Check,
  ChevronRight,
  Copy,
  Download,
  FileText,
  FolderOpen,
  KeyRound,
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
  Users,
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
import Onboarding from "../components/onboarding";
import TaskManager from "../components/task-manager";
import TeamManager, { TeamBadge } from "../components/team-manager";
import CredentialManager, { CredentialSwitcher } from "../components/credential-manager";
import { fitsProvider, type CredentialRecord } from "../lib/credentials";
import { profileAgent, type AgentProfile, type ModelChoice } from "../lib/agent-profile";
import type { Team } from "../lib/team";

const STORAGE_KEY = "open-harness.workspace.v2";
const LEGACY_STORAGE_KEY = "open-harness.workspace.v1";
const SETTINGS_KEY = "open-harness.settings.v1";
const ONBOARDING_KEY = "open-harness.onboarding.v1";
// Kept apart from SETTINGS_KEY on purpose: the onboarding save rewrites that whole
// blob, which would silently drop anything else stored alongside it.
const NOTIFY_KEY = "open-harness.notify.v1";
type View = "home" | "teams" | "chat" | "files" | "routines" | "tasks";
type ModelSettings = { provider: Provider; model: string; maxSteps?: number; baseUrl?: string; credentialRef?: string };
const defaultSettings: ModelSettings = {
  provider: "xai",
  model: PROVIDERS.xai.model,
};
const uid = () => crypto.randomUUID();
// Newest first: the file you care about is almost always the one just written.
const byNewest = (a: Artifact, b: Artifact) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt);
function formatInterval(minutes: number) {
  if (!Number.isFinite(minutes) || minutes < 1) return "—";
  if (minutes % 10080 === 0) { const weeks = minutes / 10080; return weeks === 1 ? "week" : `${weeks} weeks`; }
  if (minutes % 1440 === 0) { const days = minutes / 1440; return days === 1 ? "day" : `${days} days`; }
  if (minutes % 60 === 0) { const hours = minutes / 60; return hours === 1 ? "hour" : `${hours} hours`; }
  return minutes === 1 ? "minute" : `${minutes} minutes`;
}
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
// Hoisted: rebuilding these per render gave react-markdown new props every time and
// defeated its own memoization, so every poll re-parsed every message in the thread.
const MARKDOWN_PLUGINS = [remarkGfm];
const MARKDOWN_COMPONENTS = {
  img: ({ src, alt }: { src?: unknown; alt?: string }) => (
    <a
      href={typeof src === "string" ? src : undefined}
      target="_blank"
      rel="noopener noreferrer"
    >
      {alt || "Open image"}
    </a>
  ),
};
// Memoized: a run polls every 500ms, and each poll re-renders this page. Without this
// every message in the conversation goes through the full remark/rehype pipeline again.
const Markdown = memo(function Markdown({ children }: { children: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown remarkPlugins={MARKDOWN_PLUGINS} components={MARKDOWN_COMPONENTS}>
        {children}
      </ReactMarkdown>
    </div>
  );
});

export default function Home() {
  const [workspace, setWorkspace] = useState<Workspace>(initialWorkspace);
  const [retiredTeams, setRetiredTeams] = useState<Team[]>([]);
  const [ready, setReady] = useState(false);
  const [view, setView] = useState<View>("home");
  const lastWorkspaceView = useRef<View>("home");
  const [selectedAgent, setSelectedAgent] = useState("atlas");
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [settings, setSettings] = useState<ModelSettings>(defaultSettings);
  const [credentials, setCredentials] = useState<CredentialRecord[]>([]);
  const [credentialsOpen, setCredentialsOpen] = useState(false);
  const [workspaceModelRevision, setWorkspaceModelRevision] = useState(0);
  const [server, setServer] = useState({
    xai: false,
    openai: false,
    openrouter: false,
    local: false,
    localModel: "",
  });
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Snapshot of the settings when the dialog opened, so dismissing it can tell an
  // untouched dialog from one holding an unsaved model change or a freshly pasted key.
  const [settingsBaseline, setSettingsBaseline] = useState("");
  const [confirmCloseSettings, setConfirmCloseSettings] = useState(false);
  const [onboardingOpen, setOnboardingOpen] = useState(false);
  const [editingAgent, setEditingAgent] = useState<Agent | null>(null);
  const [editingAgentTab, setEditingAgentTab] = useState<'profile' | 'computer'>('profile');
  const [mobileOpen, setMobileOpen] = useState(false);
  const [input, setInput] = useState("");
  const [search, setSearch] = useState("");
  const [agentTeamFilter, setAgentTeamFilter] = useState("all");
  const [running, setRunning] = useState(false);
  const [persistentRun, setPersistentRun] = useState<PersistentRun | null>(null);
  const [runtime, setRuntime] = useState<RuntimeStatus | null>(null);
  // A queue, not a slot. Two agents can pause at once, and the second request used to
  // overwrite the first — leaving a run blocked on an approval with no way to answer it.
  const [approvals, setApprovals] = useState<Array<{ approvalId: string; detail: string; runId: string; agentName: string }>>([]);
  const [inputMode, setInputMode] = useState<"steer" | "followup">("steer");
  const [routines, setRoutines] = useState<Array<Record<string, unknown>>>([]);
  const [routineDraft, setRoutineDraft] = useState<{ id?: string; name: string; prompt: string; agentId: string; intervalMinutes: number } | null>(null);
  const [routineBusy, setRoutineBusy] = useState(false);
  // MEMORY.md and SKILL.md are multi-section Markdown documents; window.prompt cannot
  // realistically edit either, and there was no way to write a skill by hand at all.
  const [docEditor, setDocEditor] = useState<
    | { kind: "memory"; value: string }
    | { kind: "skill"; skill: string; value: string }
    | { kind: "new-skill"; skill: string; value: string }
    | null
  >(null);
  const [docBusy, setDocBusy] = useState(false);
  const [agentContext, setAgentContext] = useState<{
    memory: string;
    user: string;
    skills: string[];
    capabilities: Record<string, boolean>;
  } | null>(null);

  const [notice, setNotice] = useState("");
  const [reconnecting, setReconnecting] = useState(false);
  const [notifyWhenDone, setNotifyWhenDone] = useState(false);
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
  // The deterministic adapter exists for automated tests only. Treating it as a
  // connected runtime let a source preview display canned prose as an agent reply.
  const testMode = runtime?.mode === "test";
  const connected = Boolean(runtime?.runtime.available && !testMode);

  useEffect(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY) || localStorage.getItem(LEGACY_STORAGE_KEY);
      // Hydrate browser-only persistence after the server-rendered first frame.
      if (saved) {
        const parsed = normalizeWorkspace(JSON.parse(saved));
        if (!parsed) throw new Error();
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
      if (localStorage.getItem(NOTIFY_KEY) === "on" && typeof Notification !== "undefined" && Notification.permission === "granted") setNotifyWhenDone(true);
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
        if (workspace.teams.length) await client.request("/v1/teams/sync", { method: "POST", body: JSON.stringify({ teams: workspace.teams }) });
        const teamResult = await client.request<{ teams: Team[] }>("/v1/teams?includeRetired=1");
        if (!cancelled) {
          setWorkspace(current => ({ ...current, teams: teamResult.teams.filter(team => !team.retiredAt), agents: synced.agents.map(agent => ({ ...agent, memory: current.agents.find(a => a.id === agent.id)?.memory || [] })) }));
          setRetiredTeams(teamResult.teams.filter(team => Boolean(team.retiredAt)));
          const defaults = await client.request<{ model: ModelChoice; revision: number }>("/v1/workspace/model/import", {
            method: "POST",
            body: JSON.stringify({ model: { provider: settings.provider, model: settings.model, baseUrl: settings.baseUrl || "", credentialRef: settings.credentialRef || "" } }),
          });
          setSettings({ provider: defaults.model.provider as Provider, model: defaults.model.model, baseUrl: defaults.model.baseUrl, credentialRef: defaults.model.credentialRef });
          setWorkspaceModelRevision(defaults.revision);
          if (localStorage.getItem(ONBOARDING_KEY) !== 'done') setOnboardingOpen(true);
        }
        try { const saved = await client.request<{ credentials: CredentialRecord[] }>("/v1/credentials"); if (!cancelled) setCredentials(saved.credentials); } catch {}
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
            )
              .catch(() => setNotice("Lost contact with the local service while following this task. It is still running — reload to reattach."))
              .finally(() => {
                runLock.current = false;
                setRunning(false);
                setPersistentRun(null);
                setReconnecting(false);
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
  // Agents run for minutes and the whole point is that you go and do something else.
  // Only interrupt when the page is actually out of view — a notification for something
  // the user is already looking at is noise.
  const skillPath = (agentId: string, skill: string) =>
    `/v1/agents/${encodeURIComponent(agentId)}/context/skills/${encodeURIComponent(skill)}`;
  const saveDoc = async () => {
    if (!docEditor || !agentContext) return;
    setDocBusy(true);
    try {
      if (docEditor.kind === "memory") {
        await controlRef.current.request(`/v1/agents/${encodeURIComponent(agent.id)}/context`, { method: "PUT", body: JSON.stringify({ memory: docEditor.value }) });
        setAgentContext({ ...agentContext, memory: docEditor.value });
        setNotice("Memory saved.");
      } else {
        const name = docEditor.skill.trim();
        // Mirrors the server's own rule, so a bad name is caught before the round trip.
        if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,79}$/.test(name)) { setNotice("Use a skill name of letters, numbers, dot, dash or underscore."); return; }
        if (docEditor.kind === "new-skill" && agentContext.skills.includes(name)) { setNotice(`${agent.name} already has a skill called ${name}.`); return; }
        await controlRef.current.request(skillPath(agent.id, name), { method: "PUT", body: JSON.stringify({ content: docEditor.value }) });
        if (!agentContext.skills.includes(name)) setAgentContext({ ...agentContext, skills: [...agentContext.skills, name] });
        setNotice(`Saved ${name}/SKILL.md.`);
      }
      setDocEditor(null);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not save that.");
    } finally {
      setDocBusy(false);
    }
  };

  const refreshRoutines = async () => {
    const result = await controlRef.current.request<{ routines: Array<Record<string, unknown>> }>("/v1/routines");
    setRoutines(result.routines);
  };
  const saveRoutine = async () => {
    if (!routineDraft) return;
    const name = routineDraft.name.trim(), prompt = routineDraft.prompt.trim();
    if (!name || !prompt) { setNotice("Give the routine a name and a task."); return; }
    setRoutineBusy(true);
    try {
      const payload = JSON.stringify({ name, prompt, agentId: routineDraft.agentId, intervalMinutes: routineDraft.intervalMinutes, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone });
      if (routineDraft.id) await controlRef.current.request(`/v1/routines/${routineDraft.id}`, { method: "PUT", body: payload });
      else await controlRef.current.request("/v1/routines", { method: "POST", body: payload });
      await refreshRoutines();
      setRoutineDraft(null);
      setNotice(routineDraft.id ? "Routine updated." : "Routine created.");
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not save that routine.");
    } finally {
      setRoutineBusy(false);
    }
  };

  const agentNameFor = (id: string) => workspace.agents.find(agent => agent.id === id)?.name || "Your agent";
  const notifyDone = (title: string, body: string) => {
    if (!notifyWhenDone || typeof Notification === "undefined") return;
    if (Notification.permission !== "granted" || !document.hidden) return;
    try { new Notification(title, { body, tag: "open-harness-run" }); } catch { /* the browser may refuse; the in-app notice still stands */ }
  };
  const toggleNotifications = async () => {
    if (notifyWhenDone) { setNotifyWhenDone(false); localStorage.setItem(NOTIFY_KEY, "off"); return; }
    if (typeof Notification === "undefined") { setNotice("This browser cannot show desktop notifications."); return; }
    const permission = Notification.permission === "granted" ? "granted" : await Notification.requestPermission();
    if (permission !== "granted") { setNotice("Your browser blocked notifications for Open Harness. Allow them in its site settings to turn this on."); return; }
    setNotifyWhenDone(true); localStorage.setItem(NOTIFY_KEY, "on");
  };

  const applySavedProfile = (profile: AgentProfile) => setWorkspace(current => ({ ...current, agents: current.agents.some(a => a.id === profile.id)
    ? current.agents.map(a => a.id === profile.id ? profileAgent(profile, a.memory) : a)
    : [...current.agents, profileAgent(profile)] }));
  const settingsSnapshot = () => JSON.stringify(settings);
  const openSettings = () => {
    setSettingsBaseline(settingsSnapshot());
    setConfirmCloseSettings(false);
    setSettingsOpen(true);
  };
  const closeSettings = () => { setConfirmCloseSettings(false); setSettingsOpen(false); };
  // Dismissing this dialog used to drop an unsaved model change or a pasted API key
  // with no warning, which is the worst version of it: the key is gone from the form
  // and was never sent anywhere.
  const settingsDirty = settingsOpen && settingsSnapshot() !== settingsBaseline;
  const requestCloseSettings = () => { if (settingsDirty) setConfirmCloseSettings(true); else closeSettings(); };
  const escapeSettingsRef = useRef<() => void>(() => {});
  escapeSettingsRef.current = () => { if (settingsOpen) requestCloseSettings(); };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === "k") {
        event.preventDefault();
        // Cmd+K is a desktop habit too; the sidebar drawer is only a mobile concern.
        if (window.matchMedia("(max-width: 900px)").matches) setMobileOpen(true);
        searchRef.current?.focus();
      }
      if (event.key === "Escape") {
        escapeSettingsRef.current();
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
      void followRun(run, run.conversation_id, messageId, run.agent_id, existingReply?.eventCursor || 0, Boolean(existingReply?.content))
        .catch(() => setNotice("Lost contact with the local service while following this task. It is still running — reload to reattach."))
        .finally(() => {
          runLock.current = false;
          setRunning(false);
          setPersistentRun(null);
          setReconnecting(false);
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
    let consecutiveFailures = 0;
    while (true) {
      // The run lives on the coordinator, not here. A dropped fetch — a sleeping
      // laptop, a coordinator restart, a blip — used to end this loop and leave the
      // agent working with nothing watching it. Retry with backoff instead, and only
      // give up once it is clear the coordinator is really gone.
      let snapshot;
      try {
        snapshot = await controlRef.current.events(run.id, cursor);
        if (consecutiveFailures) { setReconnecting(false); setNotice("Reconnected. Still following this task."); }
        consecutiveFailures = 0;
      } catch (error) {
        consecutiveFailures += 1;
        if (consecutiveFailures > 10) { setReconnecting(false); throw error; }
        setReconnecting(true);
        await new Promise(resolve => setTimeout(resolve, Math.min(8000, 500 * 2 ** (consecutiveFailures - 1))));
        continue;
      }
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
          const detail = String(
            payload.command || payload.description || "Hermes requests approval.",
          );
          const approvalId = String(payload.approvalId);
          setApprovals(current => current.some(item => item.approvalId === approvalId)
            ? current
            : [...current, { approvalId, detail, runId: run.id, agentName: agentNameFor(agentId) }]);
          // An approval blocks the run and the agent's whole slot until it is answered,
          // so this is the one the user most needs to hear about while looking elsewhere.
          notifyDone(`${agentNameFor(agentId)} needs your approval`, detail);
        } else if (item.type === "run.failed" || item.type === "run.interrupted") {
          const message = String(payload.error || "Run interrupted.");
          handleEvent({ type: "error", message }, cid, mid, agentId);
          notifyDone(`${agentNameFor(agentId)} stopped`, message);
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
        if (snapshot.run.state === "completed") notifyDone(`${agentNameFor(agentId)} finished`, "Your task is done. Open Harness to see the result.");
        // Otherwise a resolved or abandoned request keeps its banner over a later run.
        setApprovals(current => current.filter(item => item.runId !== snapshot.run.id));
        return snapshot.run;
      }
      // A hidden tab still has a live run, but nobody is reading it. task-manager.tsx
      // already backs off the same way; polling twice a second behind another window
      // just burns the coordinator and re-renders this page for no one.
      await new Promise((resolve) => setTimeout(resolve, document.hidden ? 4000 : 500));
    }
  }
  async function send(text = input, guided = false) {
    if (!text.trim() || !ready) return;
    if (!guided && testMode) {
      setNotice("Agent chat is disabled in automated test mode. Open the installed desktop app to run a real agent.");
      return;
    }
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
      const parsed = normalizeWorkspace(JSON.parse(await upload.text()));
      if (!parsed) throw new Error();
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
        if (runtime && parsed.teams.length) void controlRef.current.request("/v1/teams/sync", { method: "POST", body: JSON.stringify({ teams: parsed.teams }) })
          .then(() => controlRef.current.request<{ teams: Team[] }>("/v1/teams"))
          .then(result => setWorkspace(current => ({ ...current, teams: result.teams })))
          .catch(error => setNotice(error instanceof Error ? error.message : "Team restore failed."));
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
  const visibleAgents = workspace.agents.filter(candidate => agentTeamFilter === "all"
    || (agentTeamFilter === "unassigned" ? !workspace.teams.some(team => team.memberAgentIds.includes(candidate.id)) : workspace.teams.find(team => team.id === agentTeamFilter)?.memberAgentIds.includes(candidate.id)));

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
          className={`nav-item ${view === "teams" ? "active" : ""}`}
          onClick={() => {
            setView("teams");
            setMobileOpen(false);
          }}
        >
          <Users size={16} /> Teams <span>{workspace.teams.length}</span>
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
          {testMode ? "Automated test mode" : connected ? "Agent runtime ready" : "Agent runtime needs setup"}
          <button onClick={() => openSettings()}>
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
                : view === "teams"
                  ? "Teams"
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
        {view === "tasks" && <TaskManager agents={workspace.agents} teams={[...workspace.teams, ...retiredTeams]} client={controlRef.current} onOpenRun={openTaskRun} />}
        {view === "teams" && <TeamManager agents={workspace.agents} teams={workspace.teams} client={controlRef.current} onChanged={teams => { setWorkspace(current => ({ ...current, teams: teams.filter(team => !team.retiredAt) })); setRetiredTeams(teams.filter(team => Boolean(team.retiredAt))); }} />}
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
            <div className="agent-team-filters" aria-label="Filter agents by team">
              <button className={agentTeamFilter === "all" ? "active" : ""} onClick={() => setAgentTeamFilter("all")}>All</button>
              {workspace.teams.map(team => <button className={agentTeamFilter === team.id ? "active" : ""} onClick={() => setAgentTeamFilter(team.id)} key={team.id}>{team.name}</button>)}
              <button className={agentTeamFilter === "unassigned" ? "active" : ""} onClick={() => setAgentTeamFilter("unassigned")}>Unassigned</button>
            </div>
            <div className="agent-grid">
              {visibleAgents.map((a) => (
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
                  <div className="agent-team-badges">{workspace.teams.filter(team => team.memberAgentIds.includes(a.id)).slice(0, 2).map(team => <TeamBadge team={team} key={team.id} />)}{workspace.teams.filter(team => team.memberAgentIds.includes(a.id)).length > 2 && <small>+{workspace.teams.filter(team => team.memberAgentIds.includes(a.id)).length - 2}</small>}{!workspace.teams.some(team => team.memberAgentIds.includes(a.id)) && <span className="team-badge unassigned">Unassigned</span>}</div>
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
                <div className="agent-card-tools">
                  <CredentialSwitcher agent={a} credentials={credentials} workspaceRef={settings.credentialRef || ""} client={controlRef.current} running={running && a.id === selectedAgent} onManage={() => setCredentialsOpen(true)} onSaved={profile => applySavedProfile(profile as AgentProfile)} />
                </div>
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
              <button onClick={() => openSettings()}>
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
                <CredentialSwitcher agent={agent} credentials={credentials} workspaceRef={settings.credentialRef || ""} client={controlRef.current} running={running} onManage={() => setCredentialsOpen(true)} onSaved={profile => applySavedProfile(profile as AgentProfile)} />
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
                          {reconnecting ? "Reconnecting — your agent is still working…" : "Working on it…"}
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
                      onClick={() => openSettings()}
                    >
                      <span className="status-dot" />
                      {testMode
                        ? "Automated test mode"
                        : connected
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
                {approvals.length > 0 && (() => {
                  const pending = approvals[0];
                  const resolve = async (decision: "approve" | "deny") => {
                    try {
                      await controlRef.current.request(`/v1/runs/${pending.runId}/approval`, {
                        method: "POST",
                        body: JSON.stringify({ approvalId: pending.approvalId, decision }),
                      });
                    } catch (error) {
                      setNotice(error instanceof Error ? error.message : "Could not send that decision.");
                      return;
                    }
                    setApprovals(current => current.filter(item => item.approvalId !== pending.approvalId));
                  };
                  return (
                    <div className="approval-banner" role="alert">
                      <ShieldCheck size={18} />
                      <div>
                        <strong>
                          {pending.agentName} needs approval
                          {approvals.length > 1 && <span className="approval-count"> · {approvals.length - 1} more waiting</span>}
                        </strong>
                        <p>{pending.detail}</p>
                      </div>
                      <button className="subtle-button" onClick={() => void resolve("deny")}>Deny</button>
                      <button className="light-button" onClick={() => void resolve("approve")}>Approve once</button>
                    </div>
                  );
                })()}
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
                  [...workspace.files].sort(byNewest).map((f) => (
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
                      onClick={() => setDocEditor({ kind: "memory", value: agentContext.memory })}
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
                            try {
                              const current = await controlRef.current.request<{ content: string }>(skillPath(agent.id, skill));
                              setDocEditor({ kind: "skill", skill, value: current.content });
                            } catch (error) {
                              setNotice(error instanceof Error ? error.message : `Could not open ${skill}.`);
                            }
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
                <button
                  className="subtle-button"
                  onClick={() => setDocEditor({
                    kind: "new-skill",
                    skill: "",
                    value: "# New skill\n\nDescribe when this skill applies, then give the steps to follow.\n",
                  })}
                >
                  <Plus size={12} /> New skill
                </button>
                <div className="inspector-label"><Cable size={13} /> PROFILE TOOLS <span>{agent.profile?.allowedTools.length || 0}</span></div>
                <p className="panel-help">{agent.profile?.allowedTools.length ? `${agent.profile.allowedTools.length} tools selected. Open Agent settings to check availability or change access.` : "No tools selected. Choose the capabilities this agent needs."}</p>
                <button className="subtle-button" onClick={() => setEditingAgent({ ...agent })}><SlidersHorizontal size={13} /> Agent settings</button>
                <div className="scope-note">
                  {testMode
                    ? "Automated test mode does not run agents. Open the installed desktop app for live work."
                    : runtime?.runtime.available
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
                {[...workspace.files].sort(byNewest).map((f) => (
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
                onClick={() => setRoutineDraft({ name: "", prompt: "", agentId: agent.id, intervalMinutes: 1440 })}
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
                          {agentNameFor(String(routine.agent_id))}
                          {" · "}every {formatInterval(Number(routine.interval_minutes))}
                          {" · "}next {new Date(String(routine.next_run_at)).toLocaleString()}
                        </small>
                        <small>
                          {routine.last_run_at
                            ? `Last run ${new Date(String(routine.last_run_at)).toLocaleString()}`
                            : "Has not run yet"}
                        </small>
                      </span>
                    </div>
                    <span className="muted small">
                      {routine.enabled ? "Enabled" : "Paused"}
                    </span>
                    <button
                      className="subtle-button"
                      onClick={async () => {
                        try {
                          await controlRef.current.request(`/v1/routines/${String(routine.id)}/run`, { method: "POST" });
                          // The server stamps last_run_at and next_run_at; without this the
                          // row keeps showing the schedule it had before you pressed the button.
                          await refreshRoutines();
                          setNotice("Routine queued now.");
                        } catch (error) {
                          setNotice(error instanceof Error ? error.message : "Could not start that routine.");
                        }
                      }}
                    >
                      Run now
                    </button>
                    <button
                      className="subtle-button"
                      onClick={() => setRoutineDraft({
                        id: String(routine.id),
                        name: String(routine.name),
                        prompt: String(routine.prompt),
                        agentId: String(routine.agent_id),
                        intervalMinutes: Number(routine.interval_minutes) || 1440,
                      })}
                    >
                      Edit
                    </button>
                    <button
                      onClick={async () => {
                        try {
                          await controlRef.current.request(`/v1/routines/${String(routine.id)}/toggle`, { method: "POST" });
                          await refreshRoutines();
                        } catch (error) {
                          setNotice(error instanceof Error ? error.message : "Could not change that routine.");
                        }
                      }}
                    >
                      {routine.enabled ? "Pause" : "Enable"}
                    </button>
                    <button
                      className="danger-text"
                      aria-label={`Delete routine ${String(routine.name)}`}
                      onClick={async () => {
                        if (!window.confirm(`Delete the routine “${String(routine.name)}”? Its schedule and history are removed.`)) return;
                        try {
                          await controlRef.current.request(`/v1/routines/${String(routine.id)}`, { method: "DELETE" });
                          await refreshRoutines();
                          setNotice("Routine deleted.");
                        } catch (error) {
                          setNotice(error instanceof Error ? error.message : "Could not delete that routine.");
                        }
                      }}
                    >
                      <Trash2 size={16} />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </section>
        )}
      </main>
      {docEditor && (
        <div className="modal-backdrop" onClick={() => !docBusy && setDocEditor(null)}>
          <section
            className="modal doc-editor"
            role="dialog"
            aria-modal="true"
            aria-labelledby="doc-editor-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-heading">
              <div>
                <div className="eyebrow">{docEditor.kind === "memory" ? "DURABLE MEMORY" : "REUSABLE SKILL"}</div>
                <h2 id="doc-editor-title">
                  {docEditor.kind === "memory"
                    ? `${agent.name}’s memory`
                    : docEditor.kind === "new-skill"
                      ? "New skill"
                      : `${docEditor.skill}/SKILL.md`}
                </h2>
              </div>
              <button aria-label="Close editor" onClick={() => setDocEditor(null)}>
                <X size={19} />
              </button>
            </div>
            <div className="modal-body">
              {docEditor.kind === "new-skill" && (
                <label>
                  Skill name
                  <input
                    autoFocus
                    value={docEditor.skill}
                    onChange={(e) => setDocEditor({ ...docEditor, skill: e.target.value })}
                    placeholder="weekly-digest"
                  />
                  <small className="muted">Invoked in chat as /{docEditor.skill.trim() || "name"}</small>
                </label>
              )}
              <label>
                {docEditor.kind === "memory" ? "What this agent should remember" : "Markdown"}
                <textarea
                  className="doc-editor-text"
                  rows={16}
                  autoFocus={docEditor.kind !== "new-skill"}
                  value={docEditor.value}
                  onChange={(e) => setDocEditor({ ...docEditor, value: e.target.value })}
                />
              </label>
            </div>
            <div className="modal-footer">
              <button className="subtle-button" disabled={docBusy} onClick={() => setDocEditor(null)}>Cancel</button>
              <button className="light-button" disabled={docBusy} onClick={() => void saveDoc()}>
                {docBusy ? "Saving…" : "Save"}
              </button>
            </div>
          </section>
        </div>
      )}
      {routineDraft && (
        <div className="modal-backdrop" onClick={() => !routineBusy && setRoutineDraft(null)}>
          <section
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="routine-title"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-heading">
              <div>
                <div className="eyebrow">BACKGROUND WORK</div>
                <h2 id="routine-title">{routineDraft.id ? "Edit routine" : "New routine"}</h2>
              </div>
              <button aria-label="Close routine" onClick={() => setRoutineDraft(null)}>
                <X size={19} />
              </button>
            </div>
            <div className="modal-body">
              <label>
                Name
                <input
                  autoFocus
                  value={routineDraft.name}
                  onChange={(e) => setRoutineDraft({ ...routineDraft, name: e.target.value })}
                  placeholder="Weekly digest"
                />
              </label>
              <label>
                What should the agent do?
                <textarea
                  rows={5}
                  value={routineDraft.prompt}
                  onChange={(e) => setRoutineDraft({ ...routineDraft, prompt: e.target.value })}
                  placeholder="Summarize anything new in the shared files and save it as digest.md."
                />
              </label>
              <label>
                Agent
                <select
                  value={routineDraft.agentId}
                  onChange={(e) => setRoutineDraft({ ...routineDraft, agentId: e.target.value })}
                >
                  {workspace.agents.map((item) => (
                    <option key={item.id} value={item.id}>{item.name}</option>
                  ))}
                </select>
              </label>
              <label>
                Run every
                <select
                  value={String(routineDraft.intervalMinutes)}
                  onChange={(e) => setRoutineDraft({ ...routineDraft, intervalMinutes: Number(e.target.value) })}
                >
                  <option value="60">Hour</option>
                  <option value="360">6 hours</option>
                  <option value="720">12 hours</option>
                  <option value="1440">Day</option>
                  <option value="10080">Week</option>
                </select>
                <small className="muted">
                  Counted from the last run, not from a clock time — a daily routine drifts if you also run it by hand.
                </small>
              </label>
            </div>
            <div className="modal-footer">
              <button className="subtle-button" disabled={routineBusy} onClick={() => setRoutineDraft(null)}>Cancel</button>
              <button className="light-button" disabled={routineBusy} onClick={() => void saveRoutine()}>
                {routineBusy ? "Saving…" : routineDraft.id ? "Save changes" : "Create routine"}
              </button>
            </div>
          </section>
        </div>
      )}
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
        <div className="modal-backdrop" onClick={requestCloseSettings}>
          <section
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="settings-title"
            onClick={(e) => e.stopPropagation()}
          >
            {confirmCloseSettings && (
              <div className="settings-discard" onClick={(e) => e.stopPropagation()}>
                <div role="alertdialog" aria-labelledby="settings-discard-title">
                  <h3 id="settings-discard-title">Discard unsaved settings?</h3>
                  <p className="muted small">Your saved settings will stay as they are.</p>
                  <div className="task-discard-actions">
                    <button type="button" autoFocus onClick={() => setConfirmCloseSettings(false)}>Keep editing</button>
                    <button type="button" className="task-primary" onClick={closeSettings}>Discard changes</button>
                  </div>
                </div>
              </div>
            )}
            <div className="modal-heading">
              <div>
                <div className="eyebrow">MAKE IT YOURS</div>
                <h2 id="settings-title">Workspace settings</h2>
              </div>
              <button
                aria-label="Close settings"
                autoFocus
                onClick={requestCloseSettings}
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
                      credentialRef: credentials.some((item) => item.ref === s.credentialRef && fitsProvider(item, provider))
                        ? s.credentialRef
                        : credentials.find((item) => item.provider === provider)?.ref || "",
                    }));
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
              <label>
                Credential
                <select
                  value={settings.credentialRef || ""}
                  onChange={(e) => { if (e.target.value === "__manage") { setCredentialsOpen(true); return; } setSettings((current) => ({ ...current, credentialRef: e.target.value })); }}
                >
                  <option value="">No credential</option>
                  {credentials.filter((item) => fitsProvider(item, settings.provider)).map((item) => (
                    <option value={item.ref} key={item.ref}>{item.label}{item.present ? "" : " — missing"}</option>
                  ))}
                  {settings.credentialRef && !credentials.some((item) => item.ref === settings.credentialRef) && (
                    <option value={settings.credentialRef}>{settings.credentialRef} — missing</option>
                  )}
                  <option value="__manage">＋ Manage credentials…</option>
                </select>
                <small>Agents using “Use workspace default” run on this credential.</small>
              </label>
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
                onClick={() => setCredentialsOpen(true)}
              >
                <KeyRound size={14} /> Saved credentials
              </button>
              <button
                className="subtle-button"
                onClick={() => { closeSettings(); setOnboardingOpen(true); }}
              >
                <Sparkles size={14} /> Run setup again
              </button>
              <button
                className="subtle-button"
                aria-pressed={notifyWhenDone}
                onClick={() => void toggleNotifications()}
                title="Show a desktop notification when a task finishes, fails, or needs your approval — only while this window is in the background."
              >
                {notifyWhenDone ? <Bell size={14} /> : <BellOff size={14} />}
                {notifyWhenDone ? "Notifications on" : "Notify me when tasks finish"}
              </button>
              <button className="subtle-button" onClick={async () => {
                try { const bundle = await controlRef.current.request<Record<string, unknown>>('/v1/support-bundle'); download(`open-harness-diagnostics-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(bundle, null, 2), 'application/json'); }
                catch (error) { setNotice(error instanceof Error ? error.message : 'Could not create diagnostics.'); }
              }}><Download size={14} /> Download diagnostics</button>
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
                MIT licensed · Open Harness v{runtime?.version || '0.3.0'} · Hermes {runtime?.hermes.release}
              </span>
              <button
                className="light-button"
                onClick={async () => {
                  try {
                    const saved = await controlRef.current.request<{ revision: number }>("/v1/workspace/model", {
                      method: "PUT", body: JSON.stringify({ revision: workspaceModelRevision, model: { provider: settings.provider, model: settings.model, baseUrl: settings.baseUrl || "", credentialRef: settings.credentialRef || "" } }),
                    });
                    setWorkspaceModelRevision(saved.revision);
                    const checked = await controlRef.current.request<{ ok: boolean; message: string }>("/v1/onboarding/model-test", {
                      method: "POST",
                      body: JSON.stringify({ model: { provider: settings.provider, model: settings.model, baseUrl: settings.baseUrl || "", credentialRef: settings.credentialRef || "" } }),
                    });
                    if (!checked.ok) {
                      setNotice(checked.message);
                      return;
                    }
                    closeSettings();
                    setSettingsBaseline(JSON.stringify(settings));
                    setNotice(checked.message);
                  } catch (error) {
                    setNotice(
                      error instanceof Error
                        ? error.message
                        : "Could not save settings.",
                    );
                  }
                }}
              >
                Save and test <Check size={14} />
              </button>
            </div>
          </section>
        </div>
      )}
      {credentialsOpen && <CredentialManager client={controlRef.current} provider={settings.provider} onClose={() => setCredentialsOpen(false)} onChanged={setCredentials} />}
      {onboardingOpen && runtime && <Onboarding client={controlRef.current} model={{ provider: settings.provider, model: settings.model, baseUrl: settings.baseUrl || '', credentialRef: settings.credentialRef || "" }} revision={workspaceModelRevision} onModelSaved={(model, revision) => {
        setSettings({ provider: model.provider as Provider, model: model.model, baseUrl: model.baseUrl, credentialRef: model.credentialRef });
        setWorkspaceModelRevision(revision);
        void controlRef.current.request<{ credentials: CredentialRecord[] }>("/v1/credentials").then(saved => setCredentials(saved.credentials)).catch(() => {});
        localStorage.setItem(SETTINGS_KEY, JSON.stringify({ provider: model.provider, model: model.model, baseUrl: model.baseUrl }));
      }} onComputerSettings={() => {
        localStorage.setItem(ONBOARDING_KEY, 'done');
        setOnboardingOpen(false);
        setEditingAgentTab('computer');
        setEditingAgent(agent);
      }} onFinished={() => {
        localStorage.setItem(ONBOARDING_KEY, 'done');
        setOnboardingOpen(false);
      }} />}
      {editingAgent && <AgentSettings key={`${editingAgent.id}:${editingAgentTab}`} initialTab={editingAgentTab} agent={editingAgent} client={controlRef.current} onClose={() => { setEditingAgent(null); setEditingAgentTab('profile'); }} onSaved={applySavedProfile} onManageCredentials={() => setCredentialsOpen(true)} />}
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

function normalizeWorkspace(value: unknown): Workspace | null {
  if (!value || typeof value !== "object") return null;
  const source = value as Record<string, unknown>;
  if (source.version !== 1 && source.version !== 2) return null;
  const normalized = { ...source, version: 2 as const, teams: Array.isArray(source.teams) ? source.teams : [] } as unknown as Workspace;
  return validWorkspace(normalized) ? normalized : null;
}

function validWorkspace(value: unknown): value is Workspace {
  if (!value || typeof value !== "object") return false;
  const w = value as Workspace;
  return (
    w.version === 2 &&
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
    Array.isArray(w.teams) &&
    w.teams.length <= 100 &&
    w.teams.every(team => team && typeof team.id === "string" && typeof team.name === "string" && team.name.trim() && team.name.length <= 60 && typeof team.description === "string" && team.description.length <= 240 && typeof team.color === "string" && typeof team.icon === "string" && Number.isInteger(team.revision) && Array.isArray(team.memberAgentIds) && team.memberAgentIds.every(id => w.agents.some(agent => agent.id === id))) &&
    new Set(w.teams.map(team => team.id)).size === w.teams.length &&
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
