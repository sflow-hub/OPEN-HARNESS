import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { spawn } from "node:child_process";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Audit } from "../runtime/audit";

test("audit appends, pages, filters, and rejects mutation", () => {
  const db = new DatabaseSync(':memory:'), audit = new Audit(db);
  try {
    const first = audit.record({ actorKind: 'operator', action: 'credential.create', targetKind: 'credential', targetId: 'ref' });
    const second = audit.record({ actorKind: 'runner', actorId: 'machine', action: 'machine.pair', targetKind: 'machine', targetId: 'machine' });
    assert.deepEqual(audit.list({ limit: 1 }), [first]);
    assert.deepEqual(audit.list({ after: first.seq }), [second]);
    assert.deepEqual(audit.list({ action: first.action, targetKind: 'credential', targetId: 'ref' }), [first]);
    assert.deepEqual(audit.list({ targetId: 'missing' }), []);
    assert.throws(() => db.exec("UPDATE audit_events SET action='changed'"), /append-only/);
    assert.throws(() => db.exec('DELETE FROM audit_events'), /append-only/);
    assert.equal(audit.list().length, 2);
    assert.throws(() => audit.list({ after: -1 }));
    assert.throws(() => audit.list({ limit: 0 }));
    for (let i = 0; i < 501; i++) audit.record({ actorKind: 'system', action: 'test' });
    assert.equal(audit.list({ limit: 999 }).length, 500);
    assert.equal(audit.list().length, 100);
    new Audit(db);
    assert.equal(audit.list().length, 100);
  } finally { db.close(); }
});

test("audit recursively redacts sensitive keys and caps serialized detail", () => {
  const db = new DatabaseSync(':memory:'), audit = new Audit(db);
  try {
    const event = audit.record({ actorKind: 'operator', action: 'test', detail: { value: 'sensitive', TOKEN: 'sensitive', password: 'sensitive', secretRef: 'sensitive', apiKey: 'sensitive', credentialRef: 'ref', ref: 'ref', label: 'label', nested: [{ value: 'sensitive', label: 'kept' }] } });
    assert.deepEqual(event.detail, { credentialRef: 'ref', ref: 'ref', label: 'label', nested: [{ label: 'kept' }] });
    assert.ok(!JSON.stringify(audit.list()).includes('sensitive'));
    const capped = audit.record({ actorKind: 'system', action: 'test', detail: { text: '😀'.repeat(4096) } });
    assert.deepEqual(capped.detail, { truncated: true });
    assert.ok(JSON.stringify(capped.detail).length <= 4096);
    const boundary = audit.record({ actorKind: 'system', action: 'test', detail: { text: 'a'.repeat(4085) } });
    assert.equal(JSON.stringify(boundary.detail).length, 4096);
  } finally { db.close(); }
});

test("HTTP audit authenticates operators and never exposes credential values", async () => {
  const stateDir = mkdtempSync(join(tmpdir(), 'open-harness-audit-')), port = 15329, base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['--import', 'tsx', 'runtime/service.ts'], { cwd: join(import.meta.dirname, '..'), env: { ...process.env, OPEN_HARNESS_MOCK: '1', OPEN_HARNESS_PORT: String(port), OPEN_HARNESS_STATE_DIR: stateDir }, stdio: 'pipe' });
  let output = '';
  child.stderr.on('data', data => { output += String(data); });
  try {
    let token = '';
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline && !token) {
      if (child.exitCode !== null) throw new Error(`Service exited: ${output}`);
      try { const response = await fetch(`${base}/v1/bootstrap`); if (response.ok) token = (await response.json() as { token: string }).token; } catch {}
      if (!token) await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.ok(token, output);
    const request = (path: string, method = 'GET', body?: unknown) => fetch(`${base}${path}`, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    const value = 'known-audit-credential-value-123';
    assert.equal((await request('/v1/credentials', 'POST', { ref: 'AUDIT_REF', label: 'Audit credential', provider: 'openai', value })).status, 201);
    const pairingResponse = await request('/v1/machines', 'POST', { name: 'Audit machine', platform: 'linux' });
    assert.equal(pairingResponse.status, 201);
    const pairing = await pairingResponse.json() as { code: string };
    const pairedResponse = await fetch(`${base}/v1/runner/pair`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: pairing.code }) });
    assert.equal(pairedResponse.status, 201);
    const paired = await pairedResponse.json() as { machineId: string };
    assert.equal((await request(`/v1/machines/${paired.machineId}/revoke`, 'POST', {})).status, 200);
    const response = await request('/v1/audit'), text = await response.text();
    assert.equal(response.status, 200);
    assert.ok(!text.includes(value));
    const events = (JSON.parse(text) as { events: { action: string }[] }).events;
    for (const action of ['credential.create', 'machine.pair', 'machine.revoke']) assert.ok(events.some(event => event.action === action));
    assert.equal((await fetch(`${base}/v1/audit`)).status, 401);
    const agentToken = createHmac('sha256', token).update('agent:audit-agent').digest('hex');
    assert.equal((await fetch(`${base}/v1/audit`, { headers: { Authorization: `Bearer ${agentToken}`, "x-open-harness-agent": "audit-agent" } })).status, 401);
    for (const query of ['after=-1', 'after=foo', 'limit=0', 'limit=1.5', 'after=', 'limit=Infinity']) assert.equal((await request(`/v1/audit?${query}`)).status, 400);
  } finally {
    if (child.exitCode === null) { const exited = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGTERM'); await exited; }
    rmSync(stateDir, { recursive: true, force: true });
  }
});
