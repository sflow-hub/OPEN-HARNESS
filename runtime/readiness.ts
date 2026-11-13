import { spawn, spawnSync } from 'node:child_process';
import './docker-path.mjs';
import { commandAsync } from './commands';
import { HERMES_IMAGE_TAG } from '../lib/hermes-pin';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { OnboardingStatus, ReadinessCheck } from '../lib/onboarding';
import { stateSharing, stateSharingAsync, imageContractAsync } from './hermes';

const releaseImageFile=join(import.meta.dirname,'release-image.json');
const releaseImage=existsSync(releaseImageFile)?JSON.parse(readFileSync(releaseImageFile,'utf8')) as {ref:string;contract:number}:null;
if(releaseImage&&(!/^ghcr\.io\/[a-z0-9-]+\/open-harness-hermes@sha256:[a-f0-9]{64}$/.test(releaseImage.ref)||releaseImage.contract!==11))throw new Error('The installed runtime image manifest is invalid. Reinstall this signed Open Harness release.');
export const HERMES_IMAGE = releaseImage?.ref || process.env.OPEN_HARNESS_HERMES_IMAGE || `open-harness-hermes:${HERMES_IMAGE_TAG}`;
const pullRuntime=Boolean(releaseImage)||process.env.OPEN_HARNESS_HERMES_PULL==='1';

// Every layer of the managed-run handshake -- the policy extension, managed_entry.py,
// inspect_runtime.py, the config shape -- ships inside the image, so an image built before
// a fix keeps the bug while its tag never changes. The image carries this number as a
// label. Anything else means "rebuild", including no label at all: contract 1 is the set
// of images built before the label existed. Bump it whenever runtime/hermes/ changes.
export const RUNTIME_CONTRACT = 11;
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

function command(name: string, args: string[], timeout = 7_000) {
  return spawnSync(name, args, { encoding: 'utf8', timeout });
}

function desktopCheck(ready = true): ReadinessCheck {
  return platform === 'linux'
    ? { id: 'desktop', label: 'Desktop control', state: ready ? 'ready' : 'action', detail: ready ? 'A private agent desktop is available. It has its own apps and login sessions.' : 'Set up Docker and the pinned agent runtime to enable a private agent desktop.' }
    : { id: 'desktop', label: 'Desktop control', state: 'unavailable', detail: 'Use a Linux runner with Docker for a private agent desktop. Control of your existing signed-in desktop is disabled because it cannot be isolated.' };
}

export function onboardingStatus(credentialNames: string[] = [], stateRoot = process.env.OPEN_HARNESS_STATE_DIR || '.open-harness'): OnboardingStatus {
  if (process.env.OPEN_HARNESS_MOCK === '1') return {
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

  const installed = command('docker', ['--version']).status === 0;
  const daemon = installed && command('docker', ['version', '--format', '{{.Server.Version}}']).status === 0;
  const contract: ImageContract = daemon ? imageContract() : 'missing';
  const image = contract === 'current';
  const container: ReadinessCheck = !installed
    ? { id: 'container-engine', label: 'Private workspaces', state: 'missing', detail: `Install Docker on ${labels[platform]} to give agents isolated workspaces.`, helpUrl: installUrls[platform] }
    : !daemon
      ? { id: 'container-engine', label: 'Private workspaces', state: 'action', detail: 'Docker is installed but is not running.', action: 'start-container-engine', actionLabel: 'Start Docker' }
      : { id: 'container-engine', label: 'Private workspaces', state: 'ready', detail: 'Docker is running.' };
  const runtime: ReadinessCheck = image
    ? { id: 'agent-runtime', label: 'Agent runtime', state: 'ready', detail: 'The pinned Hermes runtime is ready for isolated agents.' }
    : contract === 'stale'
      ? { id: 'agent-runtime', label: 'Agent runtime', state: 'action', detail: pullRuntime ? 'Download the agent runtime supplied with this Open Harness release.' : 'The agent runtime on this computer was built before a fix and must be rebuilt. Layers already downloaded are reused.', action: 'prepare-runtime', actionLabel: 'Update agent runtime' }
    : daemon
      ? { id: 'agent-runtime', label: 'Agent runtime', state: 'action', detail: 'One final download and setup is needed. This can take several minutes the first time.', action: 'prepare-runtime', actionLabel: 'Set up agent runtime' }
      : { id: 'agent-runtime', label: 'Agent runtime', state: 'missing', detail: 'Start or install Docker to set up the agent runtime.', helpUrl: installUrls[platform] };

  // Only meaningful once the image exists: the probe runs a throwaway container from it.
  const sharing = image ? stateSharing(stateRoot) : null;
  const sharingCheck: ReadinessCheck | null = sharing && {
    id: 'workspace-sharing', label: 'Agent data sharing',
    state: sharing.ok ? 'ready' : 'action', detail: sharing.detail,
  };

  return {
    platform,
    platformLabel: labels[platform],
    // A container runtime that cannot read the profile directory cannot run an agent,
    // so it must not count as ready just because the image is present.
    executionReady: image && (!sharing || sharing.ok),
    recommendedAccess: 'private',
    credentialMode: 'coordinator', credentialNames,
    checks: [{ id: 'coordinator', label: 'Open Harness', state: 'ready', detail: 'The coordinator is running and your data folder is writable.' }, container, runtime, ...(sharingCheck ? [sharingCheck] : []), desktopCheck(image && (!sharing || sharing.ok))],
  };
}

async function startDockerAsync() {
  if (platform === 'darwin') return commandAsync('open', ['-gja', '/Applications/Docker.app'], 15_000);
  if (platform === 'win32') return commandAsync('powershell.exe', ['-NoProfile', '-Command', 'Start-Process "$Env:ProgramFiles\\Docker\\Docker\\Docker Desktop.exe"'], 15_000);
  const context = (await commandAsync('docker', ['context', 'show'], 5000)).stdout.trim();
  if (context.startsWith('desktop')) return commandAsync('systemctl', ['--user', 'start', 'docker-desktop.service'], 15_000);
  return commandAsync('systemctl', ['start', '--no-block', 'docker.service'], 15_000);
}

async function waitForDocker(timeout = 120_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if ((await commandAsync('docker', ['version', '--format', '{{.Server.Version}}'], 5_000)).status === 0) return;
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

export async function onboardingAction(action: unknown, credentialNames: string[] = []) {
  if (action === 'start-container-engine') {
    if ((await commandAsync('docker', ['--version'], 5000)).status !== 0) throw new Error(`Docker is not installed. Use the installation guide for ${labels[platform]}, then try again.`);
    if ((await commandAsync('docker', ['version', '--format', '{{.Server.Version}}'], 5000)).status !== 0) {
      const started = await startDockerAsync();
      if (started.status !== 0) throw new Error((started.stderr || started.stdout || '').trim() || 'Open Harness could not start Docker. Start it from your applications, then try again.');
      await waitForDocker();
    }
    return onboardingStatusAsync(credentialNames, undefined, true);
  }
  if (action === 'prepare-runtime') {
    await prepareRuntime();
    return onboardingStatusAsync(credentialNames, undefined, true);
  }
  throw new Error('Unknown setup action.');
}

export async function prepareRuntime() {
  if (pullRuntime && !/^\S+@sha256:[a-f0-9]{64}$/.test(HERMES_IMAGE)) throw new Error('This release is missing its pinned agent image. Download a complete Open Harness release; its image-lock.json and Compose file must stay together.');
  await waitForDocker(10_000);
  if (pullRuntime) {
    await runStreaming('docker', ['pull', HERMES_IMAGE]);
  } else {
    const projectRoot = join(import.meta.dirname, '..'), dockerfile = join(import.meta.dirname, 'hermes', 'Dockerfile');
    if (!existsSync(dockerfile)) throw new Error('The bundled agent runtime files are missing. Reinstall Open Harness.');
    await runStreaming('docker', ['build', '-f', dockerfile, '-t', HERMES_IMAGE, projectRoot], projectRoot);
  }
  if (await imageContractAsync() !== 'current') throw new Error('The downloaded or built agent runtime does not match this Open Harness release. Setup stopped without starting an agent. Check the release files and try again.');
}

async function probeOnboardingStatus(credentialNames: string[] = [], stateRoot = process.env.OPEN_HARNESS_STATE_DIR || '.open-harness'): Promise<OnboardingStatus> {
  if (process.env.OPEN_HARNESS_MOCK === '1') return {
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

  const installed = (await commandAsync('docker', ['--version'], 5000)).status === 0;
  const daemon = installed && (await commandAsync('docker', ['version', '--format', '{{.Server.Version}}'], 5000)).status === 0;
  const contract: ImageContract = daemon ? await imageContractAsync() : 'missing';
  const image = contract === 'current';
  const container: ReadinessCheck = !installed
    ? { id: 'container-engine', label: 'Private workspaces', state: 'missing', detail: `Install Docker on ${labels[platform]} to give agents isolated workspaces.`, helpUrl: installUrls[platform] }
    : !daemon
      ? { id: 'container-engine', label: 'Private workspaces', state: 'action', detail: 'Docker is installed but is not running.', action: 'start-container-engine', actionLabel: 'Start Docker' }
      : { id: 'container-engine', label: 'Private workspaces', state: 'ready', detail: 'Docker is running.' };
  const runtime: ReadinessCheck = image
    ? { id: 'agent-runtime', label: 'Agent runtime', state: 'ready', detail: 'The pinned Hermes runtime is ready for isolated agents.' }
    : contract === 'stale'
      ? { id: 'agent-runtime', label: 'Agent runtime', state: 'action', detail: pullRuntime ? 'Download the agent runtime supplied with this Open Harness release.' : 'The agent runtime on this computer was built before a fix and must be rebuilt. Layers already downloaded are reused.', action: 'prepare-runtime', actionLabel: 'Update agent runtime' }
    : daemon
      ? { id: 'agent-runtime', label: 'Agent runtime', state: 'action', detail: 'One final download and setup is needed. This can take several minutes the first time.', action: 'prepare-runtime', actionLabel: 'Set up agent runtime' }
      : { id: 'agent-runtime', label: 'Agent runtime', state: 'missing', detail: 'Start or install Docker to set up the agent runtime.', helpUrl: installUrls[platform] };

  // Only meaningful once the image exists: the probe runs a throwaway container from it.
  const sharing = image ? await stateSharingAsync(stateRoot) : null;
  const sharingCheck: ReadinessCheck | null = sharing && {
    id: 'workspace-sharing', label: 'Agent data sharing',
    state: sharing.ok ? 'ready' : 'action', detail: sharing.detail,
  };

  return {
    platform,
    platformLabel: labels[platform],
    // A container runtime that cannot read the profile directory cannot run an agent,
    // so it must not count as ready just because the image is present.
    executionReady: image && (!sharing || sharing.ok),
    recommendedAccess: 'private',
    credentialMode: 'coordinator', credentialNames,
    checks: [{ id: 'coordinator', label: 'Open Harness', state: 'ready', detail: 'The coordinator is running and your data folder is writable.' }, container, runtime, ...(sharingCheck ? [sharingCheck] : []), desktopCheck(image && (!sharing || sharing.ok))],
  };
}


const readinessCache = new Map<string, { at: number; value: OnboardingStatus; pending?: Promise<void> }>();
export async function onboardingStatusAsync(credentialNames: string[] = [], stateRoot = process.env.OPEN_HARNESS_STATE_DIR || '.open-harness', fresh = false): Promise<OnboardingStatus> {
  if (process.env.OPEN_HARNESS_MOCK === '1') return probeOnboardingStatus(credentialNames, stateRoot);
  let item = readinessCache.get(stateRoot);
  if (!item) {
    item = { at: 0, value: { platform, platformLabel: labels[platform], executionReady: false, recommendedAccess: 'private', credentialMode: 'coordinator', credentialNames, checks: [{ id: 'coordinator', label: 'Open Harness', state: 'ready', detail: 'The coordinator is running.' }, { id: 'agent-runtime', label: 'Agent runtime', state: 'action', detail: 'Checking this computer. Other work stays available while Docker responds.' }] } };
    readinessCache.set(stateRoot, item);
  }
  if (!item.pending && (fresh || Date.now() - item.at > 5000)) {
    const current = item;
    current.pending = probeOnboardingStatus(credentialNames, stateRoot).then(value => { current.value = value; current.at = Date.now(); }).finally(() => { current.pending = undefined; });
  }
  if (item.pending) {
    if (fresh) await item.pending;
    else await Promise.race([item.pending, new Promise<void>(resolve => { const timer = setTimeout(resolve, 250); timer.unref(); })]);
  }
  return { ...item.value, credentialNames };
}
