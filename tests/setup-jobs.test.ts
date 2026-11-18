/* eslint-disable @typescript-eslint/no-explicit-any */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSetupJobs, RUNTIME_CONTRACT, type SetupTasks } from "../runtime/readiness";
import type { OnboardingStatus } from "../lib/onboarding";

function deferred() {
  let resolve!: () => void, reject!: (error: Error) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function controllable() {
  const calls: string[] = [];
  let pending = deferred();
  const tasks: SetupTasks = {
    "start-container-engine": () => { calls.push("start-container-engine"); return pending.promise; },
    "prepare-runtime": () => { calls.push("prepare-runtime"); return pending.promise; },
  };
  return { tasks, calls, finish: () => pending.resolve(), fail: (message: string) => pending.reject(new Error(message)), reset: () => { pending = deferred(); } };
}

test("a setup job runs once, joins repeat requests, and refuses a different action while running", async () => {
  const fake = controllable(), jobs = createSetupJobs(fake.tasks);
  assert.equal(jobs.current(), undefined);
  const first = jobs.start("prepare-runtime");
  assert.equal(first.accepted, true);
  assert.equal(first.job.state, "running");
  const again = jobs.start("prepare-runtime");
  assert.deepEqual([again.accepted, again.job.state], [true, "running"]);
  const other = jobs.start("start-container-engine");
  assert.equal(other.accepted, false);
  assert.equal(other.job.action, "prepare-runtime");
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(fake.calls, ["prepare-runtime"], "joining or refusing must not start a second task");
  fake.finish();
  await jobs.settled();
  assert.deepEqual(jobs.current(), { action: "prepare-runtime", state: "succeeded", message: "The agent runtime is ready." });
});

test("a failed setup job keeps its message and can be retried", async () => {
  const fake = controllable(), jobs = createSetupJobs(fake.tasks);
  jobs.start("start-container-engine");
  fake.fail("Docker did not become ready.");
  await jobs.settled();
  assert.deepEqual(jobs.current(), { action: "start-container-engine", state: "failed", message: "Docker did not become ready." });
  fake.reset();
  const retry = jobs.start("start-container-engine");
  assert.deepEqual([retry.accepted, retry.job.state], [true, "running"]);
  fake.finish();
  await jobs.settled();
  assert.equal(jobs.current()?.state, "succeeded");
  assert.deepEqual(fake.calls, ["start-container-engine", "start-container-engine"]);
});

test("unknown setup actions are rejected without changing the current job", () => {
  const jobs = createSetupJobs(controllable().tasks);
  assert.throws(() => jobs.start("rm -rf"), /Unknown setup action/);
  assert.equal(jobs.current(), undefined);
});

test("a thrown task with no message still reports a plain failure", async () => {
  const jobs = createSetupJobs({ "start-container-engine": async () => { throw new Error(" "); }, "prepare-runtime": async () => {} });
  jobs.start("start-container-engine");
  await jobs.settled();
  assert.deepEqual(jobs.current(), { action: "start-container-engine", state: "failed", message: "Setup did not finish. Try again." });
});

test("the onboarding routes answer at once and the job survives the client going away", async () => {
  const port = 14393, base = `http://127.0.0.1:${port}`, stateDir = mkdtempSync(join(tmpdir(), "open-harness-setup-"));
  const child: ChildProcess = spawn(process.execPath, ["--import", "tsx", "runtime/service.ts"], { cwd: join(import.meta.dirname, ".."), env: { ...process.env, OPEN_HARNESS_MOCK: "1", OPEN_HARNESS_DISABLE_OS_VAULT: "1", OPEN_HARNESS_PORT: String(port), OPEN_HARNESS_STATE_DIR: stateDir }, stdio: "pipe" });
  try {
    let token = "";
    const deadline = Date.now() + 30_000;
    while (!token && Date.now() < deadline) {
      try { const response = await fetch(`${base}/v1/bootstrap`); if (response.ok) token = ((await response.json()) as any).token; } catch {}
      if (!token) await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.ok(token, "Control service did not start.");
    const call = (path: string, init: RequestInit = {}) => fetch(`${base}${path}`, { ...init, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" } });

    const idle = await (await call("/v1/onboarding/status")).json() as any;
    assert.equal(idle.setupJob, undefined);

    // Start the job and abandon the connection before reading the reply, as a closed tab would.
    const abort = new AbortController();
    const started = call("/v1/onboarding/action", { method: "POST", body: JSON.stringify({ action: "prepare-runtime" }), signal: abort.signal });
    const first = await started;
    abort.abort();
    assert.equal(first.status, 202);

    const conflict = await call("/v1/onboarding/action", { method: "POST", body: JSON.stringify({ action: "start-container-engine" }) });
    assert.equal(conflict.status, 409);
    const conflictBody = await conflict.json() as any;
    assert.equal(conflictBody.setupJob.action, "prepare-runtime");
    assert.match(conflictBody.error, /current setup step/);

    const joined = await call("/v1/onboarding/action", { method: "POST", body: JSON.stringify({ action: "prepare-runtime" }) });
    assert.equal(joined.status, 202);
    assert.equal(((await joined.json()) as any).setupJob.state, "running");

    let status: any;
    const finishBy = Date.now() + 30_000;
    do { status = await (await call("/v1/onboarding/status")).json(); if (status.setupJob?.state !== "running") break; await new Promise(resolve => setTimeout(resolve, 50)); } while (Date.now() < finishBy);
    assert.deepEqual(status.setupJob, { action: "prepare-runtime", state: "succeeded", message: "The agent runtime is ready." });
    assert.equal(status.executionReady, true);

    const unknown = await call("/v1/onboarding/action", { method: "POST", body: JSON.stringify({ action: "format-disk" }) });
    assert.equal(unknown.status, 400);
    assert.match(((await unknown.json()) as any).error, /Unknown setup action/);
  } finally { child.kill("SIGTERM"); }
});

test("a blocked Docker mount leaves setup responsive and cannot restore pre-build readiness", { skip: process.platform === "win32" }, async () => {
  const fixture = mkdtempSync(join(tmpdir(), "harness-readiness-")), port = 14394;
  // Each fake build or mount waits for its own release file. Successful mounts must
  // read the canary from the exact host path passed to Docker.
  writeFileSync(join(fixture, "docker"), `#!/bin/sh
case "$1" in
  --version|version) echo Docker; exit 0;;
  image) echo ${RUNTIME_CONTRACT}; exit 0;;
  build|run) ;;
  *) exit 0;;
esac
i=1
while ! mkdir "$PROBE_FIXTURE/$1-$i" 2>/dev/null; do
  [ -d "$PROBE_FIXTURE" ] || exit 1
  i=$((i + 1))
done
release="$PROBE_FIXTURE/$1-$i/release"
while [ ! -f "$release" ]; do
  [ -d "$PROBE_FIXTURE" ] || exit 1
  sleep 0.05
done
[ "$(cat "$release")" = ok ] || exit 1
if [ "$1" = run ]; then
  for arg in "$@"; do case "$arg" in *:/probe:ro) dir=\${arg%:/probe:ro};; /probe/*) file=\${arg#/probe/};; esac; done
  cat "$dir/$file"
fi
`, { mode: 0o755 });
  for (const python of ["python", "python3"]) writeFileSync(join(fixture, python), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  const child = spawn(process.execPath, ["--import", "tsx", "runtime/service.ts"], {
    cwd: join(import.meta.dirname, ".."), stdio: "ignore",
    env: { ...process.env, OPEN_HARNESS_MOCK: "0", OPEN_HARNESS_DISABLE_OS_VAULT: "1", OPEN_HARNESS_PORT: String(port),
      OPEN_HARNESS_STATE_DIR: join(fixture, "state"), PATH: fixture + ":" + process.env.PATH, HERMES_PYTHON: join(fixture, "python"), PROBE_FIXTURE: fixture },
  });
  let token = "";
  const wait = () => new Promise(resolve => setTimeout(resolve, 30));
  const call = (path: string, init: RequestInit = {}) => fetch(`http://127.0.0.1:${port}/v1/${path}`, {
    ...init, signal: AbortSignal.timeout(10_000), headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
  });
  const build = () => call("onboarding/action", { method: "POST", body: JSON.stringify({ action: "prepare-runtime" }) });
  async function verified(path = "onboarding/status") {
    for (;;) {
      const body = await (await call(path)).json() as any;
      const status: OnboardingStatus = path === "support-bundle" ? body.readiness : body;
      if (status.setupJob?.state !== "running") return status;
      await wait();
    }
  }
  async function started(name: string) {
    const until = Date.now() + 8_000;
    while (Date.now() < until && !existsSync(join(fixture, name))) await wait();
    assert.ok(existsSync(join(fixture, name)), name + " did not start");
  }
  const release = (name: string, outcome = "ok") => writeFileSync(join(fixture, name, "release"), outcome);
  try {
    const until = Date.now() + 30_000;
    while (!token && Date.now() < until) {
      try { token = ((await (await call("bootstrap")).json()) as any).token; } catch { await wait(); }
    }
    assert.ok(token);
    const cold = await build();
    assert.equal(cold.status, 202);
    assert.equal(((await cold.json()) as any).setupJob.state, "running");
    assert.equal(((await (await call("onboarding/status")).json()) as any).setupJob.state, "running");
    await started("build-1");
    release("build-1");
    const before = verified("support-bundle");
    await started("run-1");
    const concurrent = verified();
    assert.equal((await call("health")).status, 200);
    assert.equal((await build()).status, 202);
    await started("build-2");
    release("build-2");

    const after = verified();
    await started("run-2");
    release("run-1"); // This successful pre-build check is obsolete.
    release("run-2", "denied");
    for (const status of await Promise.all([before, concurrent, after])) {
      assert.equal(status.setupJob?.state, "succeeded");
      assert.equal(status.executionReady, false);
      assert.equal(status.checks.find(c => c.id === "workspace-sharing")?.state, "action");
    }
    const retry = verified();
    await started("run-3");
    release("run-3");
    assert.equal((await retry).executionReady, true);
  } finally { child.kill("SIGTERM"); rmSync(fixture, { recursive: true, force: true }); }
});
