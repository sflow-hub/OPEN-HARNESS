import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const PLATFORMS = ['linux/amd64', 'linux/arm64'];
const digestPattern = /^sha256:[a-f0-9]{64}$/;
const referencePattern = /^(?:ghcr\.io\/[a-z0-9-]+\/open-harness-(?:coordinator|hermes)|docker\.io\/library\/docker)@sha256:[a-f0-9]{64}$/;
const readJson = path => JSON.parse(readFileSync(path, 'utf8'));
const saveJson = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
function command(args, inherit = false) {
  const result = spawnSync('docker', args, { encoding: 'utf8', stdio: inherit ? 'inherit' : 'pipe', timeout: 20 * 60_000, maxBuffer: 8 * 1024 * 1024 });
  assert.equal(result.status, 0, result.stderr || result.error?.message || `docker ${args.slice(0, 3).join(' ')} failed`);
  return result.stdout?.trim();
}
function descriptor(reference) { return JSON.parse(command(['buildx', 'imagetools', 'inspect', reference, '--format', '{{json .Manifest}}'])); }

export function validateCandidateImage(image, architecture, revision, expectedId) {
  assert.equal(image.Os, 'linux'); assert.equal(image.Architecture, architecture);
  assert.equal(image.Config.Labels['org.opencontainers.image.revision'], revision);
  assert.match(image.Id, digestPattern);
  if (expectedId) assert.equal(image.Id, expectedId, 'Candidate image changed after the scan input was recorded.');
  return image.Id;
}

export function captureScanInput(image, architecture, revision, metadata) {
  const localId = validateCandidateImage(image, architecture, revision);
  const configDigest = metadata['containerimage.config.digest'], buildDigest = metadata['containerimage.digest'];
  assert.match(configDigest, digestPattern, 'BuildKit must report the exact configuration digest.');
  assert.match(buildDigest, digestPattern, 'BuildKit must report the exported image digest.');
  // Classic stores identify images by config; containerd can use a manifest or index.
  assert.ok(localId === configDigest || localId === buildDigest, 'Loaded image does not match the BuildKit output.');
  return { localId, configDigest, buildDigest };
}

export function candidateManifestReference(repository, manifest, architecture) {
  assert.ok(PLATFORMS.includes(`linux/${architecture}`));
  let digest = manifest.digest;
  if (manifest.manifests) {
    const matches = manifest.manifests.filter(item => item.platform?.os === 'linux' && item.platform?.architecture === architecture);
    assert.equal(matches.length, 1, `Candidate must contain exactly one linux/${architecture} manifest.`);
    digest = matches[0].digest;
  }
  const ref = `${repository}@${digest}`;
  assert.match(ref, referencePattern);
  return ref;
}

export function validatePublishedConfig(manifest, configDigest) {
  assert.match(configDigest, digestPattern);
  assert.equal(manifest.config?.digest, configDigest, 'Published manifest must contain the scanned BuildKit configuration.');
}

export function imageEntry(repository, manifest) {
  assert.match(manifest.digest, digestPattern, 'Registry descriptor must have a sha256 digest.');
  const platforms = {};
  for (const platform of PLATFORMS) {
    const [os, architecture] = platform.split('/');
    const candidates = (manifest.manifests || []).filter(item => item.platform?.os === os && item.platform?.architecture === architecture);
    assert.equal(candidates.length, 1, `Image must have exactly one ${platform} manifest.`);
    assert.match(candidates[0].digest, digestPattern);
    platforms[platform] = candidates[0].digest;
  }
  const ref = `${repository}@${manifest.digest}`;
  assert.match(ref, referencePattern);
  return { ref, platforms };
}

export function validateImageLock(lock, version, revision) {
  assert.equal(lock.schemaVersion, 1, 'Unknown release image lock schema.');
  assert.equal(lock.version, version, 'Image lock version differs from the source archive.');
  assert.equal(lock.revision, revision, 'Image lock revision differs from the source archive.');
  assert.match(revision, /^[a-f0-9]{40}$/);
  assert.deepEqual(lock.platforms, PLATFORMS);
  assert.deepEqual(Object.keys(lock.images).sort(), ['coordinator', 'engine', 'hermes']);
  for (const [name, image] of Object.entries(lock.images)) {
    assert.match(image.ref, referencePattern, `${name} must be pinned by digest.`);
    assert.ok(name === 'engine' ? image.ref.startsWith('docker.io/library/docker@') : image.ref.includes(`/open-harness-${name}@`), `Wrong repository for ${name}.`);
    assert.deepEqual(Object.keys(image.platforms).sort(), PLATFORMS);
    for (const digest of Object.values(image.platforms)) assert.match(digest, digestPattern);
  }
  return lock;
}

export function browserCompose(input, lock) {
  validateImageLock(lock, lock.version, lock.revision);
  const config = structuredClone(input);
  assert.deepEqual(Object.keys(config.services).sort(), ['docker', 'open-harness'], 'Unexpected services in browser release.');
  const coordinator = config.services['open-harness'], engine = config.services.docker;
  assert.equal(coordinator.environment?.OPEN_HARNESS_REQUIRE_BROWSER_PAIRING, '1', 'Browser release must require local browser pairing.');
  delete coordinator.build;
  coordinator.image = lock.images.coordinator.ref;
  coordinator.pull_policy = 'missing';
  coordinator.environment = { ...coordinator.environment, OPEN_HARNESS_HERMES_IMAGE: lock.images.hermes.ref, OPEN_HARNESS_HERMES_PULL: '1' };
  engine.image = lock.images.engine.ref;
  engine.pull_policy = 'missing';
  // A release must be relocatable; no builder paths or operator grants belong in it.
  for (const service of Object.values(config.services)) {
    assert.equal(service.build, undefined, 'Browser packages must not build images.');
    for (const volume of service.volumes || []) {
      if (volume.type !== 'bind') continue;
      assert.equal(volume.source, './runtime/dind-entrypoint.sh', 'Unexpected host bind in browser package.');
      assert.equal(volume.target, '/usr/local/bin/open-harness-dind.sh');
      assert.equal(volume.read_only, true);
      assert.equal(service, engine, 'The entrypoint belongs only to the engine.');
    }
  }
  // Compose normally stamps project-specific names during normalization.
  delete config.name;
  for (const group of ['volumes', 'networks']) for (const item of Object.values(config[group] || {})) if (!item.external) delete item.name;
  return config;
}

function identity() {
  const version = readJson(resolve('package.json')).version, revision = process.env.GITHUB_SHA;
  assert.match(version, /^\d+\.\d+\.\d+-beta\.\d+$/);
  assert.match(revision || '', /^[a-f0-9]{40}$/);
  const owner = (process.env.GITHUB_REPOSITORY_OWNER || '').toLowerCase();
  assert.match(owner, /^[a-z0-9][a-z0-9-]*$/);
  return { version, revision, owner };
}

function main() {
  const [operation, directory, architecture] = process.argv.slice(2);
  assert.ok(directory, 'Specify an output directory.');
  mkdirSync(directory, { recursive: true });
  if (operation === 'resolve-engine') {
    saveJson(resolve(directory, 'engine.json'), imageEntry('docker.io/library/docker', descriptor('docker:28-dind')));
  } else if (operation === 'capture-scan-inputs') {
    const { version, revision } = identity();
    assert.ok(PLATFORMS.includes(`linux/${architecture}`));
    const images = {};
    for (const name of ['coordinator', 'hermes']) {
      const [image] = JSON.parse(command(['image', 'inspect', `open-harness-${name}:release-candidate`]));
      const metadata = JSON.parse(process.env[`OPEN_HARNESS_${name.toUpperCase()}_BUILD_METADATA`] || '{}');
      images[name] = captureScanInput(image, architecture, revision, metadata);
    }
    saveJson(resolve(directory, 'scanned-images.json'), { version, revision, platform: `linux/${architecture}`, images });
  } else if (operation === 'publish-architecture') {
    const { version, revision, owner } = identity();
    assert.ok(PLATFORMS.includes(`linux/${architecture}`));
    const scanned = readJson(resolve(directory, 'scanned-images.json'));
    assert.equal(scanned.version, version); assert.equal(scanned.revision, revision); assert.equal(scanned.platform, `linux/${architecture}`);
    const images = {};
    for (const name of ['coordinator', 'hermes']) {
      const input = scanned.images[name];
      assert.match(input.localId, digestPattern); assert.match(input.configDigest, digestPattern); assert.match(input.buildDigest, digestPattern);
      const local = `open-harness-${name}:release-candidate`;
      const [image] = JSON.parse(command(['image', 'inspect', local]));
      validateCandidateImage(image, architecture, revision, input.localId);
      const repository = `ghcr.io/${owner}/open-harness-${name}`;
      const tag = `${repository}:candidate-${revision}-${architecture}`;
      command(['tag', local, tag], true); command(['push', tag], true);
      const remote = descriptor(tag);
      assert.match(remote.digest, digestPattern);
      const ref = candidateManifestReference(repository, remote, architecture);
      const manifest = JSON.parse(command(['buildx', 'imagetools', 'inspect', ref, '--raw']));
      validatePublishedConfig(manifest, input.configDigest);
      images[name] = ref;
    }
    saveJson(resolve(directory, `${architecture}.json`), { version, revision, platform: `linux/${architecture}`, images });
  } else if (operation === 'publish-manifests') {
    const { version, revision, owner } = identity();
    const candidates = ['amd64', 'arm64'].map(architecture => readJson(resolve(directory, `${architecture}.json`)));
    for (const [index, candidate] of candidates.entries()) {
      assert.equal(candidate.version, version); assert.equal(candidate.revision, revision); assert.equal(candidate.platform, PLATFORMS[index]);
    }
    const images = { engine: readJson(resolve(directory, 'engine.json')) };
    for (const name of ['coordinator', 'hermes']) {
      const repository = `ghcr.io/${owner}/open-harness-${name}`, tag = `${repository}:candidate-${revision}`;
      const refs = candidates.map(candidate => candidate.images[name]);
      for (const ref of refs) { assert.match(ref, referencePattern); assert.ok(ref.startsWith(`${repository}@`)); }
      command(['buildx', 'imagetools', 'create', '--tag', tag, ...refs], true);
      const image = imageEntry(repository, descriptor(tag));
      for (const [index, platform] of PLATFORMS.entries()) assert.equal(image.platforms[platform], refs[index].split('@')[1], 'Published manifest must reference the tested architecture image.');
      images[name] = image;
    }
    const lock = { schemaVersion: 1, version, revision, platforms: PLATFORMS, images };
    saveJson(resolve(directory, 'image-lock.json'), validateImageLock(lock, version, revision));
  } else if (operation === 'promote-release') {
    const { version, revision, owner } = identity();
    const lock = validateImageLock(readJson(resolve(directory, 'image-lock.json')), version, revision);
    for (const name of ['coordinator', 'hermes']) {
      const repository = `ghcr.io/${owner}/open-harness-${name}`, image = lock.images[name];
      assert.ok(image.ref.startsWith(`${repository}@`));
      assert.deepEqual(imageEntry(repository, descriptor(image.ref)), image, 'Release must promote the verified index and architecture digests.');
      const tag = `${repository}:v${version}`;
      command(['buildx', 'imagetools', 'create', '--tag', tag, image.ref], true);
      assert.equal(descriptor(tag).digest, image.ref.split('@')[1], 'Version tag must preserve the verified manifest digest.');
    }
  } else throw new Error(`Unknown release-image operation: ${operation}`);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
