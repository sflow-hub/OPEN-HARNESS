import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHostFolderMounts, validateFolderExport } from '../runtime/host-folders';

test('Compose grants require exact exported mount roots and preserve read-only ceilings', () => {
  const mounts = parseHostFolderMounts(String.raw`10 1 0:1 / /data rw,relatime - ext4 /dev/test rw
11 1 0:1 /Users/example/Project\040files /host-folders/project\040files rw,relatime - ext4 /dev/test rw
12 11 0:1 /Users/example/private /host-folders/project\040files/private ro,relatime - ext4 /dev/test rw
13 1 0:1 /other /host-folders-sibling/other rw,relatime - ext4 /dev/test rw`);
  assert.deepEqual(mounts, [{ path: '/host-folders/project files/private', mode: 'read' }, { path: '/host-folders/project files', mode: 'write' }]);
  validateFolderExport('/host-folders/project files', 'write', mounts);
  validateFolderExport('/host-folders/project files/private', 'read', mounts);
  assert.throws(() => validateFolderExport('/host-folders/project files/private', 'write', mounts), /read-only/);
  for (const path of ['/data', '/var/run', '/host-folders', '/host-folders/project files-copy', '/host-folders/other', '/host-folders/project files/../other']) {
    assert.throws(() => validateFolderExport(path, 'read', mounts), /has not been shared/);
  }
  assert.throws(() => validateFolderExport('/host-folders/project files', 'read', []), /has not been shared/);
});

test('writable export descendants cannot become grants unless independently mounted', () => {
  const parent = { path: '/host-folders/project', mode: 'write' as const }, child = { path: '/host-folders/project/subfolder', mode: 'read' as const };
  for (const mode of ['read', 'write'] as const) {
    assert.throws(() => validateFolderExport(child.path, mode, [parent]), /export that subfolder separately/);
    assert.throws(() => validateFolderExport(`${child.path}/nested`, mode, [parent, child]), /export that subfolder separately/);
  }
  validateFolderExport(child.path, 'read', [parent, child]);
  assert.throws(() => validateFolderExport(child.path, 'write', [parent, child]), /read-only/);
  validateFolderExport(child.path, 'write', [parent, { ...child, mode: 'write' }]);
});
