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
  type Message,
  type RunEvent,
} from "../lib/types";
import { PROVIDERS, type Provider } from "../lib/provider";
import {
  ControlClient,
  PairingRequiredError,
  isLiveRun,
  isRemoteOrigin,
  selfHostedHubUrl,
  type PersistentRun,
  type RemoteConversation,
  type RuntimeStatus,
} from "../lib/control-client";

import AgentSettings from "../components/agent-settings";
import Onboarding from "../components/onboarding";
import TaskManager from "../components/task-manager";
import { profileAgent, type ModelChoice } from "../lib/agent-profile";
import { HubConnect } from "../components/hub-connect";
import { type DeviceCredential } from "../lib/hub";
import { PHONE_LAYOUT_QUERY, eventPollIntervalMs, isPhoneLayout, notificationsGranted, notify, platformFetch, requestNotificationPermission, secureStore } from "../lib/platform";
import { useBackGuard } from "../lib/back-guard";
import { trackKeyboardInset } from "../lib/platform";

const STORAGE_KEY = "open-harness.workspace.v1";
const SETTINGS_KEY = "open-harness.settings.v1";
const ONBOARDING_KEY = "open-harness.onboarding.v1";
// Kept apart from SETTINGS_KEY on purpose: the onboarding save rewrites that whole
// blob, which would silently drop anything else stored alongside it.
const NOTIFY_KEY = "open-harness.notify.v1";
type View = "home" | "chat" | "files" | "routines" | "tasks";
// credentialRef is the coordinator's name for the saved key. It used to be derivable from
// the provider; a key saved through the tested save gets a generated name, so it has to
// travel with the settings.
type ModelSettings = { provider: Provider; model: string; maxSteps?: number; baseUrl?: string; credentialRef?: string };
const providerCredential = (provider: string) => ({ xai: "XAI_API_KEY", openai: "OPENAI_API_KEY", openrouter: "OPENROUTER_API_KEY" } as Record<string, string>)[provider] || "";
const modelChoice = (settings: ModelSettings): ModelChoice => ({ provider: settings.provider, model: settings.model, baseUrl: settings.baseUrl || "", credentialRef: settings.credentialRef ?? providerCredential(settings.provider) });
const modelSettings = (model: ModelChoice): ModelSettings => ({ provider: model.provider as Provider, model: model.model, baseUrl: model.baseUrl, credentialRef: model.credentialRef });
const defaultSettings: ModelSettings = {
  provider: "xai",
  model: PROVIDERS.xai.model,
};
const uid = () => crypto.randomUUID();
// A run's messages get ids derived from the run, so every path that learns about a run —
// sending it, recovering it after a reload, opening it from the task board, another client
// having started it — lands on the same two messages instead of a duplicate pair.
const promptId = (run: Pick<PersistentRun, "id">) => `prompt:${run.id}`;
const replyId = (run: Pick<PersistentRun, "id">) => `reply:${run.id}`;
const isGuided = (run: Pick<PersistentRun, "id">) => run.id.startsWith("guided:");
// A tool id as a person would say it. MCP tools arrive as `mcp__server__tool` from the
// running gateway and as `mcp_server_tool` in saved grants; either way the prefix is noise.
const toolLabel = (id: string) => id.replace(/^mcp_+/, "").replace(/_+/g, " ").trim() || id;
// One line of text for a payload field that the mock sends as a string and the real Hermes
// gateway as an object: a tool's context, its result, a question with options. An object
// gets its most text-like field, or a compact dump short enough for an activity row.
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
async function download(name: string, content: string, type = "text/plain", encoding: "utf8" | "base64" = "utf8"): Promise<void> {
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
  const [ready, setReady] = useState(false);
  // These all start in the state the prerendered HTML was built with, and are corrected in an
  // effect after mount. Deciding any of them during the first render instead would make the
  // client disagree with the server and throw away the hydrated markup.
  //
  // Layout and authentication are independent: a narrow local browser can bootstrap,
  // while a remote browser pairs for its own credential.
  const [phone, setPhone] = useState(false);
  const [pairs, setPairs] = useState(false);
  // A remote browser is allowed to try the control token first, because an operator may have
  // accepted responsibility for authenticating in front of it. This flips when that is
  // refused, which is the coordinator telling us to pair instead.
  const [pairingRequired, setPairingRequired] = useState(false);
  // 'unknown' means "still looking for a stored pairing", which keeps the pairing screen from
  // flashing at someone who is already connected. It is also the *initial* value on purpose:
  // effects run in declaration order but each one sees the state of the render it was created
  // in, so starting at null let the connect effect below ask for a control token in the same
  // pass that this one began looking for a credential. A stored pairing then lost a race with
  // its own restore.
  const [device, setDevice] = useState<DeviceCredential | null | 'unknown'>('unknown');
  const [view, setView] = useState<View>("home");
  const lastWorkspaceView = useRef<View>("home");
  const [selectedAgent, setSelectedAgent] = useState("atlas");
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [settings, setSettings] = useState<ModelSettings>(defaultSettings);
  const [apiKey, setApiKey] = useState("");
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
  // Every run this client is following, keyed by run id, at its latest known state. Runs
  // belong to conversations, not to the page: the coordinator executes two agents at once
  // and queues a follow-up behind the run ahead of it, and a single "current run" slot sent
  // steering and stops to whichever run happened to hold it — another agent's, after a
  // switch — and had nowhere to put a queued follow-up's result.
  const [liveRuns, setLiveRuns] = useState<Record<string, PersistentRun>>({});
  const [runtime, setRuntime] = useState<RuntimeStatus | null>(null);
  // Requests answered from here but not yet gone from the coordinator's next snapshot, so
  // the banner cannot be clicked twice, plus the one being sent right now. The coordinator
  // is the authority: an entry is dropped as soon as a fresh snapshot of its run no longer
  // lists the request, and after a short while regardless, because a remote runner can
  // fail to take the answer and the coordinator then reopens the same request.
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
  const [notifyWhenDone, setNotifyWhenDone] = useState(false);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [inspector, setInspector] = useState(true);
  const abortRef = useRef<AbortController | null>(null);
  const controlRef = useRef(new ControlClient());
  // Run ids with a follower loop, kept in sync so a run learned about twice — recovered on
  // connect and then opened from the task board, say — gets one poller, not two.
  const followed = useRef(new Set<string>());
  // Conversations with a run creation in flight: Enter pressed twice before the coordinator
  // answers must not create two runs.
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
  const connected = Boolean(runtime?.runtime.available);
  // Read by code that runs after an await and needs the workspace as last rendered, not as
  // it was when the closure was created.
  const workspaceRef = useRef(workspace);
  useEffect(() => { workspaceRef.current = workspace; }, [workspace]);
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
  const suppressed = (id: string) => answered.some((entry) => entry.id === id && Date.now() - entry.at < ANSWER_GRACE_MS);
  const approvals = live.flatMap((run) => (run.pendingApprovals || []).filter((item) => !suppressed(item.approvalId)).map((item) => ({ ...item, runId: run.id, agentName: nameOf(run.agent_id) })));
  const inputs = live.flatMap((run) => (run.pendingInputs || []).filter((item) => !suppressed(item.inputId)).map((item) => ({ ...item, runId: run.id, agentName: nameOf(run.agent_id) })));

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
            // A reply for a coordinator run is reconciled against the coordinator once
            // connected, so its unfinished steps are left as they are; only the guided
            // demonstration has nothing to reconcile against.
            messages: c.messages.map((m) => m.runId ? m : ({
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
      if (localStorage.getItem(NOTIFY_KEY) === "on") void notificationsGranted().then(granted => { if (granted) setNotifyWhenDone(true); });
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
  // Resolve what kind of client this is, and restore any pairing from a previous visit. Until
  // that resolves a pairing client shows nothing, because either answer leads somewhere
  // different: the dashboard or the pairing screen.
  useEffect(() => {
    // Deliberately after mount rather than in initial state: all of these read window, and
    // deciding them during the first render would make the client disagree with the
    // prerendered HTML and throw it away.
    const mayPair = isRemoteOrigin();
    // Reading the screen and the runtime is exactly the "subscribe to an external system"
    // case the rule carves out; it cannot happen before mount without breaking hydration.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPhone(isPhoneLayout());
    setPairs(mayPair);
    // Below 1000px the workspace panel is a fixed overlay on the right (see globals.css),
    // 270px wide over a 390px phone. Open by default, it sat on top of the composer's send
    // button in every conversation until closed by hand. It stays a tap away.
    if (typeof window.matchMedia === 'function' && window.matchMedia('(max-width: 1000px)').matches) setInspector(false);
    // Every client resolves this before connecting, so a credential from a previous visit
    // always wins over asking for the control token.
    setDevice('unknown');
    let cancelled = false;
    void (async () => {
      const saved = await secureStore.get<DeviceCredential>('device.v1');
      if (cancelled) return;
      const paired = saved?.token && saved.hubUrl ? saved : null;
      // A stored credential is authoritative even when this load does not look remote. It
      // was issued to this device and is scoped far more tightly than the control token,
      // so there is never a reason to prefer the token once one exists.
      if (paired || mayPair) {
        if (paired) { setPairs(true); setPairingRequired(false); }
        const transport = await platformFetch();
        if (cancelled) return;
        controlRef.current.useDevice(paired, transport);
      }
      setDevice(paired);
    })();
    return () => { cancelled = true; };
  }, []);

  // Keep the composer above a browser's soft keyboard.
  useEffect(() => trackKeyboardInset(), []);

  // The screen can change category without a reload: a rotated tablet, a resized desktop
  // window, a foldable opening. Layout follows it; how the client authenticates does not.
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia(PHONE_LAYOUT_QUERY);
    const sync = () => setPhone(isPhoneLayout());
    query.addEventListener('change', sync);
    return () => query.removeEventListener('change', sync);
  }, []);

  const onPaired = async (credential: DeviceCredential) => {
    await secureStore.set('device.v1', credential);
    controlRef.current.useDevice(credential, await platformFetch());
    setPairs(true);
    setDevice(credential);
  };
  const onUnpaired = async () => {
    await secureStore.remove('device.v1');
    controlRef.current.useDevice(null, await platformFetch());
    setDevice(null);
    setRuntime(null);
  };

  // Keep the revocable device session alive while the companion is open. This is a status
  // heartbeat only: paired clients never poll runner commands or execute agent work.
  useEffect(() => {
    if (!pairs || !device || device === 'unknown') return;
    let cancelled = false;
    const refreshSession = async () => {
      try {
        const status = await controlRef.current.bootstrap();
        if (!cancelled) setRuntime(status);
      } catch (error) {
        if (cancelled) return;
        const message = error instanceof Error ? error.message : 'Could not reach your Open Harness hub.';
        if (message.includes('no longer paired')) {
          await secureStore.remove('device.v1');
          controlRef.current.useDevice(null, await platformFetch());
          setDevice(null); setRuntime(null); setPairingRequired(true);
        }
        setNotice(message);
      }
    };
    const onVisible = () => { if (document.visibilityState === 'visible') void refreshSession(); };
    const timer = window.setInterval(() => void refreshSession(), 30_000);
    document.addEventListener('visibilitychange', onVisible);
    return () => { cancelled = true; window.clearInterval(timer); document.removeEventListener('visibilitychange', onVisible); };
  }, [pairs, device]);

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
        if (!known.agents.some((agent) => agent.id === item.agentId)) continue;
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
    if (!ready) return;
    // Still looking for a stored credential; either answer changes where this goes.
    if (device === 'unknown') return;
    // Try bootstrap first; a refused control token opens the pairing screen.
    let cancelled = false;
    const connect = async () => {
      try {
        const client = controlRef.current;
        const status = await client.bootstrap();
        if (cancelled) return;
        setRuntime(status);
        // A remote client joins a workspace that already exists. Syncing its local starter
        // agents the way a first-run desktop does would push them into someone's established
        // hub and migrate a browser workspace that was never theirs, so it reads instead.
        const paired = pairs;
        const synced = paired
          ? await client.request<{ agents: Agent[] }>("/v1/agents")
          : await client.request<{ agents: Agent[] }>("/v1/agents/sync", {
              method: "POST",
              body: JSON.stringify({ agents: workspace.agents }),
            });
        if (!paired) {
          await client.request("/v1/migrate", {
            method: "POST",
            body: JSON.stringify(workspace),
          });
        }
        if (!cancelled) {
          setWorkspace(current => ({ ...current, agents: synced.agents.map(agent => ({ ...agent, memory: current.agents.find(a => a.id === agent.id)?.memory || [] })) }));
          const defaults = paired
            ? await client.request<{ model: ModelChoice; revision: number }>("/v1/workspace/model")
            : await client.request<{ model: ModelChoice; revision: number }>("/v1/workspace/model/import", {
                method: "POST",
                body: JSON.stringify({ model: modelChoice(settings) }),
              });
          setSettings(modelSettings(defaults.model));
          setWorkspaceModelRevision(defaults.revision);
          // Joining an existing hub must not force setup on a paired browser.
          // Paired operators can open coordinator setup from the empty state or settings.
          if (!paired && localStorage.getItem(ONBOARDING_KEY) !== 'done') setOnboardingOpen(true);
        }
        const [{ routines: savedRoutines }, { conversations: remembered }] = await Promise.all([
          client.request<{ routines: Array<Record<string, unknown>> }>(
            "/v1/routines",
          ),
          client.conversations(),
        ]);
        if (!cancelled) {
          setRoutines(savedRoutines);
          hydrateHistory(remembered);
          // Every live run, not just the first: two agents can be mid-task, and a follow-up
          // queued behind one of them is a run of its own. The newest is the one opened.
          const liveNow = remembered
            .flatMap((item) => item.runs)
            .filter((run) => !run.parent_run_id && isLiveRun(run))
            .sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")));
          for (const run of liveNow) attachRun(run);
          if (liveNow[0]) {
            setSelectedAgent(liveNow[0].agent_id);
            setConversationId(liveNow[0].conversation_id);
            setView("chat");
          }
        }
      } catch (error) {
        if (cancelled) return;
        const message = error instanceof Error ? error.message : "";
        // The coordinator declined to hand this browser the control token. That is a healthy
        // service refusing an unsafe thing, so offer the pairing screen rather than an error.
        if (error instanceof PairingRequiredError) { setPairingRequired(true); return; }
        if (pairs) {
          // A credential the hub has revoked is not coming back. Forgetting it here is what
          // returns the client to the pairing screen; otherwise it would sit on a dashboard
          // of starter agents with a notice about npm commands it cannot run.
          if (message.includes("no longer paired")) { await onUnpaired(); setPairingRequired(true); setNotice("This device is no longer paired. Connect it to your hub again."); }
          else setNotice(message || "Could not reach your Open Harness hub.");
          return;
        }
        setNotice(message ? `${message} Run npm run harness:doctor, then npm run dev.` : "The local agent runtime is unavailable.");
      }
    };
    void connect();
    return () => {
      cancelled = true;
    };
    // The one-time migration intentionally snapshots the hydrated browser workspace.
    // device and pairs are listed so pairing connects immediately; without them the client
    // would sit on its starter workspace until the next launch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, pairs, device]);
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
  const saveDownload = async (name: string, content: string, type?: string, encoding?: "utf8" | "base64") => {
    try {
      await download(name, content, type, encoding);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : `Could not save ${name}.`);
    }
  };
  // Notify only while the page is hidden; the foreground already shows a banner.
  const notifyDone = (title: string, body: string) => {
    if (!notifyWhenDone || !document.hidden) return;
    void notify(title, body, "open-harness-run");
  };
  const toggleNotifications = async () => {
    if (notifyWhenDone) { setNotifyWhenDone(false); localStorage.setItem(NOTIFY_KEY, "off"); return; }
    if (!(await requestNotificationPermission())) {
      setNotice(typeof Notification === "undefined"
          ? "This browser cannot show desktop notifications."
          : "Your browser blocked notifications for Open Harness. Allow them in its site settings to turn this on.");
      return;
    }
    setNotifyWhenDone(true); localStorage.setItem(NOTIFY_KEY, "on");
  };

  const settingsSnapshot = () => JSON.stringify({ settings, apiKey });
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
  useEffect(() => { escapeSettingsRef.current = () => { if (settingsOpen) requestCloseSettings(); }; });

  // Browser Back closes the top overlay on small screens. Scoped to
  // phone-shaped clients: on a desktop browser Back is a navigation control people expect to
  // leave the page. Ordered outermost-last so the topmost overlay is the one that closes.
  useBackGuard(phone && mobileOpen, () => setMobileOpen(false));
  useBackGuard(phone && Boolean(selectedFile), () => setSelectedFile(null));
  useBackGuard(phone && Boolean(docEditor) && !docBusy, () => setDocEditor(null));
  useBackGuard(phone && Boolean(routineDraft), () => setRoutineDraft(null));
  useBackGuard(phone && onboardingOpen, () => setOnboardingOpen(false));
  useBackGuard(phone && view === "chat" && inspector, () => setInspector(false));
  // Routed through the same guard the close button uses, so Back asks before discarding an
  // unsaved model change or a pasted key rather than throwing it away.
  useBackGuard(phone && settingsOpen, () => requestCloseSettings());

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
      if (followed.current.size) e.preventDefault();
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
  // The coordinator hands out events 500 at a time, so a page that is full may not be the
  // last one even when the run has already finished.
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
      await new Promise((resolve) => setTimeout(resolve, eventPollIntervalMs(document.hidden)));
    }
  }
  async function send(text = input, guided = false) {
    const prompt = text.trim();
    if (!prompt || !ready) return;
    const cid = conversationId || uid();
    if (sending.current.has(cid)) return;
    const agentId = agent.id;
    // Steering and follow-ups go to this conversation's own run — never to whatever some
    // other agent is doing. A run that is only queued has nothing to steer yet.
    if (activeRun && !guided) {
      const steer = inputMode === "steer" && activeRun.state !== "queued" && !isGuided(activeRun);
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
    if (!guided && !connected) {
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
    if (!guided) {
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
    // The guided demonstration is scripted here rather than run by the coordinator. It is
    // still a run as far as this conversation is concerned: it occupies the composer, can
    // be stopped, and finishes.
    const mid = uid();
    const guidedRun: PersistentRun = { id: `guided:${mid}`, agent_id: agentId, conversation_id: cid, prompt, state: "running" };
    updateConversation(cid, (c) => ({ ...c, messages: [...c.messages, { id: mid, role: "assistant", content: "", activities: [] }] }));
    setLiveRuns((current) => ({ ...current, [guidedRun.id]: guidedRun }));
    const controller = new AbortController();
    abortRef.current = controller;
    const emit = (event: RunEvent) => handleEvent(event, cid, mid, agentId);
    try {
      {
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
      sending.current.delete(cid);
      setLiveRuns((current) => { const next = { ...current }; delete next[guidedRun.id]; return next; });
      abortRef.current = null;
    }
  }
  // Stop acts on the open conversation's run; the guided demonstration is stopped here,
  // everything else by the coordinator, which also stops anything it delegated.
  const stopActiveRun = () => {
    if (!activeRun) return;
    if (isGuided(activeRun)) { abortRef.current?.abort(); return; }
    void controlRef.current.request(`/v1/runs/${activeRun.id}/stop`, { method: "POST" })
      .catch((error) => setNotice(error instanceof Error ? error.message : "Could not stop that run."));
  };
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
            // A reply for a coordinator run is reconciled against the coordinator once
            // connected, so its unfinished steps are left as they are; only the guided
            // demonstration has nothing to reconcile against.
            messages: c.messages.map((m) => m.runId ? m : ({
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

  const agentDialogs = <>
      {onboardingOpen && runtime && <Onboarding remote={pairs} client={controlRef.current} model={modelChoice(settings)} revision={workspaceModelRevision} onModelSaved={(model, revision) => {
        const adopted = modelSettings(model);
        setSettings(adopted);
        setWorkspaceModelRevision(revision);
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(adopted));
      }} onComputerSettings={() => {
        localStorage.setItem(ONBOARDING_KEY, 'done');
        setOnboardingOpen(false);
        if (agent) { setEditingAgentTab('computer'); setEditingAgent(agent); }
        else { setEditingAgentTab('computer'); newAgent(); }
      }} onFinished={() => {
        localStorage.setItem(ONBOARDING_KEY, 'done');
        setOnboardingOpen(false);
      }} />}
      {editingAgent && <AgentSettings key={`${editingAgent.id}:${editingAgentTab}`} initialTab={editingAgentTab} agent={editingAgent} client={controlRef.current} onClose={() => { setEditingAgent(null); setEditingAgentTab('profile'); }} onSaved={profile => {
        setWorkspace(current => ({ ...current, agents: current.agents.some(a => a.id === profile.id)
          ? current.agents.map(a => a.id === profile.id ? profileAgent(profile, a.memory) : a)
          : [...current.agents, profileAgent(profile)] }));
      }} />}
  </>;

  // A client that is not paired yet has no workspace to show. Until the stored credential has
  // been looked for, show nothing rather than flashing the pairing screen at someone who is
  // already connected. Pair only after the coordinator refuses the control token.
  if (pairs && device === 'unknown') return <div className="app-shell" aria-busy="true" />;
  if (!device && pairingRequired) {
    return (
      <HubConnect
        fixedHubUrl={selfHostedHubUrl()}
        onConnected={credential => { setPairingRequired(false); void onPaired(credential); }}
      />
    );
  }

  // A paired client reads the coordinator's agents without seeding an existing hub.
  // A fresh hub still needs its setup and first-agent editor on this empty screen.
  if (!agent) {
    return (
      <div className="hub-connect">
        <div className="hub-connect-panel">
          <div className="hub-connect-heading">
            <Bot size={26} aria-hidden="true" />
            <h1>No agents yet</h1>
            <p>
              Create your first agent here. Its workspace and tasks will live on the computer
              running Open Harness. Set up that computer and connect a model when you are ready.
            </p>
          </div>
          {device && device !== 'unknown' && (
            <p className="hub-connect-footnote">Connected to {device.hubUrl} as {device.name}.</p>
          )}
          <div className="button-row">
            <button type="button" className="light-button" onClick={newAgent}>Create your first agent</button>
            <button type="button" className="subtle-button" disabled={!runtime} onClick={() => setOnboardingOpen(true)}>Set up connected computer</button>
          </div>
          <button type="button" className="subtle-button" onClick={() => window.location.reload()}>
            Check again
          </button>
        </div>
        {agentDialogs}
      </div>
    );
  }

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
        <button className="new-button" onClick={newAgent} disabled={anyRunning}>
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
          <span className="status-dot" />
          {connected ? "Model configured" : "Connect a model to begin"}
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
              <button onClick={newAgent} disabled={anyRunning}>
                <Plus size={13} /> Create agent
              </button>
            </div>
            <div className="agent-grid">
              {workspace.agents.map((a) => (
                <div className="agent-card-shell" key={a.id}>
                <button
                  className="agent-card"
                  onClick={() => openAgent(a.id)}
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
                    {busyAgents.has(a.id)
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
                  conversation.messages.map((m) => {
                    // The guided demonstration's reply carries no run id; it is live while
                    // it is the newest message and its pseudo-run is still in the list.
                    const messageRun = m.runId
                      ? liveRuns[m.runId]
                      : conversationRuns.find(isGuided) && m === conversation.messages[conversation.messages.length - 1] ? conversationRuns.find(isGuided) : undefined;
                    return (
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
                          open={Boolean(messageRun)}
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
                                <strong>{toolLabel(a.name)}</strong>
                                <p>{a.detail}</p>
                              </div>
                            </div>
                          ))}
                        </details>
                      )}
                      <div className={m.error ? "message-error" : ""}>
                        <Markdown>{m.content}</Markdown>
                      </div>
                      {!m.content && messageRun && (
                        <div className="working">
                          <LoaderCircle size={13} className="spin" />
                          {pendingLabel(messageRun)}
                        </div>
                      )}
                    </article>
                    );
                  })
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
                      disabled={anyRunning}
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
                      {connected
                        ? `Hermes ${runtime?.hermes.release}`
                        : "Start local runtime"}
                      <ChevronRight size={12} />
                    </button>
                    {activeRun ? (
                      <>
                        <button
                          className={`run-mode ${inputMode === "steer" ? "active" : ""}`}
                          type="button"
                          // Nothing to steer until the coordinator has started the run.
                          disabled={activeRun.state === "queued" || isGuided(activeRun)}
                          title={activeRun.state === "queued" ? "This task has not started yet. Queue a follow-up instead." : undefined}
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
                          aria-label={`Send ${inputMode === "steer" && activeRun.state !== "queued" && !isGuided(activeRun) ? "steer" : "followup"}`}
                        >
                          <ArrowUp size={18} />
                        </button>
                        <button
                          className="send-button stop"
                          type="button"
                          aria-label="Stop run"
                          onClick={stopActiveRun}
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
                  disabled={anyRunning}
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
                  {runtime?.runtime.available
                    ? "Hermes is ready in this agent’s isolated workspace. External actions still follow the approval policy."
                    : runtime?.runtime.message ||
                      // The fallback names a terminal command, which is the right advice on the
                      // machine hosting the coordinator and useless on a device without a shell.
                      (pairs
                        ? "The Hermes runtime is not available on your coordinator. Check the computer running Open Harness."
                        : "Run npm run harness:doctor to connect the local Hermes runtime.")}
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
                disabled={anyRunning}
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
                      onClick={() => void saveDownload(f.name, f.content, f.mimeType, f.encoding)}
                    >
                      <Download size={16} />
                    </button>
                    <button
                      aria-label={`Delete ${f.name}`}
                      disabled={anyRunning}
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
                  <p className="muted small">{apiKey ? "The API key you pasted has not been saved yet." : "Your saved settings will stay as they are."}</p>
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
            {device && device !== 'unknown' && (
              <div className="hub-summary">
                <div>
                  <strong>Connected to your hub</strong>
                  <small>{device.hubUrl}</small>
                  <small>Paired as {device.name}</small>
                </div>
                <button
                  type="button"
                  className="subtle-button danger"
                  onClick={async () => {
                    // Revoking server side is what actually ends the credential's reach, but
                    // a hub that is unreachable right now must not trap the phone here, so
                    // the local pairing is cleared either way.
                    try { await controlRef.current.request(`/v1/machines/${device.machineId}/revoke`, { method: 'POST' }); } catch { /* Already revoked, or the hub is offline. */ }
                    await onUnpaired();
                    setSettingsOpen(false);
                  }}
                >
                  Disconnect this device
                </button>
              </div>
            )}
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
                      // The saved key belongs to the provider it was tested against.
                      credentialRef: providerCredential(provider),
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
                    Stored in the coordinator’s protected credential store. Secret values are never included in exports.
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
                onClick={() => { closeSettings(); setOnboardingOpen(true); }}
              >
                <Sparkles size={14} /> Run setup again
              </button>
              <button
                className="subtle-button"
                aria-pressed={notifyWhenDone}
                onClick={() => void toggleNotifications()}
                title="Show a notification when a task finishes, fails, or needs your approval — only while Open Harness is in the background."
              >
                {notifyWhenDone ? <Bell size={14} /> : <BellOff size={14} />}
                {notifyWhenDone ? "Notifications on" : "Notify me when tasks finish"}
              </button>
              <button className="subtle-button" onClick={async () => {
                try { const bundle = await controlRef.current.request<Record<string, unknown>>('/v1/support-bundle'); await saveDownload(`open-harness-diagnostics-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(bundle, null, 2), 'application/json'); }
                catch (error) { setNotice(error instanceof Error ? error.message : 'Could not create diagnostics.'); }
              }}><Download size={14} /> Download diagnostics</button>
              <button
                className="subtle-button"
                onClick={() =>
                  void saveDownload(
                    "open-harness-backup.json",
                    JSON.stringify(workspace, null, 2),
                    "application/json",
                  )
                }
              >
                <Download size={14} /> Export workspace
              </button>
              {/* Import replaces the whole workspace and is then pushed to the coordinator.
                  From a paired client that means overwriting an established shared workspace
                  with a file picked out of cloud storage, so it stays on the host. Export is
                  read-only and remains available everywhere. */}
              {!pairs && (
                <button
                  className="subtle-button"
                  disabled={anyRunning}
                  onClick={() => importRef.current?.click()}
                >
                  <FolderOpen size={14} /> Import backup
                </button>
              )}
            </div>
            <div className="modal-footer">
              <span className="muted small">
                MIT licensed · Open Harness v{runtime?.version || '0.3.0'} · Hermes {runtime?.hermes.release}
              </span>
              <button
                className="light-button"
                onClick={async () => {
                  try {
                    // One request: the coordinator tests the pasted key against this model
                    // and saves both only if that passes. Saving the key first, as this used
                    // to, overwrote a working credential with one that then failed its test.
                    const test = await controlRef.current.request<{ ok: boolean; message: string; model?: ModelChoice; revision?: number }>('/v1/onboarding/model-test', {
                      method: 'POST', body: JSON.stringify({ model: modelChoice(settings), apiKey: apiKey || undefined, save: true, revision: workspaceModelRevision }),
                    });
                    if (!test.ok || !test.model) { setNotice(`${test.message} Your previous workspace model is still active.`); return; }
                    // The saved model, not the draft: a new key comes back under a generated
                    // credential name that only the coordinator knows.
                    const adopted = modelSettings(test.model);
                    setSettings(adopted);
                    setWorkspaceModelRevision(test.revision ?? workspaceModelRevision);
                    setApiKey("");
                    closeSettings();
                    setSettingsBaseline(JSON.stringify({ settings: adopted, apiKey: "" }));
                    setNotice(test.message);
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
      {agentDialogs}
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
                  onClick={() => void saveDownload(file.name, file.content, file.mimeType, file.encoding)}
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
