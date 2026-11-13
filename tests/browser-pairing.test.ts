import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash, createHmac } from 'node:crypto';
import { createServer, request as httpRequest } from 'node:http';
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { consumeBrowserPairing, issueBrowserPairing } from '../runtime/browser-pairing';

const repository = join(import.meta.dirname, '..'), pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const execute = promisify(execFile);
const recordPath = (root: string, code: string) => join(root, '.browser-pairing', `${createHash('sha256').update(code).digest('hex')}.json`);
function state(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'open-harness-browser-pairing-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
function mint(root: string, args: string[] = []) {
  return spawnSync(process.execPath, ['--import', 'tsx', 'runtime/browser-pair-cli.ts', ...args], { cwd: repository, env: { ...process.env, OPEN_HARNESS_STATE_DIR: root }, encoding: 'utf8' });
}

test('CLI issues independent high-entropy links without storing plaintext codes and bounds their expiry', t => {
  const root = state(t), before = Date.now(), first = mint(root), second = mint(root, ['--ttl-seconds', '10']);
  assert.equal(first.status, 0, first.stderr); assert.equal(second.status, 0, second.stderr);
  const a = JSON.parse(first.stdout) as { code: string; expiresAt: string }, b = JSON.parse(second.stdout) as typeof a;
  assert.deepEqual(Object.keys(a).sort(), ['code', 'expiresAt']); assert.match(a.code, /^[A-Za-z0-9_-]{43}$/); assert.notEqual(a.code, b.code);
  assert.ok(Date.parse(a.expiresAt) >= before + 300_000); assert.ok(Date.parse(a.expiresAt) <= Date.now() + 300_000);
  assert.ok(Date.parse(b.expiresAt) <= Date.now() + 10_000);
  const dir = join(root, '.browser-pairing');
  assert.equal(readdirSync(dir).length, 2);
  for (const file of readdirSync(dir)) {
    assert.match(file, /^[a-f0-9]{64}\.json$/);
    const content = readFileSync(join(dir, file), 'utf8');
    assert.ok(!content.includes(a.code) && !content.includes(b.code));
    if (process.platform !== 'win32') assert.equal(statSync(join(dir, file)).mode & 0o777, 0o600);
  }
  if (process.platform !== 'win32') assert.equal(statSync(dir).mode & 0o777, 0o700);
  for (const args of [['--ttl-seconds', '0'], ['--ttl-seconds', '601'], ['--ttl-seconds', '1.5'], ['--unknown']]) {
    const invalid = mint(root, args); assert.equal(invalid.status, 1); assert.equal(invalid.stdout, '');
  }
  assert.equal(consumeBrowserPairing(root, 'wrong'), false);
  assert.equal(consumeBrowserPairing(root, a.code), true); assert.equal(consumeBrowserPairing(root, a.code), false);
  assert.equal(consumeBrowserPairing(root, b.code), true);
});

test('expired, malformed, symlinked and insecure pairing state fails closed', t => {
  const root = state(t), now = Date.now(), expired = issueBrowserPairing(root, 1, now - 2_000);
  assert.equal(consumeBrowserPairing(root, expired.code, now), false);
  const malformed = issueBrowserPairing(root);
  writeFileSync(recordPath(root, malformed.code), '{broken');
  assert.equal(consumeBrowserPairing(root, malformed.code), false);
  writeFileSync(recordPath(root, malformed.code), JSON.stringify({ version: 1, issuedAt: now, expiresAt: now + 601_000 }));
  assert.equal(consumeBrowserPairing(root, malformed.code), false);
  const future = issueBrowserPairing(root, 300, now + 10_000);
  assert.equal(consumeBrowserPairing(root, future.code, now), false);
  if (process.platform !== 'win32') {
    const unsafe = issueBrowserPairing(root), path = recordPath(root, unsafe.code), target = join(root, 'outside.json');
    writeFileSync(target, readFileSync(path), { mode: 0o600 }); unlinkSync(path); symlinkSync(target, path);
    assert.equal(consumeBrowserPairing(root, unsafe.code), false); assert.ok(statSync(target).isFile());
    unlinkSync(path); writeFileSync(path, readFileSync(target), { mode: 0o644 });
    // A private umask otherwise turns this insecure-file fixture back into 0600.
    chmodSync(path, 0o644); assert.equal(statSync(path).mode & 0o777, 0o644);
    assert.equal(consumeBrowserPairing(root, unsafe.code), false);
    chmodSync(join(root, '.browser-pairing'), 0o755);
    assert.equal(consumeBrowserPairing(root, future.code, now + 11_000), false);
    assert.throws(() => issueBrowserPairing(root), /private directory/);
  }
});

test('one code can be consumed by only one of competing processes', async t => {
  const root = state(t), issued = issueBrowserPairing(root);
  const source = `import { consumeBrowserPairing } from './runtime/browser-pairing.ts'; console.log(consumeBrowserPairing(process.env.OPEN_HARNESS_STATE_DIR, process.env.TEST_PAIR_CODE));`;
  const results = await Promise.all(Array.from({ length: 4 }, () => execute(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source], { cwd: repository, env: { ...process.env, OPEN_HARNESS_STATE_DIR: root, TEST_PAIR_CODE: issued.code }, timeout: 15_000 })));
  assert.deepEqual(results.map(result => result.stdout.trim()).sort(), ['false', 'false', 'false', 'true']);
});

async function coordinator(t: TestContext, requirePairing: boolean) {
  const root = mkdtempSync(join(tmpdir(), 'open-harness-browser-pairing-')), socket = createServer();
  await new Promise<void>(resolve => socket.listen(0, '127.0.0.1', resolve));
  const address = socket.address(); assert.ok(address && typeof address !== 'string');
  const port = address.port; await new Promise<void>(resolve => socket.close(() => resolve()));
  const base = `http://127.0.0.1:${port}`;
  let child: ChildProcess | undefined, output = '';
  function request(path: string, data?: unknown, headers: Record<string, string> = {}) {
    return new Promise<{ status: number; value: Record<string, unknown> }>((resolve, reject) => {
      const req = httpRequest(base + path, { method: data === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', ...headers }, signal: AbortSignal.timeout(10_000) }, res => {
        let body = ''; res.on('data', chunk => body += chunk); res.once('error', reject);
        res.once('end', () => { try { resolve({ status: res.statusCode!, value: JSON.parse(body) }); } catch (error) { reject(error); } });
      });
      req.once('error', reject); req.end(data === undefined ? undefined : JSON.stringify(data));
    });
  }
  async function start() {
    output = '';
    child = spawn(process.execPath, ['--import', 'tsx', 'runtime/service.ts'], { cwd: repository, env: { NODE_ENV: 'test', PATH: process.env.PATH, HOME: root, TMPDIR: process.env.TMPDIR, SYSTEMROOT: process.env.SYSTEMROOT, OPEN_HARNESS_DISABLE_OS_VAULT: '1', OPEN_HARNESS_MOCK: '1', OPEN_HARNESS_REQUIRE_BROWSER_PAIRING: requirePairing ? '1' : '0', OPEN_HARNESS_PORT: String(port), OPEN_HARNESS_STATE_DIR: root }, stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout!.on('data', chunk => output += chunk); child.stderr!.on('data', chunk => output += chunk);
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(output);
      try { const response = await request('/v1/bootstrap'); if (response.status === (requirePairing ? 401 : 200)) return; } catch {}
      await pause(50);
    }
    throw new Error(`Coordinator did not start: ${output}`);
  }
  async function stop() {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    const current = child, closed = new Promise<void>(resolve => current.once('exit', () => resolve()));
    current.kill('SIGTERM'); await closed;
  }
  t.after(async () => { await stop(); rmSync(root, { recursive: true, force: true }); });
  await start();
  return { root, request, start, stop };
}

test('HTTP bootstrap requires one-use filesystem pairing even with forged loopback Host, and survives restart', async t => {
  const f = await coordinator(t, true);
  assert.deepEqual(await f.request('/v1/ready'), { status: 200, value: { ok: true } });
  assert.equal((await f.request('/v1/health')).status, 401);
  for (const host of ['localhost:3000', '127.0.0.1', 'untrusted.example']) {
    const denied = await f.request('/v1/bootstrap', undefined, { Host: host, 'X-Forwarded-For': '127.0.0.1' });
    assert.equal(denied.status, 401); assert.equal(denied.value.pairingRequired, true); assert.equal(denied.value.token, undefined); assert.match(String(denied.value.error), /launcher/);
  }
  assert.equal((await f.request('/v1/browser/pair', { code: 'invalid' })).status, 401);
  const expired = issueBrowserPairing(f.root, 1, Date.now() - 2_000);
  assert.equal((await f.request('/v1/browser/pair', { code: expired.code })).status, 401);
  const cli = mint(f.root); assert.equal(cli.status, 0, cli.stderr);
  const issued = JSON.parse(cli.stdout) as { code: string };
  const attempts = await Promise.all(Array.from({ length: 5 }, () => f.request('/v1/browser/pair', { code: issued.code })));
  assert.deepEqual(attempts.map(response => response.status).sort(), [200, 401, 401, 401, 401]);
  const connected = attempts.find(response => response.status === 200)!;
  assert.equal(connected.value.mode, 'test'); assert.ok(connected.value.runtime && connected.value.version && connected.value.hermes);
  const token = String(connected.value.token); assert.ok(token.length > 40);
  const auth = { Authorization: `Bearer ${token}` };
  assert.deepEqual((await f.request('/v1/bootstrap', undefined, auth)).value, connected.value);
  const scoped = createHmac('sha256', token).update('agent:atlas').digest('hex');
  const deniedAgent = await f.request('/v1/bootstrap', undefined, { Host: 'localhost:3000', Authorization: `Bearer ${scoped}`, 'X-Open-Harness-Agent': 'atlas' });
  assert.equal(deniedAgent.status, 401); assert.equal(deniedAgent.value.token, undefined);
  assert.equal((await f.request('/v1/browser/pair', { code: issued.code })).status, 401);
  const pending = issueBrowserPairing(f.root);
  await f.stop(); await f.start();
  assert.equal((await f.request('/v1/bootstrap')).status, 401);
  assert.equal((await f.request('/v1/bootstrap', undefined, auth)).value.token, token);
  const secondBrowser = await f.request('/v1/browser/pair', { code: pending.code });
  assert.equal(secondBrowser.status, 200); assert.equal(secondBrowser.value.token, token);
  const health = await f.request('/v1/health', undefined, auth);
  assert.equal(health.status, 200); assert.equal(health.value.activeRuns, 0); assert.ok(health.value.runtime);
  assert.equal((await f.request('/v1/browser/pair', { code: pending.code })).status, 401);
  assert.equal((await f.request('/v1/browser/issue', {})).status, 401);
});

test('source-mode bootstrap remains loopback-gated and never accepts browser pairing codes', async t => {
  const f = await coordinator(t, false);
  const bootstrap = await f.request('/v1/bootstrap'); assert.equal(bootstrap.status, 200); assert.ok(bootstrap.value.token);
  assert.equal((await f.request('/v1/bootstrap', undefined, { Host: 'untrusted.example' })).status, 403);
  const issued = issueBrowserPairing(f.root);
  assert.equal((await f.request('/v1/browser/pair', { code: issued.code })).status, 404);
  assert.equal(consumeBrowserPairing(f.root, issued.code), true);
});
