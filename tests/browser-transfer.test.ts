import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DEFAULT_COMPUTER, type ComputerConfig } from '../lib/agent-profile';
import { desktopResourcePaths } from '../runtime/computer-runtime';
import { exportAgentTransfer, importAgentFiles, importAgentTransfer, type TransferBundle } from '../runtime/transfer-files';
const computer: ComputerConfig = { ...DEFAULT_COMPUTER, desktop: 'virtual', resources: { ...DEFAULT_COMPUTER.resources } };
const hash = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
function write(path: string, value: string) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, value); }
function fixture(t: TestContext) { const root = mkdtempSync(join(tmpdir(), 'browser-transfer-')), previous = process.env.OPEN_HARNESS_MOCK; process.env.OPEN_HARNESS_MOCK = '1'; t.after(() => { if (previous === undefined) delete process.env.OPEN_HARNESS_MOCK; else process.env.OPEN_HARNESS_MOCK = previous; rmSync(root, { recursive: true, force: true }); }); return { root, source: join(root, 'source'), destination: join(root, 'destination') }; }
function checksum(bundle: TransferBundle) { const manifest = (files: TransferBundle['files']) => [...files].sort((a,b) => a.path.localeCompare(b.path)).map(file => `${file.path}:${file.checksum}`).join('\n'); if (bundle.browser) bundle.browser.checksum = hash(manifest(bundle.browser.files)); bundle.checksum = hash(manifest(bundle.files) + (bundle.browser ? `\n@desktop-browser-v1:${bundle.browser.checksum}` : '')); return bundle; }
function file(path: string, value: string) { return { path, data: Buffer.from(value).toString('base64'), checksum: hash(value) }; }

test('dedicated browser transfer preserves sessions and restores to the destination resource without copying staging or caches', async t => {
  const { source, destination } = fixture(t), sourcePaths = desktopResourcePaths('atlas', source, computer), target = { ...computer, machineId: 'destination-runner' }, destinationPaths = desktopResourcePaths('atlas', destination, target);
  write(join(source, 'agents/atlas/private/report.md'), 'report'); write(join(source, 'agents/atlas/profile/.env'), 'not-exported'); write(join(source, 'agents/atlas/private/.config/chromium/Default/Cookies'), 'stale-cookie-fixture');
  write(join(sourcePaths.browser, 'Default/Cookies'), 'current-cookie-fixture'); write(join(sourcePaths.browser, 'Default/Sessions/Session_1'), 'open-tabs-fixture'); write(join(sourcePaths.browser, 'Local State'), 'browser-settings');
  write(join(sourcePaths.browser, 'Default/Cache/ignored'), 'cache'); write(join(sourcePaths.staging, 'uploads/other.txt'), 'staging'); write(join(sourcePaths.home, '.hermes/secret'), 'not-browser-state');
  if (process.platform !== 'win32') symlinkSync('/nonexistent/browser-lock', join(sourcePaths.browser, 'SingletonLock'));
  write(join(destinationPaths.browser, 'Default/Cookies'), 'previous-destination-cookie-fixture');
  const bundle = await exportAgentTransfer(source, 'atlas', computer);
  assert.deepEqual(bundle.browser?.files.map(value => value.path), ['Default/Cookies','Default/Sessions/Session_1','Local State']);
  assert.deepEqual(bundle.files.map(value => value.path), ['private/report.md']); assert.doesNotMatch(JSON.stringify(bundle), /stale-cookie|not-exported|not-browser-state|uploads|Cache/);
  assert.throws(() => importAgentFiles(destination, 'atlas', bundle), /stopped computer transfer/);
  const restored = await importAgentTransfer(destination, 'atlas', bundle, target); assert.equal(restored.checksum, bundle.checksum); assert.equal(restored.browserFiles, 3);
  assert.equal(readFileSync(join(destinationPaths.browser, 'Default/Cookies'), 'utf8'), 'current-cookie-fixture'); assert.equal(readFileSync(join(destinationPaths.browser, 'Default/Sessions/Session_1'), 'utf8'), 'open-tabs-fixture');
  assert.equal(existsSync(join(destination, 'agents/atlas/private/.config/chromium')), false); assert.equal(existsSync(destinationPaths.staging), false);
  const migration = JSON.parse(readFileSync(destinationPaths.migration, 'utf8')); assert.equal(migration.resourceKey, destinationPaths.key); assert.equal(migration.version, 2); assert.equal(readFileSync(join(destination, migration.backup, 'Default/Cookies'), 'utf8'), 'previous-destination-cookie-fixture');
  assert.equal(readFileSync(join(sourcePaths.browser, 'Default/Cookies'), 'utf8'), 'current-cookie-fixture');
});

test('browser import archives an idle legacy destination before replacing its migration record', async t=>{
  const {source,destination}=fixture(t),sourcePaths=desktopResourcePaths('atlas',source,computer),paths=desktopResourcePaths('atlas',destination,computer),legacy=join(destination,'agents/atlas/private/.config/chromium');
  write(join(sourcePaths.browser,'Default/Cookies'),'incoming session');write(join(legacy,'Default/Cookies'),'previous legacy session');write(join(destination,'agents/atlas/private/agent-note.txt'),'keep agent note');
  const bundle=await exportAgentTransfer(source,'atlas',computer);await importAgentTransfer(destination,'atlas',bundle,computer);
  assert.equal(existsSync(legacy),false);assert.equal(readFileSync(join(paths.archive,'Default/Cookies'),'utf8'),'previous legacy session');assert.equal(readFileSync(join(paths.backup,'Default/Cookies'),'utf8'),'previous legacy session');assert.equal(readFileSync(join(paths.browser,'Default/Cookies'),'utf8'),'incoming session');assert.equal(readFileSync(join(destination,'agents/atlas/private/agent-note.txt'),'utf8'),'keep agent note');
  const record=JSON.parse(readFileSync(paths.migration,'utf8'));assert.equal(record.version,2);assert.equal(record.source,'agent-transfer');assert.equal(readFileSync(join(destination,record.archive,'Default/Cookies'),'utf8'),'previous legacy session');
  write(join(legacy,'agent-created'),'later agent data');await importAgentTransfer(destination,'atlas',bundle,computer);assert.equal(readFileSync(join(legacy,'agent-created'),'utf8'),'later agent data');
});

test('browser import refuses ambiguous earlier migration records without replacing any browser data', async t=>{
  const {source,destination}=fixture(t),sourcePaths=desktopResourcePaths('atlas',source,computer),paths=desktopResourcePaths('atlas',destination,computer),legacy=join(destination,'agents/atlas/private/.config/chromium');
  write(join(sourcePaths.browser,'Default/Cookies'),'incoming');write(join(paths.browser,'Default/Cookies'),'existing');write(join(legacy,'agent-file'),'unknown later data');
  const bundle=await exportAgentTransfer(source,'atlas',computer);
  for(const record of [{version:0,resourceKey:paths.key,source:'agent-transfer-incomplete'},{version:1,resourceKey:paths.key,source:'agent-transfer',backup:null}]){
    write(paths.migration,JSON.stringify(record));await assert.rejects(importAgentTransfer(destination,'atlas',bundle,computer),/incomplete|ambiguous/);assert.equal(readFileSync(join(paths.browser,'Default/Cookies'),'utf8'),'existing');assert.equal(readFileSync(join(legacy,'agent-file'),'utf8'),'unknown later data');assert.deepEqual(JSON.parse(readFileSync(paths.migration,'utf8')),record);
  }
});

test('legacy bundles and disabled desktops retain dedicated saved sessions without copying them into the execution private folder', async t => {
  const { source, destination } = fixture(t), disabled = { ...computer, desktop: 'none' as const };
  const legacy = checksum({ files: [file('private/report.md', 'legacy report'), file('private/.config/chromium/Default/Cookies', 'legacy-cookie-fixture')], checksum: '' });
  await importAgentTransfer(destination, 'atlas', legacy, disabled);
  const paths = desktopResourcePaths('atlas', destination, computer); assert.equal(readFileSync(join(paths.browser, 'Default/Cookies'), 'utf8'), 'legacy-cookie-fixture'); assert.equal(existsSync(join(destination, 'agents/atlas/private/.config/chromium')), false);
  const exported = await exportAgentTransfer(destination, 'atlas', disabled); assert.equal(exported.browser?.files[0].path, 'Default/Cookies');
  const empty = checksum({ files: [file('private/file.md', 'ordinary')], checksum: '' }); assert.deepEqual(await importAgentTransfer(source, 'atlas', empty, disabled), { checksum: empty.checksum, files: 1 });
});

test('invalid browser paths and checksums reject before changing managed or existing browser files', async t => {
  const { source, destination } = fixture(t), sourcePaths = desktopResourcePaths('atlas', source, computer), destinationPaths = desktopResourcePaths('atlas', destination, computer);
  write(join(source, 'agents/atlas/private/report.md'), 'new report'); write(join(sourcePaths.browser, 'Default/Cookies'), 'source-cookie-fixture'); write(join(destination, 'agents/atlas/private/report.md'), 'original report'); write(join(destinationPaths.browser, 'Default/Cookies'), 'destination-cookie-fixture');
  const original = await exportAgentTransfer(source, 'atlas', computer);
  const changes: Array<(value: TransferBundle) => void> = [value => { value.browser!.files[0].data = Buffer.from('tampered').toString('base64'); }, value => { value.checksum = 'invalid'; }, value => { value.browser!.files[0].path = '../../outside'; checksum(value); }, value => { value.browser!.files.push(value.browser!.files[0]); checksum(value); }, value => { value.browser!.files[0].path = 'Default/Cache/cookie'; checksum(value); }];
  for (const change of changes) { const bundle = structuredClone(original); change(bundle); await assert.rejects(importAgentTransfer(destination, 'atlas', bundle, computer)); assert.equal(readFileSync(join(destination, 'agents/atlas/private/report.md'), 'utf8'), 'original report'); assert.equal(readFileSync(join(destinationPaths.browser, 'Default/Cookies'), 'utf8'), 'destination-cookie-fixture'); }
});

test('team browser cookies and linked browser files never enter individual transfers', { skip: process.platform === 'win32' }, async t => {
  const { root, source, destination } = fixture(t), shared = { ...computer, browserSessionTeamId: 'team' }, sharedPaths = desktopResourcePaths('atlas', source, shared);
  write(join(sharedPaths.browser, 'Default/Cookies'), 'team-cookie-fixture'); await assert.rejects(exportAgentTransfer(source, 'atlas', shared), /Team browser accounts/);
  const empty = checksum({ files: [], checksum: '' }); await assert.rejects(importAgentTransfer(destination, 'atlas', empty, shared), /Team browser accounts/);
  const paths = desktopResourcePaths('atlas', source, computer); mkdirSync(paths.browser, { recursive: true }); write(join(root, 'outside'), 'outside-secret-fixture'); symlinkSync(join(root, 'outside'), join(paths.browser, 'Cookies'));
  await assert.rejects(exportAgentTransfer(source, 'atlas', computer), /symbolic links/); assert.equal(readFileSync(join(root, 'outside'), 'utf8'), 'outside-secret-fixture');
});

test('a computer whose shutdown cannot be confirmed cannot import or export browser data', { skip: process.platform === 'win32' }, async t => {
  const { root, source, destination } = fixture(t), previousPath = process.env.PATH;
  writeFileSync(join(root, 'docker'), `#!${process.execPath}\nconsole.error('daemon unavailable');process.exit(1);\n`, { mode: 0o700 }); process.env.PATH = `${root}:${previousPath || ''}`; process.env.OPEN_HARNESS_MOCK = '0'; t.after(() => { if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath; });
  write(join(destination, 'agents/atlas/private/report.md'), 'original'); const bundle = checksum({ files: [file('private/report.md', 'replacement')], checksum: '' });
  await assert.rejects(exportAgentTransfer(source, 'atlas', computer), /daemon unavailable/); await assert.rejects(importAgentTransfer(destination, 'atlas', bundle, computer), /daemon unavailable/);
  assert.equal(readFileSync(join(destination, 'agents/atlas/private/report.md'), 'utf8'), 'original'); assert.equal(readdirSync(join(destination, 'agents/atlas/private')).length, 1);
});

test('interrupted browser replacement preserves the old profile and a fail-closed recovery record', async t => {
  const { root, source, destination } = fixture(t), paths = desktopResourcePaths('atlas', destination, computer), sourcePaths = desktopResourcePaths('atlas', source, computer);
  write(join(sourcePaths.browser, 'Default/Cookies'), 'new-cookie-fixture'); write(join(paths.browser, 'Default/Cookies'), 'old-cookie-fixture');
  const bundle = await exportAgentTransfer(source, 'atlas', computer), input = join(root, 'transfer.json'); writeFileSync(input, JSON.stringify(bundle));
  const script = `import fs from 'node:fs'; import {syncBuiltinESMExports} from 'node:module';
const original=fs.renameSync; fs.renameSync=(from,to)=>{original(from,to);if(from===process.argv[4])process.exit(42);}; syncBuiltinESMExports();
const {importAgentTransfer}=await import(process.argv[1]); await importAgentTransfer(process.argv[2],'atlas',JSON.parse(fs.readFileSync(process.argv[3],'utf8')),JSON.parse(process.argv[5]));`;
  const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', script, new URL('../runtime/transfer-files.ts', import.meta.url).href, destination, input, paths.browser, JSON.stringify(computer)], { env: { ...process.env, OPEN_HARNESS_MOCK: '1' }, timeout: 10000 });
  assert.equal(child.status, 42, String(child.stderr)); const recovery = JSON.parse(readFileSync(paths.migration, 'utf8'));
  assert.equal(recovery.version, 0); assert.equal(recovery.resourceKey, paths.key); assert.equal(existsSync(paths.browser), false);
  assert.equal(readFileSync(join(destination, recovery.backup, 'Default/Cookies'), 'utf8'), 'old-cookie-fixture');
  assert.equal(readFileSync(join(destination, recovery.staged, 'Default/Cookies'), 'utf8'), 'new-cookie-fixture');
  assert.equal(readFileSync(join(sourcePaths.browser, 'Default/Cookies'), 'utf8'), 'new-cookie-fixture');
});
