import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { ComputerConfig } from '../lib/agent-profile';

const NATIVE_FOLDER_GUIDANCE = 'Selected host folders require Open Harness and Docker to use the same Linux kernel. Use the local browser Compose installation with explicitly exported folders, or a native Linux runner.';
const BOOT_ID = '/proc/sys/kernel/random/boot_id';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const CONTAINER_ID = /^[a-f0-9]{64}$/;
const ATTEMPT_LABEL = 'open-harness.folder-attempt';
type Folder = ComputerConfig['folders'][number];
export type FolderIdentity = { path: string; device: string; inode: string; readOnly: boolean };
export type PinnedFolders = { bootId: string; mounts: FolderIdentity[]; close: () => void };
type DockerResult = { status: number | null; stdout: string; stderr: string; error?: Error };
type DockerCommand = (args: string[], timeout: number) => DockerResult;
const docker: DockerCommand = (args, timeout) => spawnSync('docker', args, { encoding: 'utf8', timeout, maxBuffer: 1024 * 1024 });

export function requiresFolderVerification(computer: ComputerConfig) {
  return process.env.OPEN_HARNESS_DEPLOYMENT !== 'compose' && computer.access === 'folders' && computer.folders.length > 0;
}

// O_NOFOLLOW protects only the final component. Each ancestor must first become
// an open directory so a later pathname replacement cannot redirect traversal.
function pinDirectory(path: string) {
  const flags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
  let fd = openSync('/', flags);
  try {
    for (const component of resolve(path).split('/').filter(Boolean)) {
      const next = openSync(`/proc/self/fd/${fd}/${component}`, flags);
      closeSync(fd); fd = next;
    }
    const info = fstatSync(fd, { bigint: true });
    if (!info.isDirectory()) throw new Error('not a directory');
    return { fd, device: String(info.dev), inode: String(info.ino) };
  } catch (error) {
    closeSync(fd);
    throw new Error(`Could not safely open selected folder ${path}. Select an existing directory without symbolic links. ${error instanceof Error ? error.message : ''}`);
  }
}

export function pinSelectedFolders(folders: Folder[]): PinnedFolders {
  if (process.platform !== 'linux') throw new Error(NATIVE_FOLDER_GUIDANCE);
  let bootId: string;
  try { bootId = readFileSync(BOOT_ID, 'utf8').trim(); }
  catch { throw new Error(NATIVE_FOLDER_GUIDANCE); }
  if (!UUID.test(bootId)) throw new Error(NATIVE_FOLDER_GUIDANCE);
  const fds: number[] = [], mounts: FolderIdentity[] = [];
  const close = () => { for (const fd of fds.splice(0)) closeSync(fd); };
  try {
    folders.forEach((folder, index) => {
      const pinned = pinDirectory(folder.path); fds.push(pinned.fd);
      mounts.push({ path: `/workspace/mounts/folder-${index + 1}`, device: pinned.device, inode: pinned.inode, readOnly: folder.mode === 'read' });
    });
    return { bootId, mounts, close };
  } catch (error) { close(); throw error; }
}

// This executes only in a newly created inert container. Isolated Python avoids
// the writable profile, HOME, cwd and installed site startup hooks.
export const FOLDER_VERIFIER = `import json, os, stat, sys
with open('/proc/sys/kernel/random/boot_id', encoding='ascii') as file:
    boot_id = file.read().strip()
with open('/proc/self/mountinfo', 'rb') as file:
    mountinfo = [line.split(b' ') for line in file]
mounts = []
for path in json.loads(sys.argv[1]):
    info = os.stat(path, follow_symlinks=False)
    if not stat.S_ISDIR(info.st_mode):
        raise ValueError('Selected mount is not a directory')
    options = [fields[5].split(b',') for fields in mountinfo if len(fields) > 5 and fields[4] == os.fsencode(path)]
    if len(options) != 1 or (b'ro' in options[0]) == (b'rw' in options[0]):
        raise ValueError('Selected mount has no unambiguous access mode')
    # QEMU user mode can report host filesystem flags for a read-only bind; mountinfo records per-mount flags.
    mounts.append({'path': path, 'device': str(info.st_dev), 'inode': str(info.st_ino), 'readOnly': b'ro' in options[0]})
print(json.dumps({'bootId': boot_id, 'mounts': mounts}))
`;

export function verifyFolderMounts(pinned: Pick<PinnedFolders, 'bootId' | 'mounts'>, output: string) {
  let value: { bootId?: unknown; mounts?: unknown };
  try { value = JSON.parse(output); } catch { throw new Error('Docker returned invalid selected-folder verification. No agent was started.'); }
  if (!value || value.bootId !== pinned.bootId) throw new Error(NATIVE_FOLDER_GUIDANCE);
  const mounts = value.mounts;
  if (!Array.isArray(mounts) || mounts.length !== pinned.mounts.length) throw new Error('Docker did not verify every selected folder. No agent was started.');
  for (const [index, expected] of pinned.mounts.entries()) {
    const actual = mounts[index];
    if (!actual || actual.path !== expected.path || actual.device !== expected.device || actual.inode !== expected.inode || actual.readOnly !== expected.readOnly) {
      throw new Error(`Docker could not confirm the selected folder and its access mode at ${expected.path}. Re-select the folder and retry. No agent was started.`);
    }
  }
}

function checked(command: DockerCommand, args: string[], timeout: number, description: string) {
  const result = command(args, timeout);
  if (result.status !== 0) throw new Error(`${description}: ${result.error?.message || result.stderr.trim() || 'Docker did not complete the request.'}`);
  return result.stdout.trim();
}

export function createVerifiedFolderContainer(args: string[], pinned: PinnedFolders, desktop: boolean, command: DockerCommand = docker) {
  const attempt = randomUUID(), name = args[args.indexOf('--name') + 1];
  let id = '';
  try {
    // Create first so every subsequent action and cleanup uses the immutable ID.
    id = checked(command, ['create', '--restart', 'no', '--entrypoint', '/usr/bin/tini', '--label', `${ATTEMPT_LABEL}=${attempt}`, ...args, '--', '/bin/sleep', 'infinity'], 30_000, 'Could not create the selected-folder container');
    if (!CONTAINER_ID.test(id)) { id = ''; throw new Error('Docker did not return a valid selected-folder container ID.'); }
    checked(command, ['start', id], 20_000, 'Could not start the selected-folder container');
    const result = checked(command, ['exec', '--workdir', '/', id, '/usr/local/bin/python', '-I', '-S', '-c', FOLDER_VERIFIER, JSON.stringify(pinned.mounts.map(mount => mount.path))], 15_000, 'Could not verify selected folders');
    verifyFolderMounts(pinned, result);
    if (desktop) checked(command, ['exec', '--workdir', '/', id, '/opt/open-harness/container-init.sh', '--init-only'], 45_000, 'Could not initialize the private desktop');
    return id;
  } catch (error) {
    let cleanupError = '';
    try {
      // A timed-out create may have completed without returning its ID. Never
      // remove by name: inspect the unique attempt label before recovering it.
      if (!id && name) {
        const inspected = command(['inspect', '-f', '{{json .}}', name], 10_000);
        if (inspected.status === 0) {
          const candidate = JSON.parse(inspected.stdout);
          if (candidate?.Config?.Labels?.[ATTEMPT_LABEL] === attempt && CONTAINER_ID.test(candidate.Id)) id = candidate.Id;
        } else if (!/No such (?:object|container)/i.test(inspected.stderr)) throw new Error(inspected.error?.message || inspected.stderr.trim() || 'Docker could not check the incomplete creation.');
      }
      if (id) checked(command, ['rm', '-f', id], 20_000, 'Could not remove the unverified selected-folder container');
    } catch (failure) { cleanupError = ` Cleanup could not be confirmed: ${failure instanceof Error ? failure.message : failure}`; }
    throw new Error(`${error instanceof Error ? error.message : error}${cleanupError}`);
  } finally { pinned.close(); }
}
