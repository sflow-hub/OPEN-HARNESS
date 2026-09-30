"use client";

import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  ArrowUp,
  ArrowUpRight,
  Bot,
  Bell,
  BellOff,
  Check,
  ChevronRight,
  CircleAlert,
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
  Cable,
  CalendarClock,
  ShieldAlert,
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
  type Message,
  type RunEvent,
} from "../lib/types";
import { PROVIDERS, type Provider } from "../lib/provider";
import {
  ControlClient,
  PairingRequiredError,
  type PersistentRun,
  type RuntimeStatus,
  type RemoteConversation,
  isLiveRun,
} from "../lib/control-client";

import AgentSettings from "../components/agent-settings";
import Onboarding from "../components/onboarding";
import TaskManager from "../components/task-manager";
import TeamManager, { TeamBadge } from "../components/team-manager";
import CredentialManager, { CredentialSwitcher } from "../components/credential-manager";
import { fitsProvider, type CredentialRecord } from "../lib/credentials";
import { isSandboxedComputer, profileAgent, type AgentProfile, type ModelChoice } from "../lib/agent-profile";
import type { Team } from "../lib/team";
import { APP_VERSION } from "../lib/version";

const STORAGE_KEY = "open-harness.workspace.v2";
const LEGACY_STORAGE_KEY = "open-harness.workspace.v1";
const SETTINGS_KEY = "open-harness.settings.v1";
const promptId = (run: Pick<PersistentRun, "id">) => `prompt:${run.id}`;
const replyId = (run: Pick<PersistentRun, "id">) => `reply:${run.id}`;
function describe(value: unknown, fallback: string): string {
  if (value === null || value === undefined || value === "") return fallback;
  if (typeof value === "string") return value.length > 400 ? `${value.slice(0, 400)}…` : value;
  if (typeof value !== "object") return String(value);
  const record = value as Record<string, unknown>;
  for (const key of ["output", "text", "content", "message", "summary", "preview", "command", "description", "question", "path", "error"]) {
    if (typeof record[key] === "string" && record[key]) return describe(record[key], fallback);
  }
  try { return describe(JSON.stringify(value), fallback); } catch { return fallback; }
}

const ONBOARDING_KEY = "open-harness.onboarding.v1";
const ADVANCED_KEY = "open-harness.advanced.v1";
const MIGRATED_KEY = "open-harness.migrated.v1";
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
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [advancedFeatures, setAdvancedFeatures] = useState(false);
  // The settings as last saved or loaded, so dismissing the dialog can tell an untouched
  // form from one holding an unsaved model change. Kept in step with every source of
  // saved settings rather than snapshotted when the dialog opens: a snapshot taken while
  // the coordinator's answer was still in flight flagged an untouched form as edited.
  const [settingsBaseline, setSettingsBaseline] = useState(JSON.stringify(defaultSettings));
  const [confirmCloseSettings, setConfirmCloseSettings] = useState(false);
  const [onboardingOpen, setOnboardingOpen] = useState(false);
  const [editingAgent, setEditingAgent] = useState<Agent | null>(null);
  const [editingAgentTab, setEditingAgentTab] = useState<'profile' | 'computer'>('profile');
  const [mobileOpen, setMobileOpen] = useState(false);
  const [input, setInput] = useState("");
  const [search, setSearch] = useState("");
  const [agentTeamFilter, setAgentTeamFilter] = useState("all");
  const [liveRuns, setLiveRuns] = useState<Record<string, PersistentRun>>({});
  const [runtime, setRuntime] = useState<RuntimeStatus | null>(null);
  const [answered, setAnswered] = useState<Array<{ id: string; runId: string; at: number }>>([]);
  const ANSWER_GRACE_MS = 20_000;
  const [answering, setAnswering] = useState("");
  const [inputDraft, setInputDraft] = useState<{ inputId: string; text: string; choices: string[] }>({ inputId: "", text: "", choices: [] });
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
  const [offline, setOffline] = useState("");
  const [retrying, setRetrying] = useState(false);
  // The Docker-backed install hands its operator token only to a browser that arrives with
  // the launcher's one-use link. "required": this browser has no token; "invalid": it came
  // with a link that was already used or has expired. Neither state polls or falls back.
  const [pairing, setPairing] = useState<{ state: "none" | "required" | "invalid"; message: string }>({ state: "none", message: "" });
  const connectAttempt = useRef(0);
  // A code taken out of the address bar by the hashchange listener below, held for exactly
  // one exchange by the next connection attempt.
  const pendingPairCode = useRef("");
  const runtimeRefresh = useRef(0);
  // What the first-run guide last reported the runtime to be, kept until a bootstrap answer
  // agrees: a re-read requested for another reason (closing the guide) carries it on.
  const runtimeExpectation = useRef<boolean | null>(null);
  const [notifyWhenDone, setNotifyWhenDone] = useState(false);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [inspector, setInspector] = useState(true);
  const controlRef = useRef(new ControlClient());
  const followed = useRef(new Set<string>());
  const sending = useRef(new Set<string>());
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

  // Read by code that runs after an await and needs the workspace as last rendered, not as
  // it was when the closure was created.
  const workspaceRef = useRef(workspace);
  useEffect(() => { workspaceRef.current = workspace; }, [workspace]);
  // Same for the settings form, read when the coordinator's saved model arrives. Set at
  // commit so no fetch callback can see the form from a render ago.
  const settingsRef = useRef({ open: settingsOpen, settings, baseline: settingsBaseline });
  useLayoutEffect(() => { settingsRef.current = { open: settingsOpen, settings, baseline: settingsBaseline }; }, [settingsOpen, settings, settingsBaseline]);
  const live = Object.values(liveRuns);
  const conversationRuns = conversation ? live.filter((run) => run.conversation_id === conversation.id) : [];
  // What Steer and Stop act on in the open conversation: the run executing, else the first
  // one queued. `running` is about this conversation only; other agents keep working.
  const activeRun = conversationRuns.find((run) => run.state !== "queued") || conversationRuns[0] || null;
  const running = Boolean(activeRun);
  const anyRunning = live.length > 0;
  const busyAgents = new Set(live.map((run) => run.agent_id));
  // Everything any live run is waiting on, as the coordinator last reported it. Derived
  // rather than accumulated from events, so a reload, a resume past the request event, or
  // an answer given from another client all leave the banner telling the truth.
  const nameOf = (id: string) => workspace.agents.find((item) => item.id === id)?.name || "Your agent";
  // Saved before direct access and existing-desktop control were withdrawn: the coordinator
  // keeps the profile but refuses to run it until its Computer settings move into a container.
  const needsComputerSettings = (item: Agent) => Boolean(item.profile && !isSandboxedComputer(item.profile.computer));
  const suppressed = (id: string) => answered.some((entry) => entry.id === id && Date.now() - entry.at < ANSWER_GRACE_MS);
  const approvals = live.flatMap((run) => (run.pendingApprovals || []).filter((item) => !suppressed(item.approvalId)).map((item) => ({ ...item, runId: run.id, agentName: nameOf(run.agent_id) })));
  const inputs = live.flatMap((run) => (run.pendingInputs || []).filter((item) => !suppressed(item.inputId)).map((item) => ({ ...item, runId: run.id, agentName: nameOf(run.agent_id) })));

  function updateConversation(
    id: string,
    update: (c: Conversation) => Conversation,
  ) {
    setWorkspace((w) => ({
      ...w,
      conversations: w.conversations.map((c) => (c.id === id ? update(c) : c)),
    }));
  }
  // Puts a run the coordinator knows about into its conversation — creating the
  // conversation, or just the run's two messages, when this client has not seen it — and
  // follows it if it is still live. Safe to call for a run already shown: the message ids
  // are derived from the run, so nothing is added twice.
  function attachRun(run: PersistentRun, title = run.prompt.slice(0, 52)) {
    const known = workspaceRef.current.conversations
      .find((item) => item.id === run.conversation_id)?.messages
      .find((message) => message.runId === run.id);
    const mid = known?.id || replyId(run);
    const reply = { id: mid, runId: run.id, role: "assistant" as const, content: run.result || run.error || "", error: Boolean(run.error), activities: [], settled: !isLiveRun(run) };
    setWorkspace((current) => {
      const existing = current.conversations.find((item) => item.id === run.conversation_id);
      if (!existing) {
        return {
          ...current,
          conversations: [
            { id: run.conversation_id, agentId: run.agent_id, title, updatedAt: now(), messages: [{ id: promptId(run), role: "user", content: run.prompt }, reply] },
            ...current.conversations,
          ],
        };
      }
      if (existing.messages.some((message) => message.runId === run.id)) return current;
      return {
        ...current,
        conversations: current.conversations.map((item) => item.id !== existing.id ? item : {
          ...item,
          messages: [...item.messages, { id: promptId(run), role: "user", content: run.prompt }, reply],
          updatedAt: now(),
        }),
      };
    });
    if (isLiveRun(run)) follow(run, run.conversation_id, mid, run.agent_id, known?.eventCursor || 0, Boolean(known?.content));
  }
  // A client with no history of its own — a phone that just paired, a browser whose storage
  // was cleared — used to see the coordinator's agents and none of what they had done. The
  // coordinator keeps every run's prompt and outcome, which is enough to rebuild each
  // conversation this client is missing. Conversations it already has are merged instead:
  // a run started from another client is added, and a reply this client stopped watching
  // before the run finished is caught up from the coordinator's events.
  function hydrateHistory(remembered: RemoteConversation[]) {
    const known = workspaceRef.current;
    const catchUp: Array<{ run: PersistentRun; mid: string; cursor: number; hasText: boolean }> = [];
    const merged = new Map<string, Message[]>();
    const added: Conversation[] = [];
    for (const item of remembered) {
      // Delegated work is shown inside the run that asked for it, not as a chat of its own.
      const runs = item.runs.filter((run) => !run.parent_run_id);
      if (!runs.length) continue;
      const existing = known.conversations.find((conversation) => conversation.id === item.id);
      if (!existing) {
        // A conversation for an agent this workspace does not have would fail validation
        // on the next load and take the whole saved workspace down with it.
        if (!workspaceRef.current.agents.some((agent) => agent.id === item.agentId)) continue;
        added.push({
          id: item.id,
          agentId: item.agentId,
          title: item.title || runs[0].prompt.slice(0, 52),
          updatedAt: item.updatedAt || now(),
          messages: runs.flatMap((run) => [
            { id: promptId(run), role: "user" as const, content: run.prompt },
            { id: replyId(run), runId: run.id, role: "assistant" as const, content: run.result || run.error || "", error: Boolean(run.error), activities: [], settled: !isLiveRun(run) },
          ]),
        });
        continue;
      }
      let messages = existing.messages;
      for (const run of runs) {
        const reply = messages.find((message) => message.runId === run.id);
        if (!reply) {
          messages = [...messages, { id: promptId(run), role: "user", content: run.prompt }, { id: replyId(run), runId: run.id, role: "assistant", content: run.result || run.error || "", error: Boolean(run.error), activities: [], settled: !isLiveRun(run) }];
        } else if (!isLiveRun(run) && !reply.settled) {
          // Anything not marked final is caught up from where this client left off, partial
          // text included: a page closed after the first streamed words looks complete
          // and is not.
          catchUp.push({ run, mid: reply.id, cursor: reply.eventCursor || 0, hasText: Boolean(reply.content) });
        }
      }
      if (messages !== existing.messages) merged.set(item.id, messages);
    }
    if (added.length || merged.size) {
      setWorkspace((current) => ({
        ...current,
        conversations: [
          ...current.conversations.map((conversation) => merged.has(conversation.id) ? { ...conversation, messages: merged.get(conversation.id)! } : conversation),
          ...added.filter((conversation) => !current.conversations.some((existing) => existing.id === conversation.id)),
        // Newest first, like everything else in the sidebar, so a run another client made
        // just now is not hidden below a dozen older chats.
        ].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)),
      }));
    }
    for (const entry of catchUp) {
      const cid = remembered.find((item) => item.runs.some((run) => run.id === entry.run.id))!.id;
      void followRun(entry.run, cid, entry.mid, entry.run.agent_id, entry.cursor, entry.hasText, false).catch(() => {
        // The coordinator no longer has this run's events; say so rather than spin forever.
        updateConversation(cid, (current) => ({
          ...current,
          messages: current.messages.map((message) => message.id !== entry.mid ? message : {
            ...message,
            content: message.content || entry.run.result || entry.run.error || "This run's transcript is no longer available.",
            error: message.error || Boolean(entry.run.error),
            settled: true,
            activities: message.activities?.map((activity) => activity.status === "running" ? { ...activity, status: "error", detail: "Interrupted when the page closed." } : activity),
          }),
        }));
      });
    }
  }
  // Starts the one poller a live run gets. The entry in liveRuns is what the rest of the
  // page reads — which agent is busy, what Stop acts on, whether a message is still being
  // written — and it disappears when the run reaches a final state.
  function follow(run: PersistentRun, cid: string, mid: string, agentId: string, cursor = 0, hasText = false) {
    if (followed.current.has(run.id)) return;
    followed.current.add(run.id);
    setLiveRuns((current) => ({ ...current, [run.id]: run }));
    void followRun(run, cid, mid, agentId, cursor, hasText)
      .catch(() => setNotice("Lost contact with the local service while following this task. It is still running — reload to reattach."))
      .finally(() => {
        followed.current.delete(run.id);
        setLiveRuns((current) => { const next = { ...current }; delete next[run.id]; return next; });
        if (!followed.current.size) setReconnecting(false);
      });
  }
  useEffect(() => {
    const narrow = window.matchMedia("(max-width: 1000px)");
    const matchLayout = () => setInspector(!narrow.matches);
    const layoutTimer = window.setTimeout(matchLayout, 0);
    narrow.addEventListener("change", matchLayout);
    try {
      const saved = localStorage.getItem(STORAGE_KEY) || localStorage.getItem(LEGACY_STORAGE_KEY);
      // Hydrate browser-only persistence after the server-rendered first frame.
      if (saved) {
        const parsed = normalizeWorkspace(JSON.parse(saved));
        if (!parsed) throw new Error();
        // The coordinator owns active work. Preserve the last rendered activity until
        // reconnect replays authoritative events instead of implying that closing the
        // browser interrupted the task.
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setWorkspace(parsed);
        setSelectedAgent(parsed.agents[0].id);
      }
      if (localStorage.getItem(NOTIFY_KEY) === "on" && typeof Notification !== "undefined" && Notification.permission === "granted") setNotifyWhenDone(true);
      setAdvancedFeatures(localStorage.getItem(ADVANCED_KEY) !== "off");
      const prefs = localStorage.getItem(SETTINGS_KEY);
      if (prefs) {
        const p = JSON.parse(prefs);
        if (Object.hasOwn(PROVIDERS, p.provider) && typeof p.model === "string") {
          const remembered = { ...defaultSettings, ...p };
          setSettings(remembered);
          setSettingsBaseline(JSON.stringify(remembered));
        }
      }
    } catch {
      setNotice(
        "Saved data could not be loaded. Import a workspace backup or start fresh.",
      );
    }
    setReady(true);
    return () => {
      window.clearTimeout(layoutTimer);
      narrow.removeEventListener("change", matchLayout);
    };
  }, []);
  useEffect(() => {
    if (!ready) return;
    let cancelled = false;
    let retryTimer = 0;
    const connect = async () => {
      const client = controlRef.current;
      // The launcher opens http://localhost:3000/#pair=<code>. The code is read once, taken
      // out of the address bar before anything else happens, and exchanged only with this
      // page's own coordinator. A browser that already holds a token keeps working even if
      // the link it arrived with has been used.
      let linkFailure = "";
      const link = /^#pair=([^&#]+)$/.exec(window.location.hash);
      if (link) window.history.replaceState(null, "", window.location.pathname + window.location.search);
      // Either the fragment this page was opened with or one that arrived later (see the
      // hashchange listener); taken once, so a retry never exchanges the same code twice.
      const code = link ? link[1] : pendingPairCode.current;
      pendingPairCode.current = "";
      if (code) {
        try { await client.pair(decodeURIComponent(code)); }
        catch (error) { linkFailure = error instanceof Error ? error.message : "This browser connection link is invalid or expired."; }
      }
      try {
        const status = await client.bootstrap();
        if (cancelled) return;
        setPairing({ state: "none", message: "" });
        setRuntime(status);
        const synced = await client.request<{ agents: Agent[] }>("/v1/agents/sync", {
          method: "POST",
          body: JSON.stringify({ agents: workspace.agents }),
        });
        if (localStorage.getItem(MIGRATED_KEY) !== 'done') {
          await client.request("/v1/migrate", { method: "POST", body: JSON.stringify(workspace) });
          localStorage.setItem(MIGRATED_KEY, 'done');
        }
        if (workspace.teams.length) await client.request("/v1/teams/sync", { method: "POST", body: JSON.stringify({ teams: workspace.teams }) });
        const teamResult = await client.request<{ teams: Team[] }>("/v1/teams?includeRetired=1");
        if (!cancelled) {
          workspaceRef.current = { ...workspaceRef.current, agents: synced.agents };
          setWorkspace(current => ({ ...current, teams: teamResult.teams.filter(team => !team.retiredAt), agents: synced.agents.map(agent => ({ ...agent, memory: current.agents.find(a => a.id === agent.id)?.memory || [] })) }));
          setRetiredTeams(teamResult.teams.filter(team => Boolean(team.retiredAt)));
          const defaults = await client.request<{ model: ModelChoice; revision: number }>("/v1/workspace/model/import", {
            method: "POST",
            body: JSON.stringify({ model: { provider: settings.provider, model: settings.model, baseUrl: settings.baseUrl || "", credentialRef: settings.credentialRef || "" } }),
          });
          const saved = { provider: defaults.model.provider as Provider, model: defaults.model.model, baseUrl: defaults.model.baseUrl, credentialRef: defaults.model.credentialRef };
          // This can land after Workspace settings was opened, even typed in. It is the
          // saved model, what the form is compared against; an edit already made stays.
          const form = settingsRef.current;
          if (!form.open || JSON.stringify(form.settings) === form.baseline) setSettings(saved);
          setSettingsBaseline(JSON.stringify(saved));
          setWorkspaceModelRevision(defaults.revision);
          if (localStorage.getItem(ONBOARDING_KEY) !== 'done') setOnboardingOpen(true);
        }
        try { const saved = await client.request<{ credentials: CredentialRecord[] }>("/v1/credentials"); if (!cancelled) setCredentials(saved.credentials); } catch {}
        const [{ routines: savedRoutines }, { runs }, history] = await Promise.all([
          client.request<{ routines: Array<Record<string, unknown>> }>(
            "/v1/routines",
          ),
          client.request<{ runs: PersistentRun[] }>("/v1/runs"),
          client.conversations(),
        ]);
        if (!cancelled) {
          setRoutines(savedRoutines);
          hydrateHistory(history.conversations);
          const liveNow = runs.filter(run => !run.parent_run_id && isLiveRun(run));
          for (const run of liveNow) attachRun(run);
          if (liveNow[0]) {
            setSelectedAgent(liveNow[0].agent_id);
            setConversationId(liveNow[0].conversation_id);
            setView("chat");
          }
        }
        if (!cancelled) setOffline("");
      } catch (error) {
        if (cancelled) return;
        if (error instanceof PairingRequiredError) {
          // Not an outage: the coordinator is there and refused an unpaired browser. Only a
          // fresh link from the launcher changes that, so there is nothing to retry on a timer.
          setPairing({ state: linkFailure ? "invalid" : "required", message: linkFailure || error.message });
          return;
        }
        setOffline(error instanceof Error ? error.message : "The local agent runtime is unavailable.");
        // First run needs the guide most when nothing is reachable yet, and the gate for it
        // used to sit inside the success path.
        if (localStorage.getItem(ONBOARDING_KEY) !== 'done') setOnboardingOpen(true);
        // Back off, but keep trying: starting the coordinator should be enough to recover
        // without reloading the page.
        const wait = Math.min(30_000, 2_000 * 2 ** Math.min(connectAttempt.current++, 4));
        retryTimer = window.setTimeout(() => { if (!cancelled) void connect(); }, wait);
      }
    };
    void connect();
    return () => {
      cancelled = true;
      if (retryTimer) window.clearTimeout(retryTimer);
    };
    // The one-time migration intentionally snapshots the hydrated browser workspace.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);
  // The sidebar's runtime label reads the bootstrap answer, which is otherwise only taken
  // at connection time; the first-run guide's checks and set-up actions change it. This
  // re-reads that one answer — no workspace sync, no history, and bootstrap()'s pairing
  // rules as they are. The coordinator serves it from a short-lived probe cache, so right
  // after a set-up action it can still describe the state before it: when the guide has
  // just reported the state it expects, ask again a few times until the two agree.
  const refreshRuntime = useCallback((expectAvailable?: boolean, attempt = 0) => {
    window.clearTimeout(runtimeRefresh.current);
    if (expectAvailable !== undefined) runtimeExpectation.current = expectAvailable;
    const expected = runtimeExpectation.current;
    controlRef.current.bootstrap().then(status => {
      setRuntime(status);
      if (expected === null || status.runtime.available === expected || attempt >= 3) { runtimeExpectation.current = null; return; }
      runtimeRefresh.current = window.setTimeout(() => refreshRuntime(undefined, attempt + 1), 2_500);
    }).catch(error => { if (error instanceof PairingRequiredError) setPairing({ state: "required", message: error.message }); });
  }, []);
  useEffect(() => () => window.clearTimeout(runtimeRefresh.current), []);
  // A link pasted into the address bar of a dashboard that is already open is a
  // same-document navigation: nothing reloads, so the read at the top of connect() never
  // sees it. The code is taken out of the address bar at once and the connection is
  // restarted the way Try again does — the attempt in flight is cancelled by the effect's
  // cleanup, the new one exchanges the code, then bootstraps and hydrates as usual. A later
  // link replaces an earlier one that has not been exchanged yet.
  useEffect(() => {
    const onHashChange = () => {
      const link = /^#pair=([^&#]+)$/.exec(window.location.hash);
      if (!link) return;
      window.history.replaceState(null, "", window.location.pathname + window.location.search);
      pendingPairCode.current = link[1];
      connectAttempt.current = 0;
      setRetrying(true);
      setReady(false);
      window.setTimeout(() => { setReady(true); setRetrying(false); }, 50);
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);
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
    if (!ready) return;
    const save = () => {
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(storable(workspace)));
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
      } catch {
        setNotice(
          "Browser storage is full or unavailable. Export a backup now to keep your work.",
        );
      }
    };
    const timer = window.setTimeout(save, 800);
    // Leaving within that delay used to drop the newest messages: a conversation whose run
    // was still streaming when the tab closed came back without the prompt it was sent.
    window.addEventListener("pagehide", save);
    return () => { window.clearTimeout(timer); window.removeEventListener("pagehide", save); };
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
    setConfirmCloseSettings(false);
    setSettingsOpen(true);
  };
  const closeSettings = () => { setConfirmCloseSettings(false); setSettingsOpen(false); };
  // Discarding puts the saved values back, so the next visit does not find the edits
  // still there and ask again.
  const discardSettings = () => { setSettings(JSON.parse(settingsBaseline)); closeSettings(); };
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
      if (followed.current.size || sending.current.size) e.preventDefault();
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
    attachRun(run, title);
    setSelectedAgent(run.agent_id);
    setConversationId(run.conversation_id);
    setView("chat");
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
  function handleEvent(
    event: RunEvent,
    cid: string,
    mid: string,
    agentId: string,
  ) {
    if (event.type === "memory")
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
  const EVENT_PAGE = 500;
  async function followRun(
    run: PersistentRun,
    cid: string,
    mid: string,
    agentId: string,
    startCursor = 0,
    hasExistingText = false,
    // false when catching a finished run up after the fact: the transcript is filled in,
    // but the run is not shown as live and nobody is notified about it.
    track = true,
  ) {
    let cursor = startCursor;
    let receivedStreamText = hasExistingText;
    let consecutiveFailures = 0;
    // A reply that already has text but no cursor got that text from the stored result,
    // not from this client's own stream. Playing the deltas into it from the start would
    // say everything twice; the terminal reconciliation below is what it needs.
    const replayText = !(startCursor === 0 && hasExistingText && !track);
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
      if (track) {
        setLiveRuns((current) => ({ ...current, [run.id]: snapshot.run }));
        // Fresh word from the coordinator about this run: anything it no longer lists as
        // pending was taken, so the optimistic suppression for it can go.
        const stillPending = new Set([...(snapshot.run.pendingApprovals || []).map((item) => item.approvalId), ...(snapshot.run.pendingInputs || []).map((item) => item.inputId)]);
        setAnswered((current) => current.some((entry) => entry.runId === run.id && !stillPending.has(entry.id)) ? current.filter((entry) => entry.runId !== run.id || stillPending.has(entry.id)) : current);
      }
      for (const item of snapshot.events) {
        cursor = Math.max(cursor, item.seq);
        const payload = item.payload || {};
        if (item.type === "message.delta") {
          const text = String(payload.text || payload.delta || payload.content || "");
          if (text && replayText) { receivedStreamText = true; handleEvent({ type: "text", text }, cid, mid, agentId); }
        } else if (item.type === "message.complete") {
          const text = String(payload.text || payload.content || "");
          if (text && !receivedStreamText && replayText) {
            receivedStreamText = true;
            handleEvent({ type: "text", text }, cid, mid, agentId);
          }
        } else if (
          item.type === "tool.start" ||
          item.type === "tool.generating" ||
          item.type === "tool.progress"
        ) {
          // The mock names these id/preview; the real gateway sends tool_id and a context
          // that can be an object. Both have to land in the same activity row.
          handleEvent(
            {
              type: "activity",
              activity: {
                id: String(payload.tool_call_id || payload.tool_id || payload.id || item.id),
                name: String(payload.name || payload.tool || "Hermes tool"),
                detail: describe(payload.preview ?? payload.context ?? payload.detail, "Running…"),
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
                id: String(payload.tool_call_id || payload.tool_id || payload.id || item.id),
                name: String(payload.name || payload.tool || "Hermes tool"),
                detail: describe(payload.result ?? payload.preview ?? payload.context, "Complete"),
                status: payload.error ? "error" : "done",
              },
            },
            cid,
            mid,
            agentId,
          );
        } else if (item.type === "approval.request") {
          // The banner itself comes from the run's pending list; this is only the nudge for
          // someone looking elsewhere, because an unanswered approval holds the agent's slot.
          notifyDone(`${agentNameFor(agentId)} needs your approval`, describe(payload.command ?? payload.description, "Hermes requests approval."));
        } else if (item.type === "clarify.request" || item.type === "secret.request" || item.type === "sudo.request") {
          notifyDone(`${agentNameFor(agentId)} has a question`, describe(payload.question ?? payload.prompt ?? payload.message, "Your agent needs an answer to continue."));
        } else if (item.type === "run.failed" || item.type === "run.interrupted") {
          const message = String(payload.error || "Run interrupted.");
          handleEvent({ type: "error", message }, cid, mid, agentId);
          notifyDone(`${agentNameFor(agentId)} stopped`, message);
        } else if (item.type === "run.cancelled") {
          // A stop used to leave an empty reply behind, as if the agent had said nothing.
          handleEvent({ type: "error", message: payload.stoppedWithParent ? "Stopped along with the task that delegated it." : "Stopped. Your completed work is saved." }, cid, mid, agentId);
        } else if (item.type === "run.completed" && payload.result && !receivedStreamText && replayText) {
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
        // A run that finished while nobody was watching can have more events than one
        // page holds; stopping at the first page dropped its result. Drain the rest first.
        if (snapshot.events.length >= EVENT_PAGE) continue;
        // The stored outcome is authoritative for what the reply says. Streamed text that
        // arrived is kept; a reply left empty, or a failure never written down, is filled
        // in from the run itself.
        const final = snapshot.run;
        updateConversation(cid, current => ({
          ...current,
          messages: current.messages.map(message => {
            if (message.id !== mid) return message;
            // A completed run's stored result is what the agent actually answered, so it
            // replaces whatever was streamed — partial text from a closed page, or text
            // that arrived twice. A run that ended any other way keeps what was streamed
            // and gets its error written under it if that never arrived.
            const missingError = final.error && !message.content.includes(final.error);
            const content = final.state === "completed" && final.result
              ? final.result
              : missingError
                ? (message.content ? `${message.content}\n\n${final.error}` : final.error!)
                : message.content || (final.state === "cancelled" ? "Stopped. Your completed work is saved." : final.state === "completed" ? "" : "Run interrupted.");
            return { ...message, content, settled: true, error: message.error || Boolean(final.error) || final.state !== "completed", activities: message.activities?.map(activity => activity.status === "running" ? { ...activity, status: final.state === "completed" ? "done" : "error" } : activity) };
          }),
        }));
        await refreshRuntimeFiles().catch(() => {});
        if (track && final.state === "completed") notifyDone(`${agentNameFor(agentId)} finished`, "Your task is done. Open Harness to see the result.");
        return final;
      }
      // A hidden tab still has a live run, but nobody is reading it. task-manager.tsx
      // already backs off the same way; polling twice a second behind another window
      // just burns the coordinator and re-renders this page for no one. A phone polls
      // slower still, on a radio and a battery; the event cursor means nothing is missed.
      await new Promise((resolve) => setTimeout(resolve, document.hidden ? 4000 : 500));
    }
  }
  async function send(text = input) {
    const prompt = text.trim();
    if (!prompt || !ready) return;
    if (testMode) {
      setNotice("Agent chat is disabled in automated test mode. Start Open Harness without mock mode to run a real agent.");
      return;
    }
    const cid = conversationId || uid();
    if (sending.current.has(cid)) return;
    const agentId = agent.id;
    // Steering and follow-ups go to this conversation's own run — never to whatever some
    // other agent is doing. A run that is only queued has nothing to steer yet.
    if (activeRun) {
      const steer = inputMode === "steer" && activeRun.state !== "queued";
      sending.current.add(cid);
      try {
        if (steer) {
          await controlRef.current.request(`/v1/runs/${activeRun.id}/steer`, {
            method: "POST",
            body: JSON.stringify({ text: prompt }),
          });
          setNotice("Guidance queued for the next tool boundary.");
        } else {
          const run = await controlRef.current.createRun({ agentId, conversationId: cid, prompt });
          updateConversation(cid, (c) => ({
            ...c,
            messages: [...c.messages, { id: promptId(run), role: "user", content: prompt }, { id: replyId(run), runId: run.id, role: "assistant", content: "", activities: [] }],
            updatedAt: now(),
          }));
          follow(run, cid, replyId(run), agentId);
          setNotice("Follow-up queued behind the current task.");
        }
        setInput("");
      } catch (error) {
        setNotice(error instanceof Error ? error.message : "Could not send guidance.");
      } finally {
        sending.current.delete(cid);
      }
      return;
    }
    if (!connected) {
      setNotice(
        runtime?.runtime.message ||
          "Start the local Hermes runtime before sending a task.",
      );
      return;
    }
    sending.current.add(cid);
    setInput("");
    const userMessage = { id: uid(), role: "user" as const, content: prompt };
    if (!conversationId) {
      setWorkspace((w) => ({
        ...w,
        conversations: [
          { id: cid, agentId, title: prompt.slice(0, 52), messages: [userMessage], updatedAt: now() },
          ...w.conversations,
        ],
      }));
      setConversationId(cid);
    } else {
      updateConversation(cid, (c) => ({ ...c, messages: [...c.messages, userMessage], updatedAt: now() }));
    }
    {
      try {
        const run = await controlRef.current.createRun({ agentId, conversationId: cid, prompt });
        // The reply appears once the coordinator has accepted the run, so its id can be
        // derived from the run's and a reload finds the same message.
        updateConversation(cid, (c) => ({ ...c, messages: [...c.messages, { id: replyId(run), runId: run.id, role: "assistant", content: "", activities: [] }] }));
        follow(run, cid, replyId(run), agentId);
      } catch (error) {
        const message = error instanceof Error ? error.message : "Something went wrong.";
        updateConversation(cid, (c) => ({ ...c, messages: [...c.messages, { id: uid(), role: "assistant", content: message, error: true, activities: [] }] }));
      } finally {
        sending.current.delete(cid);
      }
      return;
    }
  }
  // The open conversation's request first; anything another agent is waiting on still
  // shows, because it is holding that agent's slot until it is answered.
  const pendingApproval = approvals.find((item) => conversationRuns.some((run) => run.id === item.runId)) || approvals[0] || null;
  const pendingInput = inputs.find((item) => conversationRuns.some((run) => run.id === item.runId)) || inputs[0] || null;
  const resolveApproval = async (item: (typeof approvals)[number], decision: "approve" | "deny") => {
    setAnswering(item.approvalId);
    try {
      await controlRef.current.request(`/v1/runs/${item.runId}/approval`, { method: "POST", body: JSON.stringify({ approvalId: item.approvalId, decision }) });
      setAnswered((current) => [...current, { id: item.approvalId, runId: item.runId, at: Date.now() }]);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not send that decision.");
    } finally {
      setAnswering("");
    }
  };
  // What the agent asked, and any choices it offered. The real gateway's payloads vary by
  // request kind, so this reads the likely fields and falls back to something sayable.
  const inputQuestion = (item: (typeof inputs)[number]) => {
    const payload = item.payload || {};
    if (item.type === "secret") return describe(payload.prompt ?? payload.description ?? payload.name, "The agent needs a credential to continue. It is sent to the run, not shown in the transcript.");
    if (item.type === "sudo") return describe(payload.prompt ?? payload.reason ?? payload.command, "The agent needs your password to run a privileged command.");
    return describe(payload.question ?? payload.prompt ?? payload.message, "Your agent needs an answer to continue.");
  };
  const inputChoices = (item: (typeof inputs)[number]): string[] => {
    const raw = item.type === "clarify" ? item.payload?.options ?? item.payload?.choices : undefined;
    return Array.isArray(raw) ? raw.map((choice) => typeof choice === "string" ? choice : describe((choice as Record<string, unknown>)?.label ?? (choice as Record<string, unknown>)?.value ?? choice, "")).filter(Boolean) : [];
  };
  const inputAllowsMany = (item: (typeof inputs)[number]) => Boolean(item.payload?.multiple ?? item.payload?.allow_multiple ?? item.payload?.multi_select);
  const answerPendingInput = async (item: (typeof inputs)[number]) => {
    const draft = inputDraft.inputId === item.inputId ? inputDraft : { inputId: item.inputId, text: "", choices: [] };
    const text = draft.text.trim();
    // Typed text wins over picked choices; several choices only go together as a list
    // when the agent said more than one is fine.
    const value: string | string[] = item.type !== "clarify" ? draft.text : text ? text : inputAllowsMany(item) ? draft.choices : draft.choices[0] || "";
    if (!value.length) return;
    setAnswering(item.inputId);
    try {
      await controlRef.current.answerInput(item.runId, item.inputId, value);
      setAnswered((current) => [...current, { id: item.inputId, runId: item.runId, at: Date.now() }]);
      setInputDraft({ inputId: "", text: "", choices: [] });
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Could not send that answer.");
    } finally {
      setAnswering("");
    }
  };
  // What to show under a reply that has no text yet, which depends on where its run is.
  const pendingLabel = (run: PersistentRun) =>
    run.state === "queued" ? "Queued behind the current task…"
      : run.state === "waiting_approval" ? "Waiting for your approval…"
        : run.state === "waiting_input" ? "Waiting for your answer…"
          : reconnecting ? "Reconnecting — your agent is still working…" : "Working on it…";
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
  const visibleAgents = workspace.agents.filter(candidate => !advancedFeatures || agentTeamFilter === "all"
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
        {advancedFeatures && <button
          className={`nav-item ${view === "teams" ? "active" : ""}`}
          onClick={() => {
            setView("teams");
            setMobileOpen(false);
          }}
        >
          <Users size={16} /> Teams <span>{workspace.teams.length}</span>
        </button>}
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
              >
                <Avatar agent={a} />
                <div>
                  <strong>{a.name}</strong>
                  <small>{a.role}</small>
                </div>
                {busyAgents.has(a.id) && (
                  <LoaderCircle className="spin" size={12} aria-label={`${a.name} is working`} />
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
          <span className={`status-dot ${offline || pairing.state !== "none" ? "offline" : connected || testMode ? "" : "pending"}`} />
          {testMode ? "Automated test mode" : pairing.state !== "none" ? "Browser not paired" : offline ? "Not connected" : connected ? "Agent runtime ready" : "Agent runtime needs setup"}
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
          {advancedFeatures && <nav className="top-tabs" aria-label="Main workspace">
            <button className={view !== "tasks" ? "active" : ""} onClick={() => { if (view === "tasks") setView(lastWorkspaceView.current); }}>Workspace</button>
            <button className={view === "tasks" ? "active" : ""} onClick={() => { if (view !== "tasks") lastWorkspaceView.current = view; setView("tasks"); }}>Tasks</button>
          </nav>}
          <span className="badge">Open source · Yours to shape</span>
        </header>
        {advancedFeatures && view === "tasks" && <TaskManager agents={workspace.agents} teams={[...workspace.teams, ...retiredTeams]} client={controlRef.current} onOpenRun={openTaskRun} />}
        {advancedFeatures && view === "teams" && <TeamManager agents={workspace.agents} teams={workspace.teams} client={controlRef.current} onChanged={teams => { setWorkspace(current => ({ ...current, teams: teams.filter(team => !team.retiredAt) })); setRetiredTeams(teams.filter(team => Boolean(team.retiredAt))); }} />}
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
            {advancedFeatures && <div className="agent-team-filters" aria-label="Filter agents by team">
              <button className={agentTeamFilter === "all" ? "active" : ""} onClick={() => setAgentTeamFilter("all")}>All</button>
              {workspace.teams.map(team => <button className={agentTeamFilter === team.id ? "active" : ""} onClick={() => setAgentTeamFilter(team.id)} key={team.id}>{team.name}</button>)}
              <button className={agentTeamFilter === "unassigned" ? "active" : ""} onClick={() => setAgentTeamFilter("unassigned")}>Unassigned</button>
            </div>}
            <div className="agent-grid">
              {visibleAgents.map((a) => (
                <div className="agent-card-shell" key={a.id}>
                <button
                  className="agent-card"
                  onClick={() => openAgent(a.id)}
                  >
                  <Avatar agent={a} large />
                  <ArrowUpRight className="card-arrow" size={17} />
                  <h3>{a.name}</h3>
                  <div className="role">{a.role}</div>
                  {advancedFeatures && <div className="agent-team-badges">{workspace.teams.filter(team => team.memberAgentIds.includes(a.id)).slice(0, 2).map(team => <TeamBadge team={team} key={team.id} />)}{workspace.teams.filter(team => team.memberAgentIds.includes(a.id)).length > 2 && <small>+{workspace.teams.filter(team => team.memberAgentIds.includes(a.id)).length - 2}</small>}{!workspace.teams.some(team => team.memberAgentIds.includes(a.id)) && <span className="team-badge unassigned">Unassigned</span>}</div>}
                  <p>
                    {a.description ||
                      "Your custom agent. Give it a task and make it your own."}
                  </p>
                  <div className="card-footer">
                    <span className="status-dot" />
                    {busyAgents.has(a.id)
                      ? "Working on your task"
                      : needsComputerSettings(a)
                        ? "Needs new computer settings"
                        : "Ready when you are"}
                    <span>→</span>
                  </div>
                </button>
                <button className="agent-card-settings" onClick={() => setEditingAgent({ ...a })} aria-label={`Edit ${a.name} profile`} title="Agent settings"><SlidersHorizontal size={16} /></button>
                <div className="agent-card-tools">
                  <CredentialSwitcher agent={a} credentials={credentials} workspaceRef={settings.credentialRef || ""} workspaceProvider={settings.provider} client={controlRef.current} running={busyAgents.has(a.id)} onManage={() => setCredentialsOpen(true)} onSaved={profile => applySavedProfile(profile as AgentProfile)} />
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
                <CredentialSwitcher agent={agent} credentials={credentials} workspaceRef={settings.credentialRef || ""} workspaceProvider={settings.provider} client={controlRef.current} running={running} onManage={() => setCredentialsOpen(true)} onSaved={profile => applySavedProfile(profile as AgentProfile)} />
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
                          open={Boolean(m.runId && liveRuns[m.runId])}
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
                      {!m.content && m.runId && liveRuns[m.runId] && (
                        <div className="working">
                          <LoaderCircle size={13} className="spin" />
                          {pendingLabel(liveRuns[m.runId])}
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
                            if (activeRun)
                              void controlRef.current
                                .request<{ failures?: string[] }>(`/v1/runs/${activeRun.id}/stop`, { method: "POST" })
                                .then((result) => { if (result.failures?.length) setNotice(`The runtime has not confirmed that this task stopped: ${result.failures[0]}`); })
                                .catch((error) => setNotice(error instanceof Error ? error.message : "Could not stop this task."));
                          }}
                        >
                          <Square size={14} fill="currentColor" />
                        </button>
                        <button
                          className="run-mode"
                          type="button"
                          aria-label="Stop all runs"
                          onClick={() =>
                            void controlRef.current
                              .request<{ failures?: string[] }>("/v1/runs/stop-all", { method: "POST" })
                              .then((result) => { if (result.failures?.length) setNotice(`The runtime has not confirmed that all tasks stopped: ${result.failures[0]}`); })
                              .catch((error) => setNotice(error instanceof Error ? error.message : "Could not stop the running tasks."))
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
                {needsComputerSettings(agent) && (
                  <div className="approval-banner computer-blocked-banner" role="alert">
                    <ShieldAlert size={18} />
                    <div>
                      <strong>{agent.name} needs new computer settings</strong>
                      <p>It was set to work directly on this computer, which is no longer available because it ran outside the sandbox. Move it to a private agent desktop or a private workspace to continue.</p>
                    </div>
                    <button className="light-button" type="button" onClick={() => { setEditingAgentTab("computer"); setEditingAgent({ ...agent }); }}>Open Computer settings</button>
                  </div>
                )}
                {pendingApproval && (
                  <div className="approval-banner" role="alert">
                    <ShieldCheck size={18} />
                    <div>
                      <strong>
                        {pendingApproval.agentName} needs approval
                        {approvals.length > 1 && <span className="approval-count"> · {approvals.length - 1} more waiting</span>}
                      </strong>
                      <p>{pendingApproval.detail}</p>
                    </div>
                    <button className="subtle-button" disabled={answering === pendingApproval.approvalId} onClick={() => void resolveApproval(pendingApproval, "deny")}>Deny</button>
                    <button className="light-button" disabled={answering === pendingApproval.approvalId} onClick={() => void resolveApproval(pendingApproval, "approve")}>Approve once</button>
                  </div>
                )}
                {pendingInput && (
                  <form
                    className="approval-banner input-banner"
                    aria-label={`${pendingInput.agentName} has a question`}
                    onSubmit={(e) => { e.preventDefault(); void answerPendingInput(pendingInput); }}
                  >
                    <MessageSquare size={18} />
                    <div role="alert">
                      <strong>
                        {pendingInput.type === "secret" ? `${pendingInput.agentName} needs a secret` : pendingInput.type === "sudo" ? `${pendingInput.agentName} needs your password` : `${pendingInput.agentName} has a question`}
                        {inputs.length > 1 && <span className="approval-count"> · {inputs.length - 1} more waiting</span>}
                      </strong>
                      <p>{inputQuestion(pendingInput)}</p>
                      {inputChoices(pendingInput).length > 0 && (
                        <div className="input-choices" role="group" aria-label="Choices">
                          {inputChoices(pendingInput).map((choice) => {
                            const picked = inputDraft.inputId === pendingInput.inputId && inputDraft.choices.includes(choice);
                            return (
                              <button
                                type="button"
                                key={choice}
                                className={`run-mode ${picked ? "active" : ""}`}
                                aria-pressed={picked}
                                onClick={() => setInputDraft((current) => {
                                  const base = current.inputId === pendingInput.inputId ? current : { inputId: pendingInput.inputId, text: "", choices: [] };
                                  const chosen = base.choices.includes(choice) ? base.choices.filter((item) => item !== choice) : inputAllowsMany(pendingInput) ? [...base.choices, choice] : [choice];
                                  return { ...base, choices: chosen };
                                })}
                              >
                                {choice}
                              </button>
                            );
                          })}
                        </div>
                      )}
                      <input
                        type={pendingInput.type === "clarify" ? "text" : "password"}
                        autoComplete={pendingInput.type === "clarify" ? "off" : "new-password"}
                        aria-label={pendingInput.type === "secret" ? "Secret value" : pendingInput.type === "sudo" ? "Password" : "Your answer"}
                        placeholder={pendingInput.type === "clarify" ? (inputChoices(pendingInput).length ? "Or type your own answer" : "Type your answer") : "Not shown to the agent's transcript"}
                        value={inputDraft.inputId === pendingInput.inputId ? inputDraft.text : ""}
                        onChange={(e) => setInputDraft({ inputId: pendingInput.inputId, text: e.target.value, choices: inputDraft.inputId === pendingInput.inputId ? inputDraft.choices : [] })}
                        maxLength={10000}
                      />
                    </div>
                    <button
                      className="light-button"
                      type="submit"
                      disabled={answering === pendingInput.inputId || !(inputDraft.inputId === pendingInput.inputId && (inputDraft.text.trim() || inputDraft.choices.length))}
                    >
                      {answering === pendingInput.inputId ? "Sending…" : "Send answer"}
                    </button>
                  </form>
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
                        const drop = () => setWorkspace((w) => ({ ...w, files: w.files.filter((x) => x.id !== f.id) }));
                        if (!runtime) { drop(); return; }
                        void controlRef.current
                          .request(`/v1/files?scope=shared&name=${encodeURIComponent(f.name)}`, { method: "DELETE" })
                          .then(drop)
                          .catch((error) => setNotice(error instanceof Error ? `${f.name} was not deleted: ${error.message}` : `${f.name} could not be deleted.`));
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
      {pairing.state !== "none" && (
        <div className="offline-banner pairing-gate" role="alert">
          <ShieldAlert size={15} />
          <span>
            <strong>{pairing.state === "invalid" ? "This link has already been used or has expired." : "This browser isn’t paired with Open Harness."}</strong>
            <small>{pairing.state === "invalid" ? "Run Start Open Harness again; it opens a freshly paired window. Each link works once and expires after a few minutes." : "Run Start Open Harness (or launchers/start.sh) to open a paired window. Open Harness itself is running; only this browser is not connected to it."}</small>
          </span>
          <button
            className="subtle-button"
            disabled={retrying}
            onClick={() => {
              setRetrying(true);
              connectAttempt.current = 0;
              setReady(false);
              window.setTimeout(() => { setReady(true); setRetrying(false); }, 50);
            }}
          >
            Try again
          </button>
        </div>
      )}
      {offline && (
        <div className="offline-banner" role="alert">
          <CircleAlert size={15} />
          <span>
            <strong>Open Harness cannot reach its control service.</strong>
            <small>{offline} Agents and tasks already running are unaffected. Start it with <code>npm run dev</code>, or check <code>npm run harness:doctor</code>.</small>
          </span>
          <button
            className="subtle-button"
            disabled={retrying}
            onClick={() => {
              setRetrying(true);
              connectAttempt.current = 0;
              setReady(false);
              window.setTimeout(() => { setReady(true); setRetrying(false); }, 50);
            }}
          >
            {retrying ? "Reconnecting…" : "Try again"}
          </button>
        </div>
      )}
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
                    <button type="button" className="task-primary" onClick={discardSettings}>Discard changes</button>
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
                          ? ""
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
              {settings.provider === "local" && <label>Model API base URL<input value={settings.baseUrl || ""} onChange={e => setSettings(current => ({ ...current, baseUrl: e.target.value }))} placeholder="https://models.example.com/v1" /><small>Use an address reachable from the agent container.</small></label>}
              <p className="muted small">Only agents using “Use workspace default” follow these changes. Agents with their own model keep it.</p>
            </fieldset>
            <div className="settings-divider" />
            <label className="settings-feature-toggle">
              <input
                type="checkbox"
                checked={advancedFeatures}
                onChange={(event) => {
                  const enabled = event.target.checked;
                  setAdvancedFeatures(enabled);
                  if (!enabled) {
                    setAgentTeamFilter("all");
                    if (["teams", "tasks"].includes(view)) setView("home");
                  }
                  localStorage.setItem(ADVANCED_KEY, enabled ? "on" : "off");
                }}
              />
              <span><strong>Advanced features</strong><small>Show teams, task boards, MCP connections, and computer reservations and resource limits. Turn this off for a simpler workspace of agents, conversations and files.</small></span>
            </label>
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
                disabled={anyRunning}
                onClick={() => importRef.current?.click()}
              >
                <FolderOpen size={14} /> Import backup
              </button>
            </div>
            <div className="modal-footer">
              <span className="muted small">
                MIT licensed · Open Harness v{runtime?.version || APP_VERSION} · Hermes {runtime?.hermes.release}
              </span>
              <button
                className="light-button"
                onClick={async () => {
                  try {
                    const checked = await controlRef.current.request<{ ok: boolean; message: string; model?: ModelChoice; revision?: number }>("/v1/onboarding/model-test", {
                      method: "POST",
                      body: JSON.stringify({ model: { provider: settings.provider, model: settings.model, baseUrl: settings.baseUrl || "", credentialRef: settings.credentialRef || "" }, save: true, revision: workspaceModelRevision }),
                    });
                    if (!checked.ok) {
                      setNotice(checked.message);
                      return;
                    }
                    if (checked.revision !== undefined) setWorkspaceModelRevision(checked.revision);
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
        const chosen = { provider: model.provider as Provider, model: model.model, baseUrl: model.baseUrl, credentialRef: model.credentialRef };
        setSettings(chosen);
        setSettingsBaseline(JSON.stringify(chosen));
        setWorkspaceModelRevision(revision);
        void controlRef.current.request<{ credentials: CredentialRecord[] }>("/v1/credentials").then(saved => setCredentials(saved.credentials)).catch(() => {});
        localStorage.setItem(SETTINGS_KEY, JSON.stringify({ provider: model.provider, model: model.model, baseUrl: model.baseUrl }));
      }} onComputerSettings={() => {
        setAdvancedFeatures(true);
        localStorage.setItem(ADVANCED_KEY, 'on');
        setOnboardingOpen(false);
        refreshRuntime();
        setEditingAgentTab('computer');
        setEditingAgent(agent);
      }} onDismiss={() => {
        setOnboardingOpen(false);
        refreshRuntime();
      }} onFinished={() => {
        localStorage.setItem(ONBOARDING_KEY, 'done');
        setOnboardingOpen(false);
        refreshRuntime();
      }} onRuntimeChecked={status => refreshRuntime(status.executionReady)} />}
      {editingAgent && <AgentSettings key={`${editingAgent.id}:${editingAgentTab}`} initialTab={editingAgentTab} advancedFeatures={advancedFeatures} agent={editingAgent} client={controlRef.current} onClose={() => { setEditingAgent(null); setEditingAgentTab('profile'); }} onSaved={applySavedProfile} onManageCredentials={() => setCredentialsOpen(true)} />}
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
  const files = (Array.isArray(source.files) ? source.files : []).filter(storableFile);
  const normalized = { ...source, version: 2 as const, files, teams: Array.isArray(source.teams) ? source.teams : [] } as unknown as Workspace;
  return validWorkspace(normalized) ? normalized : null;
}

const FILE_CONTENT_LIMIT = 100_000;
function storableFile(file: unknown): file is Artifact {
  const value = file as Artifact | null;
  return Boolean(value && typeof value.id === "string" && typeof value.name === "string" && typeof value.content === "string" && value.content.length <= FILE_CONTENT_LIMIT && typeof value.agentId === "string" && typeof value.updatedAt === "string");
}
// What goes to browser storage must be readable back. A runtime file bigger than the limit is
// left out rather than saved in a shape that would invalidate the whole record on the next load.
function storable(value: Workspace): Workspace {
  const files = value.files.filter(storableFile);
  return files.length === value.files.length ? value : { ...value, files };
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
