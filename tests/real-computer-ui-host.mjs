// Explicit opt-in fixture host for real browser UI acceptance. Only fixture-owned state/containers are touched.
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { createServer } from 'node:http';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { initialWorkspace } from '../lib/types.ts';
import { containerStateKey } from '../runtime/hermes.ts';

assert.equal(process.env.OPEN_HARNESS_REAL_COMPUTER_UI, '1'); assert.equal(process.platform, 'linux'); assert.notEqual(process.env.OPEN_HARNESS_MOCK, '1');
const repository = resolve(import.meta.dirname, '..'), root = mkdtempSync(join(process.env.OPEN_HARNESS_SMOKE_DIR, 'computer-ui-')), coordinatorState = join(root, 'coordinator'), runnerState = join(root, 'runner');
const port = Number(process.env.OPEN_HARNESS_UI_CONTROL_PORT || 4331), endpoint = `http://127.0.0.1:${port}`, image = process.env.OPEN_HARNESS_HERMES_IMAGE, exec = promisify(execFile), children = [];
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const command = async args => (await exec('docker', args, { encoding: 'utf8', timeout: 30000, maxBuffer: 5000000 })).stdout.trim();
const wait = async (check, label) => { for (const end = Date.now() + 90000; Date.now() < end;) { const value = await check(); if (value) return value; await pause(100); } throw new Error(`Timed out: ${label}`); };
let token, failure;
const request = async (path, method = 'GET', body) => { const response = await fetch(endpoint + path, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); const value = await response.json(); assert.ok(response.ok, `${method} ${path}: ${JSON.stringify(value)}`); return value; };
const start = (name, args, environment) => { const child = spawn(process.execPath, args, { cwd: repository, env: { ...process.env, OPEN_HARNESS_MOCK: '0', OPEN_HARNESS_DISABLE_OS_VAULT: '1', ...environment }, stdio: ['ignore','pipe','pipe'] }); children.push(child); for (const stream of [child.stdout, child.stderr]) stream.on('data', data => appendFileSync(join(root, `${name}.log`), data)); return child; };
const stop = async child => { if (child.exitCode !== null || child.signalCode !== null) return; const exited = new Promise(resolve => child.once('exit', resolve)); child.kill('SIGTERM'); const timeout = setTimeout(() => child.kill('SIGKILL'), 125000); await exited; clearTimeout(timeout); assert.equal(child.exitCode, 0, 'Fixture service must confirm clean shutdown.'); };
const web = createServer((_request, response) => { response.setHeader('Content-Type', 'text/html; charset=utf-8'); response.end('<!doctype html><title>Actual paired Linux computer</title><style>body{background:#e9efe8;color:#19372d;font:24px system-ui;padding:80px}h1{font-size:48px}input{padding:14px;font-size:24px;width:60%}</style><h1>Actual paired Linux computer</h1><p>Open Harness · isolated acceptance workspace</p><input aria-label="Fixture note" placeholder="Browser session remains open"><script>window.fixtureSession=String(Math.random())</script>'); });
console.log(`Actual Computer UI fixture: ${root}`);
try {
  const imageInfo = JSON.parse(await command(['image','inspect',image]))[0]; assert.equal(imageInfo.Config.Labels['dev.openharness.runtime'], '11');
  await new Promise(resolve => web.listen(0, '0.0.0.0', resolve)); const webPort = web.address().port;
  start('coordinator', ['--import','tsx','runtime/service.ts'], { OPEN_HARNESS_STATE_DIR: coordinatorState, OPEN_HARNESS_PORT: String(port), OPEN_HARNESS_BIND: '127.0.0.1', OPEN_HARNESS_ALLOW_LOOPBACK_PAIRING: '1' });
  token = await wait(async () => { try { const response = await fetch(endpoint + '/v1/bootstrap'); return response.ok && (await response.json()).token; } catch { return false; } }, 'coordinator');
  const pairing = await request('/v1/machines','POST',{ name: 'Actual Linux UI runner', platform: 'linux', coordinatorUrl: 'https://fixture.invalid' });
  start('runner', ['runtime/runner.mjs','--coordinator',endpoint,'--pairing-code',pairing.code], { OPEN_HARNESS_RUNNER_STATE_DIR: runnerState });
  const machine = await wait(async () => (await request('/v1/machines')).machines.find(item => !item.local && item.status === 'online'), 'runner');
  await request('/v1/agents/sync','POST',{ agents: initialWorkspace.agents });
  const profile = (await request('/v1/agents/atlas/profile')).profile;
  await request('/v1/agents/atlas/profile','PUT',{ ...profile, allowedTools: ['mcp__open_harness__computer'], model: { inherit: false, provider: 'local', model: 'no-inference-ui-fixture', credentialRef: '', baseUrl: 'http://127.0.0.1:1/v1' }, computer: { ...profile.computer, machineId: machine.id, desktop: 'virtual' } });
  await wait(async () => { const value = await request('/v1/agents/atlas/profile'); assert.notEqual(value.transfer?.state,'failed',value.transfer?.detail); return value.profile.computer.machineId === machine.id; }, 'private workspace assignment');
  writeFileSync(join(root,'ready.json'),JSON.stringify({ root, coordinatorState, runnerState, port, webPort, machineId: machine.id, image, imageId: imageInfo.Id },null,2));
  console.log(`Ready for actual browser UI: ${root}/ready.json`);
  await wait(async () => existsSync(join(root,'browser-started')), 'browser test start');
  for (const end = Date.now() + 15 * 60000; !existsSync(join(root,'stop')); ) { if (Date.now() > end) throw new Error('Browser test did not finish before fixture deadline.'); await pause(250); }
  const result = join(runnerState,'shared/ui-terminal-result.txt'); assert.equal(readFileSync(result,'utf8').trim(),'ACTUAL_UI_TERMINAL_VERIFIED');
  const runs = await request('/v1/runs'); assert.equal(runs.runs?.length || 0,0);
} catch (error) { failure = error; }
finally {
  for (const child of [...children].reverse()) try { await stop(child); } catch (error) { failure ||= error; }
  const cleanup = [];
  for (const directory of [runnerState, coordinatorState]) {
    const ids = (await command(['ps','-aq','--filter',`label=open-harness.state=${containerStateKey(directory)}`])).split('\n').filter(Boolean);
    for (const id of ids) { const running = await command(['inspect','-f','{{.State.Running}}',id]); cleanup.push({ id, running: running === 'true' }); if (running === 'true') failure ||= new Error('Shutdown left a fixture container running.'); }
    if (ids.length) await command(['rm','-f',...ids]);
  }
  web.closeAllConnections(); await new Promise(resolve => web.close(resolve));
  mkdirSync(join(root,'evidence'),{recursive:true}); writeFileSync(join(root,'evidence/host-result.json'),JSON.stringify({ ok: !failure, error: failure ? String(failure.stack || failure) : null, terminalFileVerified: !failure, shutdownStoppedContainers: cleanup },null,2));
}
if (failure) throw failure;
console.log('Actual UI host file and clean shutdown verified.');
