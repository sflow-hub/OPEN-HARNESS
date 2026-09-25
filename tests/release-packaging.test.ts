import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { APP_VERSION } from '../lib/version';

test('creates a signed cross-platform desktop update manifest', () => {
  const directory = mkdtempSync(join(tmpdir(), 'open-harness-release-'));
  const artifacts = [
    'open-harness-linux-x64-app.AppImage.tar.gz',
    'open-harness-macos-x64-app.app.tar.gz',
    'open-harness-macos-arm64-app.app.tar.gz',
    'open-harness-windows-x64-app.nsis.zip',
  ];
  for (const artifact of artifacts) { writeFileSync(join(directory, artifact), 'artifact'); writeFileSync(join(directory, `${artifact}.sig`), `signature-${artifact}`); }
  const result = spawnSync(process.execPath, ['desktop/create-update-manifest.mjs', directory, `v${APP_VERSION}`, 'example/open-harness'], { cwd: join(import.meta.dirname, '..'), encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const manifest = JSON.parse(readFileSync(join(directory, 'latest.json'), 'utf8'));
  assert.equal(manifest.version, APP_VERSION);
  assert.deepEqual(Object.keys(manifest.platforms).sort(), ['darwin-aarch64', 'darwin-x86_64', 'linux-x86_64', 'windows-x86_64']);
  assert.match(manifest.platforms['windows-x86_64'].url, new RegExp(`releases/download/v${APP_VERSION.replaceAll('.', '\\.')}`));
  assert.match(manifest.platforms['darwin-aarch64'].signature, /macos-arm64/);
});

test('release version is synchronized across application manifests', () => {
  const root = join(import.meta.dirname, '..');
  const packageManifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const packageLock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'));
  const tauri = JSON.parse(readFileSync(join(root, 'src-tauri', 'tauri.conf.json'), 'utf8'));
  const cargo = readFileSync(join(root, 'src-tauri', 'Cargo.toml'), 'utf8');
  assert.equal(packageManifest.version, APP_VERSION);
  assert.equal(packageLock.version, APP_VERSION);
  assert.equal(packageLock.packages[''].version, APP_VERSION);
  assert.equal(tauri.version, APP_VERSION);
  assert.match(cargo, new RegExp(`^version = "${APP_VERSION.replaceAll('.', '\\.')}"$`, 'm'));
});

test('self-hosted publication stays gated by verification and image scanning', () => {
  const root = join(import.meta.dirname, '..');
  const release = readFileSync(join(root, '.github', 'workflows', 'release.yml'), 'utf8');
  const desktop = readFileSync(join(root, '.github', 'workflows', 'desktop-release.yml'), 'utf8');
  assert.match(release, /tags: \['v\*-beta\.\*'\]/);
  assert.match(release, /Require the tag to point at main/);
  assert.match(release, /Require the tag to match the application version/);
  for (const command of ['npm test', 'npm run typecheck', 'npm run lint', 'npm run build', 'npm run test:browser', 'docker compose config --quiet', 'docker compose up -d --build']) {
    assert.match(release, new RegExp(command.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.match(release, /aquasecurity\/trivy-action@v0\.36\.0/g);
  assert.match(release, /publish:\s+needs: \[verify, hermes-image\]/);
  assert.match(release, /npm run release:package/);
  assert.match(desktop, /workflow_dispatch:/);
  assert.doesNotMatch(desktop, /push:\s+tags:/);
});

test('desktop launches the live runtime and no user script launches mock chat', () => {
  const root = join(import.meta.dirname, '..');
  const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  assert.equal(manifest.scripts['dev:fast'], undefined);
  const tauri = JSON.parse(readFileSync(join(root, 'src-tauri', 'tauri.conf.json'), 'utf8'));
  assert.deepEqual(tauri.plugins.updater, { pubkey: '', endpoints: [] });
  const desktop = readFileSync(join(root, 'src-tauri', 'src', 'main.rs'), 'utf8');
  assert.match(desktop, /service_env\.insert\("OPEN_HARNESS_MOCK"\.into\(\), "0"\.into\(\)\)/);
});
