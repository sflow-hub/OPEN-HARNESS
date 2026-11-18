import { spawn, spawnSync } from 'node:child_process';
import { HERMES_IMAGE_TAG } from '../lib/hermes-pin';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { SETUP_ACTIONS, type OnboardingStatus, type ReadinessCheck, type SetupAction, type SetupJob } from '../lib/onboarding';
import { resetSharingChecks, stateSharing, stateSharingAsync, type SharingProbe } from './hermes';

export const HERMES_IMAGE = process.env.OPEN_HARNESS_HERMES_IMAGE || `open-harness-hermes:${HERMES_IMAGE_TAG}`;

// Every layer of the managed-run handshake -- the policy extension, managed_entry.py,
// inspect_runtime.py, the config shape -- ships inside the image, so an image built before
// a fix keeps the bug while its tag never changes. The image carries this number as a
// label. Anything else means "rebuild", including no label at all: contract 1 is the set
// of images built before the label existed. Bump it whenever runtime/hermes/ changes.
export const RUNTIME_CONTRACT = 2;
export const RUNTIME_LABEL = 'dev.openharness.runtime';
export type ImageContract = 'missing' | 'stale' | 'current';
export function classifyContract(result: { status: number | null; stdout: string }): ImageContract {
  if (result.status !== 0) return 'missing';
  return result.stdout.trim() === String(RUNTIME_CONTRACT) ? 'current' : 'stale';
}
export function imageContract(run: (name: string, args: string[]) => { status: number | null; stdout: string } = command): ImageContract {
  return classifyContract(run('docker', ['image', 'inspect', '-f', `{{index .Config.Labels "${RUNTIME_LABEL}"}}`, HERMES_IMAGE]));
}

const platform = (['linux', 'darwin', 'win32'].includes(process.platform) ? process.platform : 'unknown') as OnboardingStatus['platform'];
const labels = { linux: 'Linux', darwin: 'macOS', win32: 'Windows', unknown: 'this operating system' } as const;
const installUrls = {
  linux: 'https://docs.docker.com/engine/install/',
  darwin: 'https://docs.docker.com/desktop/setup/install/mac-install/',
  win32: 'https://docs.docker.com/desktop/setup/install/windows-install/',
  unknown: 'https://docs.docker.com/get-started/get-docker/',
} as const;

type Probe = { status: number | null; stdout: string; stderr: string };

function command(name: string, args: string[], timeout = 7_000) {
  return spawnSync(name, args, { encoding: 'utf8', timeout });
}

// The coordinator serves runs and the dashboard from one event loop, so anything reached
// from a request or a setup job uses this rather than spawnSync. A hung CLI is killed at
// the deadline and reported as a failed probe instead of stalling every other request.
function commandAsync(name: string, args: string[], timeout = 7_000) {
  return new Promise<Probe>(resolve => {
    let stdout = '', stderr = '', done = false;
    const finish = (status: number | null) => { if (done) return; done = true; clearTimeout(timer); resolve({ status, stdout, stderr }); };
    const child = spawn(name, args, { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', chunk => { stdout = (stdout + String(chunk)).slice(-16_000); });
    child.stderr.on('data', chunk => { stderr = (stderr + String(chunk)).slice(-8_000); });
    const timer = setTimeout(() => { child.kill('SIGKILL'); finish(null); }, timeout);
    timer.unref();
    child.once('error', () => finish(null));
    child.once('close', code => finish(code));
  });
}

const pythons = () => [...new Set([process.env.HERMES_PYTHON, platform === 'win32' ? 'python' : 'python3', 'python'].filter(Boolean) as string[])];
const PYTHON_PROBE = ['-c', 'import hermes_cli, open_harness_policy'];

function pythonReady() {
  for (const executable of pythons()) {
    const result = command(executable, PYTHON_PROBE, 8_000);
    if (result.status === 0) return true;
  }
  return false;
}

function desktopCheck(): ReadinessCheck {
  if (platform === 'linux') {
    const active = Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
    return active
      ? { id: 'desktop', label: 'Desktop control', state: 'ready', detail: 'A graphical session is available. Existing-desktop control can be enabled per agent.' }
      : { id: 'desktop', label: 'Desktop control', state: 'unavailable', detail: 'No graphical session is active. Private virtual desktops remain available inside isolated workspaces.' };
  }
  if (platform === 'darwin') return { id: 'desktop', label: 'Desktop control', state: 'action', detail: 'macOS will ask for Accessibility and Screen Recording access when an agent first controls this desktop.' };
  if (platform === 'win32') return { id: 'desktop', label: 'Desktop control', state: 'ready', detail: 'An interactive Windows session is available. Keep the runner signed in for existing-desktop control.' };
  return { id: 'desktop', label: 'Desktop control', state: 'unavailable', detail: 'Desktop control is not supported on this operating system.' };
}

type Facts = { installed: boolean; daemon: boolean; contract: ImageContract; native: boolean; sharing: SharingProbe | null };
const defaultStateRoot = () => process.env.OPEN_HARNESS_STATE_DIR || '.open-harness';

// Synchronous for the CLI. The coordinator uses the asynchronous probes below.
export function onboardingStatus(credentialNames: string[] = [], stateRoot = defaultStateRoot()): OnboardingStatus {
  if (process.env.OPEN_HARNESS_MOCK === '1') return mockStatus(credentialNames);
  const installed = command('docker', ['--version']).status === 0;
  const daemon = installed && command('docker', ['version', '--format', '{{.Server.Version}}']).status === 0;
  const contract = daemon ? imageContract() : 'missing';
  return statusFrom({ installed, daemon, contract, native: pythonReady(), sharing: contract === 'current' ? stateSharing(stateRoot) : null }, credentialNames);
}

// Each probe has its own deadline and independent ones run together, so the worst case is
// a few seconds rather than the sum of every timeout. Concurrent callers share one probe.
const readinessChecks = new Map<string, { last?: Facts; pending?: Promise<Facts> }>();
async function probeFacts(stateRoot: string): Promise<Facts> {
  const installed = (await commandAsync('docker', ['--version'])).status === 0;
  const [server, native] = await Promise.all([
    installed ? commandAsync('docker', ['version', '--format', '{{.Server.Version}}']) : Promise.resolve(null),
    Promise.all(pythons().map(executable => commandAsync(executable, PYTHON_PROBE, 8_000))).then(results => results.some(result => result.status === 0)),
  ]);
  const daemon = server?.status === 0;
  const contract = daemon ? classifyContract(await commandAsync('docker', ['image', 'inspect', '-f', `{{index .Config.Labels "${RUNTIME_LABEL}"}}`, HERMES_IMAGE])) : 'missing';
  return { installed, daemon, contract, native, sharing: contract === 'current' ? await stateSharingAsync(stateRoot) : null };
}

const coordinatorCheck: ReadinessCheck = { id: 'coordinator', label: 'Open Harness', state: 'ready', detail: 'The coordinator is running and your data folder is writable.' };

export async function onboardingStatusAsync(credentialNames: string[] = [], stateRoot = defaultStateRoot(), jobs = setupJobs): Promise<OnboardingStatus> {
  const setupJob = jobs.current();
  if (process.env.OPEN_HARNESS_MOCK === '1') return { ...mockStatus(credentialNames), setupJob };
  const root = resolve(stateRoot);
  const check = readinessChecks.get(root) ?? {};
  if (setupJob?.state === 'running') {
    // A cold POST or reload must acknowledge the job even when Docker is unresponsive.
    if (check.last) return { ...statusFrom(check.last, credentialNames), setupJob };
    return { platform, platformLabel: labels[platform], executionReady: false, recommendedAccess: 'private',
      credentialMode: 'coordinator', credentialNames, checks: [coordinatorCheck, desktopCheck()], setupJob };
  }
  readinessChecks.set(root, check);
  let facts = await (check.pending ??= probeFacts(root).then(value => check.last = value).finally(() => { delete check.pending; }));
  // A rebuild completed while this older check was in flight. Use the fresh verification.
  const latest = readinessChecks.get(root);
  if (latest !== check) {
    if (!latest?.last || latest.pending) return onboardingStatusAsync(credentialNames, root, jobs);
    facts = latest.last;
  }
  return { ...statusFrom(facts, credentialNames), setupJob: jobs.current() };
}

function mockStatus(credentialNames: string[]): OnboardingStatus {
  return {
    platform,
    platformLabel: labels[platform],
    executionReady: true,
    recommendedAccess: 'private',
    credentialMode: 'coordinator', credentialNames,
    checks: [
      { id: 'coordinator', label: 'Open Harness', state: 'ready', detail: 'The coordinator is running.' },
      { id: 'container-engine', label: 'Private workspaces', state: 'ready', detail: 'The container engine is running.' },
      { id: 'agent-runtime', label: 'Agent runtime', state: 'ready', detail: 'The pinned Hermes runtime is ready.' },
      desktopCheck(),
    ],
  };
}

function statusFrom({ installed, daemon, contract, native, sharing }: Facts, credentialNames: string[]): OnboardingStatus {
  const image = contract === 'current';
  const container: ReadinessCheck = !installed
    ? { id: 'container-engine', label: 'Private workspaces', state: 'missing', detail: `Install Docker on ${labels[platform]} to give agents isolated workspaces.`, helpUrl: installUrls[platform] }
    : !daemon
      ? { id: 'container-engine', label: 'Private workspaces', state: 'action', detail: 'Docker is installed but is not running.', action: 'start-container-engine', actionLabel: 'Start Docker' }
      : { id: 'container-engine', label: 'Private workspaces', state: 'ready', detail: 'Docker is running.' };
  const runtime: ReadinessCheck = image
    ? { id: 'agent-runtime', label: 'Agent runtime', state: 'ready', detail: 'The pinned Hermes runtime is ready for isolated agents.' }
    : contract === 'stale'
      ? { id: 'agent-runtime', label: 'Agent runtime', state: 'action', detail: 'The agent runtime on this computer was built before a fix and must be rebuilt. Layers already downloaded are reused.', action: 'prepare-runtime', actionLabel: 'Update agent runtime' }
    : daemon
      ? { id: 'agent-runtime', label: 'Agent runtime', state: 'action', detail: 'One final download and setup is needed. This can take several minutes the first time.', action: 'prepare-runtime', actionLabel: 'Set up agent runtime' }
      : native
        ? { id: 'agent-runtime', label: 'Agent runtime', state: 'ready', detail: 'A local Hermes installation is ready for direct computer access.' }
        : { id: 'agent-runtime', label: 'Agent runtime', state: 'missing', detail: 'Start or install Docker to set up the agent runtime.', helpUrl: installUrls[platform] };

  const sharingCheck: ReadinessCheck | null = sharing && {
    id: 'workspace-sharing', label: 'Agent data sharing',
    state: sharing.ok ? 'ready' : 'action', detail: sharing.detail,
  };

  return {
    platform,
    platformLabel: labels[platform],
    // A container runtime that cannot read the profile directory cannot run an agent,
    // so it must not count as ready just because the image is present.
    executionReady: (image && sharing?.ok === true) || native,
    recommendedAccess: image && sharing?.ok === true ? 'private' : 'direct',
    credentialMode: 'coordinator', credentialNames,
    checks: [coordinatorCheck, container, runtime, ...(sharingCheck ? [sharingCheck] : []), desktopCheck()],
  };
}

async function startDocker() {
  if (platform === 'darwin') return commandAsync('open', ['-gja', 'Docker'], 15_000);
  if (platform === 'win32') return commandAsync('powershell.exe', ['-NoProfile', '-Command', 'Start-Process "$Env:ProgramFiles\\Docker\\Docker\\Docker Desktop.exe"'], 15_000);
  const context = (await commandAsync('docker', ['context', 'show'])).stdout.trim();
  if (context.startsWith('desktop')) return commandAsync('systemctl', ['--user', 'start', 'docker-desktop.service'], 15_000);
  return commandAsync('systemctl', ['start', '--no-block', 'docker.service'], 15_000);
}

const dockerUp = async () => (await commandAsync('docker', ['version', '--format', '{{.Server.Version}}'], 5_000)).status === 0;

async function waitForDocker(timeout = 120_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await dockerUp()) return;
    await new Promise(resolve => setTimeout(resolve, 1_000));
  }
  throw new Error('Docker did not become ready. Open Docker Desktop, wait for it to finish starting, then try again.');
}

function runStreaming(name: string, args: string[], cwd?: string, timeoutMs = 45 * 60_000) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(name, args, { cwd, env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    let error = '';
    // Both pipes must be drained. Whatever the builder decides to write progress to, an
    // unread pipe fills at about 64 KB and blocks the child forever.
    child.stdout.resume();
    child.stderr.on('data', chunk => { error = (error + String(chunk)).slice(-8_000); });
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`${name} did not finish within ${Math.round(timeoutMs / 60_000)} minutes. Check that Docker has disk space and network access, then try again.`)); }, timeoutMs);
    timer.unref();
    child.once('error', failure => { clearTimeout(timer); reject(failure); });
    child.once('exit', code => { clearTimeout(timer); if (code === 0) resolve(); else reject(new Error(error.trim() || `${name} exited with code ${code ?? 'unknown'}.`)); });
  });
}

export type SetupTasks = Record<SetupAction, () => Promise<void>>;

const realTasks: SetupTasks = {
  async 'start-container-engine'() {
    if ((await commandAsync('docker', ['--version'])).status !== 0) throw new Error(`Docker is not installed. Use the installation guide for ${labels[platform]}, then try again.`);
    if (await dockerUp()) return;
    const started = await startDocker();
    if (started.status !== 0) throw new Error((started.stderr || started.stdout || '').trim() || 'Open Harness could not start Docker. Start it from your applications, then try again.');
    await waitForDocker();
  },
  async 'prepare-runtime'() {
    await waitForDocker(10_000);
    const runtimeRoot = import.meta.dirname;
    const projectRoot = join(runtimeRoot, '..');
    const dockerfile = join(runtimeRoot, 'hermes', 'Dockerfile');
    if (!existsSync(dockerfile)) throw new Error('The bundled agent runtime files are missing. Reinstall Open Harness.');
    await runStreaming('docker', ['build', '-f', dockerfile, '-t', HERMES_IMAGE, projectRoot], projectRoot);
  },
};
// The deterministic runtime has nothing to start or build; the short delay keeps the
// running state observable to the dashboard and the tests.
const mockTasks: SetupTasks = {
  'start-container-engine': () => new Promise(resolve => setTimeout(resolve, 150)),
  'prepare-runtime': () => new Promise(resolve => setTimeout(resolve, 150)),
};

const RUNNING: Record<SetupAction, string> = {
  'start-container-engine': 'Starting Docker. This can take a minute.',
  'prepare-runtime': 'Setting up the agent runtime. The first time can take several minutes.',
};
const SUCCEEDED: Record<SetupAction, string> = {
  'start-container-engine': 'Docker is running.',
  'prepare-runtime': 'The agent runtime is ready.',
};

export const isSetupAction = (value: unknown): value is SetupAction => SETUP_ACTIONS.includes(value as SetupAction);

/**
 * At most one setup job runs per coordinator. The job is detached from the request that
 * started it, so closing the dashboard never cancels a build, and the finished job stays
 * readable until the next one starts. Asking again for the running action joins it;
 * asking for a different one while a job runs is refused rather than queued, because the
 * second step usually depends on the first.
 */
export function createSetupJobs(tasks: SetupTasks) {
  let job: SetupJob | null = null;
  let settled: Promise<void> = Promise.resolve();
  return {
    current: (): SetupJob | undefined => job ? { ...job } : undefined,
    start(action: unknown): { job: SetupJob; accepted: boolean } {
      if (!isSetupAction(action)) throw new Error('Unknown setup action.');
      if (job?.state === 'running') return { job: { ...job }, accepted: job.action === action };
      const current: SetupJob = { action, state: 'running', message: RUNNING[action] };
      job = current;
      settled = Promise.resolve().then(tasks[action]).then(
        () => { current.state = 'succeeded'; current.message = SUCCEEDED[action]; },
        (error: unknown) => { current.state = 'failed'; current.message = (error instanceof Error && error.message.trim()) || 'Setup did not finish. Try again.'; },
      ).finally(() => { readinessChecks.clear(); resetSharingChecks(); });
      return { job: { ...current }, accepted: true };
    },
    /** Resolves once the current job has finished; for tests and shutdown. */
    settled: () => settled,
  };
}
export type SetupJobs = ReturnType<typeof createSetupJobs>;

export const setupJobs = createSetupJobs(process.env.OPEN_HARNESS_MOCK === '1' ? mockTasks : realTasks);
