// OPEN_HARNESS_REAL_CONTAINER=1 node --import tsx tests/real-sandbox-smoke.mjs
// Uses the production container factory and pinned image, with no model calls.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { draftProfile } from '../lib/agent-profile.ts';
import { ensureContainer, stopManagedContainers } from '../runtime/hermes.ts';
import { prepareProfile } from '../runtime/profile-runtime.ts';
import { HERMES_IMAGE } from '../runtime/readiness.ts';

assert.equal(process.env.OPEN_HARNESS_REAL_CONTAINER, '1', 'Opt in with OPEN_HARNESS_REAL_CONTAINER=1.');
assert.notEqual(process.env.OPEN_HARNESS_MOCK, '1', 'Sandbox verification requires actual containers.');
const fixture = mkdtempSync(join(tmpdir(), 'open-harness-sandbox-')), root = join(fixture, 'state');
const evidence = { image: HERMES_IMAGE, checks: [], containers: [] }, created = new Set();
const docker = args => execFileSync('docker', args, { encoding: 'utf8', timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const inspect = name => JSON.parse(docker(['inspect', '-f', '{{json .}}', name]));
const image = JSON.parse(docker(['image', 'inspect', HERMES_IMAGE]))[0];
evidence.imageId = image.Id;
evidence.platform = { os: image.Os, architecture: image.Architecture };
const python = (name, script) => docker(['exec', name, 'python', '-c', script]);
const check = (name, action) => { action(); evidence.checks.push(name); console.log(`PASS ${name}`); };
const profiles = ['one', 'two'].map(name => {
  const profile = draftProfile({ id: `sandbox-${name}-${randomUUID().slice(0, 8)}`, name, role: 'Sandbox fixture', description: '', tone: 0, instructions: '', memory: [] });
  profile.allowedTools = [];
  profile.computer.resources = { cpu: .5, memoryMb: 256, concurrency: 1 };
  return profile;
});
function prepare(profile) {
  prepareProfile(root, profile, { provider: 'mock', model: 'unused', credentialRef: 'MODEL_KEY', baseUrl: '' }, { environment: () => ({ MODEL_KEY: `credential-${profile.name}` }) }, `agent-token-${profile.name}`, 'sandbox-fixture');
}
function container(profile) {
  const name = ensureContainer(profile.id, root, profile.computer), info = inspect(name);
  created.add(info.Id);
  assert.equal(info.Image, evidence.imageId, 'Every tested container must use the recorded runtime image.');
  evidence.containers.push({ id: info.Id, name, imageId: info.Image, user: info.Config.User, mounts: info.Mounts, hostConfig: info.HostConfig });
  return name;
}
mkdirSync(join(root, 'shared'), { recursive: true });
const sentinel = join(fixture, 'host-only.txt'); writeFileSync(sentinel, 'host-private');
try {
  profiles.forEach(prepare);
  const [first, second] = profiles.map(container);
  check('each agent has only its own profile and private mounts plus the common shared folder', () => {
    for (const [index, name] of [first, second].entries()) {
      const mounts = inspect(name).Mounts;
      assert.equal(mounts.length, 4);
      for (const [destination, source, writable] of [
        ['/run/open-harness', `agents/${profiles[index].id}/managed`, false],
        ['/home/hermes/.hermes', `agents/${profiles[index].id}/profile`, true],
        ['/workspace/private', `agents/${profiles[index].id}/private`, true],
        ['/workspace/shared', 'shared', true],
      ]) {
        const mount = mounts.find(item => item.Destination === destination);
        assert.equal(mount?.Source, join(root, source)); assert.equal(mount?.RW, writable);
      }
      python(name, `from pathlib import Path
assert Path('/home/hermes/.hermes/.env').read_text() == 'MODEL_KEY="credential-${profiles[index].name}"\\n'
Path('/workspace/private/owner.txt').write_text('${profiles[index].name}')
for path in ${JSON.stringify([sentinel, join(root, 'agents', profiles[1 - index].id, 'profile', '.env'), '/var/run/docker.sock', '/run/docker.sock'])}:
    assert not Path(path).exists(), path
`);
    }
    assert.equal(python(first, "from pathlib import Path; print(Path('/workspace/private/owner.txt').read_text())"), 'one');
    assert.equal(python(second, "from pathlib import Path; print(Path('/workspace/private/owner.txt').read_text())"), 'two');
  });
  check('folder grants refuse files, control sockets and agent-planted links', () => {
    const id = inspect(first).Id;
    python(first, "import socket; s = socket.socket(socket.AF_UNIX); s.bind('/workspace/private/control.sock'); s.close()");
    for (const path of [sentinel, join(root, 'agents', profiles[0].id, 'private/control.sock')]) {
      assert.throws(() => ensureContainer(profiles[0].id, root, { ...profiles[0].computer, access: 'folders', folders: [{ id: 'invalid', path, mode: 'write' }] }), /not a directory/);
      assert.equal(inspect(first).Id, id);
    }
    python(first, "import os; os.symlink('/', '/workspace/shared/host-link')");
    for (const path of [join(root, 'shared/host-link'), join(root, 'shared/host-link/tmp')]) {
      assert.throws(() => ensureContainer(profiles[0].id, root, { ...profiles[0].computer, access: 'folders', folders: [{ id: 'invalid', path, mode: 'write' }] }), /symbolic links/);
      assert.equal(inspect(first).Id, id);
    }
  });
  check('shared files remain mutually readable and writable', () => {
    python(first, "from pathlib import Path; Path('/workspace/shared/team.txt').write_text('one')");
    python(second, "from pathlib import Path; p=Path('/workspace/shared/team.txt'); assert p.read_text() == 'one'; p.write_text('two')");
    assert.equal(readFileSync(join(root, 'shared/team.txt'), 'utf8'), 'two');
  });
  check('kernel applies non-root execution, dropped capabilities, seccomp and resource limits', () => {
    for (const name of [first, second]) {
      const info = inspect(name), limits = info.HostConfig;
      assert.notEqual(info.Config.User.split(':')[0], '0');
      assert.equal(limits.Privileged, false); assert.equal(limits.Memory, 256 * 1024 * 1024);
      assert.equal(limits.NanoCpus, 500_000_000); assert.equal(limits.PidsLimit, 512);
      assert.deepEqual(limits.CapDrop, ['ALL']); assert.ok(limits.SecurityOpt.includes('no-new-privileges'));
      for (const key of ['PidMode', 'IpcMode', 'NetworkMode']) assert.notEqual(limits[key], 'host');
      python(name, `import os
from pathlib import Path
assert os.getuid() != 0
status = dict(line.split(':', 1) for line in Path('/proc/self/status').read_text().splitlines() if ':' in line)
assert int(status['CapEff'].strip(), 16) == 0
assert status['NoNewPrivs'].strip() == '1'
assert status['Seccomp'].strip() == '2'
assert Path('/sys/fs/cgroup/memory.max').read_text().strip() == '${256 * 1024 * 1024}'
assert Path('/sys/fs/cgroup/pids.max').read_text().strip() == '512'
quota, period = map(int, Path('/sys/fs/cgroup/cpu.max').read_text().split())
assert quota / period == .5
try:
    Path('/run/open-harness/policy.json').write_text('{}')
except OSError:
    pass
else:
    raise AssertionError('Managed policy was writable')
`);
    }
  });
  check('profile regeneration cannot follow temporary symlinks planted from inside the container', () => {
    python(first, `import os
for name in ['config.yaml', 'SOUL.md', '.env']:
    os.symlink(${JSON.stringify(sentinel)}, '/home/hermes/.hermes/' + name + '.tmp')
`);
    prepare(profiles[0]);
    assert.equal(readFileSync(sentinel, 'utf8'), 'host-private');
    assert.equal(python(first, "from pathlib import Path; print(Path('/home/hermes/.hermes/.env').read_text().strip())"), 'MODEL_KEY="credential-one"');
  });
  const readonly = join(fixture, 'readonly'), writable = join(fixture, 'writable');
  for (const path of [readonly, writable]) { mkdirSync(path); writeFileSync(join(path, 'file.txt'), 'original'); }
  const selected = { ...profiles[0], computer: { ...profiles[0].computer, access: 'folders', folders: [{ id: 'read', path: readonly, mode: 'read' }, { id: 'write', path: writable, mode: 'write' }] } };
  const selectedName = container(selected), selectedId = inspect(selectedName).Id;
  check('selected folders enforce actual read-only and read/write access', () => {
    python(selectedName, `from pathlib import Path
import errno
read = Path('/workspace/mounts/folder-1/file.txt')
assert read.read_text() == 'original'
try:
    read.write_text('forbidden')
except OSError as error:
    assert error.errno == errno.EROFS, error
else:
    raise AssertionError('Read-only folder was writable')
Path('/workspace/mounts/folder-2/file.txt').write_text('allowed')
`);
    assert.equal(readFileSync(join(readonly, 'file.txt'), 'utf8'), 'original');
    assert.equal(readFileSync(join(writable, 'file.txt'), 'utf8'), 'allowed');
    python(second, "from pathlib import Path; assert not Path('/workspace/mounts/folder-1/file.txt').exists(); assert not Path('/workspace/mounts/folder-2/file.txt').exists()");
  });
  check('returning to Private workspace replaces the container and revokes selected-folder access', () => {
    const privateName = container(profiles[0]);
    assert.notEqual(inspect(privateName).Id, selectedId);
    assert.equal(inspect(privateName).Mounts.length, 4);
    python(privateName, "from pathlib import Path; assert not Path('/workspace/mounts/folder-1/file.txt').exists(); assert not Path('/workspace/mounts/folder-2/file.txt').exists(); assert Path('/workspace/private/owner.txt').read_text() == 'one'");
  });
  const stopped = await stopManagedContainers(root);
  assert.deepEqual(stopped.failures, []);
  for (const name of [first, second]) assert.equal(inspect(name).State.Running, false);
  evidence.checks.push('workspace cleanup stops both agent containers');
  assert.equal(JSON.parse(docker(['image', 'inspect', HERMES_IMAGE]))[0].Id, evidence.imageId, 'The runtime image changed during verification.');
} catch (error) {
  writeFileSync(join(fixture, 'diagnostics.json'), JSON.stringify({ ...evidence, error: String(error), stack: error.stack }, null, 2));
  throw error;
} finally {
  for (const id of created) { try { docker(['rm', '-f', id]); } catch (error) { if (!String(error.stderr).includes('No such container')) throw error; } }
}
writeFileSync(join(fixture, 'evidence.json'), JSON.stringify(evidence, null, 2));
console.log(`Sandbox verification passed: ${evidence.checks.length} checks. Evidence: ${join(fixture, 'evidence.json')}`);
