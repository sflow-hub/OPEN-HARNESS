import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { DEFAULT_COMPUTER } from '../lib/agent-profile';
import { containerStateKey, ensureContainerAsync, runningAgentContainer, stopAgentContainers } from '../runtime/hermes';
import { desktopContainerArguments, desktopResourceKey, desktopResourcePaths, ensureDesktopContainerAsync, runningDesktopContainer, stopAgentComputer, stopDesktopContainer } from '../runtime/computer-runtime';
import { RUNTIME_CONTRACT } from '../runtime/readiness';

const computer = { ...DEFAULT_COMPUTER, desktop: 'virtual' as const };
type Container = { Id: string; State: { Running: boolean }; Config: { Labels: Record<string, string> }; Mounts: Array<{ Source: string; Destination: string }> };
function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'harness-split-')), root = join(directory, 'state'), file = join(directory, 'docker.json'), log = join(directory, 'calls.jsonl');
  writeFileSync(file, JSON.stringify({ containers: {}, next: 1 })); writeFileSync(log, '');
  writeFileSync(join(directory, 'docker'), String.raw`#!${process.execPath}
const fs=require('node:fs'),args=process.argv.slice(2),file=${JSON.stringify(file)},state=JSON.parse(fs.readFileSync(file,'utf8'));
fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(args)+'\n');
const entries=Object.entries(state.containers),found=entries.find(([name,value])=>name===args.at(-1)||value.Id===args.at(-1)),value=found?.[1];
if(args[0]==='image')console.log(args.includes('{{.Id}}')?'sha256:test':'${RUNTIME_CONTRACT}');
if(args[0]==='inspect'){if(!value){console.error('No such object');process.exit(1);}console.log(JSON.stringify(value));}
if(args[0]==='run'&&args.includes('--rm')){const mount=args[args.indexOf('-v')+1];console.log(fs.readFileSync(mount.slice(0,-':/probe:ro'.length)+'/'+args.at(-1).split('/').at(-1),'utf8'));}
if(args[0]==='run'&&args.includes('-d')){const labels={},mounts=[];for(let n=0;n<args.length;n++){if(args[n]==='--label'){const at=args[n+1].indexOf('=');labels[args[n+1].slice(0,at)]=args[n+1].slice(at+1);}if(args[n]==='-v'){const [Source,Destination]=args[n+1].split(':');mounts.push({Source,Destination});}}const id='container-'+state.next++;state.containers[args[args.indexOf('--name')+1]]={Id:id,State:{Running:true},Config:{Labels:labels},Mounts:mounts};console.log(id);}
if(args[0]==='start'&&value){value.State.Running=true;console.log(value.Id);}
if(args[0]==='exec'&&state.refuseBrowserClose){console.error('browser waiting for confirmation');process.exit(1);}
if(args[0]==='stop'&&value){if(state.refuseStop){console.error('stop unconfirmed');process.exit(1);}value.State.Running=false;console.log(value.Id);}
if(args[0]==='rm'&&found)delete state.containers[found[0]];
if(args[0]==='ps'){const filters=args.filter((a,n)=>args[n-1]==='--filter').map(a=>a.replace(/^label=/,''));console.log(entries.filter(([,c])=>c.State.Running&&filters.every(filter=>{const at=filter.indexOf('=');return c.Config.Labels[filter.slice(0,at)]===filter.slice(at+1);})).map(([,c])=>c.Id).join('\n'));}
fs.writeFileSync(file,JSON.stringify(state));
`, { mode: 0o700 });
  const savedPath = process.env.PATH, savedMock = process.env.OPEN_HARNESS_MOCK;
  process.env.PATH = `${directory}:${savedPath || ''}`; delete process.env.OPEN_HARNESS_MOCK;
  t.after(() => { if (savedPath === undefined) delete process.env.PATH; else process.env.PATH = savedPath; if (savedMock === undefined) delete process.env.OPEN_HARNESS_MOCK; else process.env.OPEN_HARNESS_MOCK = savedMock; rmSync(directory, { recursive: true, force: true }); });
  return { root, load: () => JSON.parse(readFileSync(file, 'utf8')) as { containers: Record<string, Container>; next: number; refuseStop?: boolean; refuseBrowserClose?: boolean }, save: (value: unknown) => writeFileSync(file, JSON.stringify(value)), calls: () => readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as string[]) };
}

test('execution stop preserves the immutable desktop and restart reuses the execution container', { skip: process.platform === 'win32' }, async t => {
  const f = fixture(t), desktop = await ensureDesktopContainerAsync('atlas', f.root, computer);
  await ensureContainerAsync('atlas', f.root, computer); const execution = await runningAgentContainer('atlas', f.root); assert.ok(execution);
  const executionArgs = f.calls().find(args => args[0] === 'run' && args.includes('open-harness.role=execution'))!;
  assert.ok(executionArgs.includes('DISPLAY=') && executionArgs.includes('DBUS_SESSION_BUS_ADDRESS='));
  assert.ok(!executionArgs.includes('DISPLAY=:99') && !executionArgs.some(arg => arg.includes('browser-sessions/')));
  await stopAgentContainers('atlas', f.root);
  assert.equal(await runningAgentContainer('atlas', f.root), null);
  assert.equal(await runningDesktopContainer('atlas', f.root, computer), desktop);
  await ensureContainerAsync('atlas', f.root, computer);
  assert.equal(await runningAgentContainer('atlas', f.root), execution);
  assert.equal(await ensureDesktopContainerAsync('atlas', f.root, computer), desktop);
  await stopAgentComputer('atlas', f.root, computer);
  assert.equal(await runningDesktopContainer('atlas', f.root, computer), null);
  assert.equal(await runningAgentContainer('atlas', f.root), null);
});

test('shared desktop identity is workspace/team/machine scoped and never mounts member private files', { skip: process.platform === 'win32' }, async t => {
  const f = fixture(t), shared = { ...computer, browserSessionTeamId: 'ops' };
  const first = await ensureDesktopContainerAsync('atlas', f.root, shared), second = await ensureDesktopContainerAsync('scout', f.root, shared);
  assert.equal(first, second);
  assert.notEqual(desktopResourceKey('atlas', f.root, shared), desktopResourceKey('atlas', f.root, { ...shared, machineId: 'other' }));
  assert.notEqual(desktopResourceKey('atlas', f.root, shared), desktopResourceKey('atlas', `${f.root}-other`, shared));
  assert.notEqual(desktopResourceKey('atlas', f.root, computer), desktopResourceKey('scout', f.root, computer));
  const args = desktopContainerArguments('atlas', f.root, shared, 'sha256:test'), mounts = args.filter((_, index) => args[index - 1] === '-v');
  assert.equal(mounts.length, 2);
  assert.ok(mounts.every(mount => mount.includes('/computers/') && !mount.includes('/agents/') && !mount.includes('/shared') && !mount.includes('/run/open-harness')));
});

test('idle browser migration archives authenticated data outside execution mounts and never removes later agent files', { skip: process.platform === 'win32' }, async t => {
  const f = fixture(t), source = join(f.root, 'agents/atlas/private/.config/chromium');
  mkdirSync(source, { recursive: true }); writeFileSync(join(source, 'Cookies'), 'saved-session'); symlinkSync('/tmp/old-chromium-lock', join(source, 'SingletonLock'));
  await ensureDesktopContainerAsync('atlas', f.root, computer);
  const paths = desktopResourcePaths('atlas', f.root, computer);
  assert.equal(readFileSync(join(paths.browser, 'Cookies'), 'utf8'), 'saved-session');
  assert.equal(readFileSync(join(paths.backup, 'Cookies'), 'utf8'), 'saved-session');
  assert.equal(readFileSync(join(paths.archive, 'Cookies'), 'utf8'), 'saved-session');
  assert.equal(existsSync(source),false);
  const migration = JSON.parse(readFileSync(paths.migration,'utf8')); assert.equal(migration.version,2); assert.ok(migration.archive.startsWith('computers/'));
  mkdirSync(source,{recursive:true}); writeFileSync(join(source, 'agent-created.txt'), 'new agent data');
  await stopDesktopContainer('atlas',f.root,computer);
  await ensureDesktopContainerAsync('atlas', f.root, computer);
  assert.equal(readFileSync(join(source,'agent-created.txt'),'utf8'),'new agent data');
  assert.equal(readFileSync(join(paths.browser, 'Cookies'), 'utf8'), 'saved-session');
  assert.equal(readFileSync(join(paths.backup, 'Cookies'), 'utf8'), 'saved-session');
});

test('completed v1 migration archives only the recorded unchanged legacy tree, including on a live desktop', { skip: process.platform === 'win32' }, async t => {
  const f=fixture(t),source=join(f.root,'agents/atlas/private/.config/chromium'),paths=desktopResourcePaths('atlas',f.root,computer);
  mkdirSync(source,{recursive:true});writeFileSync(join(source,'Cookies'),'original');await ensureDesktopContainerAsync('atlas',f.root,computer);
  const saved=JSON.parse(readFileSync(paths.migration,'utf8'));saved.version=1;delete saved.archive;rmSync(paths.archive,{recursive:true});
  mkdirSync(source,{recursive:true});writeFileSync(join(source,'Cookies'),'changed later');writeFileSync(paths.migration,JSON.stringify(saved));
  await assert.rejects(ensureDesktopContainerAsync('atlas',f.root,computer),/changed after migration/);
  assert.equal(readFileSync(join(source,'Cookies'),'utf8'),'changed later');assert.equal(JSON.parse(readFileSync(paths.migration,'utf8')).version,1);
  writeFileSync(join(source,'Cookies'),'original');await ensureDesktopContainerAsync('atlas',f.root,computer);
  assert.equal(existsSync(source),false);assert.equal(readFileSync(join(paths.archive,'Cookies'),'utf8'),'original');assert.equal(JSON.parse(readFileSync(paths.migration,'utf8')).version,2);
});

test('interruption after legacy archival preserves recovery data and blocks automatic migration retries', { skip: process.platform === 'win32' }, async t => {
  const f=fixture(t),source=join(f.root,'agents/atlas/private/.config/chromium'),paths=desktopResourcePaths('atlas',f.root,computer);
  mkdirSync(source,{recursive:true});writeFileSync(join(source,'Cookies'),'recoverable session');
  const script=`import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';
const original=fs.promises.rename;fs.promises.rename=async(from,to)=>{await original(from,to);if(from===process.argv[3])process.exit(42);};syncBuiltinESMExports();
const {ensureDesktopContainerAsync}=await import(process.argv[1]);await ensureDesktopContainerAsync('atlas',process.argv[2],JSON.parse(process.argv[4]));`;
  const child=spawnSync(process.execPath,['--import','tsx','--input-type=module','-e',script,new URL('../runtime/computer-runtime.ts',import.meta.url).href,f.root,source,JSON.stringify(computer)],{env:{...process.env},timeout:15000});
  assert.equal(child.status,42,String(child.stderr));assert.equal(existsSync(source),false);assert.equal(readFileSync(join(paths.archive,'Cookies'),'utf8'),'recoverable session');
  assert.equal(JSON.parse(readFileSync(paths.migration,'utf8')).version,0);
  mkdirSync(source,{recursive:true});writeFileSync(join(source,'new-file'),'do not remove');
  await assert.rejects(ensureDesktopContainerAsync('atlas',f.root,computer),/migration is incomplete/);
  assert.equal(readFileSync(join(source,'new-file'),'utf8'),'do not remove');assert.equal(readFileSync(join(paths.archive,'Cookies'),'utf8'),'recoverable session');
  assert.equal(f.calls().filter(args=>args[0]==='run'&&args.includes('-d')).length,0);
});

test('unrecorded browser copies cannot trigger an ambiguous archival migration', {skip:process.platform==='win32'},async t=>{
  const f=fixture(t),source=join(f.root,'agents/atlas/private/.config/chromium'),paths=desktopResourcePaths('atlas',f.root,computer);
  mkdirSync(source,{recursive:true});writeFileSync(join(source,'Cookies'),'source session');mkdirSync(paths.backup,{recursive:true});writeFileSync(join(paths.backup,'Cookies'),'different backup');
  await assert.rejects(ensureDesktopContainerAsync('atlas',f.root,computer),/migration is incomplete/);assert.equal(readFileSync(join(source,'Cookies'),'utf8'),'source session');assert.equal(readFileSync(join(paths.backup,'Cookies'),'utf8'),'different backup');
});

test('legacy browser hardlinks into execution files block archival without moving either copy',{skip:process.platform==='win32'},async t=>{
  const f=fixture(t),source=join(f.root,'agents/atlas/private/.config/chromium'),alias=join(f.root,'agents/atlas/private/linked-cookie');
  mkdirSync(source,{recursive:true});writeFileSync(join(source,'Cookies'),'linked session');linkSync(join(source,'Cookies'),alias);
  await assert.rejects(ensureDesktopContainerAsync('atlas',f.root,computer),/unsupported link/);
  assert.equal(readFileSync(alias,'utf8'),'linked session');assert.equal(readFileSync(join(source,'Cookies'),'utf8'),'linked session');assert.equal(existsSync(desktopResourcePaths('atlas',f.root,computer).archive),false);
});

test('shared migration refuses a running legacy writer and planted links', { skip: process.platform === 'win32' }, async t => {
  const f = fixture(t), shared = { ...computer, browserSessionTeamId: 'ops' }, key = createHash('sha256').update(JSON.stringify(['ops', shared.machineId])).digest('hex').slice(0, 32), source = join(f.root, 'browser-sessions', key);
  mkdirSync(source, { recursive: true }); writeFileSync(join(source, 'Cookies'), 'session');
  const state = f.load(); state.containers.legacy = { Id: 'legacy-id', State: { Running: true }, Config: { Labels: { 'open-harness.managed': '1', 'open-harness.state': containerStateKey(f.root) } }, Mounts: [{ Source: source, Destination: '/workspace/private/.config/chromium' }] }; f.save(state);
  await assert.rejects(ensureDesktopContainerAsync('atlas', f.root, shared), /Stop agents using the old browser/);
  assert.equal(f.calls().filter(args => args[0] === 'run' && args.includes('-d')).length, 0);
  state.containers.legacy.State.Running = false; f.save(state); symlinkSync('/etc/passwd', join(source, 'planted'));
  await assert.rejects(ensureDesktopContainerAsync('atlas', f.root, shared), /unsupported link/);
  assert.equal(readFileSync(join(source, 'Cookies'), 'utf8'), 'session');
});

test('desktop ownership, live image replacement, and unconfirmed stop fail closed', { skip: process.platform === 'win32' }, async t => {
  const f = fixture(t), id = await ensureDesktopContainerAsync('atlas', f.root, computer), paths = desktopResourcePaths('atlas', f.root, computer), state = f.load();
  state.containers[paths.name].Config.Labels['open-harness.config'] = 'old-image'; f.save(state);
  await assert.rejects(ensureDesktopContainerAsync('atlas', f.root, computer), /Stop the computer/);
  assert.equal(await runningDesktopContainer('atlas', f.root, computer), id);
  state.refuseStop = true; f.save(state); await assert.rejects(stopDesktopContainer('atlas', f.root, computer), /could not confirm/);
  state.containers[paths.name].Config.Labels['open-harness.state'] = 'foreign'; f.save(state);
  const before = f.calls().filter(args => ['stop', 'rm', 'start'].includes(args[0])).length;
  await assert.rejects(stopDesktopContainer('atlas', f.root, computer), /another workspace/);
  await assert.rejects(ensureDesktopContainerAsync('atlas', f.root, computer), /another workspace/);
  assert.equal(f.calls().filter(args => ['stop', 'rm', 'start'].includes(args[0])).length, before);
});

test('desktop teardown requires normal browser exit before Docker stops or profile transfer proceeds', { skip: process.platform === 'win32' }, async t => {
  const f = fixture(t), id = await ensureDesktopContainerAsync('atlas', f.root, computer), state = f.load();
  state.refuseBrowserClose = true; f.save(state);
  await assert.rejects(stopAgentComputer('atlas', f.root, computer), /confirmation.*not been transferred/);
  assert.equal(await runningDesktopContainer('atlas', f.root, computer), id);
  assert.ok(!f.calls().some(args => args[0] === 'stop' && args.at(-1) === id));
  state.refuseBrowserClose = false; f.save(state);
  await stopDesktopContainer('atlas', f.root, computer);
  const calls = f.calls(), stop = calls.findIndex(args => args[0] === 'stop' && args.at(-1) === id);
  assert.ok(stop > 0); assert.deepEqual(calls[stop - 1], ['exec', id, 'python', '/opt/open-harness/browser_shutdown.py']);
});
