import type { DatabaseSync } from 'node:sqlite';
import { DEFAULT_BOARD, DEFAULT_COMPUTER, DEFAULT_MODEL, draftProfile, runToolGrants, type AgentProfile, type ComputerConfig, type ModelChoice } from '../lib/agent-profile';
import type { Agent } from '../lib/types';

export class ProfileError extends Error { constructor(message: string, readonly status = 400) { super(message); } }
export function validId(id: string) { if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(id)) throw new ProfileError('Invalid agent ID.'); return id; }
function short(value: unknown, name: string, max: number, required = false) {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) throw new ProfileError(`${name} ${required ? 'is required and ' : ''}must be at most ${max} characters.`);
  return value;
}
export function validateModel(value: ModelChoice): ModelChoice {
  if (!value || typeof value !== 'object') throw new ProfileError('Choose a model.');
  const model = { provider: short(value.provider, 'Provider', 100, true), model: short(value.model, 'Model ID', 200, true), credentialRef: short(value.credentialRef, 'Credential reference', 80), baseUrl: short(value.baseUrl, 'Endpoint', 2000) };
  if (model.credentialRef && !/^[A-Z][A-Z0-9_]+$/.test(model.credentialRef)) throw new ProfileError('Credential references must use uppercase letters, digits, and underscores.');
  if (model.baseUrl) { let url: URL; try { url = new URL(model.baseUrl); } catch { throw new ProfileError('Enter a valid endpoint URL.'); } if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new ProfileError('Endpoint must be HTTP(S), without embedded credentials, query, or fragment.'); }
  return model;
}
export function validateProfile(value: AgentProfile): AgentProfile {
  if (!value || !value.prompt || !value.model || !Array.isArray(value.allowedTools) || !Array.isArray(value.connectors)) throw new ProfileError('Invalid profile.');
  if (!Number.isInteger(value.revision) || value.revision < 0 || typeof value.prompt.enabled !== 'boolean' || typeof value.model.inherit !== 'boolean') throw new ProfileError('Invalid profile revision or switches.');
  if (!Number.isInteger(value.tone) || value.tone < 0 || value.tone > 5) throw new ProfileError('Choose an avatar color.');
  if (value.allowedTools.length > 3000 || value.allowedTools.some(id => typeof id !== 'string' || !/^[a-zA-Z0-9_.:-]{1,200}$/.test(id))) throw new ProfileError('Invalid tool selection.');
  const names = new Set<string>();
  const connectors = value.connectors.map(c => {
    if (!c || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(c.name) || names.has(c.name) || c.name === 'open_harness') throw new ProfileError('Connections need unique names using letters, numbers, dashes, or underscores.');
    names.add(c.name);
    if (!Array.isArray(c.args) || c.args.length > 100 || c.args.some(a => typeof a !== 'string' || a.length > 4000) || typeof c.enabled !== 'boolean') throw new ProfileError('Invalid connection arguments.');
    if (c.secretRef && !/^[A-Z][A-Z0-9_]{1,79}$/.test(c.secretRef)) throw new ProfileError('Invalid connector secret reference.');
    return { id: short(c.id, 'Connection ID', 100, true), name: c.name, command: short(c.command, 'Executable', 300, true), args: c.args, secretRef: c.secretRef || '', enabled: c.enabled };
  });
  const computerInput = (value.computer || DEFAULT_COMPUTER) as ComputerConfig;
  if (!['private', 'folders', 'direct'].includes(computerInput.access) || !['none', 'virtual', 'existing'].includes(computerInput.desktop)) throw new ProfileError('Choose a valid computer access and desktop mode.');
  if (computerInput.desktop === 'existing' && computerInput.access !== 'direct') throw new ProfileError('Existing desktop control requires direct computer access.');
  if (computerInput.desktop === 'virtual' && computerInput.access === 'direct') throw new ProfileError('A private virtual desktop requires an isolated workspace.');
  const resources = computerInput.resources || DEFAULT_COMPUTER.resources;
  if (![resources.cpu, resources.memoryMb, resources.concurrency].every(Number.isFinite) || resources.cpu < .25 || resources.cpu > 64 || resources.memoryMb < 256 || resources.memoryMb > 262144 || !Number.isInteger(resources.concurrency) || resources.concurrency < 1 || resources.concurrency > 32) throw new ProfileError('Computer resource limits are outside the supported range.');
  const folders = (computerInput.folders || []).slice(0, 50).map(folder => {
    if (!folder || typeof folder.path !== 'string' || !folder.path.trim() || folder.path.length > 4000 || !['read', 'write'].includes(folder.mode)) throw new ProfileError('Shared folders need a path and read or write access.');
    return { id: short(folder.id || crypto.randomUUID(), 'Folder ID', 100, true), path: folder.path.trim(), mode: folder.mode };
  });
  const computer: ComputerConfig = { machineId: short(computerInput.machineId || 'local', 'Machine', 100, true), access: computerInput.access, desktop: computerInput.desktop, reserveMachine: Boolean(computerInput.reserveMachine), folders: computerInput.access === 'folders' ? folders : [], resources: { cpu: Math.round(resources.cpu * 100) / 100, memoryMb: Math.round(resources.memoryMb), concurrency: resources.concurrency } };
  const board = { ...DEFAULT_BOARD, ...(value.board || {}) };
  if (![board.assignOthers, board.dispatch, board.manageProjects].every(permission => typeof permission === 'boolean')) throw new ProfileError('Invalid board permissions.');
  return { id: validId(value.id), revision: value.revision, name: short(value.name, 'Name', 30, true).trim(), role: short(value.role, 'Role', 60, true).trim(), description: short(value.description, 'Description', 180), tone: value.tone, prompt: { enabled: value.prompt.enabled, text: short(value.prompt.text, 'System prompt', 12000) }, model: { ...validateModel(value.model.inherit ? { ...DEFAULT_MODEL, ...value.model, model: value.model.model || DEFAULT_MODEL.model } : value.model), inherit: value.model.inherit }, allowedTools: [...new Set([...value.allowedTools, 'mcp_open_harness_task'])].filter(id => computer.desktop !== 'none' || id !== 'computer_use'), board, connectors, computer };
}
export class Profiles {
  constructor(readonly db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS agent_profiles(id TEXT PRIMARY KEY, revision INTEGER NOT NULL, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS profile_revisions(agent_id TEXT NOT NULL, revision INTEGER NOT NULL, json TEXT NOT NULL, PRIMARY KEY(agent_id,revision));
      CREATE TABLE IF NOT EXISTS workspace_settings(id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS run_profiles(run_id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, revision INTEGER NOT NULL, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tool_catalogs(agent_id TEXT PRIMARY KEY, json TEXT NOT NULL);`);
  }
  get(id: string): AgentProfile | null { const row = this.db.prepare('SELECT json FROM agent_profiles WHERE id=?').get(id) as { json: string } | undefined; if (!row) return null; const profile = JSON.parse(row.json); return { ...profile, allowedTools: [...new Set([...(profile.allowedTools || []), 'mcp_open_harness_task'])], board: { ...DEFAULT_BOARD, ...(profile.board || {}) }, computer: profile.computer || { ...DEFAULT_COMPUTER, resources: { ...DEFAULT_COMPUTER.resources } } }; }
  list(): AgentProfile[] { return (this.db.prepare('SELECT json FROM agent_profiles ORDER BY rowid').all() as Array<{ json: string }>).map(row => this.get(JSON.parse(row.json).id)!).filter(Boolean); }
  defaults(): { model: ModelChoice; revision: number } { const row = this.db.prepare('SELECT revision,json FROM workspace_settings WHERE id=1').get() as { revision: number; json: string } | undefined; return row ? { model: JSON.parse(row.json), revision: row.revision } : { model: DEFAULT_MODEL, revision: 0 }; }
  setDefaults(model: ModelChoice, revision: number) { const current = this.defaults(); if (revision !== current.revision) throw new ProfileError('Workspace settings changed elsewhere. Reload before saving.', 409); this.db.prepare('INSERT INTO workspace_settings VALUES(1,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,json=excluded.json').run(revision + 1, JSON.stringify(validateModel(model))); return this.defaults(); }
  effective(profile: AgentProfile): ModelChoice { const source = profile.model.inherit ? this.defaults().model : profile.model; return { provider: source.provider, model: source.model, credentialRef: source.credentialRef, baseUrl: source.baseUrl }; }
  save(input: AgentProfile) {
    const profile = validateProfile(input), current = this.get(profile.id);
    if (profile.revision !== (current?.revision || 0)) throw new ProfileError('This profile was changed elsewhere. Reload the saved profile before saving again; your draft is still here.', 409);
    profile.revision++;
    this.db.exec('BEGIN IMMEDIATE');
    try { this.db.prepare('INSERT INTO agent_profiles VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,json=excluded.json').run(profile.id, profile.revision, JSON.stringify(profile)); this.db.prepare('INSERT INTO profile_revisions VALUES(?,?,?)').run(profile.id, profile.revision, JSON.stringify(profile)); this.db.prepare(`INSERT INTO agents(id,name,role,instructions,config_json,updated_at) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,role=excluded.role,instructions=excluded.instructions,updated_at=excluded.updated_at`).run(profile.id, profile.name, profile.role, profile.prompt.text, '{}', new Date().toISOString()); this.db.exec('COMMIT'); } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return profile;
  }
  applyTransferredProfile(input: AgentProfile) {
    const current = this.get(input.id); if (!current) throw new ProfileError('Agent profile not found.', 404);
    const profile = validateProfile({ ...input, revision: current.revision });
    this.db.exec('BEGIN IMMEDIATE');
    try { this.db.prepare('UPDATE agent_profiles SET json=? WHERE id=?').run(JSON.stringify(profile), profile.id); this.db.prepare('UPDATE profile_revisions SET json=? WHERE agent_id=? AND revision=?').run(JSON.stringify(profile), profile.id, profile.revision); this.db.prepare('UPDATE agents SET name=?,role=?,instructions=?,updated_at=? WHERE id=?').run(profile.name, profile.role, profile.prompt.text, new Date().toISOString(), profile.id); this.db.exec('COMMIT'); } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    return profile;
  }
  import(agent: Agent & { config?: Partial<ModelChoice> }) {
    const existing = this.get(agent.id); if (existing) return existing;
    const draft = draftProfile({ ...agent, description: agent.description || '', tone: agent.tone || 0 }); draft.revision = 0;
    if (agent.config?.model && agent.config.model !== 'hermes-agent') draft.model = { ...DEFAULT_MODEL, ...agent.config, credentialRef: agent.config.credentialRef || ({ xai: "XAI_API_KEY", openrouter: "OPENROUTER_API_KEY", anthropic: "ANTHROPIC_API_KEY", openai: "OPENAI_API_KEY" } as Record<string,string>)[agent.config.provider || "xai"] || "", inherit: false };
    const legacy = this.db.prepare('SELECT * FROM connectors WHERE agent_id=?').all(agent.id) as Array<{ id: string; name: string; command: string; args_json: string; secret_ref: string; enabled: number }>;
    if (!agent.profile) draft.connectors = legacy.map(c => ({ id: c.id, name: c.name, command: c.command, args: JSON.parse(c.args_json), secretRef: c.secret_ref || '', enabled: Boolean(c.enabled) }));
    return this.save(draft);
  }
  snapshot(runId: string, profile: AgentProfile) { const allowedTools = runToolGrants(profile);
    const value = { ...profile, allowedTools, effectiveModel: this.effective(profile), workspaceRevision: this.defaults().revision }; this.db.prepare('INSERT INTO run_profiles VALUES(?,?,?,?)').run(runId, profile.id, profile.revision, JSON.stringify(value)); return value; }
  runSnapshot(runId: string): (AgentProfile & { effectiveModel: ModelChoice }) | null { const row = this.db.prepare('SELECT json FROM run_profiles WHERE run_id=?').get(runId) as { json: string } | undefined; return row ? JSON.parse(row.json) : null; }
}
