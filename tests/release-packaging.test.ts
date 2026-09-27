import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { APP_VERSION } from '../lib/version';
import { browserCompose, candidateManifestReference, captureScanInput, imageEntry, PLATFORMS, validateCandidateImage, validateImageLock, validatePublishedConfig } from '../scripts/release-images.mjs';
import { packageBrowser, releaseSourcePaths } from '../scripts/package-self-hosted.mjs';

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
  assert.match(release, /defaults:\s+run:\s+shell: bash/, 'Smoke failures must survive tee through GitHub bash pipefail.');
  assert.match(release, /Require the tag to point at main/);
  assert.match(release, /Require the tag to match the application version/);
  for (const command of ['npm test', 'npm run typecheck', 'npm run lint', 'npm run build', 'npm run test:browser', 'docker compose config --quiet']) {
    assert.match(release, new RegExp(command.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.match(release, /aquasecurity\/trivy-action@v0\.36\.0/g);
  assert.match(release, /publish:\s+needs: \[verify, images, package, browser-acceptance\]/);
  for (const required of ['ubuntu-24.04-arm', 'architecture: amd64', 'architecture: arm64', 'tests/real-hermes-smoke.mjs', 'tests/real-sandbox-smoke.mjs', 'tests/real-desktop-smoke.mjs', 'tests/compose-smoke.mjs', 'publish-architecture', 'publish-manifests', 'OPEN_HARNESS_COMPOSE_PACKAGE_DIR', "OPEN_HARNESS_COMPOSE_PULL_RUNTIME: '1'", 'anonymous-docker', 'capture-scan-inputs', 'steps.build-coordinator.outputs.metadata', 'steps.build-hermes.outputs.metadata', 'promote-release', 'sudo apt-get install -y zip unzip', "OPEN_HARNESS_REQUIRE_RELEASE_TOOLS: '1'", 'diff -r extracted-tar extracted-zip', 'Exercise the downloaded launcher against real Docker', 'export COMPOSE_PROJECT_NAME=', 'start.sh\" --no-open', 'start.sh\" --stop', 'timeout --foreground 360', 'launcher-proof.txt', 'restart_preserves_data=passed', 'down --volumes --remove-orphans --timeout 30']) assert.ok(release.includes(required), required);
  assert.equal((release.match(/scanners: vuln,secret/g) || []).length, 2);
  assert.doesNotMatch(release, /ignore-unfixed: true|exit-code: '0'/);
  assert.ok(release.indexOf('Publish only the scanned') > release.indexOf('Exercise the exact scanned'));
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

const digest = (character: string) => `sha256:${character.repeat(64)}`;
const releaseLock = () => ({ schemaVersion: 1, version: APP_VERSION, revision: 'a'.repeat(40), platforms: [...PLATFORMS], images: Object.fromEntries(['coordinator', 'hermes', 'engine'].map((name, index) => [name, { ref: `${name === 'engine' ? 'docker.io/library/docker' : `ghcr.io/sflow-hub/open-harness-${name}`}@${digest(String(index + 1))}`, platforms: { 'linux/amd64': digest('4'), 'linux/arm64': digest('5') } }])) });
const releaseCompose = () => ({
  name: 'builder-project',
  services: {
    docker: { image: 'docker:28-dind', volumes: [{ type: 'bind', source: './runtime/dind-entrypoint.sh', target: '/usr/local/bin/open-harness-dind.sh', read_only: true }], networks: { runtime: null } },
    'open-harness': { image: 'coordinator:local', build: { context: '.' }, environment: { OPEN_HARNESS_REQUIRE_BROWSER_PAIRING: '1', OPEN_HARNESS_ALLOW_REMOTE_DASHBOARD: '${OPEN_HARNESS_ALLOW_REMOTE_DASHBOARD:-0}' }, ports: ['${OPEN_HARNESS_LISTEN_ADDRESS:-127.0.0.1}:3000:3000'], networks: { default: null } },
  },
  volumes: { 'harness-data': { name: 'builder-project_harness-data' } },
  networks: { default: { name: 'builder-project_default' }, runtime: { name: 'builder-project_runtime' } },
});

test('browser image locks require immutable matching revisions and both native architectures', () => {
  const lock = releaseLock();
  assert.equal(validateImageLock(lock, APP_VERSION, lock.revision), lock);
  assert.throws(() => validateImageLock(lock, '0.0.0-beta.1', lock.revision), /version differs/);
  assert.throws(() => validateImageLock(lock, APP_VERSION, 'b'.repeat(40)), /revision differs/);
  const floating = releaseLock(); floating.images.hermes.ref = 'ghcr.io/sflow-hub/open-harness-hermes:latest';
  assert.throws(() => validateImageLock(floating, APP_VERSION, floating.revision), /pinned by digest/);
  const incomplete = releaseLock(); delete (incomplete.images.coordinator.platforms as Record<string, string>)['linux/arm64'];
  assert.throws(() => validateImageLock(incomplete, APP_VERSION, incomplete.revision));
  const manifest = { digest: digest('1'), manifests: [{ digest: digest('2'), platform: { os: 'linux', architecture: 'amd64' } }] };
  assert.throws(() => imageEntry('ghcr.io/sflow-hub/open-harness-hermes', manifest), /linux\/arm64/);
  manifest.manifests.push({ digest: digest('3'), platform: { os: 'linux', architecture: 'arm64' } });
  assert.deepEqual(imageEntry('ghcr.io/sflow-hub/open-harness-hermes', manifest), { ref: `ghcr.io/sflow-hub/open-harness-hermes@${digest('1')}`, platforms: { 'linux/amd64': digest('2'), 'linux/arm64': digest('3') } });
});

test('browser Compose pins all images, preserves pairing and isolates projects without source builds', () => {
  const source = releaseCompose(), lock = releaseLock();
  const config = browserCompose(source, lock);
  assert.equal(config.services['open-harness'].build, undefined);
  assert.ok(source.services['open-harness'].build, 'The source Compose remains buildable.');
  assert.equal(config.services['open-harness'].image, lock.images.coordinator.ref);
  assert.equal(config.services.docker.image, lock.images.engine.ref);
  assert.equal(config.services['open-harness'].environment.OPEN_HARNESS_HERMES_IMAGE, lock.images.hermes.ref);
  assert.equal(config.services['open-harness'].environment.OPEN_HARNESS_HERMES_PULL, '1');
  assert.equal(config.services['open-harness'].environment.OPEN_HARNESS_REQUIRE_BROWSER_PAIRING, '1');
  assert.deepEqual(config.services['open-harness'].ports, source.services['open-harness'].ports);
  assert.equal(config.name, undefined); assert.equal(config.volumes['harness-data'].name, undefined); assert.equal(config.networks.runtime.name, undefined);
  const unpaired = releaseCompose(); unpaired.services['open-harness'].environment.OPEN_HARNESS_REQUIRE_BROWSER_PAIRING = '0';
  assert.throws(() => browserCompose(unpaired, lock), /require local browser pairing/);
  const bind = releaseCompose(); bind.services.docker.volumes[0].source = '/Users/operator';
  assert.throws(() => browserCompose(bind, lock), /Unexpected host bind/);
});

test('source packaging excludes collaboration files and refuses tracked credentials or generated state', () => {
  const required = ['package-lock.json', 'compose.yaml', 'Dockerfile.coordinator', '.env.example', 'docs/SELF_HOSTING.md', 'runtime/hermes/Dockerfile'];
  assert.deepEqual(releaseSourcePaths([...required, 'COORDINATION.md', 'private.bundle', 'work/review/report.md']), required);
  for (const privateFile of ['.env', '.env.local', '.open-harness/secrets.json', 'node_modules/pkg/index.js', 'test-results/trace.zip']) assert.throws(() => releaseSourcePaths([...required, privateFile]), /forbidden local state/);
  assert.throws(() => releaseSourcePaths(['package-lock.json']), /missing compose.yaml/);
});

test('browser ZIP and tar contain only relocatable launch assets and pinned images', t => {
  const missing = ['zip', 'unzip'].filter(binary => (spawnSync(binary, ['-v'], { encoding: 'utf8' }).error as NodeJS.ErrnoException | undefined)?.code === 'ENOENT');
  if (missing.length && process.env.OPEN_HARNESS_REQUIRE_RELEASE_TOOLS !== '1') { t.skip(`Release-only archive roundtrip needs ${missing.join(', ')}; image locks, Compose and source-archive checks still run.`); return; }
  assert.deepEqual(missing, [], 'Release verification requires zip and unzip.');
  const root = mkdtempSync(join(tmpdir(), 'open-harness-browser-release-test-'));
  try {
    const sourceRoot = join(root, 'source'), destination = join(root, 'artifacts');
    for (const file of ['runtime/dind-entrypoint.sh', 'compose.host-folders.example.yaml', 'docs/LOCAL_BROWSER.md', 'LICENSE', 'Start Open Harness.command', 'Start Open Harness.cmd', 'launchers/start.sh', 'launchers/start.ps1']) {
      mkdirSync(join(sourceRoot, file, '..'), { recursive: true }); writeFileSync(join(sourceRoot, file), `fixture for ${file}\n`);
    }
    mkdirSync(join(sourceRoot, 'runtime/hermes')); writeFileSync(join(sourceRoot, 'runtime/hermes/private.txt'), 'not a browser asset');
    const names = packageBrowser({ sourceRoot, destination, version: APP_VERSION, lock: releaseLock(), compose: releaseCompose() });
    assert.equal(names.length, 2); for (const name of names) assert.ok(existsSync(join(destination, name)));
    const listing = spawnSync('tar', ['-tzf', join(destination, names[0])], { encoding: 'utf8' }); assert.equal(listing.status, 0, listing.stderr);
    assert.match(listing.stdout, /image-lock.json/); assert.match(listing.stdout, /Start Open Harness.command/); assert.doesNotMatch(listing.stdout, /private.txt|Dockerfile|package.json/);
    const zip = spawnSync('unzip', ['-t', join(destination, names[1])], { encoding: 'utf8' }); assert.equal(zip.status, 0, zip.stderr || zip.stdout);
    const extract = join(root, 'extracted'); mkdirSync(extract);
    const result = spawnSync('tar', ['-xzf', join(destination, names[0]), '-C', extract], { encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr);
    const packageRoot = join(extract, `open-harness-browser-${APP_VERSION}`);
    if (process.platform !== 'win32') {
      assert.ok(statSync(join(packageRoot, 'Start Open Harness.command')).mode & 0o111);
      assert.ok(statSync(join(packageRoot, 'launchers/start.sh')).mode & 0o111);
    }
    assert.equal(JSON.parse(readFileSync(join(packageRoot, 'compose.yaml'), 'utf8')).services['open-harness'].build, undefined);
  } finally { rmSync(root, { recursive: true, force: true }); }
});


test('source archive is bound to committed HEAD and never captures a dirty local environment', () => {
  const directory = mkdtempSync(join(tmpdir(), 'open-harness-source-release-test-'));
  try {
    const command = (args: string[]) => { const result = spawnSync('git', args, { cwd: directory, encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr); return result; };
    for (const path of ['compose.yaml', 'Dockerfile.coordinator', '.env.example', 'docs/SELF_HOSTING.md', 'runtime/hermes/Dockerfile', 'package-lock.json']) {
      mkdirSync(join(directory, path, '..'), { recursive: true }); writeFileSync(join(directory, path), 'release fixture\n');
    }
    mkdirSync(join(directory, 'scripts'));
    for (const file of ['package-self-hosted.mjs', 'release-images.mjs']) cpSync(join(import.meta.dirname, '../scripts', file), join(directory, 'scripts', file));
    writeFileSync(join(directory, 'package.json'), JSON.stringify({ version: APP_VERSION, type: 'module' }));
    writeFileSync(join(directory, 'COORDINATION.md'), 'Private collaboration history.');
    command(['init', '--quiet']); command(['add', '.']); command(['-c', 'user.name=Release fixture', '-c', 'user.email=release-fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'Release fixture']);
    writeFileSync(join(directory, 'package.json'), JSON.stringify({ version: '99.0.0-beta.1', type: 'module' }));
    writeFileSync(join(directory, '.env'), 'PRIVATE_FIXTURE_VALUE=must-not-ship');
    const destination = join(directory, 'artifacts');
    const result = spawnSync(process.execPath, ['scripts/package-self-hosted.mjs', destination], { cwd: directory, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const archive = join(destination, `open-harness-self-hosted-${APP_VERSION}.tar.gz`);
    assert.ok(existsSync(archive));
    const listing = spawnSync('tar', ['-tzf', archive], { encoding: 'utf8' }); assert.equal(listing.status, 0, listing.stderr);
    assert.doesNotMatch(listing.stdout, /COORDINATION.md|\/.env\n|99.0.0-beta/);
    command(['add', '.env']); command(['-c', 'user.name=Release fixture', '-c', 'user.email=release-fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'Forbidden fixture']);
    const refused = spawnSync(process.execPath, ['scripts/package-self-hosted.mjs', destination], { cwd: directory, encoding: 'utf8' });
    assert.notEqual(refused.status, 0); assert.match(refused.stderr, /forbidden local state: .env/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});


test('publication rejects changed, wrong-platform or wrong-revision scan inputs', () => {
  const revision = 'a'.repeat(40), id = digest('1');
  const image = { Id: id, Os: 'linux', Architecture: 'arm64', Config: { Labels: { 'org.opencontainers.image.revision': revision } } };
  assert.equal(validateCandidateImage(image, 'arm64', revision, id), id);
  assert.throws(() => validateCandidateImage({ ...image, Id: digest('2') }, 'arm64', revision, id), /changed after the scan/);
  assert.throws(() => validateCandidateImage(image, 'amd64', revision, id));
  assert.throws(() => validateCandidateImage(image, 'arm64', 'b'.repeat(40), id));
});


test('release scan binding distinguishes containerd index IDs from BuildKit configuration digests', () => {
  const revision = 'a'.repeat(40), configDigest = digest('1'), buildDigest = digest('2'), manifestDigest = digest('3');
  const image = { Id: buildDigest, Os: 'linux', Architecture: 'arm64', Config: { Labels: { 'org.opencontainers.image.revision': revision } }, Descriptor: { digest: buildDigest, mediaType: 'application/vnd.oci.image.index.v1+json' } };
  const metadata = { 'containerimage.config.digest': configDigest, 'containerimage.digest': buildDigest };
  assert.deepEqual(captureScanInput(image, 'arm64', revision, metadata), { localId: buildDigest, configDigest, buildDigest });
  assert.deepEqual(captureScanInput({ ...image, Id: configDigest }, 'arm64', revision, metadata), { localId: configDigest, configDigest, buildDigest });
  assert.throws(() => captureScanInput(image, 'arm64', revision, {}), /exact configuration digest/);
  assert.throws(() => captureScanInput({ ...image, Id: digest('4') }, 'arm64', revision, metadata), /does not match the BuildKit output/);
  const repository = 'ghcr.io/sflow-hub/open-harness-hermes';
  const index = { digest: buildDigest, manifests: [{ digest: manifestDigest, platform: { os: 'linux', architecture: 'arm64' } }, { digest: digest('5'), platform: { os: 'unknown', architecture: 'unknown' } }] };
  assert.equal(candidateManifestReference(repository, index, 'arm64'), `${repository}@${manifestDigest}`);
  assert.throws(() => candidateManifestReference(repository, index, 'amd64'), /exactly one linux\/amd64/);
  assert.equal(candidateManifestReference(repository, { digest: manifestDigest }, 'arm64'), `${repository}@${manifestDigest}`);
  validatePublishedConfig({ config: { digest: configDigest } }, configDigest);
  assert.throws(() => validatePublishedConfig({ config: { digest: configDigest } }, buildDigest), /scanned BuildKit configuration/);
  assert.throws(() => validatePublishedConfig(index, configDigest), /scanned BuildKit configuration/);
});
