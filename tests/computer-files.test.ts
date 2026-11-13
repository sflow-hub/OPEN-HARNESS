import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_COMPUTER } from '../lib/agent-profile';
import { claimDesktopExchange, DESKTOP_FILE_LIMITS, publishDesktopDownloads, stageDesktopUpload, validateDesktopUploadName } from '../runtime/computer-files';
import { desktopResourcePaths } from '../runtime/computer-runtime';

const computer = { ...DEFAULT_COMPUTER, desktop: 'virtual' as const, browserSessionTeamId: 'ops' }, lease = { ownerId: 'atlas', epoch: 1, runId: 'run-1' };
function fixture(t: TestContext) {
  const root = mkdtempSync(join(tmpdir(), 'harness-exchange-')), paths = desktopResourcePaths('atlas', root, computer);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, paths, downloads: join(paths.staging, 'downloads'), uploads: join(paths.staging, 'uploads'), file: (name: string) => join(paths.staging, 'downloads', name), private: (agent: string) => join(root, `agents/${agent}/private`) };
}

test('completed downloads go only to the initiating private folder with retry-safe receipts', async t => {
  const f = fixture(t); let stops = 0;
  assert.deepEqual(await claimDesktopExchange('atlas', f.root, computer, lease, async () => { stops++; }), { reset: false });
  writeFileSync(f.file('invoice.pdf'), 'invoice');
  const [receipt] = publishDesktopDownloads('atlas', f.root, computer, lease);
  assert.equal(stops, 0); assert.equal(receipt.ownerId, 'atlas'); assert.equal(receipt.epoch, 1); assert.equal(receipt.runId, 'run-1');
  assert.equal(readFileSync(join(f.private('atlas'), receipt.path), 'utf8'), 'invoice');
  assert.equal(existsSync(join(f.root, 'shared')), false); assert.equal(existsSync(f.private('scout')), false);
  assert.deepEqual(publishDesktopDownloads('atlas', f.root, computer, lease), []);
  assert.equal(readdirSync(join(f.private('atlas'), 'downloads')).length, 1);
  assert.equal(JSON.parse(readFileSync(join(f.paths.base, 'receipts', receipt.id + '.json'), 'utf8')).sha256, receipt.sha256);
});

test('same-agent handoff preserves partial download origin and never resets the browser', async t => {
  const f = fixture(t); await claimDesktopExchange('atlas', f.root, computer, lease, async () => assert.fail('unexpected stop'));
  writeFileSync(f.file('Unconfirmed 1.crdownload'), 'partial');
  assert.deepEqual(publishDesktopDownloads('atlas', f.root, computer, lease), []);
  const next = { ownerId: 'atlas', epoch: 2 };
  assert.deepEqual(await claimDesktopExchange('atlas', f.root, computer, next, async () => assert.fail('same-agent browser reset')), { reset: false });
  renameSync(f.file('Unconfirmed 1.crdownload'), f.file('finished.pdf'));
  const [receipt] = publishDesktopDownloads('atlas', f.root, computer, next);
  assert.equal(receipt.epoch, 1); assert.equal(receipt.runId, 'run-1');
  assert.throws(() => publishDesktopDownloads('atlas', f.root, computer, lease), /ownership changed/);
  await assert.rejects(claimDesktopExchange('atlas', f.root, computer, lease, async () => {}), /stale/);
});

test('cross-agent claim stops the browser before draining complete files and clearing owned staging', async t => {
  const f = fixture(t); await claimDesktopExchange('atlas', f.root, computer, lease, async () => {});
  writeFileSync(f.file('old.crdownload'), 'partial'); writeFileSync(join(f.uploads, 'old-upload.txt'), 'upload');
  mkdirSync(f.paths.browser, { recursive: true }); writeFileSync(join(f.paths.browser, 'Cookies'), 'cookies');
  const next = { ownerId: 'scout', epoch: 2, runId: 'run-2' };
  const changed = await claimDesktopExchange('scout', f.root, computer, next, async () => {
    assert.equal(existsSync(f.file('old.crdownload')), true);
    assert.throws(() => publishDesktopDownloads('atlas', f.root, computer, lease), /ownership changed/);
    writeFileSync(f.file('last-finished.txt'), 'late but old owner');
  });
  assert.deepEqual(changed, { reset: true }); assert.deepEqual(readdirSync(f.downloads), []); assert.deepEqual(readdirSync(f.uploads), []);
  assert.equal(readFileSync(join(f.paths.browser, 'Cookies'), 'utf8'), 'cookies');
  assert.equal(readdirSync(join(f.private('atlas'), 'downloads')).length, 1);
  assert.equal(existsSync(f.private('scout')), false);
  writeFileSync(f.file('new.txt'), 'new owner');
  const [receipt] = publishDesktopDownloads('scout', f.root, computer, next); assert.equal(receipt.ownerId, 'scout');
  assert.equal(readFileSync(join(f.private('scout'), receipt.path), 'utf8'), 'new owner');
});

test('unconfirmed browser stop and concurrent ownership claims fail without clearing staging', async t => {
  const f = fixture(t); await claimDesktopExchange('atlas', f.root, computer, lease, async () => {}); writeFileSync(f.file('kept.crdownload'), 'kept');
  const next = { ownerId: 'scout', epoch: 2 };
  await assert.rejects(claimDesktopExchange('scout', f.root, computer, next, async () => { throw new Error('stop failed'); }), /stop failed/);
  assert.equal(readFileSync(f.file('kept.crdownload'), 'utf8'), 'kept');
  let finish!: () => void; const wait = new Promise<void>(resolve => { finish = resolve; });
  const pending = claimDesktopExchange('scout', f.root, computer, next, () => wait);
  await assert.rejects(claimDesktopExchange('atlas', f.root, computer, { ...lease, epoch: 3 }, async () => {}), /ownership is changing/);
  finish(); await pending;
});

test('unsafe names, partial files, oversized files and hard links are withheld', async t => {
  const f = fixture(t); await claimDesktopExchange('atlas', f.root, computer, lease, async () => {});
  for (const name of ['CON.txt', 'trailing.', '.hidden', 'pending.tmp', 'bad:name.txt']) assert.throws(() => validateDesktopUploadName(name), /ordinary file name/);
  for (const name of process.platform === 'win32' ? ['.hidden', 'pending.tmp'] : ['CON.txt', 'trailing.', '.hidden', 'pending.tmp', 'bad:name.txt']) writeFileSync(f.file(name), 'unsafe');
  writeFileSync(f.file('huge.bin'), ''); truncateSync(f.file('huge.bin'), DESKTOP_FILE_LIMITS.fileBytes + 1);
  const secret = join(f.root, 'never-copy.txt'); writeFileSync(secret, 'secret'); linkSync(secret, f.file('hardlink.txt'));
  if (process.platform !== 'win32') symlinkSync(secret, f.file('link.txt'));
  assert.deepEqual(publishDesktopDownloads('atlas', f.root, computer, lease), []);
  assert.equal(existsSync(f.private('atlas')), false); assert.equal(readFileSync(secret, 'utf8'), 'secret');
  await claimDesktopExchange('scout', f.root, computer, { ownerId: 'scout', epoch: 2 }, async () => {});
  assert.equal(readFileSync(secret, 'utf8'), 'secret'); assert.deepEqual(readdirSync(f.downloads), []);
});

test('upload requires an explicit ordinary filename inside this agent private exchange', async t => {
  const f = fixture(t); await claimDesktopExchange('atlas', f.root, computer, lease, async () => {});
  const directory = join(f.private('atlas'), 'exchange'); mkdirSync(directory, { recursive: true }); writeFileSync(join(directory, 'proposal.txt'), 'proposal');
  const upload = stageDesktopUpload('atlas', f.root, computer, lease, 'proposal.txt');
  assert.match(upload.path, /^\/workspace\/exchange\/uploads\/[a-f0-9]+-proposal.txt$/);
  assert.equal(readFileSync(join(f.uploads, upload.path.split('/').at(-1)!), 'utf8'), 'proposal');
  assert.deepEqual(stageDesktopUpload('atlas', f.root, computer, lease, 'proposal.txt'), upload);
  assert.deepEqual(publishDesktopDownloads('atlas', f.root, computer, lease), []);
  for (const name of ['../proposal.txt', '/etc/passwd', 'other/file', 'other\\file', 'CON', '.env']) assert.throws(() => stageDesktopUpload('atlas', f.root, computer, lease, name), /ordinary file name/);
  assert.throws(() => stageDesktopUpload('scout', f.root, computer, lease, 'proposal.txt'), /ownership is invalid/);
  if (process.platform !== 'win32') { symlinkSync(join(directory, 'proposal.txt'), join(directory, 'link.txt')); assert.throws(() => stageDesktopUpload('atlas', f.root, computer, lease, 'link.txt'), /symbolic links/); }
});

test('count limit, nested directories and planted destination links fail closed', async t => {
  const f = fixture(t); await claimDesktopExchange('atlas', f.root, computer, lease, async () => {});
  for (let n = 0; n <= DESKTOP_FILE_LIMITS.entries; n++) writeFileSync(f.file(`file-${n}.tmp`), '');
  assert.throws(() => publishDesktopDownloads('atlas', f.root, computer, lease), /too many files/);
  for (const name of readdirSync(f.downloads)) rmSync(f.file(name));
  mkdirSync(f.file('nested')); writeFileSync(join(f.file('nested'), 'kept.txt'), 'kept');
  await assert.rejects(claimDesktopExchange('scout', f.root, computer, { ownerId: 'scout', epoch: 2 }, async () => {}), /unsupported directories/);
  assert.equal(readFileSync(join(f.file('nested'), 'kept.txt'), 'utf8'), 'kept');
  rmSync(f.file('nested'), { recursive: true });
  if (process.platform !== 'win32') {
    const outside = join(f.root, 'outside'); mkdirSync(outside); mkdirSync(f.private('atlas'), { recursive: true }); symlinkSync(outside, join(f.private('atlas'), 'downloads'));
    writeFileSync(f.file('ordinary.txt'), 'ordinary');
    assert.throws(() => publishDesktopDownloads('atlas', f.root, computer, lease), /symbolic links/);
    assert.deepEqual(readdirSync(outside), []); assert.equal(readFileSync(f.file('ordinary.txt'), 'utf8'), 'ordinary');
  }
});
