import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// launchers/start.sh and launchers/start.ps1 are what a person double-clicks after
// extracting a browser release, on a computer with Docker Desktop and nothing else.
// These cases run them against fake docker/curl/browser executables placed first on
// PATH, so they establish which commands the launchers run and how they react to
// what Docker answers — not that Docker Desktop on macOS or Windows behaves this way.
// Platform acceptance is recorded separately in runtime/VERIFICATION.md.
const root = resolve(import.meta.dirname, '..');
// The PowerShell launcher runs through whichever PowerShell is installed (pwsh 7 or Windows
// PowerShell); resolved to an absolute path because the launcher itself runs with a PATH
// that holds only the fakes.
const pwshBinary = ['pwsh', 'powershell'].map(name => (spawnSync('sh', ['-c', `command -v ${name}`], { encoding: 'utf8' }).stdout || '').trim()).find(Boolean) || null;
// The fakes are POSIX shell scripts and the bash launcher needs /bin/bash, so the whole
// file runs on the Linux and macOS jobs; the Windows job skips it with that reason rather
// than failing on a missing /bin/bash. The PowerShell launcher is still exercised there
// through pwsh, which those runners have.
const posixOnly = process.platform === 'win32' ? 'The fake docker/curl executables are POSIX shell scripts; the launchers are exercised on the Linux and macOS jobs (start.ps1 through pwsh).' : false;
const posixTest = (name: string, fn: () => void) => test(name, { skip: posixOnly }, fn);

type Scenario = {
  dockerMissing?: boolean;
  /** `docker info` fails this many times before succeeding (Docker Desktop starting up). */
  infoFailures?: number;
  osType?: string;
  composeMissing?: boolean;
  /** `curl`/health fails this many times before answering 200. */
  healthFailures?: number;
  pairFails?: boolean;
  desktopApp?: boolean;
};

// A release directory with a space in its name, the contract files, and a fake bin.
function release(scenario: Scenario = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'open harness release '));
  mkdirSync(join(dir, 'launchers'));
  mkdirSync(join(dir, 'runtime'));
  mkdirSync(join(dir, 'bin'));
  mkdirSync(join(dir, 'state'));
  for (const name of ['start.sh', 'start.ps1']) writeFileSync(join(dir, 'launchers', name), readFileSync(join(root, 'launchers', name)));
  chmodSync(join(dir, 'launchers', 'start.sh'), 0o755);
  writeFileSync(join(dir, 'compose.yaml'), '{"name":"open-harness","services":{}}\n');
  writeFileSync(join(dir, 'image-lock.json'), JSON.stringify({ schemaVersion: 1, images: { hermes: { ref: 'ghcr.io/example/hermes@sha256:' + 'a'.repeat(64) } } }));
  writeFileSync(join(dir, 'runtime', 'dind-entrypoint.sh'), '#!/bin/sh\n');
  const state = join(dir, 'state');
  const counter = (name: string) => `count=$(cat "${state}/${name}" 2>/dev/null || echo 0); count=$((count + 1)); echo "$count" > "${state}/${name}"`;
  // The fake docker records every invocation (with the environment the launcher exported)
  // and answers the few subcommands the launcher depends on.
  writeFileSync(join(dir, 'bin', 'docker'), `#!/bin/sh
printf '%s\\n' "docker $*" >> "${state}/calls"
printf 'HERMES_PULL=%s HERMES_IMAGE=%s\\n' "\${OPEN_HARNESS_HERMES_PULL-unset}" "\${OPEN_HARNESS_HERMES_IMAGE-unset}" >> "${state}/env"
case "$1" in
  info)
    ${counter('info')}
    if [ "$count" -le ${scenario.infoFailures ?? 0} ]; then echo "Cannot connect to the Docker daemon" >&2; exit 1; fi
    if [ "$2" = "--format" ]; then echo "${scenario.osType ?? 'linux'}"; fi
    exit 0 ;;
  compose)
    ${scenario.composeMissing ? 'echo "docker: unknown command: compose" >&2; exit 1' : ''}
    if [ "$2" = "version" ]; then echo "Docker Compose version v2.29.0"; exit 0; fi
    for arg in "$@"; do if [ "$arg" = "exec" ]; then ${scenario.pairFails ? 'exit 1' : 'printf \'{"code":"secret-code-XYZ/=+","expiresAt":"2030-01-01T00:00:00.000Z"}\\n\''}; exit 0; fi; done
    exit 0 ;;
esac
exit 0
`);
  writeFileSync(join(dir, 'bin', 'curl'), `#!/bin/sh
printf '%s\\n' "curl $*" >> "${state}/calls"
${counter('health')}
if [ "$count" -le ${scenario.healthFailures ?? 0} ]; then exit 7; fi
echo 200
`);
  writeFileSync(join(dir, 'bin', 'browser'), `#!/bin/sh
printf '%s\\n' "browser $*" >> "${state}/calls"
`);
  // macOS "open" is used both to start Docker Desktop and as the fallback browser.
  writeFileSync(join(dir, 'bin', 'open'), `#!/bin/sh
printf '%s\\n' "open $*" >> "${state}/calls"
`);
  for (const name of ['docker', 'curl', 'browser', 'open']) chmodSync(join(dir, 'bin', name), 0o755);
  if (scenario.dockerMissing) rmSync(join(dir, 'bin', 'docker'));
  return {
    dir,
    calls: () => existsSync(join(state, 'calls')) ? readFileSync(join(state, 'calls'), 'utf8').trim().split('\n') : [],
    env: () => existsSync(join(state, 'env')) ? readFileSync(join(state, 'env'), 'utf8') : '',
    log: () => existsSync(join(dir, 'open-harness-launcher.log')) ? readFileSync(join(dir, 'open-harness-launcher.log'), 'utf8') : '',
    // Only the fake bin and the system directories the scripts need for sed/tr/date.
    path: `${join(dir, 'bin')}:/usr/bin:/bin`,
  };
}
function run(fixture: ReturnType<typeof release>, args: string[], env: Record<string, string> = {}, viaWrapper = false) {
  const command = viaWrapper ? join(fixture.dir, 'Start Open Harness.command') : join(fixture.dir, 'launchers', 'start.sh');
  return spawnSync('/bin/bash', [command, ...args], {
    encoding: 'utf8', timeout: 60_000,
    env: { NODE_ENV: 'test', PATH: fixture.path, HOME: fixture.dir, OPEN_HARNESS_LAUNCHER_PLATFORM: 'darwin', OPEN_HARNESS_BROWSER_COMMAND: join(fixture.dir, 'bin', 'browser'), ...env },
  });
}
// The PowerShell launcher checks health with Invoke-WebRequest rather than curl, so it gets a
// real local endpoint that fails a chosen number of times; the launcher runs asynchronously
// because that server needs the event loop while the launcher polls it.
async function runPs(fixture: ReturnType<typeof release>, args: string[], healthFailures = 0, env: Record<string, string> = {}) {
  let remaining = healthFailures;
  const server = createServer((_request, response) => { if (remaining > 0) { remaining -= 1; response.writeHead(503); response.end(); } else { response.writeHead(200); response.end('{"ok":true}'); } });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  try {
    return await new Promise<{ status: number | null; stdout: string; stderr: string }>(resolve => {
      const child = spawn(pwshBinary!, ['-NoProfile', '-File', join(fixture.dir, 'launchers', 'start.ps1'), ...args], {
        env: { NODE_ENV: 'test', PATH: fixture.path, HOME: fixture.dir, OPEN_HARNESS_LAUNCHER_PLATFORM: 'other', OPEN_HARNESS_BROWSER_COMMAND: join(fixture.dir, 'bin', 'browser'), OPEN_HARNESS_HEALTH_URL: `http://127.0.0.1:${port}/api/health`, ...env },
      });
      let stdout = '', stderr = '';
      child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
      const timer = setTimeout(() => child.kill('SIGKILL'), 90_000);
      child.on('close', status => { clearTimeout(timer); resolve({ status, stdout, stderr }); });
    });
  } finally { server.close(); }
}
const CODE = 'secret-code-XYZ/=+';
const ENCODED = 'secret-code-XYZ%2F%3D%2B';

posixTest('start.sh: a computer without Docker is told what to install, and nothing else runs', () => {
  const fixture = release({ dockerMissing: true });
  const result = run(fixture, ['--no-open']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Docker Desktop is not installed/);
  assert.match(result.stderr, /docker compose logs --tail=100 open-harness/);
  assert.deepEqual(fixture.calls(), []);
  assert.match(fixture.log(), /Docker Desktop is not installed/);
});

posixTest('start.sh: a Docker engine in Windows-containers mode is refused before Compose runs', () => {
  const fixture = release({ osType: 'windows' });
  const result = run(fixture, ['--no-open']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /needs Linux containers/);
  assert.ok(!fixture.calls().some(call => call.startsWith('docker compose')));
});

posixTest('start.sh: a missing Compose v2 is named', () => {
  const fixture = release({ composeMissing: true });
  const result = run(fixture, ['--no-open']);
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Docker Compose v2/);
});

posixTest('start.sh: pulls the pinned images, starts without building, waits for health, mints a code and opens the paired URL without printing the code', () => {
  const fixture = release({ healthFailures: 2 });
  const result = run(fixture, []);
  assert.equal(result.status, 0, result.stderr);
  const calls = fixture.calls();
  assert.deepEqual(calls.filter(call => call.startsWith('docker compose')), [
    'docker compose version',
    'docker compose -f compose.yaml pull',
    'docker compose -f compose.yaml up -d --no-build',
    'docker compose -f compose.yaml exec -T open-harness node /opt/open-harness/runtime/browser-pair.mjs',
  ]);
  assert.equal(calls.filter(call => call.startsWith('curl')).length, 3, 'health is polled until it answers 200');
  assert.ok(calls.some(call => call.startsWith('curl') && call.includes('http://127.0.0.1:3000/api/health')));
  assert.deepEqual(calls.filter(call => call.startsWith('browser')), [`browser http://localhost:3000/#pair=${ENCODED}`]);
  // The code reaches the browser and nowhere else.
  assert.ok(!result.stdout.includes(CODE) && !result.stderr.includes(CODE) && !fixture.log().includes(CODE));
  assert.ok(!result.stdout.includes(ENCODED) && !fixture.log().includes(ENCODED));
  assert.match(result.stdout, /Open Harness is running at http:\/\/localhost:3000/);
  // Release mode leaves the image variables to the shipped compose.yaml.
  assert.match(fixture.env(), /HERMES_PULL=unset HERMES_IMAGE=unset/);
});

posixTest('start.sh: --no-open neither mints a code nor opens anything, and says how to pair', () => {
  const fixture = release();
  const result = run(fixture, ['--no-open']);
  assert.equal(result.status, 0, result.stderr);
  const calls = fixture.calls();
  assert.ok(!calls.some(call => call.includes('browser-pair.mjs')));
  assert.ok(!calls.some(call => call.startsWith('browser')));
  assert.match(result.stdout, /No browser was opened/);
  assert.match(result.stdout, /browser-pair\.mjs/);
});

posixTest('start.sh: --build is the only way to build, and it switches Hermes pulling off; a release without the source tree refuses it', () => {
  const fixture = release();
  writeFileSync(join(fixture.dir, 'Dockerfile.coordinator'), 'FROM scratch\n');
  const result = run(fixture, ['--build', '--no-open']);
  assert.equal(result.status, 0, result.stderr);
  const compose = fixture.calls().filter(call => call.startsWith('docker compose -f'));
  assert.deepEqual(compose, ['docker compose -f compose.yaml up -d --build']);
  assert.match(fixture.env(), /HERMES_PULL=0/);
  const plain = release();
  const refused = run(plain, ['--build', '--no-open']);
  assert.equal(refused.status, 64);
  assert.match(refused.stderr, /Dockerfile\.coordinator/);
  assert.deepEqual(plain.calls(), []);
});

posixTest('start.sh: an explicitly chosen override file is added to every Compose call; a missing one is refused; nothing is added otherwise', () => {
  const fixture = release();
  writeFileSync(join(fixture.dir, 'compose.host-folders.yaml'), '{"services":{}}\n');
  const result = run(fixture, ['--override', 'compose.host-folders.yaml', '--no-open']);
  assert.equal(result.status, 0, result.stderr);
  for (const call of fixture.calls().filter(call => call.startsWith('docker compose -f'))) assert.ok(call.startsWith('docker compose -f compose.yaml -f compose.host-folders.yaml '), call);
  const missing = run(release(), ['--override', 'nope.yaml', '--no-open']);
  assert.equal(missing.status, 64);
  assert.match(missing.stderr, /override file does not exist/);
});

posixTest('start.sh: running it again on a running stack is harmless and stopping keeps the volumes', () => {
  const fixture = release();
  assert.equal(run(fixture, ['--no-open']).status, 0);
  assert.equal(run(fixture, ['--no-open']).status, 0);
  const ups = fixture.calls().filter(call => call.endsWith('up -d --no-build'));
  assert.equal(ups.length, 2);
  const stop = run(fixture, ['--stop']);
  assert.equal(stop.status, 0, stop.stderr);
  const after = fixture.calls();
  assert.ok(after.some(call => call === 'docker compose -f compose.yaml stop'));
  assert.ok(!after.some(call => / down| prune| volume rm|-v\b/.test(call)), 'data-destroying commands are never issued');
  assert.match(stop.stdout, /stay in Docker volumes/);
});

posixTest('start.sh: the health wait is bounded by --timeout and ends with where to look', () => {
  const fixture = release({ healthFailures: 1000 });
  const started = Date.now();
  const result = run(fixture, ['--no-open', '--timeout', '3']);
  assert.equal(result.status, 4);
  assert.ok(Date.now() - started < 30_000);
  assert.match(result.stderr, /did not answer at http:\/\/127\.0\.0\.1:3000\/api\/health within 3 seconds/);
  assert.match(result.stderr, /data is intact/);
  assert.match(result.stderr, /docker compose ps/);
});

posixTest('start.sh: Docker Desktop that is installed but stopped is started and waited for', () => {
  const fixture = release({ infoFailures: 2 });
  // The launcher checks /Applications/Docker.app to decide it may start Docker Desktop;
  // point it at a fake application bundle through the platform override's home.
  mkdirSync(join(fixture.dir, 'Applications', 'Docker.app'), { recursive: true });
  const result = run(fixture, ['--no-open', '--timeout', '20'], { OPEN_HARNESS_DOCKER_APP: join(fixture.dir, 'Applications', 'Docker.app') });
  assert.equal(result.status, 0, result.stderr);
  assert.ok(fixture.calls().some(call => call === 'open -gja Docker'));
  assert.match(result.stdout, /Docker Desktop is not running. Starting it/);
  assert.match(result.stdout, /Docker is ready/);
});

posixTest('start.sh: when the pairing helper is unavailable the plain URL opens with a warning, and a failed opener is exit 5', () => {
  const fixture = release({ pairFails: true });
  const result = run(fixture, []);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /Could not mint a browser pairing code/);
  assert.deepEqual(fixture.calls().filter(call => call.startsWith('browser')), ['browser http://localhost:3000']);
  const noBrowser = release();
  writeFileSync(join(noBrowser.dir, 'bin', 'browser'), '#!/bin/sh\nexit 1\n');
  const failed = run(noBrowser, []);
  assert.equal(failed.status, 5);
  assert.match(failed.stderr, /no browser could be opened/);
});

posixTest('start.sh: the double-click wrapper finds the release directory with spaces and usage errors are exit 64', () => {
  const fixture = release();
  writeFileSync(join(fixture.dir, 'Start Open Harness.command'), readFileSync(join(root, 'Start Open Harness.command')));
  const result = run(fixture, ['--no-open'], {}, true);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, new RegExp(`starting in: ${fixture.dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  assert.equal(run(fixture, ['--bogus']).status, 64);
  assert.equal(run(fixture, ['--timeout', 'soon']).status, 64);
});

posixTest('start.sh: a directory that is not a full release is refused before Docker is touched', () => {
  const fixture = release();
  rmSync(join(fixture.dir, 'image-lock.json'));
  const result = run(fixture, ['--no-open']);
  assert.equal(result.status, 64);
  assert.match(result.stderr, /image-lock\.json is missing/);
  assert.deepEqual(fixture.calls(), []);
});

test('start.ps1: the same contract holds for the PowerShell launcher', { skip: posixOnly || (pwshBinary ? false : 'PowerShell is not installed here; the PowerShell launcher is exercised where pwsh is available (GitHub-hosted runners have it).') }, async () => {
  const fixture = release();
  const result = await runPs(fixture, [], 1);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const calls = fixture.calls();
  assert.deepEqual(calls.filter(call => call.startsWith('docker compose')), [
    'docker compose version',
    'docker compose -f compose.yaml pull',
    'docker compose -f compose.yaml up -d --no-build',
    'docker compose -f compose.yaml exec -T open-harness node /opt/open-harness/runtime/browser-pair.mjs',
  ]);
  assert.deepEqual(calls.filter(call => call.startsWith('browser')), [`browser http://localhost:3000/#pair=${ENCODED}`]);
  assert.ok(!result.stdout.includes(CODE) && !result.stderr.includes(CODE) && !fixture.log().includes(CODE));
  assert.match(fixture.env(), /HERMES_PULL=unset HERMES_IMAGE=unset/);

  const quiet = release();
  writeFileSync(join(quiet.dir, 'compose.host-folders.yaml'), '{"services":{}}\n');
  const noOpen = await runPs(quiet, ['--no-open', '--override', 'compose.host-folders.yaml']);
  assert.equal(noOpen.status, 0, noOpen.stderr + noOpen.stdout);
  assert.ok(!quiet.calls().some(call => call.includes('browser-pair.mjs') || call.startsWith('browser')));
  for (const call of quiet.calls().filter(call => call.startsWith('docker compose -f'))) assert.ok(call.startsWith('docker compose -f compose.yaml -f compose.host-folders.yaml '), call);

  const windows = release({ osType: 'windows' });
  const refused = await runPs(windows, ['--no-open']);
  assert.equal(refused.status, 2, refused.stderr + refused.stdout);
  assert.match(refused.stderr, /needs Linux containers/);

  const stuck = release();
  const timedOut = await runPs(stuck, ['--no-open', '--timeout', '3'], 1000);
  assert.equal(timedOut.status, 4, timedOut.stderr + timedOut.stdout);
  assert.match(timedOut.stderr, /within 3 seconds/);

  const stopped = await runPs(release(), ['--stop']);
  assert.equal(stopped.status, 0, stopped.stderr + stopped.stdout);
  assert.equal((await runPs(release(), ['--bogus'])).status, 64);
  const source = release();
  writeFileSync(join(source.dir, 'Dockerfile.coordinator'), 'FROM scratch\n');
  const built = await runPs(source, ['--build', '--no-open']);
  assert.equal(built.status, 0, built.stderr + built.stdout);
  assert.deepEqual(source.calls().filter(call => call.startsWith('docker compose -f')), ['docker compose -f compose.yaml up -d --build']);
  assert.match(source.env(), /HERMES_PULL=0/);
});
