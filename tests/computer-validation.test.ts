import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { COMPUTER_TOOL, draftProfile, runToolGrants } from '../lib/agent-profile';
import { validateProfile } from '../runtime/profiles';
import { ensureContainer } from '../runtime/hermes';
import { nativeRuntimeProbe } from '../runtime/profile-runtime';
import { assertGrantAllowed, sharedFolderSource, validateComputerTarget } from '../runtime/computer-validation';

const capabilities = { container: true, direct: true, desktop: true, virtualDesktop: true };
// Grants are refused inside the data folder, so it must not contain the temporary folders granted below.
const stateRoot = join(tmpdir(), 'open-harness-validation-state');
const profile = draftProfile({ id: 'atlas', name: 'Atlas', role: 'Assistant', description: '', tone: 0, instructions: '', memory: [] });

test('destination validation enforces folder grants, capabilities, and machine credentials', t => {
  const folder = realpathSync(mkdtempSync(join(tmpdir(), 'open-harness-folder-')));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  const selected = { ...profile, computer: { ...profile.computer, access: 'folders' as const, folders: [{ id: 'project', name: 'project', path: folder, mode: 'read' as const }] } };
  assert.deepEqual(validateComputerTarget(selected, capabilities, stateRoot, ['MODEL_KEY'], name => name === 'MODEL_KEY'), { ok: true });
  assert.throws(() => validateComputerTarget({ ...selected, computer: { ...selected.computer, folders: [{ id: 'missing', name: 'missing', path: join(folder, 'missing'), mode: 'write' }] } }, capabilities, stateRoot), /not an accessible read\/write folder/);
  assert.throws(() => validateComputerTarget(selected, capabilities, stateRoot, ['MISSING_KEY'], () => false), /Credential MISSING_KEY is missing/);
  assert.throws(() => validateComputerTarget(selected, { ...capabilities, container: false }, stateRoot), /Docker/);
  assert.throws(() => validateComputerTarget({ ...selected, computer: { ...selected.computer, access: 'private', folders: [] } }, { ...capabilities, container: false }, stateRoot), /Docker/);
});

test('folder mounts reject links in the selected path and its parents', t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'harness-mount-links-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'actual/child'), { recursive: true });
  symlinkSync(join(root, 'actual'), join(root, 'link'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(sharedFolderSource(join(root, 'actual/child'), 'read', stateRoot), join(root, 'actual/child'));
  for (const path of [join(root, 'link'), join(root, 'link/child')]) assert.throws(() => sharedFolderSource(path, 'read', stateRoot), /symbolic links/);
});

test('no-desktop runs cannot dispatch the computer-use tool', () => {
  const selected = { ...profile, allowedTools: ['computer_use', 'terminal'] };
  assert.deepEqual(runToolGrants(selected), ['terminal']);
  assert.deepEqual(runToolGrants({ ...selected, computer: { ...selected.computer, desktop: 'virtual' } }), [COMPUTER_TOOL, 'terminal']);
});

test('legacy native access is refused before execution regardless of advertised capabilities', async () => {
  for (const computer of [{ ...profile.computer, access: 'direct' as const }, { ...profile.computer, desktop: 'existing' as const }]) {
    const legacy = { ...profile, allowedTools: ['computer_use', 'terminal'], computer };
    assert.throws(() => validateProfile(legacy), /not sandboxed and is disabled/);
    assert.throws(() => validateComputerTarget(legacy, capabilities, stateRoot), /not sandboxed and is disabled/);
    await assert.rejects(async () => ensureContainer('atlas', '/unused', computer), /not sandboxed and is disabled/);
    assert.deepEqual(runToolGrants(legacy), ['terminal']);
  }
  assert.throws(() => nativeRuntimeProbe('/unused', { action: 'mcp', command: 'must-never-run' }), /not sandboxed and is disabled/);
});

test('grants never cover the whole disk, the home folder, Open Harness data, or the Docker socket', t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'harness-deny-'))), state = join(root, 'state');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(state, 'agents/other/private'), { recursive: true }); mkdirSync(join(root, 'project'));
  const saved = process.env.DOCKER_HOST; t.after(() => { if (saved === undefined) delete process.env.DOCKER_HOST; else process.env.DOCKER_HOST = saved; });
  delete process.env.DOCKER_HOST;
  assert.throws(() => assertGrantAllowed('/', state), /whole disk/);
  assert.throws(() => assertGrantAllowed(homedir(), state), /home folder/);
  if (dirname(homedir()) !== homedir()) assert.throws(() => assertGrantAllowed(dirname(homedir()), state), /home folder/);
  for (const path of [state, join(state, 'agents/other/private'), root]) assert.throws(() => assertGrantAllowed(path, state), /Open Harness data/);
  if (process.platform !== 'win32') for (const path of ['/run', '/var/run']) assert.throws(() => assertGrantAllowed(path, state), /Docker control socket|home folder/);
  process.env.DOCKER_HOST = `unix://${join(root, 'docker/docker.sock')}`;
  assert.throws(() => assertGrantAllowed(join(root, 'docker'), join(root, 'elsewhere')), /Docker control socket/);
  delete process.env.DOCKER_HOST;
  assert.equal(sharedFolderSource(join(root, 'project'), 'write', state), join(root, 'project'));
  assert.throws(() => sharedFolderSource(join(state, 'agents/other/private'), 'read', state), /Open Harness data/);
  assert.doesNotThrow(() => assertGrantAllowed(join(homedir(), 'projects', 'website'), state));
});

test('literal dot-dot-prefixed names remain inside protected data directories', t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'harness-containment-'))), state = join(root, 'state');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const name of ['..private-backup', '..secrets', '..parent/child']) {
    const selected = join(state, name); mkdirSync(selected, { recursive: true });
    assert.throws(() => sharedFolderSource(selected, 'read', state), /Open Harness data/);
    assert.throws(() => sharedFolderSource(selected, 'write', state), /Open Harness data/);
  }
  const sibling = join(root, '..ordinary-project'); mkdirSync(sibling);
  assert.equal(sharedFolderSource(sibling, 'read', state), sibling);
});

test('Docker context endpoints and conventional desktop/rootless sockets cannot be granted', t => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'harness-context-grants-'))), config = join(root, 'config'), state = join(root, 'state');
  const variables = ['DOCKER_CONFIG', 'DOCKER_CONTEXT', 'DOCKER_HOST', 'XDG_RUNTIME_DIR'] as const;
  const saved = variables.map(key => [key, process.env[key]] as const);
  t.after(() => { for (const [key, value] of saved) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } rmSync(root, { recursive: true, force: true }); });
  process.env.DOCKER_CONFIG = config; delete process.env.DOCKER_CONTEXT; delete process.env.DOCKER_HOST; delete process.env.XDG_RUNTIME_DIR;
  const context = (name: string, endpoint: string) => {
    const dir = join(config, 'contexts/meta', createHash('sha256').update(name).digest('hex')); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'meta.json'), JSON.stringify({ Name: name, Endpoints: { docker: { Host: endpoint } } }));
    return dir;
  };
  const socketDir = join(root, 'custom-engine'); mkdirSync(socketDir);
  const meta = context('custom', `unix://${join(socketDir, 'docker.sock')}`);
  writeFileSync(join(config, 'config.json'), JSON.stringify({ currentContext: 'custom' }));
  for (const mode of ['read', 'write'] as const) assert.throws(() => sharedFolderSource(socketDir, mode, state), /Docker control socket/);
  assert.throws(() => assertGrantAllowed(root, join(tmpdir(), 'unrelated-state')), /Docker control socket/);
  process.env.DOCKER_CONTEXT = 'custom'; process.env.DOCKER_HOST = 'tcp://remote.example:2376';
  assert.throws(() => sharedFolderSource(socketDir, 'read', state), /Docker control socket/);
  // Reread metadata when mounting: a changed endpoint cannot inherit an earlier approval.
  const nextSocketDir = join(root, 'new-engine'); mkdirSync(nextSocketDir);
  assert.equal(sharedFolderSource(nextSocketDir, 'read', state), nextSocketDir);
  context('custom', `unix://${join(nextSocketDir, 'engine.sock')}`);
  assert.throws(() => sharedFolderSource(nextSocketDir, 'read', state), /Docker control socket/);
  if (process.platform !== 'win32') {
    const canonical = join(root, 'canonical-engine'); mkdirSync(canonical);
    writeFileSync(join(canonical, 'engine.sock'), 'Synthetic socket target');
    symlinkSync(join(canonical, 'engine.sock'), join(nextSocketDir, 'engine.sock'));
    assert.throws(() => sharedFolderSource(canonical, 'read', state), /Docker control socket/, 'The socket link must protect its real endpoint too.');
  }
  context('remote', 'ssh://remote.example'); process.env.DOCKER_CONTEXT = 'remote';
  const ordinary = join(root, 'project'); mkdirSync(ordinary);
  assert.equal(sharedFolderSource(ordinary, 'read', state), ordinary);
  const plugin = context('plugin', 'ssh://unused.example');
  writeFileSync(join(plugin, 'meta.json'), JSON.stringify({ Name: 'plugin', Endpoints: { plugin: {} } }));
  assert.equal(sharedFolderSource(ordinary, 'read', state), ordinary, 'An unused plugin context has no engine socket to protect.');
  process.env.DOCKER_CONTEXT = 'plugin';
  assert.throws(() => sharedFolderSource(ordinary, 'read', state), /context could not be resolved/);
  process.env.DOCKER_CONTEXT = 'missing';
  assert.throws(() => sharedFolderSource(ordinary, 'read', state), /context could not be resolved/);
  process.env.DOCKER_CONTEXT = 'custom'; writeFileSync(join(meta, 'meta.json'), '{broken');
  assert.throws(() => sharedFolderSource(ordinary, 'read', state), /endpoint settings could not be read/);
  writeFileSync(join(meta, 'meta.json'), JSON.stringify({ Name: 'custom', Endpoints: { docker: { Host: 'unix://relative/socket' } } }));
  assert.throws(() => sharedFolderSource(ordinary, 'read', state), /invalid socket path/);
  context('custom', `unix://${join(nextSocketDir, 'engine.sock')}`);
  for (const path of [join(homedir(), '.docker/desktop'), join(homedir(), '.docker/run'), ...(process.getuid ? [`/run/user/${process.getuid()}`] : [])]) assert.throws(() => assertGrantAllowed(path, state), /Docker control socket/);
});

test('workspace security defaults off, preserves legacy model settings, and shares revisions', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const { Profiles } = await import('../runtime/profiles');
  const db = new DatabaseSync(':memory:');
  try {
    const profiles = new Profiles(db), model = profiles.defaults().model;
    assert.deepEqual(profiles.security(), { allowDirectAccess: false, revision: 0 });
    db.prepare('INSERT INTO workspace_settings VALUES(1,1,?)').run(JSON.stringify(model));
    assert.equal(profiles.security().allowDirectAccess, false);
    assert.throws(() => profiles.setSecurity(true, 1), /not sandboxed and is disabled/);
    assert.throws(() => profiles.setSecurity(true, 1, true), /not sandboxed and is disabled/);
    profiles.setSecurity(false, 1);
    assert.deepEqual(profiles.defaults().model, model);
    profiles.setDefaults(model, 2);
    assert.equal(profiles.security().allowDirectAccess, false);
    assert.throws(() => profiles.setSecurity(false, 2), /changed elsewhere/);
    profiles.setSecurity(false, 3);
    assert.throws(() => profiles.checkDirect({ access: 'direct' } as never), /not sandboxed and is disabled/);
    assert.throws(() => profiles.save({ ...profile, computer: { ...profile.computer, access: 'direct' } }), /not sandboxed and is disabled/);
  } finally { db.close(); }
});
