// Explicit opt-in: synthetic legacy browser storage and actual Docker mount isolation.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve, sep } from 'node:path';
import { draftProfile } from '../lib/agent-profile.ts';
import { desktopResourcePaths, ensureDesktopContainerAsync, stopDesktopContainer } from '../runtime/computer-runtime.ts';
import { containerStateKey, ensureContainerAsync, stopAgentContainers } from '../runtime/hermes.ts';
import { prepareProfile } from '../runtime/profile-runtime.ts';
import { DESKTOP_HELPER } from '../runtime/desktop-helper.ts';

assert.equal(process.env.OPEN_HARNESS_REAL_BROWSER_MIGRATION, '1', 'Set OPEN_HARNESS_REAL_BROWSER_MIGRATION=1 on an isolated Linux Docker host.');
assert.equal(process.platform, 'linux'); assert.notEqual(process.env.OPEN_HARNESS_MOCK, '1');
const root = mkdtempSync(join(process.env.OPEN_HARNESS_SMOKE_DIR || tmpdir(), 'browser-migration-'));
const image = process.env.OPEN_HARNESS_HERMES_IMAGE || 'open-harness-hermes:2026.9.11', id = `migration-${randomUUID().slice(0, 8)}`;
const profile = draftProfile({ id, name: 'Legacy migration fixture', role: 'Acceptance', description: '', tone: 0, instructions: '', memory: [] }); profile.computer.desktop = 'virtual';
const privateHome = join(root, 'agents', id, 'private'), legacy = join(privateHome, '.config/chromium'), paths = desktopResourcePaths(id, root, profile.computer);
const cookie = `COOKIE_${randomUUID()}`, storage = `STORAGE_${randomUUID()}`, note = 'Later agent files must survive browser migration.', observations = [];
const docker = args => execFileSync('docker', args, { encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const hash = path => createHash('sha256').update(readFileSync(path)).digest('hex');
let seed = true, failure, evidence, oldContainer, desktop;
const wait = async (check, label) => { for (const end = Date.now() + 30000; Date.now() < end;) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 100)); } throw new Error(`Timed out: ${label}`); };
const helper = (container, spec) => new Promise((resolve, reject) => {
  const child = spawn('docker', ['exec', '-i', container, 'timeout', '--signal=KILL', '18s', 'python', '-c', DESKTOP_HELPER], { stdio: ['pipe', 'pipe', 'ignore'], timeout: 20000, killSignal: 'SIGKILL' });
  let output = ''; child.stdout.on('data', data => { output += data; if (output.length > 9000000) child.kill('SIGKILL'); }); child.on('error', reject); child.stdin.on('error', reject);
  child.once('close', code => { try { assert.equal(code, 0, 'The real desktop helper must succeed.'); const result = JSON.parse(output); assert.equal(result.error, undefined); resolve(result); } catch (error) { reject(error); } }); child.stdin.end(JSON.stringify(spec) + '\n');
});
const web = createServer((req, res) => {
  const url = new URL(req.url || '/', 'http://fixture');
  if (url.pathname === '/observed') { observations.push({ cookie: req.headers.cookie || '', storage: url.searchParams.get('storage') }); res.end('ok'); return; }
  const initialize = url.pathname === '/seed' && seed; if (initialize) seed = false;
  if (initialize) res.setHeader('Set-Cookie', `migration_fixture=${cookie}; Max-Age=3600; HttpOnly; SameSite=Lax; Path=/`);
  res.setHeader('Cache-Control', 'no-store'); res.setHeader('Content-Type', 'text/html');
  res.end(`<!doctype html><title>Browser migration acceptance</title><h1>Browser migration acceptance</h1><script>${initialize ? `localStorage.setItem('migration',${JSON.stringify(storage)});` : ''}fetch('/observed?storage='+encodeURIComponent(localStorage.getItem('migration')||''));</script>`);
});
const visit = async (container, port, path) => {
  const count = observations.length, gateway = docker(['inspect', '-f', '{{range .NetworkSettings.Networks}}{{.Gateway}}{{end}}', container]);
  await helper(container, { action: 'start' }); await helper(container, { action: 'navigate', url: `http://${gateway}:${port}/${path}` });
  await wait(() => observations.slice(count).some(value => value.cookie.includes(`migration_fixture=${cookie}`) && value.storage === storage), 'real cookie and local storage');
};
console.log(`Browser migration acceptance artifacts: ${root}`);
try {
  const imageInfo = JSON.parse(docker(['image', 'inspect', image]))[0]; assert.equal(imageInfo.Config.Labels['dev.openharness.runtime'], '9');
  prepareProfile(root, profile, profile.model, { environment: () => ({}) }, 'fixture-token', 'fixture-run');
  mkdirSync(privateHome, { recursive: true, mode: 0o700 }); mkdirSync(join(root, 'shared'), { recursive: true, mode: 0o700 }); writeFileSync(join(privateHome, 'agent-note.txt'), note);
  await new Promise(resolve => web.listen(0, '0.0.0.0', resolve)); const port = web.address().port;
  oldContainer = docker(['run', '-d', '--name', `open-harness-legacy-${id}`, '--label', 'open-harness.managed=1', '--label', `open-harness.state=${containerStateKey(root)}`, '--user', `${process.getuid()}:${process.getgid()}`, '-e', 'OPEN_HARNESS_RUNTIME_ROLE=desktop', '-e', 'OPEN_HARNESS_VIRTUAL_DESKTOP=1', '-e', 'DISPLAY=:99', '-e', 'HOME=/workspace/private', '-e', 'HERMES_HOME=/workspace/private/.hermes', '-e', 'AGENT_BROWSER_PROFILE=/workspace/private/.config/chromium', '--workdir', '/workspace/private', '-v', `${privateHome}:/workspace/private`, image]);
  await visit(oldContainer, port, 'seed');
  await assert.rejects(ensureDesktopContainerAsync(id, root, profile.computer), /Stop agents using the old browser|old browser.*idle/i);
  assert.equal(existsSync(paths.migration), false); assert.equal(existsSync(legacy), true);
  docker(['exec', oldContainer, 'python', '/opt/open-harness/browser_shutdown.py']); docker(['stop', '--time', '8', oldContainer]); assert.equal(docker(['inspect', '-f', '{{.State.Running}}', oldContainer]), 'false');
  const cookieHash = hash(join(legacy, 'Default/Cookies'));
  desktop = await ensureDesktopContainerAsync(id, root, profile.computer);
  assert.equal(existsSync(legacy), false, 'Original authentication data must leave the agent-mounted private home.');
  assert.equal(hash(join(paths.backup, 'Default/Cookies')), cookieHash, 'Recoverable browser backup must preserve the stopped cookie store.');
  assert.equal(hash(join(paths.archive, 'Default/Cookies')), cookieHash, 'The original cookie store must remain recoverable outside execution mounts.');
  assert.equal(JSON.parse(readFileSync(paths.migration, 'utf8')).version, 2);
  assert.equal(readFileSync(join(privateHome, 'agent-note.txt'), 'utf8'), note);
  await visit(desktop, port, 'check'); const frame = await helper(desktop, { action: 'frame' }); assert.match(frame.image, /^data:image\/png;base64,/);
  const execution = await ensureContainerAsync(id, root, profile.computer), inspect = JSON.parse(docker(['inspect', execution]))[0];
  for (const mount of inspect.Mounts) for (const saved of [paths.backup, paths.archive]) { const path = relative(resolve(mount.Source), resolve(saved)); assert.ok(path === '..' || path.startsWith(`..${sep}`) || path.startsWith(sep), 'No execution mount may expose a recoverable browser copy.'); }
  assert.equal(docker(['exec', execution, 'python', '-c', "from pathlib import Path; assert not Path('/workspace/private/.config/chromium').exists(); assert not Path('/workspace/desktop').exists(); assert Path('/workspace/private/agent-note.txt').read_text() == 'Later agent files must survive browser migration.'; print('isolated')"]), 'isolated');
  evidence = { ok: true, mode: 'actual Linux Docker, synthetic legacy-shaped browser home; no model or paid inference', image, imageId: imageInfo.Id, runtimeSourceSha256: hash(resolve(import.meta.dirname, '../runtime/computer-runtime.ts')), liveLegacyMigrationRefused: true, legacyContainerStoppedBeforeMigration: true, recoverableCookieOutsideExecutionMounts: true, oldAuthPathNotAgentReadable: true, unrelatedAgentDataPreserved: true, migratedCookieAndLocalStorageUsable: true, newDesktopCapture: true };
} catch (error) { failure = error; }
finally {
  await stopAgentContainers(id, root).catch(() => {}); if (desktop) await stopDesktopContainer(id, root, profile.computer).catch(() => {});
  try { const ids = docker(['ps', '-aq', '--filter', `label=open-harness.state=${containerStateKey(root)}`]).split('\n').filter(Boolean); if (ids.length) docker(['rm', '-f', ...ids]); } catch (error) { failure ||= error; }
  web.closeAllConnections(); await new Promise(resolve => web.close(() => resolve()));
  writeFileSync(join(root, 'diagnostics.json'), JSON.stringify({ error: failure ? String(failure.stack || failure) : null, observations: observations.map(value => ({ cookie: value.cookie.includes(cookie), localStorage: value.storage === storage })) }, null, 2));
}
if (failure) throw failure;
writeFileSync(join(root, 'evidence.json'), JSON.stringify(evidence, null, 2)); console.log(JSON.stringify(evidence, null, 2));
