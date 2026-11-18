/* eslint-disable @typescript-eslint/no-explicit-any */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Dashboard uploads send createOnly so they can never replace a file an agent or another tab
// already wrote; ordinary writers (agents, restores, the API) keep overwrite semantics.
let child: ChildProcess, stateDir: string, outside: string, base = "", token = "";

async function freePort() {
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address(); assert.ok(address && typeof address !== "string");
  await new Promise<void>(resolve => server.close(() => resolve()));
  return address.port;
}
async function send(path: string, init: RequestInit = {}) {
  const response = await fetch(base + path, { ...init, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", ...init.headers } });
  return { status: response.status, body: await response.json() as any };
}
const post = (path: string, data: Record<string, unknown>) => send(path, { method: "POST", body: JSON.stringify(data) });

test.before(async () => {
  stateDir = mkdtempSync(join(tmpdir(), "open-harness-upload-"));
  outside = mkdtempSync(join(tmpdir(), "open-harness-upload-outside-"));
  const port = await freePort(); base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ["--import", "tsx", "runtime/service.ts"], { cwd: join(import.meta.dirname, ".."), env: { ...process.env, OPEN_HARNESS_MOCK: "1", OPEN_HARNESS_DISABLE_OS_VAULT: "1", OPEN_HARNESS_PORT: String(port), OPEN_HARNESS_STATE_DIR: stateDir }, stdio: "pipe" });
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try { const response = await fetch(`${base}/v1/bootstrap`); if (response.ok) { token = (await response.json() as { token: string }).token; return; } } catch { /* still starting */ }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error("Control service did not start.");
});
test.after(async () => {
  if (child.exitCode === null) await new Promise<void>(resolve => { child.once("exit", () => resolve()); child.kill("SIGTERM"); });
  rmSync(stateDir, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true });
});

test("simultaneous create-only uploads with one name keep exactly the first accepted file", async () => {
  const path = "/v1/files?scope=shared", name = "concurrent-upload.txt", contents = ["first version", "other version", "third version", "fourth version"];
  const responses = await Promise.all(contents.map(content => post(path, { name, content, createOnly: true })));
  assert.deepEqual(responses.map(response => response.status).sort(), [201, 409, 409, 409]);
  const winner = responses.findIndex(response => response.status === 201);
  assert.deepEqual(responses[winner].body, { name, scope: "shared", created: true });
  for (const response of responses.filter(item => item.status === 409)) assert.equal(response.body.error, `A file named ${name} already exists. Rename the upload first.`);
  assert.equal((await send(`${path}&name=${name}`)).body.content, contents[winner]);
  // Existing writers are unchanged: a plain POST still updates in place.
  assert.equal((await post(path, { name, content: "intentional update" })).status, 201);
  assert.equal((await send(`${path}&name=${name}`)).body.content, "intentional update");
});

test("create-only keeps validation, size limits, private scope, and symlink refusal", async () => {
  const shared = "/v1/files?scope=shared";
  assert.equal((await post(shared, { name: "../escape.txt", content: "x", createOnly: true })).status, 400);
  assert.equal((await post(shared, { name: "big.txt", content: "x".repeat(1_000_001), createOnly: true })).status, 413);
  assert.equal((await send(`${shared}&name=big.txt`)).status, 404);

  const priv = "/v1/files?scope=private&agentId=atlas";
  assert.equal((await post(priv, { name: "mine.txt", content: "private copy", createOnly: true })).status, 201);
  assert.equal((await post(priv, { name: "mine.txt", content: "replacement", createOnly: true })).status, 409);
  assert.equal((await send(`${priv}&name=mine.txt`)).body.content, "private copy");
  // The same name in another scope is a different file.
  assert.equal((await post(shared, { name: "mine.txt", content: "shared copy", createOnly: true })).status, 201);

  const target = join(outside, "target.txt"); writeFileSync(target, "outside");
  mkdirSync(join(stateDir, "shared"), { recursive: true }); symlinkSync(target, join(stateDir, "shared", "planted.txt"));
  assert.equal((await post(shared, { name: "planted.txt", content: "HACKED", createOnly: true })).status, 400);
  assert.equal(readFileSync(target, "utf8"), "outside");
});

test("create-only refuses a new name once the workspace holds 40 files, but still reports duplicates", async () => {
  const path = "/v1/files?scope=private&agentId=quota";
  for (let i = 0; i < 40; i++) assert.equal((await post(path, { name: `f${i}.txt`, content: String(i), createOnly: true })).status, 201);
  const full = await post(path, { name: "one-more.txt", content: "x", createOnly: true });
  assert.equal(full.status, 409); assert.equal(full.body.error, "The workspace already has 40 files. Remove a file to add another.");
  assert.match((await post(path, { name: "f0.txt", content: "x", createOnly: true })).body.error, /already exists/);
  // The cap applies to uploads only; agents and restores keep their existing behavior.
  assert.equal((await post(path, { name: "agent-output.txt", content: "x" })).status, 201);
});
