// Opt in: OPEN_HARNESS_REAL_HERMES_PYTHON=/path/to/hermes-venv/bin/python
// OPEN_HARNESS_REAL_MODEL_BASE_URL=http://127.0.0.1:11435/v1
// OPEN_HARNESS_REAL_MODEL_ID=tiny-local node --import tsx tests/real-local-model-smoke.mjs
// Requires the pinned Hermes + policy extension (see README.md direct-access setup),
// and a running local OpenAI-compatible inference server with tool calling and
// >=64K reported context. Verified with Ollama 0.34.4's bundled llama-server,
// official Llama 3.2 3B Q4_K_M: -c 65536 --jinja --alias tiny-local.
// Uses genuine inference, fresh temporary state and no user credentials.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const python = process.env.OPEN_HARNESS_REAL_HERMES_PYTHON;
assert.ok(python, 'Set OPEN_HARNESS_REAL_HERMES_PYTHON to an environment with the pinned Hermes and policy extension.');
assert.notEqual(process.env.OPEN_HARNESS_MOCK, '1', 'This verification requires genuine Hermes and model inference.');
const baseUrl = process.env.OPEN_HARNESS_REAL_MODEL_BASE_URL || 'http://127.0.0.1:11435/v1';
const endpointUrl = new URL(baseUrl);
assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(endpointUrl.hostname) && endpointUrl.protocol === 'http:' && !endpointUrl.username && !endpointUrl.password, 'Use a loopback HTTP inference server; this test does not call cloud providers.');
const modelId = process.env.OPEN_HARNESS_REAL_MODEL_ID || 'tiny-local';
const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = mkdtempSync(join(tmpdir(), 'open-harness-live-model-'));
const reserve = createServer();
await new Promise(resolve => reserve.listen(0, '127.0.0.1', resolve));
const port = reserve.address().port;
await new Promise(resolve => reserve.close(resolve));
const child = spawn(process.execPath, ['--import', 'tsx', 'runtime/service.ts'], {
  cwd: repository,
  env: {
    PATH: `${dirname(process.execPath)}:${dirname(python)}:/usr/bin:/bin:/usr/sbin:/sbin`,
    TMPDIR: root, LANG: 'en_US.UTF-8', HERMES_PYTHON: python, HERMES_TUI_MAX_TURNS: '4',
    OPEN_HARNESS_PORT: String(port), OPEN_HARNESS_STATE_DIR: join(root, 'state'),
    OPEN_HARNESS_DISABLE_OS_VAULT: '1', OPENAI_API_KEY: 'local-inference-only', OPENAI_BASE_URL: baseUrl,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let logs = '', token;
child.stdout.on('data', data => { logs += data; });
child.stderr.on('data', data => { logs += data; });
const endpoint = `http://127.0.0.1:${port}`;
async function api(path, method = 'GET', body) {
  const response = await fetch(endpoint + path, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const value = await response.json();
  assert.ok(response.ok, `${method} ${path}: ${response.status} ${JSON.stringify(value)}`);
  return value;
}
async function waitRun(run) {
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    const snapshot = await api(`/v1/runs/${run.id}/events?after=0`);
    if (['completed', 'failed', 'cancelled', 'interrupted'].includes(snapshot.run.state)) {
      writeFileSync(join(root, `${run.id}.json`), JSON.stringify(snapshot, null, 2));
      assert.equal(snapshot.run.state, 'completed', JSON.stringify(snapshot.run));
      return snapshot;
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  throw new Error(`Real inference run ${run.id} timed out.`);
}
try {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try { const response = await fetch(endpoint + '/v1/bootstrap'); if (response.ok) { token = (await response.json()).token; break; } } catch { /* wait for the isolated service */ }
    assert.equal(child.exitCode, null, 'Coordinator exited before becoming ready.');
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  assert.ok(token, 'Coordinator must become ready.');
  const model = { provider: 'local', model: modelId, baseUrl, credentialRef: 'OPENAI_API_KEY' };
  const modelTest = await api('/v1/onboarding/model-test', 'POST', { model });
  assert.equal(modelTest.ok, true, JSON.stringify(modelTest));
  await api('/v1/agents/sync', 'POST', { agents: [{ id: 'actual-model', name: 'Actual local model', role: 'Verification', instructions: 'Follow the user request exactly. Use write_file when asked to write a file.', memory: [] }] });
  const { profile } = await api('/v1/agents/actual-model/profile');
  await api('/v1/agents/actual-model/profile', 'PUT', { ...profile, model: { ...model, inherit: false }, allowedTools: ['write_file', 'mcp_open_harness_task'], computer: { ...profile.computer, access: 'direct', desktop: 'none' } });
  const artifact = join(root, 'state', 'shared', 'local-model.txt');
  const first = await waitRun(await api('/v1/runs', 'POST', { agentId: 'actual-model', conversationId: 'real-model-continuity', prompt: `Use the write_file tool to create ${artifact} containing exactly the text RED_CEDAR_42. After the tool succeeds, reply briefly. Do not merely describe the tool call.` }));
  assert.equal(readFileSync(artifact, 'utf8').trim(), 'RED_CEDAR_42');
  assert.ok(first.events.some(event => event.type === 'tool.complete' && event.payload.name === 'write_file'));
  const followup = await waitRun(await api('/v1/runs', 'POST', { agentId: 'actual-model', conversationId: 'real-model-continuity', prompt: 'What exact text content did I ask you to write into local-model.txt in my previous message? Reply only with that file content; do not call tools.' }));
  assert.match(followup.run.result, /RED_CEDAR_42/);
  assert.notEqual(first.run.session_id, followup.run.session_id);
  const evidence = { ok: true, realInference: true, model: modelId, baseUrl, root, modelTest, firstRun: first.run, followupRun: followup.run, artifact };
  writeFileSync(join(root, 'evidence.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify(evidence, null, 2));
} finally {
  if (child.exitCode === null) {
    const exited = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGTERM');
    const force = setTimeout(() => child.kill('SIGKILL'), 10_000);
    await exited; clearTimeout(force);
  }
  writeFileSync(join(root, 'coordinator.log'), logs);
  console.log(`Evidence directory: ${root}`);
}
