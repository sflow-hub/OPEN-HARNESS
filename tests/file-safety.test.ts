/* eslint-disable @typescript-eslint/no-explicit-any */
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { pathToFileURL } from "node:url";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, symlinkSync, unlinkSync, rmSync, existsSync, linkSync, lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Agent containers mount these dirs read-write, so an agent can plant a symlink and wait for
// the operator to drive one of the coordinator's file endpoints through it. Every case below
// points a planted link at a file OUTSIDE the workspace and asserts the coordinator refuses to
// read, overwrite, or delete the outside target — while an ordinary file still round-trips.
// Links are planted not only on the leaf but on the base dir itself (private/shared/profile/
// skills) and left dangling, to prove the check walks from a trusted anchor the agent cannot
// alter rather than trusting the base.
type Service = { child: ChildProcess; state: string; outside: string; base: string; token: string; fileSafety: string };
const services: Service[] = [];
let stateDir: string, outsideDir: string;
let main: Service;

async function terminate(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>(resolve => {
    const timer = setTimeout(() => child.kill("SIGKILL"), 2_000);
    child.once("exit", () => { clearTimeout(timer); resolve(); });
    child.kill("SIGTERM");
  });
}
async function freePort() {
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address(); assert.ok(address && typeof address !== "string");
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return address.port;
}
async function start(hooked = false): Promise<Service> {
  const state = mkdtempSync(join(tmpdir(), "open-harness-filesafety-"));
  const outside = mkdtempSync(join(tmpdir(), "open-harness-outside-"));
  let child: ChildProcess | undefined;
  try {
    const port = await freePort(), base = `http://127.0.0.1:${port}`;
    // tsx resolves service.ts's './safe-fs' to this same file URL. The moved-dir
    // assertions below prove the installed hooks actually ran in the HTTP handler.
    const code = `
      const fs = await import(${JSON.stringify(pathToFileURL(join(import.meta.dirname, "../runtime/safe-fs.ts")).href)});
      const disk = await import('node:fs');
      const path = await import('node:path');
      const counts = new Map();
      for (const phase of ['beforeTerminalOp', 'betweenReaddirAndLstat']) {
        fs.__setSafeFsHook(phase, ({ name }) => {
          if (!/^race-(read|write|create|delete|list)\\.txt$/.test(name || '')) return;
          const id = name.replace('.txt', '');
          if ((phase === 'betweenReaddirAndLstat') !== (id === 'race-list')) return;
          const count = (counts.get(name) || 0) + 1; counts.set(name, count);
          if (count !== (id === 'race-read' ? 2 : 1)) return;
          const parent = path.join(process.env.OPEN_HARNESS_STATE_DIR, 'agents', id, 'private');
          disk.renameSync(parent, parent + '.moved');
          disk.symlinkSync(path.join(process.env.FILE_SAFETY_OUTSIDE, id), parent);
        });
      }
      await import(${JSON.stringify(pathToFileURL(join(import.meta.dirname, "../runtime/service.ts")).href)});
    `;
    child = spawn(process.execPath, hooked ? ["--import", "tsx", "--input-type=module", "-e", code] : ["--import", "tsx", "runtime/service.ts"], {
      cwd: join(import.meta.dirname, ".."), stdio: "pipe",
      env: { ...process.env, OPEN_HARNESS_MOCK: "1", OPEN_HARNESS_BIND: "127.0.0.1", OPEN_HARNESS_PORT: String(port), OPEN_HARNESS_STATE_DIR: state, OPEN_HARNESS_SAFE_FS_TEST_HOOKS: hooked ? "1" : "0", OPEN_HARNESS_SAFE_FS_MODE: "", FILE_SAFETY_OUTSIDE: outside },
    });
    const owned = child;
    let stderr = "", stdout = "";
    owned.stderr?.on("data", chunk => { stderr += String(chunk); });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error(`Coordinator readiness timed out.\n${stderr}`)), 10_000);
      const finish = (error?: Error) => { clearTimeout(timer); owned.removeListener("exit", exited); owned.removeListener("error", failed); owned.stdout?.removeListener("data", output); if (error) reject(error); else resolve(); };
      const exited = (code: number | null, signal: string | null) => finish(new Error(`Coordinator exited early (code=${code}, signal=${signal}).\n${stderr}`));
      const failed = (error: Error) => finish(error);
      const output = (chunk: Buffer) => { stdout += String(chunk); if (stdout.split(/\r?\n/).includes(`Open Harness coordinator listening on ${base}`)) finish(); };
      owned.once("exit", exited); owned.once("error", failed); owned.stdout?.on("data", output);
    });
    const response = await fetch(`${base}/v1/bootstrap`, { signal: AbortSignal.timeout(10_000) });
    assert.equal(response.status, 200);
    const bootstrap = await response.json() as { token: string; fileSafety: string };
    assert.ok(bootstrap.token);
    const service = { child, state, outside, base, ...bootstrap }; services.push(service); return service;
  } catch (error) {
    if (child) await terminate(child);
    rmSync(state, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); throw error;
  }
}
const createdAgents = new Map<string, Promise<void>>();
async function send(path: string, init: RequestInit = {}, service = main) {
  const url = new URL(path, service.base), agent = url.searchParams.get('agentId') || url.pathname.match(/^\/v1\/agents\/([^/]+)\/context/)?.[1];
  if (agent) {
    const key = `${service.base}:${agent}`;
    if (!createdAgents.has(key)) createdAgents.set(key, (async () => {
      const response = await fetch(`${service.base}/v1/agents`, { method: 'POST', headers: { Authorization: `Bearer ${service.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ id: agent, name: agent.slice(0, 30) }), signal: AbortSignal.timeout(10_000) });
      assert.ok([201, 409].includes(response.status), `Creating fixture agent ${agent}: ${response.status}`);
    })());
    await createdAgents.get(key);
  }
  const response = await fetch(`${service.base}${path}`, { ...init, signal: AbortSignal.timeout(10_000), headers: { Authorization: `Bearer ${service.token}`, "Content-Type": "application/json", ...init.headers } });
  let body: any = null; try { body = await response.json(); } catch {}
  return { status: response.status, body };
}
function fdTest(name: string, fn: () => Promise<void>) {
  test(name, async t => { if (main.fileSafety !== "fd-relative") { t.skip(`fileSafety=${main.fileSafety}`); return; } await fn(); });
}
function outside(name: string, content: string) { const path = join(outsideDir, name); writeFileSync(path, content); return path; }
function agentDir(id: string) { const dir = join(stateDir, "agents", id); mkdirSync(dir, { recursive: true }); return dir; }

test.before(async () => { main = await start(); stateDir = main.state; outsideDir = main.outside; });
test.after(async () => {
  for (const service of services) {
    await terminate(service.child);
    rmSync(service.state, { recursive: true, force: true }); rmSync(service.outside, { recursive: true, force: true });
  }
});

test("private workspace files refuse to follow a planted symlink", async () => {
  const id = "sym-private", secret = outside("private-secret.txt", "TOP SECRET PRIVATE");
  const dir = join(stateDir, "agents", id, "private"); mkdirSync(dir, { recursive: true });
  symlinkSync(secret, join(dir, "link.txt"));
  const q = `scope=private&agentId=${id}`;
  assert.equal((await send(`/v1/files?${q}&name=link.txt`)).status, 400);
  assert.equal((await send(`/v1/files?${q}`, { method: "POST", body: JSON.stringify({ name: "link.txt", content: "HACKED" }) })).status, 400);
  assert.equal(readFileSync(secret, "utf8"), "TOP SECRET PRIVATE");
  assert.equal((await send(`/v1/files?${q}&name=link.txt`, { method: "DELETE" })).status, 400);
  assert.ok(existsSync(secret));
  // A regular file still round-trips unchanged.
  assert.equal((await send(`/v1/files?${q}`, { method: "POST", body: JSON.stringify({ name: "note.txt", content: "hello" }) })).status, 201);
  assert.equal((await send(`/v1/files?${q}&name=note.txt`)).body.content, "hello");
});

test("a private dir that is itself a symlink is refused, never followed or created through", async () => {
  const id = "sym-private-base", home = join(outsideDir, "outside-home"); mkdirSync(home, { recursive: true });
  const loot = join(home, "loot.txt"); writeFileSync(loot, "OUTSIDE HOME");
  // Replace the whole `private` base dir with a link to an outside directory, before it exists.
  symlinkSync(home, join(agentDir(id), "private"), process.platform === "win32" ? "junction" : "dir");
  const q = `scope=private&agentId=${id}`;
  assert.equal((await send(`/v1/files?${q}`)).status, 400);                                                   // listing
  assert.equal((await send(`/v1/files?${q}&name=loot.txt`)).status, 400);                                     // read
  assert.equal((await send(`/v1/files?${q}`, { method: "POST", body: JSON.stringify({ name: "planted.txt", content: "HACKED" }) })).status, 400);
  assert.equal((await send(`/v1/files?${q}&name=loot.txt`, { method: "DELETE" })).status, 400);
  assert.equal(readFileSync(loot, "utf8"), "OUTSIDE HOME");
  assert.deepEqual(readdirSync(home).sort(), ["loot.txt"]);                                                   // nothing created outside
});

test("shared workspace files refuse to follow a planted symlink", async () => {
  const secret = outside("shared-secret.txt", "TOP SECRET SHARED");
  const dir = join(stateDir, "shared"); mkdirSync(dir, { recursive: true });
  symlinkSync(secret, join(dir, "shared-link.txt"));
  const q = "scope=shared";
  assert.equal((await send(`/v1/files?${q}&name=shared-link.txt`)).status, 400);
  assert.equal((await send(`/v1/files?${q}`, { method: "POST", body: JSON.stringify({ name: "shared-link.txt", content: "HACKED" }) })).status, 400);
  assert.equal(readFileSync(secret, "utf8"), "TOP SECRET SHARED");
  assert.equal((await send(`/v1/files?${q}&name=shared-link.txt`, { method: "DELETE" })).status, 400);
  assert.ok(existsSync(secret));
  // Planted symlinks are skipped by the listing rather than statted through.
  assert.ok(!(await send(`/v1/files?${q}`)).body.files.some((f: any) => f.name === "shared-link.txt"));
  assert.equal((await send(`/v1/files?${q}`, { method: "POST", body: JSON.stringify({ name: "shared-note.txt", content: "hi there" }) })).status, 201);
  assert.equal((await send(`/v1/files?${q}&name=shared-note.txt`)).body.content, "hi there");
});

test("a shared dir that is itself a symlink is refused", async () => {
  const home = join(outsideDir, "outside-shared"); mkdirSync(home, { recursive: true });
  const loot = join(home, "shared-loot.txt"); writeFileSync(loot, "OUTSIDE SHARED");
  const dir = join(stateDir, "shared");
  // The coordinator created `shared` at startup; swap it for a link to an outside directory.
  rmSync(dir, { recursive: true, force: true }); symlinkSync(home, dir, process.platform === "win32" ? "junction" : "dir");
  const q = "scope=shared";
  assert.equal((await send(`/v1/files?${q}`)).status, 400);
  assert.equal((await send(`/v1/files?${q}&name=shared-loot.txt`)).status, 400);
  assert.equal((await send(`/v1/files?${q}`, { method: "POST", body: JSON.stringify({ name: "planted.txt", content: "HACKED" }) })).status, 400);
  assert.equal(readFileSync(loot, "utf8"), "OUTSIDE SHARED");
  assert.deepEqual(readdirSync(home).sort(), ["shared-loot.txt"]);
  // Restore a real shared dir so later shared operations are unaffected.
  unlinkSync(dir); mkdirSync(dir, { recursive: true });
});

test("skill endpoints refuse to follow a planted symlink", async () => {
  const id = "sym-skill", outsideSkill = join(outsideDir, "outside-skill"); mkdirSync(outsideSkill, { recursive: true });
  const outsideFile = join(outsideSkill, "SKILL.md"); writeFileSync(outsideFile, "OUTSIDE SKILL");
  const skillsDir = join(stateDir, "agents", id, "profile", "skills"); mkdirSync(skillsDir, { recursive: true });
  symlinkSync(outsideSkill, join(skillsDir, "evil"), process.platform === "win32" ? "junction" : "dir");
  const evil = `/v1/agents/${id}/context/skills/evil`;
  const get = await send(evil); assert.equal(get.status, 400); assert.notEqual(get.body?.content, "OUTSIDE SKILL");
  assert.equal((await send(evil, { method: "PUT", body: JSON.stringify({ content: "HACKED" }) })).status, 400);
  assert.equal(readFileSync(outsideFile, "utf8"), "OUTSIDE SKILL");
  assert.equal((await send(evil, { method: "DELETE" })).status, 400);
  assert.ok(existsSync(outsideFile));
  // A real skill still round-trips.
  const good = `/v1/agents/${id}/context/skills/report-writer`;
  assert.equal((await send(good, { method: "PUT", body: JSON.stringify({ content: "# Report writer\nUse concise sections." }) })).status, 200);
  assert.match((await send(good)).body.content, /concise sections/);
});

test("a skills dir that is itself a symlink is refused by skill and context endpoints", async () => {
  const id = "sym-skills-base", outsideSkills = join(outsideDir, "outside-skills"); mkdirSync(join(outsideSkills, "planted"), { recursive: true });
  writeFileSync(join(outsideSkills, "planted", "SKILL.md"), "OUTSIDE SKILLS");
  const profile = join(stateDir, "agents", id, "profile"); mkdirSync(profile, { recursive: true });
  symlinkSync(outsideSkills, join(profile, "skills"), process.platform === "win32" ? "junction" : "dir");
  const planted = `/v1/agents/${id}/context/skills/planted`;
  assert.equal((await send(planted)).status, 400);
  assert.equal((await send(planted, { method: "PUT", body: JSON.stringify({ content: "HACKED" }) })).status, 400);
  assert.equal(readFileSync(join(outsideSkills, "planted", "SKILL.md"), "utf8"), "OUTSIDE SKILLS");
  // Listing skills via the context endpoint must refuse rather than silently enumerate through the link.
  assert.equal((await send(`/v1/agents/${id}/context`)).status, 400);
});

test("context endpoints refuse to follow a planted MEMORY.md symlink", async () => {
  const id = "sym-ctx", secret = outside("ctx-secret.txt", "OUTSIDE MEMORY");
  const profile = join(stateDir, "agents", id, "profile"); mkdirSync(profile, { recursive: true });
  mkdirSync(join(profile, "memories"));
  symlinkSync(secret, join(profile, "memories", "MEMORY.md"));
  const get = await send(`/v1/agents/${id}/context`); assert.equal(get.status, 400); assert.notEqual(get.body?.memory, "OUTSIDE MEMORY");
  assert.equal((await send(`/v1/agents/${id}/context`, { method: "PUT", body: JSON.stringify({ memory: "HACKED" }) })).status, 400);
  assert.equal(readFileSync(secret, "utf8"), "OUTSIDE MEMORY");
  // A fresh agent writes and reads its memory normally.
  const fresh = "ctx-ok";
  assert.equal((await send(`/v1/agents/${fresh}/context`, { method: "PUT", body: JSON.stringify({ memory: "remember this" }) })).status, 200);
  assert.equal((await send(`/v1/agents/${fresh}/context`)).body.memory, "remember this");
});

test("context GET refuses a planted USER.md symlink", async () => {
  const id = "sym-user", secret = outside("user-secret.txt", "OUTSIDE USER");
  const profile = join(stateDir, "agents", id, "profile"); mkdirSync(profile, { recursive: true });
  symlinkSync(secret, join(profile, "USER.md"));
  const get = await send(`/v1/agents/${id}/context`); assert.equal(get.status, 400); assert.notEqual(get.body?.user, "OUTSIDE USER");
  assert.equal(readFileSync(secret, "utf8"), "OUTSIDE USER");
});

test("a dangling MEMORY.md symlink is a symlink (400), never read as empty", async () => {
  const id = "sym-dangling";
  const profile = join(stateDir, "agents", id, "profile"); mkdirSync(profile, { recursive: true });
  // Points at a path that does not exist: existsSync would say "absent" and yield "".
  symlinkSync(join(outsideDir, "does-not-exist.txt"), join(profile, "MEMORY.md"));
  const get = await send(`/v1/agents/${id}/context`);
  assert.equal(get.status, 400);
  assert.notEqual(get.body?.memory, "");
});


test("ordinary private/shared files, skills and memory round-trip in every mode", async () => {
  for (const query of ["scope=private&agentId=ordinary", "scope=shared"]) {
    const endpoint = `/v1/files?${query}`;
    assert.equal((await send(endpoint, { method: "POST", body: JSON.stringify({ name: "ordinary.txt", content: "hello" }) })).status, 201);
    assert.equal((await send(`${endpoint}&name=ordinary.txt`)).body.content, "hello");
    assert.ok((await send(endpoint)).body.files.some((file: any) => file.name === "ordinary.txt"));
    assert.equal((await send(`${endpoint}&name=ordinary.txt`, { method: "DELETE" })).status, 200);
    assert.equal((await send(`${endpoint}&name=ordinary.txt`)).status, 404);
  }
  const context = "/v1/agents/ordinary/context", skill = `${context}/skills/ordinary`;
  assert.equal((await send(context, { method: "PUT", body: JSON.stringify({ memory: "remember" }) })).status, 200);
  assert.equal((await send(context)).body.memory, "remember");
  assert.equal((await send(skill, { method: "PUT", body: JSON.stringify({ content: "# Ordinary" }) })).status, 200);
  assert.equal((await send(skill)).body.content, "# Ordinary");
  assert.equal((await send(skill, { method: "DELETE" })).status, 200);
});

test("a hard-linked workspace file remains readable", async () => {
  const dir = join(agentDir("hard-link"), "private"); mkdirSync(dir);
  writeFileSync(join(dir, "original.txt"), "hard links are allowed");
  linkSync(join(dir, "original.txt"), join(dir, "linked.txt"));
  const result = await send("/v1/files?scope=private&agentId=hard-link&name=linked.txt");
  assert.equal(result.status, 200); assert.equal(result.body.content, "hard links are allowed");
});

fdTest("HTTP operations survive hook-driven parent swaps in the service process", async () => {
  const service = await start(true); assert.equal(service.fileSafety, "fd-relative");
  for (const operation of ["read", "write", "create", "delete", "list"]) {
    const id = `race-${operation}`, name = `${id}.txt`;
    const parent = join(service.state, "agents", id, "private"), outside = join(service.outside, id);
    mkdirSync(parent, { recursive: true }); mkdirSync(outside);
    if (operation !== "create") writeFileSync(join(parent, name), "inside");
    writeFileSync(join(outside, name), "OUTSIDE RACE SECRET");
    writeFileSync(join(outside, "outside-only.txt"), "OUTSIDE RACE SECRET");
    const endpoint = `/v1/files?scope=private&agentId=${id}`;
    const result = await send(operation === "list" || operation === "write" || operation === "create" ? endpoint : `${endpoint}&name=${name}`,
      operation === "write" || operation === "create" ? { method: "POST", body: JSON.stringify({ name, content: "written inside" }) } : operation === "delete" ? { method: "DELETE" } : {}, service);
    assert.ok(existsSync(`${parent}.moved`), `hook executed for ${operation}`);
    assert.ok(lstatSync(parent).isSymbolicLink());
    assert.ok(!JSON.stringify(result.body).includes("OUTSIDE RACE SECRET"));
    // GET's first terminal operation is stat; the hook fires on its second (read).
    assert.equal(result.status, operation === "write" || operation === "create" ? 201 : operation === "list" ? 400 : 200, `${operation}: ${JSON.stringify(result.body)}`);
    if (operation === "read") assert.equal(result.body.content, "inside");
    if (operation === "write" || operation === "create") assert.equal(readFileSync(join(`${parent}.moved`, name), "utf8"), "written inside");
    if (operation === "delete") assert.ok(!existsSync(join(`${parent}.moved`, name)));
    if (operation === "list") assert.ok(!JSON.stringify(result.body).includes("outside-only.txt"));
    assert.deepEqual(readdirSync(outside).sort(), [name, "outside-only.txt"].sort());
    for (const file of readdirSync(outside)) assert.equal(readFileSync(join(outside, file), "utf8"), "OUTSIDE RACE SECRET");
  }
});

fdTest("external-process parent swaps never reach outside files over HTTP", async () => {
  const id = "stress", parent = join(agentDir(id), "private"), outside = join(outsideDir, "stress");
  mkdirSync(parent); mkdirSync(outside);
  writeFileSync(join(outside, "sentinel.txt"), "OUTSIDE STRESS SECRET");
  const code = `
    const fs = require('node:fs'); const [parent, outside] = process.argv.slice(1);
    const attempt = operation => {
      try { operation(); return true; }
      catch (error) {
        if (!['EEXIST', 'ENOENT', 'ENOTEMPTY'].includes(error.code)) throw error;
        return false;
      }
    };
    const restore = () => {
      while (true) {
        if (!attempt(() => fs.rmSync(parent, { recursive: true, force: true }))) continue;
        if (attempt(() => fs.renameSync(parent + '.held', parent))) return;
        if (attempt(() => fs.mkdirSync(parent))) return;
      }
    };
    const end = Date.now() + 2300; let swaps = 0;
    while (Date.now() < end) {
      try {
        if (!attempt(() => fs.renameSync(parent, parent + '.held'))) continue;
        let linked = attempt(() => fs.symlinkSync(outside, parent));
        if (!linked && attempt(() => fs.rmSync(parent, { recursive: true, force: true }))) {
          linked = attempt(() => fs.symlinkSync(outside, parent));
        }
        if (linked) swaps++;
      } finally { restore(); }
    }
    console.log(swaps);
  `;
  const swapper = spawn(process.execPath, ["-e", code, parent, outside], { stdio: "pipe" });
  let stderr = "", stdout = "";
  swapper.stderr?.on("data", chunk => { stderr += String(chunk); });
  swapper.stdout?.on("data", chunk => { stdout += String(chunk); });
  const exited = new Promise<number | null>((resolve, reject) => { swapper.once("exit", resolve); swapper.once("error", reject); });
  try {
    const endpoint = `/v1/files?scope=private&agentId=${id}`, end = Date.now() + 2500;
    let batches = 0;
    do {
      const results = await Promise.all([
        send(`${endpoint}&name=sentinel.txt`), send(endpoint),
        send(endpoint, { method: "POST", body: JSON.stringify({ name: "new.txt", content: "inside" }) }),
        send(endpoint, { method: "POST", body: JSON.stringify({ name: "sentinel.txt", content: "overwrite" }) }),
        send(`${endpoint}&name=sentinel.txt`, { method: "DELETE" }),
      ]);
      for (const result of results) {
        // Errors map to 400; the real guarantees are the no-leak and outside-intact checks.
        assert.ok([200, 201, 400, 404, 409].includes(result.status), JSON.stringify(result));
        assert.ok(!JSON.stringify(result.body).includes("OUTSIDE STRESS SECRET"));
      }
      batches++;
    } while (Date.now() < end);
    assert.ok(batches > 1);
    assert.equal(await exited, 0, stderr); assert.ok(Number(stdout.trim()) > 0, "swapper ran");
    assert.deepEqual(readdirSync(outside), ["sentinel.txt"]);
    assert.equal(readFileSync(join(outside, "sentinel.txt"), "utf8"), "OUTSIDE STRESS SECRET");
  } finally { await terminate(swapper); await exited; }
});
