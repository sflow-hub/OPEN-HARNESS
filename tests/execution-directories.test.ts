import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_COMPUTER } from '../lib/agent-profile';
import { ensureContainer, ensureContainerAsync } from '../runtime/hermes';
import { RUNTIME_CONTRACT } from '../runtime/readiness';

function fixture(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'execution-dirs-')), root = join(directory, 'state'), inventory = join(directory, 'container.json'), log = join(directory, 'calls.jsonl'); writeFileSync(log, '');
  writeFileSync(join(directory, 'docker'), String.raw`#!${process.execPath}
const fs=require('node:fs'),args=process.argv.slice(2),file=${JSON.stringify(inventory)};
fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(args)+'\n');
if(args[0]==='image')console.log(args.includes('{{.Id}}')?'sha256:test':'${RUNTIME_CONTRACT}');
if(args[0]==='inspect'){if(!fs.existsSync(file)){console.error('No such object');process.exit(1);}console.log(fs.readFileSync(file,'utf8'));}
if(args[0]==='run'&&args.includes('--rm')){const mount=args[args.indexOf('-v')+1];console.log(fs.readFileSync(mount.slice(0,-':/probe:ro'.length)+'/'+args.at(-1).split('/').at(-1),'utf8'));}
if(args[0]==='run'&&args.includes('-d')){const labels={},mounts=[];for(let n=0;n<args.length;n++){if(args[n]==='--label'){const at=args[n+1].indexOf('=');labels[args[n+1].slice(0,at)]=args[n+1].slice(at+1);}if(args[n]==='-v'){const [Source,Destination]=args[n+1].split(':');const stat=fs.lstatSync(Source);if(!stat.isDirectory()||stat.isSymbolicLink()||stat.uid!==process.getuid())throw Error('Docker must never create a managed bind directory');mounts.push({Source,Destination});}}const value={Id:'${'a'.repeat(64)}',State:{Running:true},Config:{Labels:labels},Mounts:mounts};fs.writeFileSync(file,JSON.stringify(value));console.log(value.Id);}
`, { mode: 0o700 });
  const previousPath = process.env.PATH, previousMock = process.env.OPEN_HARNESS_MOCK; process.env.PATH = `${directory}:${previousPath || ''}`; delete process.env.OPEN_HARNESS_MOCK;
  t.after(() => { if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath; if (previousMock === undefined) delete process.env.OPEN_HARNESS_MOCK; else process.env.OPEN_HARNESS_MOCK = previousMock; rmSync(directory, { recursive: true, force: true }); });
  return { root, directory, calls: () => readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as string[]) };
}
for (const asynchronous of [false, true]) {
  test(`${asynchronous ? 'async' : 'sync'} first execution creates writable managed binds before Docker sees them`, { skip: process.platform === 'win32' }, async t => {
    const { root } = fixture(t); if (asynchronous) await ensureContainerAsync('atlas', root, DEFAULT_COMPUTER); else ensureContainer('atlas', root, DEFAULT_COMPUTER);
    for (const name of ['shared', 'agents/atlas/profile', 'agents/atlas/private', 'agents/atlas/managed']) { const stat = statSync(join(root, name)); assert.equal(stat.uid, process.getuid?.()); assert.equal(stat.mode & 0o777, 0o700); }
    const result = join(root, 'shared/human-result.txt'); writeFileSync(result, 'human first-use'); assert.equal(readFileSync(result, 'utf8'), 'human first-use');
  });
  test(`${asynchronous ? 'async' : 'sync'} execution refuses linked managed bind sources before starting a container`, { skip: process.platform === 'win32' }, async t => {
    const { root, directory, calls } = fixture(t), outside = join(directory, 'outside'); mkdirSync(outside); mkdirSync(join(root, 'agents/atlas'), { recursive: true }); symlinkSync(outside, join(root, 'agents/atlas/private'));
    if (asynchronous) await assert.rejects(ensureContainerAsync('atlas', root, DEFAULT_COMPUTER), /symbolic links/); else assert.throws(() => ensureContainer('atlas', root, DEFAULT_COMPUTER), /symbolic links/);
    assert.equal(calls().some(args => args[0] === 'run' && args.includes('-d')), false);
  });
}
