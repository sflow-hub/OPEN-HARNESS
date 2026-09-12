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

const STORAGE_KEY = "open-harness.workspace.v1";
const SETTINGS_KEY = "open-harness.settings.v1";
type View = "home" | "chat" | "files";
type ModelSettings = { provider: Provider; model: string; maxSteps: number };
const defaultSettings: ModelSettings = {
  provider: "xai",
  model: PROVIDERS.xai.model,
  maxSteps: 8,
};
const uid = () => crypto.randomUUID();
const now = () => new Date().toISOString();
function download(name: string, content: string, type = "text/plain") {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function Avatar({ agent, large = false }: { agent: Agent; large?: boolean }) {
  return (
    <div className={`avatar tone-${agent.tone % 3} ${large ? "large" : ""}`}>
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
  const [selectedAgent, setSelectedAgent] = useState("atlas");
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [settings, setSettings] = useState<ModelSettings>(defaultSettings);
  const [apiKey, setApiKey] = useState("");
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
  const [notice, setNotice] = useState("");
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [inspector, setInspector] = useState(true);
  const abortRef = useRef<AbortController | null>(null);
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
  const connected = !!apiKey || server[settings.provider];

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
        setEditingAgent(null);
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
  async function send(text = input, guided = false) {
    if (!text.trim() || runLock.current || !ready) return;
    if (!guided && !connected) {
      setSettingsOpen(true);
      setNotice("Connect your model, then send your task.");
      return;
    }
    if (!guided && !settings.model.trim()) {
      setSettingsOpen(true);
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
              "# Your first handoff\n\n## A useful first task\nGive your agent a clear outcome and the relevant source material.\n\nExample: “Read my notes and turn them into a one-page project brief. Save the result as project-brief.md.”\n\n## Make the agent yours\n1. Edit its name, role, and instructions.\n2. Connect an xAI, OpenRouter, or local model in Settings.\n3. Attach a text or Markdown file for context.\n4. Send a task and watch the tool activity.\n5. Download the result from Files.\n\n## What persists\nConversations, agent instructions, memories, and files stay in this browser. Export your workspace for a portable backup. API keys entered in Settings stay only in memory for this page session.\n\nThis file was created by the guided example. No AI model was called.\n",
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
        const response = await fetch("/api/run", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            agent,
            files: workspace.files,
            messages: messages.filter((m) => !("error" in m && m.error)),
            ...settings,
            apiKey,
          }),
          signal: controller.signal,
        });
        if (!response.ok) {
          const data = (await response.json()) as { error?: string };
          throw new Error(data.error || "Could not start the run.");
        }
        if (!response.body)
          throw new Error("The server returned no response stream.");
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let finished = false;
        while (true) {
          const { value, done } = await reader.read();
          buffer += done
            ? decoder.decode()
            : decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";
          for (const line of lines)
            if (line.trim()) {
              const event = JSON.parse(line) as RunEvent;
              emit(event);
              if (event.type === "done" || event.type === "error")
                finished = true;
            }
          if (done) break;
        }
        if (buffer.trim()) {
          const event = JSON.parse(buffer) as RunEvent;
          emit(event);
          if (event.type === "done" || event.type === "error") finished = true;
        }
        if (!finished)
          throw new Error(
            "The connection ended before the run finished. Completed work is preserved; send a follow-up to continue.",
          );
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
    if (uploadRef.current) uploadRef.current.value = "";
  }
  function saveAgent(form: HTMLFormElement) {
    if (!editingAgent) return;
    const data = new FormData(form);
    const updated = {
      ...editingAgent,
      name: String(data.get("name")).trim(),
      role: String(data.get("role")).trim(),
      description: String(data.get("description")).trim(),
      instructions: String(data.get("instructions")).trim(),
    };
    if (!updated.name || !updated.instructions) return;
    setWorkspace((w) => ({
      ...w,
      agents: w.agents.some((a) => a.id === updated.id)
        ? w.agents.map((a) => (a.id === updated.id ? updated : a))
        : [...w.agents, updated],
    }));
    setEditingAgent(null);
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
                  : agent.name}
            </span>
          </span>
          <span className="badge">Open source · Yours to shape</span>
        </header>
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
                <button
                  className="agent-card"
                  key={a.id}
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
                    title="Edit agent"
                    aria-label="Edit agent"
                    disabled={running}
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
                    disabled={running}
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
                      disabled={running}
                    >
                      <span className="status-dot" />
                      {connected
                        ? settings.model || "Choose model"
                        : "Connect model"}
                      <ChevronRight size={12} />
                    </button>
                    {running ? (
                      <button
                        className="send-button stop"
                        type="button"
                        aria-label="Stop run"
                        onClick={() => abortRef.current?.abort()}
                      >
                        <Square size={14} fill="currentColor" />
                      </button>
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
                    ? "Keep this tab open while your agent works."
                    : "Enter to send · Shift + Enter for a new line · Files are shared with all your agents"}
                </div>
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
                  <Brain size={13} /> MEMORY <span>{agent.memory.length}</span>
                </div>
                {agent.memory.length ? (
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
                  <Cable size={13} /> AVAILABLE TOOLS
                </div>
                <div className="tool-chips">
                  <span>Read files</span>
                  <span>Write files</span>
                  <span>Save memory</span>
                </div>
                <div className="scope-note">
                  This first version works with text files. Browser, terminal,
                  and background routines are future extensions.
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
                      onClick={() => download(f.name, f.content)}
                    >
                      <Download size={16} />
                    </button>
                    <button
                      aria-label={`Delete ${f.name}`}
                      disabled={running}
                      onClick={() => {
                        if (confirm(`Delete ${f.name}?`))
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
            <fieldset disabled={running}>
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
                    Kept in memory for this page session only. Never included in
                    backups.
                  </small>
                </label>
              )}
              {settings.provider === "local" && (
                <div className="info-box">
                  Set <code>MODEL_BASE_URL</code> and <code>MODEL_NAME</code> in
                  your server’s environment. For Ollama, use{" "}
                  <code>http://localhost:11434/v1</code> and a model with tool
                  support. Restart the server after changes.
                </div>
              )}
              <label>
                Maximum model steps per task
                <select
                  value={settings.maxSteps}
                  onChange={(e) =>
                    setSettings((s) => ({
                      ...s,
                      maxSteps: Number(e.target.value),
                    }))
                  }
                >
                  {[4, 8, 12].map((n) => (
                    <option key={n} value={n}>
                      {n} steps
                    </option>
                  ))}
                </select>
                <small>
                  Each step can call the model once and use its requested tools.
                </small>
              </label>
            </fieldset>
            <div className="settings-divider" />
            <h3>Your data stays with you</h3>
            <p className="muted small">
              Agents, conversations, memory, and files are saved in this
              browser. Export a backup before moving devices or clearing browser
              data. Tasks run while this tab stays open.
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
                MIT licensed · Open Harness v0.1
              </span>
              <button
                className="light-button"
                onClick={() => {
                  setSettingsOpen(false);
                  setNotice("Settings saved.");
                }}
              >
                Done <Check size={14} />
              </button>
            </div>
          </section>
        </div>
      )}
      {editingAgent && (
        <div className="modal-backdrop" onClick={() => setEditingAgent(null)}>
          <form
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="agent-title"
            onClick={(e) => e.stopPropagation()}
            onSubmit={(e) => {
              e.preventDefault();
              saveAgent(e.currentTarget);
            }}
          >
            <div className="modal-heading">
              <h2 id="agent-title">
                {workspace.agents.some((a) => a.id === editingAgent.id)
                  ? "Shape your agent"
                  : "Meet your next agent"}
              </h2>
              <button
                type="button"
                aria-label="Close agent editor"
                onClick={() => setEditingAgent(null)}
              >
                <X size={19} />
              </button>
            </div>
            <label>
              Name
              <input
                autoFocus
                name="name"
                defaultValue={editingAgent.name}
                required
                maxLength={30}
                placeholder="e.g. Nova"
              />
            </label>
            <label>
              Role
              <input
                name="role"
                defaultValue={editingAgent.role}
                required
                maxLength={60}
                placeholder="e.g. Project planner"
              />
            </label>
            <label>
              Short description
              <input
                name="description"
                defaultValue={editingAgent.description}
                maxLength={180}
                placeholder="What should this agent help you with?"
              />
            </label>
            <label>
              Instructions
              <textarea
                name="instructions"
                defaultValue={editingAgent.instructions}
                required
                rows={6}
                maxLength={12000}
                placeholder="Describe its job, style, and what a good result looks like."
              />
            </label>
            {editingAgent.memory.length > 0 && (
              <>
                <label>Saved memory</label>
                {editingAgent.memory.map((m, i) => (
                  <div className="memory-edit" key={i}>
                    <span>{m}</span>
                    <button
                      type="button"
                      aria-label="Remove memory"
                      onClick={() =>
                        setEditingAgent((a) =>
                          a
                            ? {
                                ...a,
                                memory: a.memory.filter((_, n) => n !== i),
                              }
                            : a,
                        )
                      }
                    >
                      <X size={14} />
                    </button>
                  </div>
                ))}
              </>
            )}
            <div className="modal-footer">
              {workspace.agents.length > 1 &&
                workspace.agents.some((a) => a.id === editingAgent.id) && (
                  <button
                    className="danger-button"
                    type="button"
                    onClick={() => {
                      if (
                        confirm(
                          `Delete ${editingAgent.name} and its conversations? Shared files will be kept.`,
                        )
                      ) {
                        setWorkspace((w) => ({
                          ...w,
                          agents: w.agents.filter(
                            (a) => a.id !== editingAgent.id,
                          ),
                          conversations: w.conversations.filter(
                            (c) => c.agentId !== editingAgent.id,
                          ),
                        }));
                        setEditingAgent(null);
                        setView("home");
                        setConversationId(null);
                      }
                    }}
                  >
                    <Trash2 size={14} /> Delete agent
                  </button>
                )}
              <button className="light-button" disabled={running} type="submit">
                Save agent <Check size={14} />
              </button>
            </div>
          </form>
        </div>
      )}
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
                  onClick={() => download(file.name, file.content)}
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
            {file.name.endsWith(".md") ? (
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
