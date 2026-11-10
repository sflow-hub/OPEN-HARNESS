import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_COMPUTER } from '../lib/agent-profile';
import { closeContainerAdmissions, withContainerAdmission } from '../runtime/container-admission';
import { ensureContainer, ensureContainerAsync, stopManagedContainers } from '../runtime/hermes';
import { ensureDesktopContainerAsync } from '../runtime/computer-runtime';
import { RUNTIME_CONTRACT } from '../runtime/readiness';

test('shutdown drains delayed execution and desktop creation before cleanup and fences every new admission', { skip: process.platform === 'win32' }, async t => {
  const directory = mkdtempSync(join(tmpdir(), 'container-admission-')), root = join(directory, 'state'), inventory = join(directory, 'inventory'), log = join(directory, 'calls.jsonl'), release = join(directory, 'release'); mkdirSync(inventory); writeFileSync(log, '');
  writeFileSync(join(directory, 'docker'), String.raw`#!${process.execPath}
const fs=require('node:fs'),path=require('node:path'),args=process.argv.slice(2),inventory=${JSON.stringify(inventory)},release=${JSON.stringify(release)};
fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(args)+'\n');
const records=()=>fs.readdirSync(inventory).filter(name=>name.endsWith('.json')).map(name=>({path:path.join(inventory,name),value:JSON.parse(fs.readFileSync(path.join(inventory,name),'utf8'))}));
if(args[0]==='image')console.log(args.includes('{{.Id}}')?'sha256:test':'${RUNTIME_CONTRACT}');
if(args[0]==='inspect'){const record=records().find(item=>item.value.Id===args.at(-1)||item.value.Name===args.at(-1));if(!record){console.error('No such object');process.exit(1);}console.log(JSON.stringify(record.value));}
if(args[0]==='ps')console.log(records().filter(item=>item.value.State.Running).map(item=>item.value.Id).join('\n'));
if(args[0]==='stop'){const record=records().find(item=>item.value.Id===args.at(-1));record.value.State.Running=false;fs.writeFileSync(record.path,JSON.stringify(record.value));}
if(args[0]==='run'&&args.includes('--rm')){const mount=args[args.indexOf('-v')+1];console.log(fs.readFileSync(mount.slice(0,-':/probe:ro'.length)+'/'+args.at(-1).split('/').at(-1),'utf8'));}
if(args[0]==='run'&&args.includes('-d')){const labels={};for(let n=0;n<args.length;n++)if(args[n]==='--label'){const at=args[n+1].indexOf('=');labels[args[n+1].slice(0,at)]=args[n+1].slice(at+1);}const role=labels['open-harness.role'];fs.writeFileSync(path.join(inventory,role+'.starting'),'');const started=Date.now();while(!fs.existsSync(release)){if(Date.now()-started>10000)process.exit(2);Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,10);}const value={Id:(role==='desktop'?'b':'a').repeat(64),Name:args[args.indexOf('--name')+1],State:{Running:true},Config:{Labels:labels}};fs.writeFileSync(path.join(inventory,role+'.json'),JSON.stringify(value));console.log(value.Id);}
`, { mode: 0o700 });
  const oldPath = process.env.PATH, oldMock = process.env.OPEN_HARNESS_MOCK; process.env.PATH = `${directory}:${oldPath || ''}`; delete process.env.OPEN_HARNESS_MOCK;
  t.after(() => { if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath; if (oldMock === undefined) delete process.env.OPEN_HARNESS_MOCK; else process.env.OPEN_HARNESS_MOCK = oldMock; rmSync(directory, { recursive: true, force: true }); });
  const execution = ensureContainerAsync('atlas', root, DEFAULT_COMPUTER), desktop = ensureDesktopContainerAsync('atlas', root, { ...DEFAULT_COMPUTER, desktop: 'virtual' });
  for (let n = 0; n < 500 && !(existsSync(join(inventory, 'execution.starting')) && existsSync(join(inventory, 'desktop.starting'))); n++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(existsSync(join(inventory, 'execution.starting')) && existsSync(join(inventory, 'desktop.starting')), 'both Docker creations must already be in flight');
  let drained = false; const closed = closeContainerAdmissions(root).then(() => { drained = true; });
  await assert.rejects(ensureContainerAsync('late', join(root, '.'), DEFAULT_COMPUTER), /workspace is stopping/);
  await assert.rejects(ensureDesktopContainerAsync('late', root, { ...DEFAULT_COMPUTER, desktop: 'virtual' }), /workspace is stopping/);
  assert.throws(() => ensureContainer('late', root, DEFAULT_COMPUTER), /workspace is stopping/);
  assert.equal(drained, false); assert.equal(readFileSync(log, 'utf8').includes('"stop"'), false);
  writeFileSync(release, ''); assert.deepEqual(await Promise.all([execution, desktop]), ['a'.repeat(64), 'b'.repeat(64)]); await closed;
  const stopped = await stopManagedContainers(root); assert.deepEqual(stopped.failures, []); assert.deepEqual(stopped.stopped.sort(), ['a'.repeat(64), 'b'.repeat(64)]);
  for (const name of ['execution','desktop']) assert.equal(JSON.parse(readFileSync(join(inventory, name + '.json'), 'utf8')).State.Running, false);
  const calls = readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line) as string[]); assert.equal(calls.filter(args => args[0] === 'run' && args.includes('-d')).length, 2);
  assert.equal(await withContainerAdmission(join(directory, 'other-workspace'), async () => 'still available'), 'still available');
});

test('failed startup still drains without reopening the workspace', async () => {
  const root = join(tmpdir(), `admission-failure-${crypto.randomUUID()}`);
  let fail!: (error: Error) => void;
  const operation = withContainerAdmission(root, () => new Promise<never>((_resolve, reject) => { fail = reject; }));
  await Promise.resolve(); const rejected = assert.rejects(operation, /startup failed/), closed = closeContainerAdmissions(root);
  fail(new Error('startup failed')); await rejected; await closed;
  await assert.rejects(withContainerAdmission(root, async () => 'must not run'), /workspace is stopping/);
});
