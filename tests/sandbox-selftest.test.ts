import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_COMPUTER, type ComputerConfig } from '../lib/agent-profile';
import { attestContainer, CONTAINER_CHECKS } from '../runtime/sandbox-attest';
import { combineSandbox, directSandbox, mockSandbox, sandboxSelftest, SANDBOX_EXEC_ARGS, type SandboxResult } from '../runtime/sandbox-selftest';

test('runner installers download every served Hermes runtime file', () => {
  const service = readFileSync(new URL('../runtime/service.ts', import.meta.url), 'utf8');
  const allowlist = service.match(/if \(req.method === 'GET' && url.pathname === '\/v1\/install\/file'\) \{[\s\S]*?const allowed = new Set\(\[([^\]]+)\]\)/);
  assert.ok(allowlist, 'install file allowlist exists');
  const served = [...allowlist[1].matchAll(/'(runtime\/hermes\/[^']+)'/g)].map(match => match[1]).sort();
  assert.ok(served.length > 0, 'allowlist contains Hermes files');
  for (const installer of ['install-runner.sh', 'install-runner.ps1']) {
    const script = readFileSync(new URL(`../runtime/installers/${installer}`, import.meta.url), 'utf8');
    const list = installer.endsWith('.sh')
      ? script.match(/for file in ([^;]+); do\s+download "runtime\/hermes\/\$file"/)
      : script.match(/@\(([^)]+)\) \| ForEach-Object \{ Get-RunnerFile "runtime\/hermes\/\$_" \}/);
    assert.ok(list, `${installer} downloads its Hermes file list`);
    const files = installer.endsWith('.sh') ? list[1].trim().split(/\s+/) : [...list[1].matchAll(/"([^"]+)"/g)].map(match => match[1]);
    assert.deepEqual(files.map(file => `runtime/hermes/${file}`).sort(), served, installer);
  }
});

// Embedded JSON fixtures keep the inspect inputs independent of Docker and the launcher.
const good = JSON.parse(`{
  "HostConfig": {"CapDrop":["ALL"],"CapAdd":[],"SecurityOpt":["no-new-privileges"],"Privileged":false,"ReadonlyRootfs":true,"PidsLimit":512,"Memory":4294967296,"NanoCpus":2000000000,"NetworkMode":"bridge"},
  "Mounts": [
    {"Source":"/state/agents/atlas/managed","Destination":"/run/open-harness","RW":false},
    {"Source":"/state/agents/atlas/profile","Destination":"/home/hermes/.hermes","RW":true},
    {"Source":"/state/agents/atlas/private","Destination":"/workspace/private","RW":true},
    {"Source":"/state/shared","Destination":"/workspace/shared","RW":true}
  ]
}`);
const expected = { computer: DEFAULT_COMPUTER, agentId: 'atlas', stateRoot: '/state' };
const fixture = () => structuredClone(good) as typeof good;
test('good inspect fixture passes every host check', () => {
  const { checks } = attestContainer(good, expected);
  assert.deepEqual(Object.keys(checks), CONTAINER_CHECKS);
  assert.ok(Object.values(checks).every(c => c.ok === true));
});
test('bad inspect fixtures fail privileged, foreign mounts, socket and cap-drop', () => {
  const privileged = fixture(); privileged.HostConfig.Privileged = true;
  assert.equal(attestContainer(privileged, expected).checks.not_privileged.ok, false);
  const foreign = fixture(); foreign.Mounts.push({ Source: '/state/agents/scout/private', Destination: '/foreign', RW: true });
  assert.equal(attestContainer(foreign, expected).checks.mounts_expected.ok, false);
  const socket = fixture(); socket.Mounts.push({ Source: '/var/run/docker.sock', Destination: '/var/run/docker.sock', RW: true });
  assert.equal(attestContainer(socket, expected).checks.no_docker_socket_mount.ok, false);
  const missing = fixture(); delete missing.HostConfig.CapDrop;
  assert.equal(attestContainer(missing, expected).checks.cap_drop_all.ok, false);
});
test('hardening, resources, host roots and security options are checked', () => {
  const input = fixture(); Object.assign(input.HostConfig, { ReadonlyRootfs: false, CapAdd: ['SYS_ADMIN'], SecurityOpt: ['seccomp=unconfined'], Memory: 1, NanoCpus: 1, PidsLimit: -1 });
  const checks = attestContainer(input, expected).checks;
  for (const key of ['readonly_rootfs', 'cap_drop_all', 'no_new_privileges', 'seccomp_not_unconfined', 'limits']) assert.equal(checks[key].ok, false, key);
  assert.equal(checks.readonly_rootfs.detail, 'writable image rootfs (hardening pending)');
  for (const Source of ['/', '/home', '/root', '/home/operator', '/Users/operator']) {
    const mounted = fixture(); mounted.Mounts.push({ Source, Destination: '/host', RW: false });
    assert.equal(attestContainer(mounted, expected).checks.no_host_home_mount.ok, false);
  }
  const custom = fixture(); custom.HostConfig.SecurityOpt = ['no-new-privileges:true', 'seccomp=/custom.json'];
  assert.equal(attestContainer(custom, expected).checks.no_new_privileges.ok, true);
  assert.match(attestContainer(custom, expected).checks.seccomp_not_unconfined.detail, /custom/);
});
test('each resource and security setting independently fails closed', () => {
  for (const [key, value, check] of [
    ['PidsLimit', 0, 'limits'], ['Memory', 1024, 'limits'], ['NanoCpus', 1, 'limits'],
    ['CapAdd', ['SYS_ADMIN'], 'cap_drop_all'], ['SecurityOpt', ['no-new-privileges=false'], 'no_new_privileges'],
  ] as const) {
    const input = fixture(); input.HostConfig[key] = value;
    assert.equal(attestContainer(input, expected).checks[check].ok, false, key);
  }
  for (const Source of ['/state', '/state/agents', '/state/agents/scout/private', '/state/agents/scout/profile', '/state/secrets.json']) {
    const input = fixture(); input.Mounts.push({ Source, Destination: '/workspace/mounts/folder-1', RW: false });
    const computer = { ...DEFAULT_COMPUTER, access: 'folders' as const, folders: [{ id: 'unsafe', path: Source, mode: 'read' as const }] };
    assert.equal(attestContainer(input, { ...expected, computer }).checks.mounts_expected.ok, false, Source);
  }
});
test('mount grants require the correct source, destination, team and RW flag', () => {
  const computer: ComputerConfig = { ...DEFAULT_COMPUTER, access: 'folders', folders: [{ id: 'docs', path: '/docs', mode: 'read' }] };
  const input = fixture(); input.Mounts.push({ Source: '/docs', Destination: '/workspace/mounts/folder-1', RW: false }, { Source: '/state/teams/research/shared', Destination: '/workspace/teams/research', RW: true });
  const e = { ...expected, computer, teamIds: ['research'] };
  assert.equal(attestContainer(input, e).checks.mounts_expected.ok, true);
  assert.equal(attestContainer(input, { ...e, teamIds: [] }).checks.mounts_expected.ok, false);
  input.Mounts[0].RW = true;
  assert.equal(attestContainer(input, e).checks.mounts_expected.ok, false);
  const grantForeign = { ...computer, folders: [{ id: 'foreign', path: '/state/agents/scout/private', mode: 'read' as const }] };
  const foreign = fixture(); foreign.Mounts.push({ Source: '/state/agents/scout/private', Destination: '/workspace/mounts/folder-1', RW: false });
  assert.equal(attestContainer(foreign, { ...e, computer: grantForeign }).checks.mounts_expected.ok, false);
});
test('restrictive network policy remains unknown on bridge; names do not prove internal networks', () => {
  for (const mode of ['none', 'allowlist'] as const) {
    const e = { ...expected, computer: { ...DEFAULT_COMPUTER, network: { mode, allow: [] } } };
    const input = fixture(); input.HostConfig.NetworkMode = 'internal-looking-name';
    assert.equal(attestContainer(input, e).checks.network_mode.ok, null);
    assert.match(attestContainer(input, e).checks.network_mode.detail, /not enforced yet/);
    input.HostConfig.NetworkMode = 'none';
    assert.equal(attestContainer(input, e).checks.network_mode.ok, true);
  }
});
test('internal network evidence must come from the host and every attached network must be internal', async () => {
  const input = fixture(); input.NetworkSettings = { Networks: { isolated: { NetworkID: 'network-id' } } }; input.HostConfig.NetworkMode = 'isolated';
  const e = { ...expected, computer: { ...DEFAULT_COMPUTER, network: { mode: 'none' as const, allow: [] } } };
  for (const Internal of [true, false]) {
    const value = await sandboxSelftest('container', e, 'host-attested', async args => args[0] === 'inspect' ? [structuredClone(input)] : args[0] === 'network' ? [{ Id: 'network-id', Name: 'isolated', Internal }] : {});
    assert.equal(value.checks.network_mode.ok, Internal ? true : null);
  }
  input.NetworkSettings.Networks.bridge = { NetworkID: 'bridge-id' };
  const value = await sandboxSelftest('container', e, 'host-attested', async args => args[0] === 'inspect' ? [input] : args[0] === 'network' ? [{ Id: 'network-id', Name: 'isolated', Internal: true }, { Id: 'bridge-id', Name: 'bridge', Internal: false }] : {});
  assert.equal(value.checks.network_mode.ok, null);
});
test('host facts remain authoritative and contradictions flag tampering', () => {
  for (const host of [true, false]) {
    const value = combineSandbox({ no_docker_socket_mount: { ok: host, detail: 'host fact' } }, { docker_socket_absent: { ok: !host, detail: 'probe claim' } });
    assert.equal(value.checks.no_docker_socket_mount.ok, host);
    assert.equal(value.checks.no_docker_socket_mount.tampering_suspected, true);
    assert.equal(value.status, 'red');
  }
  assert.equal(combineSandbox({ check: { ok: true, detail: '' } }).status, 'green');
  assert.equal(combineSandbox({ check: { ok: null, detail: '' } }).status, 'amber');
  const native = directSandbox('runner-attested');
  assert.equal(native.runnerKind, 'native'); assert.equal(native.status, 'amber');
  assert.ok(Object.values(native.checks).every(c => c.ok === null && c.detail === 'not a sandbox (direct access)'));
  assert.equal(mockSandbox().attestation, 'mock');
});
test('inspect and isolated exec use the same container; malformed or unavailable probe cannot grant a pass', async () => {
  const calls: string[][] = [];
  const transport = async (args: string[]) => { calls.push(args); return args[0] === 'inspect' ? [fixture()] : { probe: 'sandbox-selftest/v1', checks: Object.fromEntries(['writes_outside_writable_mounts_denied', 'docker_socket_absent', 'host_home_absent', 'no_privilege_escalation', 'cpu_mem_pids_limited'].map(key => [key, { ok: key !== 'docker_socket_absent', detail: 'probe observation' }])) }; };
  const value = await sandboxSelftest('open-harness-atlas', expected, 'runner-attested', transport);
  assert.equal(value.attestation, 'runner-attested'); assert.equal(value.status, 'red');
  assert.deepEqual(calls, [['inspect', 'open-harness-atlas'], ['exec', '-i', 'open-harness-atlas', ...SANDBOX_EXEC_ARGS]]);
  assert.deepEqual(SANDBOX_EXEC_ARGS, ['env', '-i', 'PATH=/usr/local/bin:/usr/bin:/bin', 'python', '-I', '-S', '/opt/open-harness/sandbox_selftest.py']);
  const invalid = await sandboxSelftest('container', expected, 'host-attested', async args => args[0] === 'inspect' ? [fixture()] : { probe: 'fake', checks: {} });
  assert.equal(invalid.status, 'amber'); assert.equal(invalid.checks.cap_drop_all.ok, true);
  await assert.rejects(sandboxSelftest('container', expected, 'host-attested', async () => []), /inspect/);
});

test('mock HTTP self-test requires operator auth, persists history and records audit', async t => {
  const port = await new Promise<number | null>((resolve, reject) => {
    const server = createServer(); server.once('error', error => { if (['EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code || '')) resolve(null); else reject(error); });
    server.listen(0, '127.0.0.1', () => { const address = server.address(); const port = typeof address === 'object' && address ? address.port : 0; server.close(() => resolve(port)); });
  });
  if (port === null) return t.skip('Sandbox disallows socket listeners; run HTTP coverage outside sandbox.');
  const state = mkdtempSync(join(tmpdir(), 'sandbox-selftest-')), base = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['--import', 'tsx', 'runtime/service.ts'], { env: { ...process.env, OPEN_HARNESS_MOCK: '1', OPEN_HARNESS_PORT: String(port), OPEN_HARNESS_STATE_DIR: state }, stdio: 'pipe' });
  let output = ''; child.stdout?.on('data', part => { output += part; }); child.stderr?.on('data', part => { output += part; });
  t.after(async () => { if (child.exitCode === null) { const stopped = new Promise(r => child.once('exit', r)); child.kill('SIGTERM'); await stopped; } rmSync(state, { recursive: true, force: true }); });
  let token = '';
  for (let i = 0; i < 200; i++) { try { const response = await fetch(base + '/v1/bootstrap'); if (response.ok) { token = (await response.json()).token; break; } } catch {} if (child.exitCode !== null) break; await new Promise(r => setTimeout(r, 50)); }
  assert.ok(token, output);
  const request = async (path: string, method = 'GET', body?: unknown) => {
    const response = await fetch(base + path, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    assert.equal(response.status, 200, await response.clone().text()); return response.json();
  };
  await request('/v1/agents/sync', 'POST', { agents: [{ id: 'atlas', name: 'Atlas', role: 'Assistant', description: '', tone: 1, instructions: '', memory: [] }] });
  const path = '/v1/agents/atlas/sandbox-selftest';
  for (const method of ['GET', 'POST']) assert.equal((await fetch(base + path, { method })).status, 401);
  assert.deepEqual(await request(path), { latest: null, history: [] });
  const record = await request(path, 'POST');
  assert.equal((record.result as SandboxResult).attestation, 'mock'); assert.equal(record.result.status, 'red');
  const history = await request(path); assert.equal(history.latest.id, record.id); assert.deepEqual(history.latest.result, record.result);
  for (let i = 0; i < 21; i++) await request(path, 'POST');
  assert.equal((await request(path)).history.length, 20);
  const audit = await request('/v1/audit?action=sandbox.selftest');
  assert.equal(audit.events.length, 22); assert.deepEqual(audit.events[0].detail, { status: 'red', attestation: 'mock' });
  const { profile } = await request('/v1/agents/atlas/profile');
  const direct = await fetch(base + '/v1/agents/atlas/profile', { method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ ...profile, computer: { ...profile.computer, access: 'direct' } }) });
  assert.equal(direct.status, 400); assert.match((await direct.json()).error, /not sandboxed and is disabled/);
  assert.equal((await request(path)).latest.result.runnerKind, 'container');
});

test('mount attestation rejects missing mounts and permits explicit repeated source grants', () => {
  const absent = fixture(); absent.Mounts = [];
  assert.equal(attestContainer(absent, expected).checks.mounts_expected.ok, false);
  const partial = fixture(); partial.Mounts.pop();
  assert.equal(attestContainer(partial, expected).checks.mounts_expected.ok, false);
  const repeated = fixture(); repeated.Mounts.push({ Source: '/state/shared', Destination: '/workspace/mounts/folder-1', RW: false });
  const computer: ComputerConfig = { ...DEFAULT_COMPUTER, access: 'folders', folders: [{ id: 'shared-read', path: '/state/shared', mode: 'read' }] };
  assert.equal(attestContainer(repeated, { ...expected, computer }).checks.mounts_expected.ok, true);
});
