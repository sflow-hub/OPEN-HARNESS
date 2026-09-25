// Contract tests for the two pieces of the managed-run handshake that live in different
// languages and so cannot be typechecked together: the config.yaml Open Harness writes,
// and the entry point Hermes resolves. Both were silently wrong at once, and the only
// symptom was "Hermes gateway exited during startup" on every containerized run.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { COORDINATION_TOOLS, prepareProfile } from '../runtime/profile-runtime';
import { hermesApprovalDecision } from '../runtime/hermes';
import { DEFAULT_BOARD, DEFAULT_COMPUTER, HANDOFF_TOOL, MCP_PREFIX, mcpServerOf, mcpToolId, normalizeToolIds, ROUTINE_TOOL, runToolGrants, TASK_TOOL, type AgentProfile, type ModelChoice } from '../lib/agent-profile';

const model: ModelChoice = { provider: 'custom', model: 'some-model', credentialRef: 'SOME_KEY', baseUrl: 'http://localhost:9/v1' };
const profile: AgentProfile = {
  id: 'contract', revision: 1, name: 'Contract', role: 'test', description: '', tone: 0,
  prompt: { enabled: true, text: 'hi' }, model: { ...model, inherit: false },
  allowedTools: ['terminal'], board: { ...DEFAULT_BOARD }, connectors: [],
  computer: { ...DEFAULT_COMPUTER, resources: { ...DEFAULT_COMPUTER.resources } },
};

function writeConfig() {
  const root = mkdtempSync(join(tmpdir(), 'harness-contract-'));
  prepareProfile(root, profile, model, { environment: () => ({ SOME_KEY: 'value' }) }, 'token', 'run-1');
  return JSON.parse(readFileSync(join(root, 'agents', profile.id, 'profile', 'config.yaml'), 'utf8'));
}

// Hermes reads plugins.enabled as an allow-LIST of plugin keys and treats any non-list
// (including a nested {entries:{name:{enabled:true}}} object) as "nothing enabled", which
// gates the managed policy extension off and makes managed_entry.py abort.
test('the agent config enables the policy plugin as a list Hermes can read', () => {
  const config = writeConfig();
  assert.ok(Array.isArray(config.plugins?.enabled), 'plugins.enabled must be an array');
  assert.ok(config.plugins.enabled.includes('open_harness_policy'));
});

test('the agent config still carries the selected model and endpoint', () => {
  const config = writeConfig();
  assert.equal(config.model.default, 'some-model');
  assert.equal(config.model.base_url, 'http://localhost:9/v1');
});

// Hermes gates OPENAI_API_KEY on the endpoint's host (GHSA-76xc-57q6-vm5m), so a custom
// endpoint must get its credential through a providers: entry naming the env var. Without
// it Hermes sends the literal "no-key-required" and any authenticating provider returns 401.
test('a custom endpoint carries its credential through a providers entry', () => {
  const config = writeConfig();
  const entry = config.providers?.custom;
  assert.ok(entry, 'providers.custom is missing for a custom endpoint');
  assert.equal(entry.base_url, 'http://localhost:9/v1');
  assert.equal(entry.key_env, 'OPEN_HARNESS_MODEL_API_KEY');
  assert.equal(config.model.provider, 'custom');
});

// The neutral name must carry the same value the credential was saved under.
test('a custom endpoint gets its credential under the Open Harness env name', () => {
  const root = mkdtempSync(join(tmpdir(), 'harness-contract-'));
  prepareProfile(root, profile, model, { environment: () => ({ SOME_KEY: 'value' }) }, 'token', 'run-1');
  assert.match(readFileSync(join(root, 'agents', profile.id, 'profile', '.env'), 'utf8'), /^OPEN_HARNESS_MODEL_API_KEY="value"$/m);
});

// Hermes ignores base_url on its native providers, so a proxy in front of xAI would have
// been bypassed silently. An explicit endpoint always takes the custom path, key included.
test('a first-party provider with an explicit endpoint is routed as a custom endpoint', () => {
  const root = mkdtempSync(join(tmpdir(), 'harness-contract-'));
  const proxied: ModelChoice = { provider: 'xai', model: 'grok-4.6', credentialRef: 'XAI_API_KEY', baseUrl: 'http://proxy.internal/v1' };
  prepareProfile(root, { ...profile, model: { ...proxied, inherit: false } }, proxied, { environment: () => ({ XAI_API_KEY: 'value' }) }, 'token', 'run-1');
  const config = JSON.parse(readFileSync(join(root, 'agents', profile.id, 'profile', 'config.yaml'), 'utf8'));
  assert.equal(config.model.provider, 'custom');
  assert.equal(config.providers.custom.base_url, 'http://proxy.internal/v1');
  assert.equal(config.providers.custom.key_env, 'OPEN_HARNESS_MODEL_API_KEY');
});

// Hermes has no provider named "openai"; the API-key one is "openai-api".
test('the openai choice maps to the provider name Hermes actually has', () => {
  const root = mkdtempSync(join(tmpdir(), 'harness-contract-'));
  const openai: ModelChoice = { provider: 'openai', model: 'gpt-5', credentialRef: 'OPENAI_API_KEY', baseUrl: '' };
  prepareProfile(root, { ...profile, model: { ...openai, inherit: false } }, openai, { environment: () => ({ OPENAI_API_KEY: 'value' }) }, 'token', 'run-1');
  const dir = join(root, 'agents', profile.id, 'profile');
  assert.equal(JSON.parse(readFileSync(join(dir, 'config.yaml'), 'utf8')).model.provider, 'openai-api');
  assert.match(readFileSync(join(dir, '.env'), 'utf8'), /OPENAI_API_KEY=/);
});

// The credential value belongs in the profile .env, never in config.yaml.
test('the custom providers entry names the env var without inlining the secret', () => {
  const config = writeConfig();
  assert.equal(JSON.stringify(config).includes('value'), false, 'config.yaml must not contain the secret value');
});

// A first-party provider keeps its conventional env var and gets no providers entry.
test('a first-party provider is left on its conventional credential env var', () => {
  const root = mkdtempSync(join(tmpdir(), 'harness-contract-'));
  const xai: ModelChoice = { provider: 'xai', model: 'grok-4.6', credentialRef: 'XAI_API_KEY', baseUrl: '' };
  prepareProfile(root, { ...profile, model: { ...xai, inherit: false } }, xai, { environment: () => ({ XAI_API_KEY: 'value' }) }, 'token', 'run-1');
  const dir = join(root, 'agents', profile.id, 'profile');
  const config = JSON.parse(readFileSync(join(dir, 'config.yaml'), 'utf8'));
  assert.equal(config.providers, undefined);
  assert.match(readFileSync(join(dir, '.env'), 'utf8'), /XAI_API_KEY=/);
});

// Hermes imports the entry point as a module and calls getattr(module, 'register').
// A "module:function" target resolves to the function, which has no .register, so the
// plugin is discovered, reported as loaded, and never actually registers.
test('the policy extension entry point resolves to a module, not a function', () => {
  const pyproject = readFileSync(join(import.meta.dirname, '..', 'runtime', 'hermes', 'extension', 'pyproject.toml'), 'utf8');
  const entry = pyproject.split('\n').find(line => line.trimStart().startsWith('open_harness_policy =') );
  assert.ok(entry, 'entry point declaration is missing');
  assert.match(entry!, /open_harness_policy\s*=\s*"open_harness_policy"\s*$/);
});

// Hermes registers an MCP tool as mcp__<server>__<tool> (tools/mcp_tool_schema.py,
// MCP_TOOL_NAME_PREFIX = "mcp__"), and the managed policy extension compares a granted name
// with that registry name exactly. Open Harness granted mcp_open_harness_task, so every
// coordination tool was filtered out of every request: a container agent was told the task,
// hand-off and routine tools did not exist, and a user's own MCP connection lost all of its
// tools the same way. These names are a wire contract with a Python runtime, so they are
// pinned here rather than left to whichever spelling reads nicely.
test('coordination tools are named the way Hermes registers them', () => {
  assert.equal(MCP_PREFIX, 'mcp__');
  assert.equal(TASK_TOOL, 'mcp__open_harness__task');
  assert.equal(HANDOFF_TOOL, 'mcp__open_harness__delegate_named_agent');
  assert.equal(ROUTINE_TOOL, 'mcp__open_harness__create_open_harness_routine');
  assert.equal(mcpToolId('research', 'lookup'), 'mcp__research__lookup');
  assert.equal(mcpServerOf('mcp__research__lookup'), 'research');
  assert.equal(mcpServerOf('terminal'), null);
  // Every name the coordination server offers must be a tool Open Harness can grant, or the
  // model is shown a tool the policy will refuse; and every tool it grants must exist there.
  const offered = readFileSync(join(import.meta.dirname, '..', 'runtime', 'hermes', 'coordination.mjs'), 'utf8')
    .match(/^\s*name: "([a-z_]+)",$/gm)!.map(line => line.split('"')[1]);
  assert.deepEqual(offered.map(name => mcpToolId('open_harness', name)).sort(), [HANDOFF_TOOL, ROUTINE_TOOL, TASK_TOOL].sort());
  assert.deepEqual(COORDINATION_TOOLS.map(tool => tool.id).sort(), [HANDOFF_TOOL, ROUTINE_TOOL, TASK_TOOL].sort());
});

// A grant saved by an earlier version must keep working. This renames; it must never widen.
test('a legacy tool grant is renamed, and an unknown mcp_ name is not guessed at', () => {
  assert.deepEqual(normalizeToolIds(['mcp_open_harness_task', 'terminal']), [TASK_TOOL, 'terminal']);
  assert.deepEqual(normalizeToolIds(['mcp_research_lookup'], ['research']), ['mcp__research__lookup']);
  assert.deepEqual(normalizeToolIds(['mcp_research_lookup']), ['mcp_research_lookup']);
  assert.deepEqual(normalizeToolIds([TASK_TOOL]), [TASK_TOOL]);
  const connectors = [{ id: 'r', name: 'research', command: 'npx', args: [], secretRef: '', enabled: true }];
  assert.deepEqual(runToolGrants({ ...profile, allowedTools: ['mcp_open_harness_task', 'mcp_research_lookup', 'mcp_other_thing'], connectors }),
    [TASK_TOOL, 'mcp__research__lookup']);
});

// The image bakes its own coordination.mjs; the pinned one predates the task tool. Running
// the checkout's copy is what makes a granted tool actually reachable.
test('the agent runs the checkout copy of the coordination server', () => {
  const root = mkdtempSync(join(tmpdir(), 'harness-coordination-'));
  prepareProfile(root, { ...profile, allowedTools: [TASK_TOOL] }, model, { environment: () => ({}) }, 'token', 'run-1');
  const config = JSON.parse(readFileSync(join(root, 'agents', profile.id, 'profile', 'config.yaml'), 'utf8'));
  assert.deepEqual(config.mcp_servers.open_harness.args, ['/run/open-harness/coordination.mjs']);
  const shipped = join(root, 'agents', profile.id, 'managed', 'coordination.mjs');
  assert.equal(readFileSync(shipped, 'utf8'), readFileSync(join(import.meta.dirname, '..', 'runtime', 'hermes', 'coordination.mjs'), 'utf8'));
});

// Hermes answers an approval with once | session | always | deny and reads anything else as a
// refusal, so "approve" made a resumed run tell the agent the operator had blocked it. The mock
// runtime accepted "approve" too, which is why every test passed while the real thing denied.
test('an approval is answered in the vocabulary Hermes accepts', () => {
  assert.equal(hermesApprovalDecision('approve'), 'once');
  assert.equal(hermesApprovalDecision('once'), 'once');
  assert.equal(hermesApprovalDecision('session'), 'session');
  assert.equal(hermesApprovalDecision('always'), 'always');
  assert.equal(hermesApprovalDecision('deny'), 'deny');
  for (const unknown of ['', 'yes', 'ok', 'APPROVE', 'allow']) assert.equal(hermesApprovalDecision(unknown), 'deny');
  // The choices Hermes offers in the request payload must all be answerable.
  for (const choice of ['once', 'session', 'always', 'deny']) assert.equal(hermesApprovalDecision(choice), choice);
});

// Without this marker Hermes finds no interactive context, no gateway context and no unattended
// context, and approves every flagged command outright: the dashboard's approval UI and the
// configured approvals.unattended_mode never came into play on a real run.
test('the managed gateway announces itself as a session that can answer approvals', () => {
  const hermes = readFileSync(join(import.meta.dirname, '..', 'runtime', 'hermes.ts'), 'utf8');
  assert.match(hermes, /HERMES_GATEWAY_SESSION=1/);
  for (const path of ['runtime/service.ts', 'runtime/runner.ts']) {
    assert.match(readFileSync(join(import.meta.dirname, '..', path), 'utf8'), /HERMES_GATEWAY_SESSION: '1'/,
      `${path} must mark its native gateway as an approval channel too`);
  }
});
