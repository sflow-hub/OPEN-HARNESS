import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { APP_VERSION } from '../lib/version';
import { browserCompose, candidateManifestReference, captureScanInput, ENGINE_BINARIES, ENGINE_MANIFESTS, engineContext, engineLabels, imageEntry, inspectEngineInputs, PLATFORMS, RELEASE_IMAGES, validateCandidateImage, validateCoordinatorBuildx, validateEngineCandidate, validateEngineInputsLock, validateImageLock, validatePublishedConfig } from '../scripts/release-images.mjs';
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
  for (const required of ['ubuntu-24.04-arm', 'architecture: amd64', 'architecture: arm64', 'tests/real-hermes-smoke.mjs', 'tests/real-sandbox-smoke.mjs', 'tests/real-desktop-smoke.mjs', 'tests/compose-smoke.mjs', 'publish-architecture', 'publish-manifests', 'OPEN_HARNESS_COMPOSE_PACKAGE_DIR', "OPEN_HARNESS_COMPOSE_PULL_RUNTIME: '1'", 'anonymous-docker', 'capture-scan-inputs', 'steps.build-coordinator.outputs.metadata', 'steps.build-engine.outputs.metadata', 'steps.build-hermes.outputs.metadata', 'verify-engine-inputs', 'stage-engine-context', 'file: runtime/engine/Dockerfile', 'network: none', 'OPEN_HARNESS_ENGINE_IMAGE: open-harness-engine:release-candidate', 'promote-release', 'sudo apt-get install -y zip unzip', "OPEN_HARNESS_REQUIRE_RELEASE_TOOLS: '1'", 'diff -r extracted-tar extracted-zip', 'Exercise the downloaded launcher against real Docker', 'export COMPOSE_PROJECT_NAME=', 'start.sh\" --no-open', 'start.sh\" --stop', 'timeout --foreground 360', 'launcher-proof.txt', 'restart_preserves_data=passed', 'down --volumes --remove-orphans --timeout 30']) assert.ok(release.includes(required), required);
  assert.equal((release.match(/scanners: vuln,secret/g) || []).length, 3);
  assert.match(release, /name: Scan the exact private engine architecture[\s\S]*?image-ref: open-harness-engine:release-candidate\n/);
  assert.doesNotMatch(release, /resolve-engine|release-engine|OPEN_HARNESS_ENGINE_SCAN_IMAGE|docker\.io\/library\/docker/, 'Releases must not fall back to the official engine.');
  assert.ok(release.indexOf('verify-engine-inputs') < release.indexOf('\n  images:'), 'Incomplete engine inputs must stop the release before any image job.');
  assert.ok(release.indexOf('Build native engine image') < release.indexOf('Record immutable scan inputs'));
  assert.ok(release.indexOf('Scan the exact private engine architecture') < release.indexOf('Publish only the scanned'));
  assert.doesNotMatch(release, /ignore-unfixed: true|exit-code: '0'/);
  assert.ok(release.indexOf('Publish only the scanned') > release.indexOf('Exercise the exact scanned'));
  assert.match(release, /npm run release:package/);
  assert.match(desktop, /workflow_dispatch:/);
  assert.doesNotMatch(desktop, /push:\s+tags:/);
});

test('coordinator ships a Docker client and checks application health', () => {
  const root = join(import.meta.dirname, '..');
  const dockerfile = readFileSync(join(root, 'Dockerfile.coordinator'), 'utf8');
  const compose = readFileSync(join(root, 'compose.yaml'), 'utf8');
  const runtime = dockerfile.slice(dockerfile.lastIndexOf('FROM node:'));
  assert.match(runtime, /COPY --from=docker-cli \/usr\/local\/bin\/docker \/usr\/local\/bin\/docker/);
  assert.doesNotMatch(runtime, /docker\.io|dockerd|apt-get|COPY .*docker-compose/);
  assert.match(runtime, /^USER node$/m);
  assert.match(compose, /127\.0\.0\.1:3000\/api\/health/);
  assert.doesNotMatch(compose, /healthcheck:\s*\n\s*test: \["CMD", "curl"/);
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
const releaseLock = () => ({ schemaVersion: 1, version: APP_VERSION, revision: 'a'.repeat(40), platforms: [...PLATFORMS], images: Object.fromEntries(['coordinator', 'hermes', 'engine'].map((name, index) => [name, { ref: `ghcr.io/sflow-hub/open-harness-${name}@${digest(String(index + 1))}`, platforms: { 'linux/amd64': digest('4'), 'linux/arm64': digest('5') } }])) });
const releaseCompose = () => ({
  name: 'builder-project',
  services: {
    docker: { image: 'docker:29.8.1-dind', volumes: [{ type: 'bind', source: './runtime/dind-entrypoint.sh', target: '/usr/local/bin/open-harness-dind.sh', read_only: true }], networks: { runtime: null } },
    'open-harness': { image: 'coordinator:local', build: { context: '.' }, environment: { OPEN_HARNESS_REQUIRE_BROWSER_PAIRING: '1', OPEN_HARNESS_ALLOW_REMOTE_DASHBOARD: '${OPEN_HARNESS_ALLOW_REMOTE_DASHBOARD:-0}' }, ports: ['${OPEN_HARNESS_LISTEN_ADDRESS:-127.0.0.1}:3000:3000'], volumes: [{ type: 'volume', source: 'harness-data', target: '/data' }], networks: { default: null } },
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
  assert.equal(config.name, 'open-harness'); assert.equal(source.name, 'builder-project');
  assert.equal(config.volumes['harness-data'].name, undefined); assert.equal(config.networks.runtime.name, undefined);
  const unpaired = releaseCompose(); unpaired.services['open-harness'].environment.OPEN_HARNESS_REQUIRE_BROWSER_PAIRING = '0';
  assert.throws(() => browserCompose(unpaired, lock), /require local browser pairing/);
  const bind = releaseCompose(); bind.services.docker.volumes[0].source = '/Users/operator';
  assert.throws(() => browserCompose(bind, lock), /Unexpected host bind/);
});

test('packaged Compose retains its workspace across release directories and respects explicit projects', t => {
  const available = spawnSync('docker', ['compose', 'version', '--short'], { encoding: 'utf8', timeout: 10_000 });
  if (available.status !== 0 && process.env.OPEN_HARNESS_REQUIRE_RELEASE_TOOLS !== '1') { t.skip('Compose project precedence needs the Docker Compose CLI; the package-name and archive assertions still run.'); return; }
  assert.equal(available.status, 0, available.stderr || available.error?.message || 'Release verification requires Docker Compose.');
  const root = mkdtempSync(join(tmpdir(), 'open-harness-compose-projects-'));
  try {
    const emptyEnv = join(root, 'empty.env'); writeFileSync(emptyEnv, '');
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const name of Object.keys(env)) if (name.startsWith('COMPOSE_') || name.startsWith('OPEN_HARNESS_')) delete env[name];
    for (const directory of ['open-harness-browser-before-update', 'open-harness-browser-after-update']) {
      const folder = join(root, directory); mkdirSync(folder);
      const file = join(folder, 'compose.yaml'); writeFileSync(file, JSON.stringify(browserCompose(releaseCompose(), releaseLock())));
      for (const [override, explicit, expected] of [[undefined, undefined, 'open-harness'], ['operator-workspace', undefined, 'operator-workspace'], ['operator-workspace', 'cli-workspace', 'cli-workspace']]) {
        const result = spawnSync('docker', ['compose', '--env-file', emptyEnv, ...(explicit ? ['--project-name', explicit] : []), '-f', file, 'config', '--format', 'json'], { cwd: folder, env: { ...env, ...(override ? { COMPOSE_PROJECT_NAME: override } : {}) }, encoding: 'utf8', timeout: 15_000 });
        assert.equal(result.status, 0, result.stderr || result.error?.message);
        const config = JSON.parse(result.stdout);
        assert.equal(config.name, expected);
        assert.equal(config.volumes['harness-data'].name, `${expected}_harness-data`);
        assert.equal(config.networks.runtime.name, `${expected}_runtime`);
      }
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('source packaging excludes collaboration files and refuses tracked credentials or generated state', () => {
  const required = ['package-lock.json', 'compose.yaml', 'Dockerfile.coordinator', '.env.example', 'docs/SELF_HOSTING.md', 'runtime/hermes/Dockerfile'];
  assert.deepEqual(releaseSourcePaths([...required, 'COORDINATION.md', 'private.bundle', 'work/review/report.md', 'Claude outputs/audit/evidence.json']), required);
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
    for (const file of ['runtime/dind-entrypoint.sh', 'compose.host-folders.example.yaml', 'docs/LOCAL_BROWSER.md', 'docs/SELF_HOSTING.md', 'LICENSE', 'Start Open Harness.command', 'Start Open Harness.cmd', 'launchers/start.sh', 'launchers/start.ps1']) {
      mkdirSync(join(sourceRoot, file, '..'), { recursive: true }); writeFileSync(join(sourceRoot, file), `fixture for ${file}\n`);
    }
    mkdirSync(join(sourceRoot, 'runtime/hermes')); writeFileSync(join(sourceRoot, 'runtime/hermes/private.txt'), 'not a browser asset');
    const names = packageBrowser({ sourceRoot, destination, version: APP_VERSION, lock: releaseLock(), compose: releaseCompose() });
    assert.equal(names.length, 2); for (const name of names) assert.ok(existsSync(join(destination, name)));
    const listing = spawnSync('tar', ['-tzf', join(destination, names[0])], { encoding: 'utf8' }); assert.equal(listing.status, 0, listing.stderr);
    assert.match(listing.stdout, /docs\/SELF_HOSTING.md/); assert.match(listing.stdout, /image-lock.json/); assert.match(listing.stdout, /Start Open Harness.command/); assert.doesNotMatch(listing.stdout, /private.txt|Dockerfile|package.json/);
    const zip = spawnSync('unzip', ['-t', join(destination, names[1])], { encoding: 'utf8' }); assert.equal(zip.status, 0, zip.stderr || zip.stdout);
    const extract = join(root, 'extracted'); mkdirSync(extract);
    const result = spawnSync('tar', ['-xzf', join(destination, names[0]), '-C', extract], { encoding: 'utf8' }); assert.equal(result.status, 0, result.stderr);
    const packageRoot = join(extract, `open-harness-browser-${APP_VERSION}`);
    if (process.platform !== 'win32') {
      assert.ok(statSync(join(packageRoot, 'Start Open Harness.command')).mode & 0o111);
      assert.ok(statSync(join(packageRoot, 'launchers/start.sh')).mode & 0o111);
    }
    const packaged = JSON.parse(readFileSync(join(packageRoot, 'compose.yaml'), 'utf8'));
    assert.equal(packaged.services['open-harness'].build, undefined);
    assert.equal(packaged.name, 'open-harness');
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
    mkdirSync(join(directory, 'Claude outputs')); writeFileSync(join(directory, 'Claude outputs/audit.txt'), 'Private audit artifacts.');
    command(['init', '--quiet']); command(['add', '.']); command(['-c', 'user.name=Release fixture', '-c', 'user.email=release-fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'Release fixture']);
    writeFileSync(join(directory, 'package.json'), JSON.stringify({ version: '99.0.0-beta.1', type: 'module' }));
    writeFileSync(join(directory, '.env'), 'PRIVATE_FIXTURE_VALUE=must-not-ship');
    const destination = join(directory, 'artifacts');
    const result = spawnSync(process.execPath, ['scripts/package-self-hosted.mjs', destination], { cwd: directory, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const archive = join(destination, `open-harness-self-hosted-${APP_VERSION}.tar.gz`);
    assert.ok(existsSync(archive));
    const listing = spawnSync('tar', ['-tzf', archive], { encoding: 'utf8' }); assert.equal(listing.status, 0, listing.stderr);
    assert.doesNotMatch(listing.stdout, /COORDINATION.md|Claude outputs|\/.env\n|99.0.0-beta/);
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

type EngineComponent = { version: string | null; sourceManifest: string | null };
type EngineLockEntry = { components: Record<string, EngineComponent>; status: string; inputs: string | null; missing?: string[]; files: Record<string, string | null> };
type EngineLock = { schemaVersion: number; base: { ref: string }; expat: { package: string; version: string; file: string }; architectures: Record<string, EngineLockEntry> };
const repositoryRoot = join(import.meta.dirname, '..');
const committedEngineLock = (): EngineLock => JSON.parse(readFileSync(join(repositoryRoot, 'runtime', 'engine', 'inputs.lock.json'), 'utf8'));
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
const completeEngineLock = (): EngineLock => {
  const lock = committedEngineLock();
  for (const [index, platform] of PLATFORMS.entries()) {
    const paths = [lock.expat.file, ...ENGINE_BINARIES, ...Object.keys(ENGINE_MANIFESTS).map(name => `${name}/provenance/LICENSE`), ...Object.values(ENGINE_MANIFESTS)];
    lock.architectures[platform] = { status: 'complete', inputs: `ghcr.io/sflow-hub/open-harness-engine-inputs@${digest(String(index + 6))}`, files: Object.fromEntries(paths.map(path => [path, hash(`${platform} ${path}`)])), components: Object.fromEntries(Object.entries(ENGINE_MANIFESTS).map(([name, path]) => [name, { version: `v1.2.3+fixture.${platform.split('/')[1]}`, sourceManifest: hash(`${platform} ${path}`) }])) };
  }
  return lock;
};
const incompleteEngineLock = (): EngineLock => {
  const lock = completeEngineLock();
  for (const entry of Object.values(lock.architectures)) { entry.status = 'incomplete'; entry.inputs = null; entry.missing = ['Native inputs image has not been reviewed.']; }
  return lock;
};

test('release locks accept only the derived engine from the release namespace', () => {
  const lock = releaseLock();
  assert.deepEqual(Object.keys(lock.images).sort(), RELEASE_IMAGES);
  const official = releaseLock(); official.images.engine.ref = `docker.io/library/docker@${digest('3')}`;
  assert.throws(() => validateImageLock(official, APP_VERSION, official.revision), /engine must be pinned by digest/);
  const foreign = releaseLock(); foreign.images.engine.ref = `ghcr.io/someone-else/open-harness-engine@${digest('3')}`;
  assert.throws(() => validateImageLock(foreign, APP_VERSION, foreign.revision), /one registry namespace/);
  const swapped = releaseLock(); swapped.images.engine.ref = `ghcr.io/sflow-hub/open-harness-hermes@${digest('3')}`;
  assert.throws(() => validateImageLock(swapped, APP_VERSION, swapped.revision), /Wrong repository for engine/);
});

test('engine inputs stay fail-closed until both native architectures are reviewed', () => {
  validateEngineInputsLock(committedEngineLock());
  const lock = incompleteEngineLock();
  assert.equal(validateEngineInputsLock(lock), lock);
  assert.throws(() => validateEngineInputsLock(lock, PLATFORMS), /linux\/amd64 are incomplete/);
  assert.throws(() => validateEngineInputsLock(lock, ['linux/arm64']), /linux\/arm64 are incomplete/);
  assert.equal(validateEngineInputsLock(completeEngineLock(), PLATFORMS).schemaVersion, 2);
  const traversal = completeEngineLock(); traversal.architectures['linux/arm64'].files['runc/provenance/../../etc/passwd'] = 'f'.repeat(64);
  assert.throws(() => validateEngineInputsLock(traversal), /unsafe engine input path/);
  const floating = completeEngineLock(); floating.architectures['linux/amd64'].inputs = 'ghcr.io/sflow-hub/open-harness-engine-inputs:latest';
  assert.throws(() => validateEngineInputsLock(floating, PLATFORMS), /pinned by digest/);
  const unofficial = completeEngineLock(); unofficial.base.ref = `ghcr.io/sflow-hub/docker:29.8.1-dind@${digest('9')}`;
  assert.throws(() => validateEngineInputsLock(unofficial), /official Docker engine index/);
  const extra = completeEngineLock(); extra.architectures['linux/arm64'].components.moby = { version: 'v1.0.0+local', sourceManifest: 'a'.repeat(64) };
  assert.throws(() => validateEngineInputsLock(extra), /reviewed set/);
  const unpinned = completeEngineLock(); unpinned.architectures['linux/arm64'].files['runc/bin/runc'] = null;
  assert.throws(() => validateEngineInputsLock(unpinned, PLATFORMS), /unpinned inputs/);
  const unnamed = incompleteEngineLock(); unnamed.architectures['linux/amd64'].missing = [];
  assert.throws(() => validateEngineInputsLock(unnamed), /name every missing input/);
});

test('engine metadata binds each architecture to its own shipped source manifests', () => {
  const lock = completeEngineLock(), lockSha256 = 'e'.repeat(64);
  const legacy = { ...lock, schemaVersion: 1 };
  assert.throws(() => validateEngineInputsLock(legacy), /Unknown engine inputs lock schema/);
  assert.throws(() => validateEngineInputsLock({ ...lock, components: lock.architectures['linux/arm64'].components }), /per architecture/);
  for (const architecture of ['arm64', 'amd64']) {
    const platform = `linux/${architecture}`, other = architecture === 'arm64' ? 'amd64' : 'arm64';
    const context = engineContext(lock, lockSha256, architecture);
    assert.ok(context.notice.includes(`Reviewed inputs for ${platform}`));
    for (const [name, path] of Object.entries(ENGINE_MANIFESTS)) {
      const component = lock.architectures[platform].components[name];
      assert.equal(context.buildArgs[`${name.toUpperCase()}_SOURCE_MANIFEST`], lock.architectures[platform].files[path]);
      assert.ok(context.notice.includes(component.sourceManifest!));
      assert.ok(context.notice.includes(component.version!));
      assert.ok(!context.notice.includes(lock.architectures[`linux/${other}`].components[name].sourceManifest!));
      const swapped = structuredClone(lock);
      swapped.architectures[platform].components[name] = swapped.architectures[`linux/${other}`].components[name];
      assert.throws(() => validateEngineInputsLock(swapped), /source manifest must match its shipped file/);
      const absent = structuredClone(lock); delete absent.architectures[platform].files[path];
      assert.throws(() => validateEngineInputsLock(absent), /source manifest must match its shipped file/);
      const unpinned = structuredClone(lock); unpinned.architectures[platform].components[name].sourceManifest = null;
      assert.throws(() => validateEngineInputsLock(unpinned), /reviewed source manifest/);
    }
    const image = { Id: digest('1'), Os: 'linux', Architecture: architecture, Config: { Labels: { ...engineLabels(lock, architecture, lockSha256), 'dev.openharness.buildx.source-manifest': lock.architectures[`linux/${other}`].components.buildx.sourceManifest } } };
    assert.throws(() => validateEngineCandidate(image, architecture, lock, lockSha256), /buildx.source-manifest/);
  }
  const pending = incompleteEngineLock(), entry = pending.architectures['linux/amd64'];
  entry.components = Object.fromEntries(Object.keys(ENGINE_MANIFESTS).map(name => [name, { version: null, sourceManifest: null }]));
  entry.files = {};
  validateEngineInputsLock(pending);
  entry.components.runc.version = 'v1.2.3+bad\nINJECTED=value';
  assert.throws(() => validateEngineInputsLock(pending), /stamped derived version/);
  entry.components.runc.version = null;
  entry.files[ENGINE_MANIFESTS.runc] = 'a'.repeat(64);
  assert.throws(() => validateEngineInputsLock(pending), /source manifest must match its shipped file/);
});

test('engine Dockerfile pins the reviewed base, labels, install paths and exact input check', () => {
  const lock = committedEngineLock();
  const dockerfile = readFileSync(join(repositoryRoot, 'runtime', 'engine', 'Dockerfile'), 'utf8');
  assert.ok(dockerfile.includes(`ARG ENGINE_BASE=${lock.base.ref}\n`));
  assert.deepEqual(dockerfile.match(/^FROM .*$/gm), ['FROM ${ENGINE_INPUTS} AS inputs', 'FROM ${ENGINE_BASE} AS verified', 'FROM ${ENGINE_BASE}']);
  assert.match(dockerfile, /cmp \/tmp\/found \/tmp\/expected/);
  assert.ok(dockerfile.includes("\\( -path './containerd/bin/*' -o -path './runc/bin/*' -o -path './buildx/bin/*' \\) ! -perm 755"), 'Only the component bin directories hold binaries.');
  assert.ok(dockerfile.includes("! -path './containerd/bin/*' ! -path './runc/bin/*' ! -path './buildx/bin/*' ! -perm 644"));
  assert.match(dockerfile, /sha256sum -c \/inputs\.sha256/);
  assert.doesNotMatch(dockerfile, /\b(?:curl|wget|git clone|apk update|--allow-untrusted)\b/);
  const labels: Record<string, string | null> = engineLabels(completeEngineLock(), 'arm64', 'e'.repeat(64));
  // Component labels come from this architecture's reviewed build arguments.
  const argumentLabels: Record<string, string> = { 'org.opencontainers.image.base.name': 'ENGINE_BASE', 'dev.openharness.engine.inputs': 'ENGINE_INPUTS', 'dev.openharness.engine.inputs-lock-sha256': 'ENGINE_INPUTS_LOCK_SHA256' };
  for (const name of Object.keys(ENGINE_MANIFESTS)) { argumentLabels[`dev.openharness.${name}.version`] = `${name.toUpperCase()}_VERSION`; argumentLabels[`dev.openharness.${name}.source-manifest`] = `${name.toUpperCase()}_SOURCE_MANIFEST`; }
  for (const [key, value] of Object.entries(labels)) assert.ok(dockerfile.includes(argumentLabels[key] ? `${key}="\${${argumentLabels[key]}}"` : `${key}="${value}"`), key);
  assert.match(dockerfile, /^FROM \$\{ENGINE_BASE\}\nARG ENGINE_BASE\nARG ENGINE_INPUTS\nARG ENGINE_INPUTS_LOCK_SHA256\n/m);
  assert.ok(dockerfile.includes(`/tmp/open-harness-apk/${lock.expat.file.slice('apk/'.length)}`));
  assert.ok(dockerfile.includes(`apk info -e '${lock.expat.package}=${lock.expat.version}' > /dev/null`), 'The exact Expat version is checked by exit status.');
  const directoryMode = dockerfile.indexOf('chmod 0755 /usr/local/share/open-harness/engine');
  assert.ok(directoryMode >= 0 && directoryMode < dockerfile.indexOf('COPY --chown=0:0 --chmod=0644 NOTICE.md'), 'Create a traversable notice directory before applying the file mode.');
  for (const target of ['/inputs/containerd/bin/ /usr/local/bin/', '/inputs/runc/bin/runc /usr/local/bin/runc', '/inputs/buildx/bin/docker-buildx /usr/local/libexec/docker/cli-plugins/docker-buildx', '/inputs/containerd/provenance/ /usr/local/share/open-harness/containerd-remediation/', '/inputs/runc/provenance/ /usr/local/share/open-harness/runc-remediation/', '/inputs/buildx/provenance/ /usr/local/share/open-harness/buildx-remediation/', 'NOTICE.md /usr/local/share/open-harness/engine/NOTICE.md']) assert.ok(dockerfile.includes(`${target}\n`), target);
  const notice = readFileSync(join(repositoryRoot, 'runtime', 'engine', 'NOTICE.md'), 'utf8');
  assert.match(notice, /architecture's stamped component versions and source manifest/);
  for (const component of Object.values(lock.architectures['linux/arm64'].components)) assert.ok(!notice.includes(component.sourceManifest!), 'The template must not present an ARM64 manifest as universal.');
  const workflow = readFileSync(join(repositoryRoot, '.github', 'workflows', 'release.yml'), 'utf8');
  for (const arg of Object.values(argumentLabels).filter(arg => arg !== 'ENGINE_BASE')) {
    assert.ok(dockerfile.includes(`ARG ${arg}\n`), arg);
    assert.ok(workflow.includes(`${arg}=\${{ env.OPEN_HARNESS_${arg} }}`), arg);
  }
  assert.ok(notice.includes(lock.base.ref));
});

test('engine and coordinator candidates must carry labels bound to the committed inputs', () => {
  const lock = completeEngineLock(), lockSha256 = 'e'.repeat(64);
  const labels: Record<string, string | null> = { ...engineLabels(lock, 'arm64', lockSha256), 'org.opencontainers.image.revision': 'a'.repeat(40) };
  const image = { Id: digest('1'), Os: 'linux', Architecture: 'arm64', Config: { Labels: labels } };
  assert.equal(validateEngineCandidate(image, 'arm64', lock, lockSha256), digest('1'));
  assert.throws(() => validateEngineCandidate(image, 'amd64', lock, lockSha256));
  assert.throws(() => validateEngineCandidate(image, 'arm64', lock, 'd'.repeat(64)), /inputs-lock-sha256/);
  for (const key of ['org.opencontainers.image.base.name', 'dev.openharness.engine.inputs', 'dev.openharness.engine.expat', 'dev.openharness.runc.source-manifest', 'dev.openharness.buildx.version']) {
    const changed = { ...image, Config: { Labels: { ...labels, [key]: 'changed' } } };
    assert.throws(() => validateEngineCandidate(changed, 'arm64', lock, lockSha256), new RegExp(key.replace(/\./g, '\\.')));
  }
  assert.throws(() => validateEngineCandidate(image, 'arm64', incompleteEngineLock(), lockSha256), /incomplete/);
  const inputs = lock.architectures['linux/arm64'].inputs;
  const coordinator = { Id: digest('2'), Os: 'linux', Architecture: 'arm64', Config: { Labels: { 'dev.openharness.buildx.inputs': inputs, 'dev.openharness.buildx.sha256': lock.architectures['linux/arm64'].files['buildx/bin/docker-buildx'] } } };
  assert.equal(validateCoordinatorBuildx(coordinator, 'arm64', lock, lockSha256), digest('2'));
  assert.throws(() => validateCoordinatorBuildx({ ...coordinator, Config: { Labels: {} } }, 'arm64', lock, lockSha256), /reviewed engine inputs/);
  assert.throws(() => validateCoordinatorBuildx(coordinator, 'amd64', lock, lockSha256), /reviewed engine inputs/);
  assert.throws(() => validateCoordinatorBuildx({ ...coordinator, Config: { Labels: { ...coordinator.Config.Labels, 'dev.openharness.buildx.sha256': '0'.repeat(64) } } }, 'arm64', lock, lockSha256), /checksum must match/);
});

test('coordinator source builds keep official Buildx while releases select the reviewed inputs', () => {
  const dockerfile = readFileSync(join(repositoryRoot, 'Dockerfile.coordinator'), 'utf8');
  const release = readFileSync(join(repositoryRoot, '.github', 'workflows', 'release.yml'), 'utf8');
  assert.ok(dockerfile.startsWith('# Source builds keep the official Buildx plugin.'));
  assert.match(dockerfile, /^ARG BUILDX_INPUTS=official-buildx\nFROM /m);
  assert.match(dockerfile, /^FROM scratch AS official-buildx\nCOPY --from=docker-cli \/usr\/local\/libexec\/docker\/cli-plugins\/docker-buildx \/buildx\/bin\/docker-buildx\n/m);
  assert.match(dockerfile, /^FROM \$\{BUILDX_INPUTS\} AS buildx-inputs$/m);
  assert.match(dockerfile, /RUN --mount=type=bind,from=buildx-inputs,source=\/buildx,target=\/tmp\/open-harness-buildx/);
  assert.ok(dockerfile.includes('/usr/local/share/open-harness/buildx-remediation'));
  assert.doesNotMatch(dockerfile, /COPY --from=docker-cli \/usr\/local\/libexec\/docker\/cli-plugins\/docker-buildx \/usr\/local/);
  assert.ok(dockerfile.indexOf('docker buildx version') > dockerfile.indexOf('buildx-remediation'), 'The installed plugin is exercised after replacement.');
  assert.match(release, /name: Build native coordinator image[\s\S]*?BUILDX_INPUTS=\$\{\{ env\.OPEN_HARNESS_ENGINE_INPUTS \}\}\n\s+BUILDX_SHA256=\$\{\{ env\.OPEN_HARNESS_BUILDX_SHA256 \}\}[\s\S]*?name: Build native Hermes image/);
  assert.match(dockerfile, /dev\.openharness\.buildx\.inputs="\$\{BUILDX_INPUTS\}" dev\.openharness\.buildx\.sha256="\$\{BUILDX_SHA256\}"/);
  assert.ok(dockerfile.indexOf('sha256sum -c -') < dockerfile.indexOf('docker buildx version'), 'Check the installed plugin bytes before executing it.');
});

test('engine build contexts render exact sums and input checks refuse drift', () => {
  const directory = mkdtempSync(join(tmpdir(), 'open-harness-engine-inputs-'));
  try {
    const lock = completeEngineLock(), entry = lock.architectures['linux/arm64'];
    // A bin/ directory nested inside provenance holds data, not binaries, exactly as the Dockerfile checks it.
    entry.files['runc/provenance/source/bin/helper.sh'] = null;
    for (const path of Object.keys(entry.files)) {
      const content = `fixture ${path}\n`, file = join(directory, path);
      mkdirSync(join(file, '..'), { recursive: true }); writeFileSync(file, content); entry.files[path] = hash(content);
      if (process.platform !== 'win32') chmodSync(file, /^(?:containerd|runc|buildx)\/bin\//.test(path) ? 0o755 : 0o644);
    }
    if (process.platform !== 'win32') for (const folder of ['apk', 'containerd', 'containerd/bin', 'containerd/provenance', 'runc', 'runc/bin', 'runc/provenance', 'runc/provenance/build', 'runc/provenance/source', 'runc/provenance/source/bin', 'buildx', 'buildx/bin', 'buildx/provenance', 'buildx/provenance/build']) chmodSync(join(directory, folder), 0o755);
    for (const [name, path] of Object.entries(ENGINE_MANIFESTS)) entry.components[name].sourceManifest = entry.files[path];
    const context = engineContext(lock, 'e'.repeat(64), 'arm64');
    assert.equal(context.inputs, entry.inputs);
    assert.deepEqual(context.sums.trimEnd().split('\n'), Object.entries(entry.files).sort(([a], [b]) => (a < b ? -1 : 1)).map(([path, value]) => `${value}  ${path}`));
    assert.throws(() => engineContext(incompleteEngineLock(), 'e'.repeat(64), 'arm64'), /incomplete/);
    assert.deepEqual(inspectEngineInputs(directory, lock, 'arm64'), { platform: 'linux/arm64', verified: Object.keys(entry.files).length, unexpected: [], absent: [], mismatched: [], unpinned: [], modes: [] });
    writeFileSync(join(directory, 'runc/bin/runc'), 'tampered');
    writeFileSync(join(directory, 'runc/provenance/extra.txt'), 'extra');
    if (process.platform !== 'win32') chmodSync(join(directory, 'runc/provenance/extra.txt'), 0o644);
    unlinkSync(join(directory, 'buildx/provenance/LICENSE'));
    const pending = structuredClone(lock); pending.architectures['linux/arm64'].status = 'incomplete'; pending.architectures['linux/arm64'].missing = ['fixture']; pending.architectures['linux/arm64'].files[lock.expat.file] = null;
    const report = inspectEngineInputs(directory, pending, 'arm64');
    assert.deepEqual([report.mismatched, report.unexpected, report.absent], [['runc/bin/runc'], ['runc/provenance/extra.txt'], ['buildx/provenance/LICENSE']]);
    assert.deepEqual(report.unpinned, [{ path: lock.expat.file, sha256: hash(`fixture ${lock.expat.file}\n`) }]);
    if (process.platform !== 'win32') {
      chmodSync(join(directory, 'containerd/bin/ctr'), 0o700);
      assert.deepEqual(inspectEngineInputs(directory, pending, 'arm64').modes, ['containerd/bin/ctr']);
      symlinkSync('ctr', join(directory, 'containerd/bin/link'));
      assert.throws(() => inspectEngineInputs(directory, pending, 'arm64'), /must not contain symlinks/);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('release operations refuse to stage an engine from incomplete reviewed inputs', () => {
  const directory = mkdtempSync(join(tmpdir(), 'open-harness-engine-stage-'));
  try {
    mkdirSync(join(directory, 'runtime', 'engine'), { recursive: true });
    writeFileSync(join(directory, 'runtime', 'engine', 'inputs.lock.json'), JSON.stringify(incompleteEngineLock()));
    for (const args of [['verify-engine-inputs', directory], ['stage-engine-context', directory, 'arm64'], ['stage-engine-context', directory, 'amd64']]) {
      const result = spawnSync(process.execPath, [join(repositoryRoot, 'scripts/release-images.mjs'), ...args], { cwd: directory, encoding: 'utf8', env: { ...process.env, GITHUB_ENV: '' } });
      assert.notEqual(result.status, 0, args.join(' '));
      assert.match(result.stderr, /Reviewed engine inputs for linux\/(?:amd64|arm64) are incomplete/);
    }
    assert.ok(!existsSync(join(directory, 'engine-context')));
    assert.ok(!existsSync(join(directory, 'engine-inputs.json')));
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('release operations stage, capture and publish only candidates bound to the committed engine lock', t => {
  if (process.platform === 'win32') { t.skip('The fake docker CLI is a POSIX shell script.'); return; }
  const root = mkdtempSync(join(tmpdir(), 'open-harness-engine-operations-'));
  try {
    const lock = completeEngineLock(), lockText = `${JSON.stringify(lock, null, 2)}\n`, lockSha256 = hash(lockText), revision = 'a'.repeat(40);
    mkdirSync(join(root, 'runtime', 'engine'), { recursive: true }); mkdirSync(join(root, 'bin'));
    writeFileSync(join(root, 'runtime', 'engine', 'inputs.lock.json'), lockText);
    writeFileSync(join(root, 'runtime', 'engine', 'NOTICE.md'), 'notice\n');
    writeFileSync(join(root, 'package.json'), JSON.stringify({ version: APP_VERSION }));
    // The fake docker CLI answers only `image inspect` for the three local candidates; anything else fails.
    writeFileSync(join(root, 'fake-docker.mjs'), [
      "import { readFileSync } from 'node:fs';",
      "const [operation, action, reference] = process.argv.slice(2), images = JSON.parse(readFileSync('images.json', 'utf8'));",
      "const name = /^open-harness-([a-z]+):release-candidate$/.exec(reference || '')?.[1];",
      "if (operation === 'image' && action === 'inspect' && name && images[name]) process.stdout.write(JSON.stringify([images[name]]));",
      "else { process.stderr.write(`unexpected docker ${process.argv.slice(2).join(' ')}`); process.exitCode = 1; }",
      '',
    ].join('\n'));
    writeFileSync(join(root, 'bin', 'docker'), `#!/bin/sh\nexec '${process.execPath}' '${join(root, 'fake-docker.mjs')}' "$@"\n`);
    chmodSync(join(root, 'bin', 'docker'), 0o755);
    const inputs = lock.architectures['linux/arm64'].inputs as string;
    const candidate = (id: string, labels: Record<string, string | null>) => ({ Id: digest(id), Os: 'linux', Architecture: 'arm64', Config: { Labels: { ...labels, 'org.opencontainers.image.revision': revision } } });
    const buildxSha256 = lock.architectures['linux/arm64'].files['buildx/bin/docker-buildx'];
    const images = { engine: candidate('1', engineLabels(lock, 'arm64', lockSha256)), coordinator: candidate('2', { 'dev.openharness.buildx.inputs': inputs, 'dev.openharness.buildx.sha256': buildxSha256 }), hermes: candidate('3', {}) };
    const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${join(root, 'bin')}${delimiter}${process.env.PATH}`, GITHUB_SHA: revision, GITHUB_REPOSITORY_OWNER: 'sflow-hub', GITHUB_ENV: join(root, 'github-env') };
    for (const [name, image] of Object.entries(images)) env[`OPEN_HARNESS_${name.toUpperCase()}_BUILD_METADATA`] = JSON.stringify({ 'containerimage.config.digest': image.Id, 'containerimage.digest': digest('9') });
    const run = (fixture: object, ...args: string[]) => {
      writeFileSync(join(root, 'images.json'), JSON.stringify(fixture));
      return spawnSync(process.execPath, [join(repositoryRoot, 'scripts', 'release-images.mjs'), ...args], { cwd: root, encoding: 'utf8', env });
    };
    const staged = run(images, 'stage-engine-context', 'out', 'arm64');
    assert.equal(staged.status, 0, staged.stderr);
    assert.equal(readFileSync(join(root, 'out', 'engine-context', 'inputs.sha256'), 'utf8'), engineContext(lock, lockSha256, 'arm64').sums);
    assert.equal(readFileSync(join(root, 'out', 'engine-context', 'NOTICE.md'), 'utf8'), `notice\n${engineContext(lock, lockSha256, 'arm64').notice}`);
    const stagedEnv = Object.fromEntries(readFileSync(join(root, 'github-env'), 'utf8').trimEnd().split('\n').map(line => line.split('=')));
    assert.equal(stagedEnv.OPEN_HARNESS_ENGINE_INPUTS, inputs);
    assert.equal(stagedEnv.OPEN_HARNESS_ENGINE_INPUTS_LOCK_SHA256, lockSha256);
    assert.equal(stagedEnv.OPEN_HARNESS_BUILDX_SHA256, buildxSha256);
    for (const [name, component] of Object.entries(lock.architectures['linux/arm64'].components)) {
      assert.equal(stagedEnv[`OPEN_HARNESS_${name.toUpperCase()}_VERSION`], component.version);
      assert.equal(stagedEnv[`OPEN_HARNESS_${name.toUpperCase()}_SOURCE_MANIFEST`], component.sourceManifest);
    }
    assert.equal(Object.keys(stagedEnv).length, 9);
    assert.match(run(images, 'stage-engine-context', 'out', 'arm64').stderr, /staged fresh/);
    const unbound = run({ ...images, coordinator: candidate('2', {}) }, 'capture-scan-inputs', 'out', 'arm64');
    assert.notEqual(unbound.status, 0); assert.match(unbound.stderr, /ship Buildx from the reviewed engine inputs/);
    const drifted = run({ ...images, engine: candidate('1', { ...engineLabels(lock, 'arm64', lockSha256), 'dev.openharness.runc.source-manifest': 'f'.repeat(64) }) }, 'capture-scan-inputs', 'out', 'arm64');
    assert.notEqual(drifted.status, 0); assert.match(drifted.stderr, /dev\.openharness\.runc\.source-manifest/);
    assert.ok(!existsSync(join(root, 'out', 'scanned-images.json')));
    const captured = run(images, 'capture-scan-inputs', 'out', 'arm64');
    assert.equal(captured.status, 0, captured.stderr);
    const scanned = JSON.parse(readFileSync(join(root, 'out', 'scanned-images.json'), 'utf8'));
    assert.equal(scanned.engineInputsLockSha256, lockSha256);
    assert.deepEqual(Object.keys(scanned.images).sort(), RELEASE_IMAGES);
    // Publication re-reads the lock and refuses before any docker call if it changed after the scan.
    writeFileSync(join(root, 'runtime', 'engine', 'inputs.lock.json'), `${JSON.stringify(lock)}\n`);
    const republished = run(images, 'publish-architecture', 'out', 'arm64');
    assert.notEqual(republished.status, 0); assert.match(republished.stderr, /engine inputs lock changed after the scan/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
