import test from 'node:test';
import assert from 'node:assert/strict';
import { fstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { draftProfile } from '../lib/agent-profile';
import { createVerifiedFolderContainer, pinSelectedFolders, requiresFolderVerification, verifyFolderMounts, type PinnedFolders } from '../runtime/folder-mounts';
import { containerSignature, containerStateKey, ensureContainer } from '../runtime/hermes';
import { RUNTIME_CONTRACT } from '../runtime/readiness';

const bootId = 'b9e3931c-e849-4e14-847b-e8e4152f8ac4';
const id = 'a'.repeat(64), otherId = 'b'.repeat(64);
const mounts = [{ path: '/workspace/mounts/folder-1', device: '9007199254740993', inode: '18446744073709551001', readOnly: true }];
const computer = draftProfile({ id: 'atlas', name: 'Atlas', role: 'Assistant', description: '', tone: 0, instructions: '', memory: [] }).computer;
const ok = (stdout = '') => ({ status: 0, stdout, stderr: '' });
const failed = (stderr = 'verification failed') => ({ status: 1, stdout: '', stderr });

test('native folder verification is limited to selected host grants outside Compose', t => {
  const original = process.env.OPEN_HARNESS_DEPLOYMENT;
  t.after(() => { if (original === undefined) delete process.env.OPEN_HARNESS_DEPLOYMENT; else process.env.OPEN_HARNESS_DEPLOYMENT = original; });
  delete process.env.OPEN_HARNESS_DEPLOYMENT;
  const selected = { ...computer, access: 'folders' as const, folders: [{ id: 'project', path: '/project', mode: 'read' as const }] };
  assert.equal(requiresFolderVerification(computer), false);
  assert.equal(requiresFolderVerification({ ...selected, folders: [] }), false);
  assert.equal(requiresFolderVerification(selected), true);
  process.env.OPEN_HARNESS_DEPLOYMENT = 'compose';
  assert.equal(requiresFolderVerification(selected), false);
});

test('mount identity preserves large integers and rejects cross-kernel, changed, missing or malformed results', () => {
  const pinned = { bootId, mounts };
  assert.doesNotThrow(() => verifyFolderMounts(pinned, JSON.stringify(pinned)));
  assert.throws(() => verifyFolderMounts(pinned, '{'), /invalid selected-folder verification/);
  assert.throws(() => verifyFolderMounts(pinned, JSON.stringify({ ...pinned, bootId: 'different' })), /same Linux kernel/);
  assert.throws(() => verifyFolderMounts(pinned, JSON.stringify({ bootId, mounts: [] })), /every selected folder/);
  for (const patch of [{ device: '9007199254740992' }, { inode: Number(mounts[0].inode) }, { readOnly: false }, { path: '/wrong' }]) {
    assert.throws(() => verifyFolderMounts(pinned, JSON.stringify({ bootId, mounts: [{ ...mounts[0], ...patch }] })), /folder and its access mode/);
  }
});

test('fresh native folder containers use immutable inert startup and initialize only after successful verification', () => {
  const calls: string[][] = [], timeouts: number[] = []; let closed = 0;
  const pinned: PinnedFolders = { bootId, mounts, close: () => { closed++; } };
  const result = createVerifiedFolderContainer(['--name', 'unit-agent', 'unit-image'], pinned, true, (args, timeout) => {
    calls.push(args); timeouts.push(timeout);
    if (args[0] === 'create') return ok(id);
    if (args.includes('/usr/local/bin/python')) return ok(JSON.stringify({ bootId, mounts }));
    return ok();
  });
  assert.equal(result, id); assert.equal(closed, 1);
  assert.deepEqual(calls.map(args => args[0]), ['create', 'start', 'exec', 'exec']);
  assert.equal(calls[0][calls[0].indexOf('--restart') + 1], 'no');
  assert.equal(calls[0][calls[0].indexOf('--entrypoint') + 1], '/usr/bin/tini');
  assert.deepEqual(calls[0].slice(-4), ['unit-image', '--', '/bin/sleep', 'infinity']);
  assert.equal(calls[0].some(arg => arg.includes('container-init')), false);
  assert.deepEqual(calls[1], ['start', id]);
  assert.deepEqual(calls[2].slice(0, 8), ['exec', '--workdir', '/', id, '/usr/local/bin/python', '-I', '-S', '-c']);
  assert.deepEqual(calls[3], ['exec', '--workdir', '/', id, '/opt/open-harness/container-init.sh', '--init-only']);
  assert.equal(timeouts[3], 45_000);
});

test('verifier and start failures remove only the immutable container and never initialize its desktop', () => {
  for (const failure of ['start', 'exec', 'identity', 'kernel', 'malformed']) {
    const calls: string[][] = []; let closed = 0;
    assert.throws(() => createVerifiedFolderContainer(['--name', 'unit-agent', 'unit-image'], { bootId, mounts, close: () => { closed++; } }, true, args => {
      calls.push(args);
      if (args[0] === 'create') return ok(id);
      if (args[0] === failure) return failed();
      if (args.includes('/usr/local/bin/python')) return ok(failure === 'malformed' ? '{}' : JSON.stringify({ bootId: failure === 'kernel' ? 'other' : bootId, mounts: failure === 'identity' ? [{ ...mounts[0], inode: '0' }] : mounts }));
      return ok();
    }), /verify|start|same Linux kernel|folder and its access mode/);
    assert.equal(closed, 1); assert.deepEqual(calls.at(-1), ['rm', '-f', id]);
    assert.equal(calls.some(args => args.includes('/opt/open-harness/container-init.sh')), false);
  }
});

test('failed creation recovers ownership by its unique label and cleanup errors remain visible', () => {
  for (const owned of [true, false]) {
    const calls: string[][] = []; let attempt = '';
    assert.throws(() => createVerifiedFolderContainer(['--name', 'unit-agent', 'unit-image'], { bootId, mounts, close: () => {} }, false, args => {
      calls.push(args);
      if (args[0] === 'create') { attempt = args[args.indexOf('--label') + 1].split('=')[1]; return failed('create timed out'); }
      if (args[0] === 'inspect') return ok(JSON.stringify({ Id: otherId, Config: { Labels: { 'open-harness.folder-attempt': owned ? attempt : 'foreign' } } }));
      if (args[0] === 'rm') return failed('daemon unavailable for cleanup');
      return ok();
    }), owned ? /create timed out.*Cleanup could not be confirmed.*daemon unavailable for cleanup/ : /create timed out/);
    assert.deepEqual(calls.filter(args => args[0] === 'rm'), owned ? [['rm', '-f', otherId]] : []);
  }
});

test('private desktop initialization failure removes the verified container before returning failure', () => {
  const calls: string[][] = [];
  assert.throws(() => createVerifiedFolderContainer(['--name', 'unit-agent', 'unit-image'], { bootId, mounts, close: () => {} }, true, args => {
    calls.push(args);
    if (args[0] === 'create') return ok(id);
    if (args.includes('/usr/local/bin/python')) return ok(JSON.stringify({ bootId, mounts }));
    if (args.includes('/opt/open-harness/container-init.sh')) return failed('desktop unavailable');
    return ok();
  }), /desktop unavailable/);
  assert.deepEqual(calls.at(-1), ['rm', '-f', id]);
});

test('directory pins retain filesystem identity across an ordinary rename and close cleanly', { skip: process.platform !== 'linux' }, t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'harness-folder-pin-'))), selected = join(root, 'project'), renamed = join(root, 'renamed');
  t.after(() => rmSync(root, { recursive: true, force: true })); mkdirSync(selected);
  const original = statSync(selected, { bigint: true });
  const pinned = pinSelectedFolders([{ id: 'project', path: selected, mode: 'write' }]);
  t.after(pinned.close);
  assert.equal(pinned.bootId, readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim());
  assert.deepEqual(pinned.mounts, [{ path: '/workspace/mounts/folder-1', device: String(original.dev), inode: String(original.ino), readOnly: false }]);
  renameSync(selected, renamed);
  const descriptor = readdirSync('/proc/self/fd').find(fd => { try { return readlinkSync(`/proc/self/fd/${fd}`) === renamed; } catch { return false; } });
  assert.notEqual(descriptor, undefined);
  assert.equal(String(fstatSync(Number(descriptor), { bigint: true }).ino), pinned.mounts[0].inode);
  pinned.close(); pinned.close();
  assert.throws(() => fstatSync(Number(descriptor)), { code: 'EBADF' });
});

test('directory pinning rejects final and ancestor symlinks and non-directory selections', { skip: process.platform !== 'linux' }, t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'harness-folder-link-')));
  t.after(() => rmSync(root, { recursive: true, force: true })); mkdirSync(join(root, 'real/child'), { recursive: true });
  symlinkSync(join(root, 'real'), join(root, 'link'));
  for (const path of [join(root, 'link'), join(root, 'link/child'), join(root, 'missing'), '/proc/version']) {
    assert.throws(() => pinSelectedFolders([{ id: 'project', path, mode: 'read' }]), /Could not safely open selected folder/);
  }
});

test('native folder pinning explains unsupported host platforms before opening directories', { skip: process.platform === 'linux' }, () => {
  assert.throws(() => pinSelectedFolders([{ id: 'project', path: '/unused', mode: 'read' }]), /same Linux kernel.*Compose installation.*Linux runner/);
});

test('native folder admission recreates both running and stopped owned containers before returning a verified ID', { skip: process.platform !== 'linux' }, t => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'harness-folder-admission-'))), root = join(dir, 'state'), folder = join(dir, 'project'), log = join(dir, 'calls.jsonl'), statePath = join(dir, 'docker.json');
  mkdirSync(folder); writeFileSync(log, '');
  const saved = { PATH: process.env.PATH, OPEN_HARNESS_MOCK: process.env.OPEN_HARNESS_MOCK, OPEN_HARNESS_DEPLOYMENT: process.env.OPEN_HARNESS_DEPLOYMENT };
  t.after(() => { for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } rmSync(dir, { recursive: true, force: true }); });
  delete process.env.OPEN_HARNESS_MOCK; delete process.env.OPEN_HARNESS_DEPLOYMENT;
  const selected = { ...computer, access: 'folders' as const, folders: [{ id: 'project', path: folder, mode: 'read' as const }] };
  const oldId = 'f'.repeat(64);
  const state = { next: 0, container: { Id: oldId, Name: 'open-harness-atlas', State: { Running: true }, Config: { Labels: { 'open-harness.managed': '1', 'open-harness.state': containerStateKey(root), 'open-harness.config': containerSignature(selected, 'sha256:test', root) } } } };
  writeFileSync(statePath, JSON.stringify(state));
  writeFileSync(join(dir, 'docker'), String.raw`#!${process.execPath}
const fs = require('node:fs'), args = process.argv.slice(2), file = ${JSON.stringify(statePath)}, state = JSON.parse(fs.readFileSync(file, 'utf8'));
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\n');
if (args[0] === 'image') console.log(args.includes('{{.Id}}') ? 'sha256:test' : '${RUNTIME_CONTRACT}');
if (args[0] === 'run' && args.includes('--rm')) {
  const mount = args[args.indexOf('-v') + 1]; console.log(fs.readFileSync(mount.slice(0, -':/probe:ro'.length) + '/canary', 'utf8'));
}
if (args[0] === 'inspect') {
  if (!state.container || ![state.container.Id, state.container.Name].includes(args.at(-1))) { console.error('No such container'); process.exit(1); }
  console.log(JSON.stringify(state.container));
}
if (args[0] === 'rm') { if (state.container?.Id !== args.at(-1)) process.exit(3); state.container = null; }
if (args[0] === 'create') {
  const labels = {};
  for (let i = 0; i < args.length; i++) if (args[i] === '--label') { const value = args[++i], at = value.indexOf('='); labels[value.slice(0, at)] = value.slice(at + 1); }
  state.container = { Id: String(++state.next).padStart(64, '0'), Name: args[args.indexOf('--name') + 1], State: { Running: false }, Config: { Labels: labels } };
  console.log(state.container.Id);
}
if (args[0] === 'start') { if (state.container?.Id !== args.at(-1)) process.exit(4); state.container.State.Running = true; }
if (args[0] === 'exec') {
  if (!args.includes('/usr/local/bin/python')) process.exit(5);
  const info = fs.statSync(${JSON.stringify(folder)}, { bigint: true });
  console.log(JSON.stringify({ bootId: fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(), mounts: [{ path: '/workspace/mounts/folder-1', device: String(info.dev), inode: String(info.ino), readOnly: true }] }));
}
fs.writeFileSync(file, JSON.stringify(state));
`, { mode: 0o700 });
  process.env.PATH = `${dir}:${saved.PATH || ''}`;
  const first = ensureContainer('atlas', root, selected);
  assert.equal(first, '1'.padStart(64, '0'));
  const current = JSON.parse(readFileSync(statePath, 'utf8')); current.container.State.Running = false; writeFileSync(statePath, JSON.stringify(current));
  const second = ensureContainer('atlas', root, selected);
  assert.equal(second, '2'.padStart(64, '0'));
  const calls = readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line) as string[]);
  assert.deepEqual(calls.filter(args => args[0] === 'rm'), [['rm', '-f', oldId], ['rm', '-f', first]]);
  assert.deepEqual(calls.filter(args => args[0] === 'start'), [['start', first], ['start', second]]);
  assert.equal(calls.filter(args => args[0] === 'create').length, 2);
  assert.equal(calls.filter(args => args[0] === 'exec').length, 2);
});
