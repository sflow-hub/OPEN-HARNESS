import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SecretStore, SecretsUnavailableError } from '../runtime/secrets';

function stateDir() { return mkdtempSync(join(tmpdir(), 'harness-secrets-')); }
function withEnv<T>(values: Record<string, string | undefined>, body: () => T): T {
  const previous = Object.fromEntries(Object.keys(values).map(key => [key, process.env[key]]));
  for (const [key, value] of Object.entries(values)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  try { return body(); } finally {
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
}

// A fake secret-tool, so the vault paths are exercised without touching a real keyring.
// `mode` decides whether a stored value can be read back, whether the collection is locked,
// or whether the entry is simply absent.
function fakeVault(mode: 'honest' | 'lying' | 'locked') {
  const dir = stateDir();
  const store = join(dir, 'vault-blob');
  const lookup = mode === 'honest'
    ? `if [ -f "${store}" ]; then cat "${store}"; exit 0; fi\nexit 1`
    : mode === 'lying' ? 'exit 1'
    : 'echo "cannot unlock the collection" >&2\nexit 1';
  writeFileSync(join(dir, 'secret-tool'), `#!/bin/sh\ncase "$1" in\n  lookup) ${lookup} ;;\n  store) cat > "${store}" ; exit 0 ;;\nesac\nexit 2\n`);
  chmodSync(join(dir, 'secret-tool'), 0o755);
  return { path: `${dir}:${process.env.PATH}`, store };
}

test('a fresh install writes a restricted file and records the backend it chose', () => {
  const root = stateDir(), file = join(root, 'secrets.json');
  withEnv({ OPEN_HARNESS_DISABLE_OS_VAULT: '1' }, () => {
    const secrets = new SecretStore(file);
    secrets.set('XAI_API_KEY', 'xai-value');
    assert.equal(secrets.backend, 'restricted local file');
    assert.deepEqual(secrets.names(), ['XAI_API_KEY']);
    assert.equal(readFileSync(join(root, 'secrets.backend'), 'utf8'), 'file');
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).XAI_API_KEY, 'xai-value');
    // A restart keeps both the keys and the control token that authorizes every client.
    const reopened = new SecretStore(file);
    assert.equal(reopened.token, secrets.token);
    assert.equal(reopened.environment().XAI_API_KEY, 'xai-value');
  });
});

test('an unreadable vault stops startup instead of minting a new store over it', () => {
  const root = stateDir(), file = join(root, 'secrets.json');
  writeFileSync(join(root, 'secrets.backend'), 'vault:system password vault');
  withEnv({ OPEN_HARNESS_DISABLE_OS_VAULT: '1' }, () => {
    assert.throws(() => new SecretStore(file), SecretsUnavailableError);
    // Refusing has to be inert: no file, and so no new control token to invalidate runners.
    assert.equal(existsSync(file), false);
  });
});

test('credentials that cannot be parsed are reported, not replaced', () => {
  const root = stateDir(), file = join(root, 'secrets.json');
  writeFileSync(file, 'not json at all');
  withEnv({ OPEN_HARNESS_DISABLE_OS_VAULT: '1' }, () => {
    assert.throws(() => new SecretStore(file), SecretsUnavailableError);
    assert.equal(readFileSync(file, 'utf8'), 'not json at all');
  });
});

test('the file copy survives a vault that accepts a write but returns nothing', { skip: process.platform !== 'linux' }, () => {
  const root = stateDir(), file = join(root, 'secrets.json');
  const vault = fakeVault('lying');
  withEnv({ OPEN_HARNESS_DISABLE_OS_VAULT: undefined, DBUS_SESSION_BUS_ADDRESS: 'unix:path=/dev/null', PATH: vault.path }, () => {
    const secrets = new SecretStore(file);
    secrets.set('XAI_API_KEY', 'xai-value');
    assert.equal(secrets.backend, 'restricted local file');
    assert.equal(existsSync(file), true, 'the only readable copy must not be deleted');
    assert.equal(new SecretStore(file).environment().XAI_API_KEY, 'xai-value');
  });
});

test('a working vault takes over, and a later locked vault refuses rather than start empty', { skip: process.platform !== 'linux' }, () => {
  const root = stateDir(), file = join(root, 'secrets.json');
  const honest = fakeVault('honest');
  const token = withEnv({ OPEN_HARNESS_DISABLE_OS_VAULT: undefined, DBUS_SESSION_BUS_ADDRESS: 'unix:path=/dev/null', PATH: honest.path }, () => {
    const secrets = new SecretStore(file);
    secrets.set('XAI_API_KEY', 'xai-value');
    assert.equal(secrets.backend, 'system password vault');
    assert.equal(existsSync(file), false, 'the vault confirmed the write, so the file copy goes');
    assert.match(readFileSync(join(root, 'secrets.backend'), 'utf8'), /^vault:/);
    assert.equal(new SecretStore(file).environment().XAI_API_KEY, 'xai-value');
    return secrets.token;
  });
  const locked = fakeVault('locked');
  withEnv({ OPEN_HARNESS_DISABLE_OS_VAULT: undefined, DBUS_SESSION_BUS_ADDRESS: 'unix:path=/dev/null', PATH: locked.path }, () => {
    assert.throws(() => new SecretStore(file), (error: unknown) => error instanceof SecretsUnavailableError && /cannot read them now/.test(error.message));
  });
  // And once the real vault is reachable again, the original token is still in force.
  withEnv({ OPEN_HARNESS_DISABLE_OS_VAULT: undefined, DBUS_SESSION_BUS_ADDRESS: 'unix:path=/dev/null', PATH: honest.path }, () => {
    assert.equal(new SecretStore(file).token, token);
  });
});
