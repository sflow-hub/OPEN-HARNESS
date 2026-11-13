import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FOLDER_VERIFIER } from '../runtime/folder-mounts';

// Runs the real verifier text with the two kernel files and the mount targets redirected to fixtures, so its reading of
// /proc/self/mountinfo is tested without privileges or Docker. The fixture files are read in the same modes as the
// kernel files would be.
const SHIM = `import builtins, json, os, sys
redirect = json.loads(sys.argv.pop(1))
source = sys.argv.pop(1)
real_open, real_stat = builtins.open, os.stat
builtins.open = lambda file, *args, **kwargs: real_open(redirect.get(file, file), *args, **kwargs)
os.stat = lambda path, *args, **kwargs: real_stat(redirect.get(path, path), *args, **kwargs)
exec(compile(source, 'FOLDER_VERIFIER', 'exec'), {'__name__': '__main__'})`;
const python = spawnSync('python3', ['--version']).status === 0 ? 'python3' : '';
const targets = ['/workspace/mounts/folder-1', '/workspace/mounts/folder-2'];
const root = '1234 1100 0:120 / / rw,relatime master:1 - overlay overlay rw,lowerdir=/var/lib/docker/overlay2/l/A:/var/lib/docker/overlay2/l/B';
const bind = (id: number, source: string, target: string, options: string, optional = '') =>
  `${id} 1234 8:2 ${source} ${target} ${options}${optional ? ` ${optional}` : ''} - ext4 /dev/sda2 rw`;

function verify(t: TestContext, lines: Array<string | Buffer>, paths = targets): { readOnly?: boolean[]; error?: string } {
  const dir = mkdtempSync(join(tmpdir(), 'harness-folder-verifier-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const redirect: Record<string, string> = { '/proc/self/mountinfo': join(dir, 'mountinfo'), '/proc/sys/kernel/random/boot_id': join(dir, 'boot_id') };
  writeFileSync(redirect['/proc/self/mountinfo'], Buffer.concat(lines.map(line => Buffer.concat([Buffer.from(line), Buffer.from('\n')]))));
  writeFileSync(redirect['/proc/sys/kernel/random/boot_id'], 'b9e3931c-e849-4e14-847b-e8e4152f8ac4\n');
  paths.forEach((path, index) => { redirect[path] = join(dir, `folder-${index + 1}`); mkdirSync(redirect[path]); });
  const result = spawnSync(python, ['-I', '-S', '-c', SHIM, JSON.stringify(redirect), FOLDER_VERIFIER, JSON.stringify(paths)], { encoding: 'utf8' });
  if (result.status !== 0) return { error: result.stderr.trim().split('\n').at(-1) };
  return { readOnly: JSON.parse(result.stdout).mounts.map((mount: { readOnly: boolean }) => mount.readOnly) };
}

test('the verifier takes each access mode from its own mountinfo entry, not the superblock', { skip: !python }, t => {
  const lines = [root, bind(1241, '/home/developer/project-a', targets[0], 'ro,relatime'), bind(1242, '/home/developer/project-b', targets[1], 'rw,relatime', 'shared:5')];
  assert.deepEqual(verify(t, lines), { readOnly: [true, false] });
});

test('non-ASCII bytes in any mount path do not stop verification', { skip: !python }, t => {
  const lines = [root, bind(1240, '/home/zoë/.local/state/open-harness/shared', '/workspace/shared', 'rw,relatime'),
    bind(1241, '/home/zoë/Téléchargements', targets[0], 'ro,relatime'),
    Buffer.concat([Buffer.from('1242 1234 8:2 /data/'), Buffer.from([0xff]), Buffer.from(` ${targets[1]} rw,relatime - ext4 /dev/sda2 rw`)])];
  assert.deepEqual(verify(t, lines), { readOnly: [true, false] });
});

test('folder names cannot inject or hide mountinfo entries', { skip: !python }, t => {
  // The kernel escapes only space, tab, newline and backslash in these paths; \r and \v reach mountinfo unchanged.
  const injected = bind(1241, '/x\r1\v2\v0:0\v/\v/workspace/mounts/folder-1\vro\rz', targets[0], 'rw,relatime');
  assert.deepEqual(verify(t, [root, injected], [targets[0]]), { readOnly: [false] });
  assert.deepEqual(verify(t, [root, bind(1241, '/notes\rdraft', targets[0], 'ro,relatime')], [targets[0]]), { readOnly: [true] });
});

test('a missing, stacked or ambiguous entry refuses verification, and only whole option tokens count', { skip: !python }, t => {
  const ro = bind(1241, '/home/developer/project-a', targets[0], 'ro,relatime');
  for (const lines of [[root], [root, ro, bind(1243, '/home/developer/project-a', targets[0], 'rw,relatime')], [root, bind(1241, '/p', targets[0], 'relatime')],
    [root, bind(1241, '/p', targets[0], 'ro,rw')], [root, bind(1241, '/p', `${targets[0]}/sub`, 'ro')]]) {
    assert.match(verify(t, lines, [targets[0]]).error ?? '', /no unambiguous access mode/);
  }
  assert.deepEqual(verify(t, [root, bind(1241, '/p', targets[0], 'rw,relatime,x-ro')], [targets[0]]), { readOnly: [false] });
});
