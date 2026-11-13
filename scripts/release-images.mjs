import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFileSync, copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const PLATFORMS = ['linux/amd64', 'linux/arm64'];
// Every released image is built for its target architecture, scanned, exercised, then published.
export const RELEASE_IMAGES = ['coordinator', 'engine', 'hermes'];
export const ENGINE_LOCK = 'runtime/engine/inputs.lock.json';
export const ENGINE_BINARIES = ['containerd/bin/containerd', 'containerd/bin/containerd-shim-runc-v2', 'containerd/bin/ctr', 'runc/bin/runc', 'buildx/bin/docker-buildx'];
export const ENGINE_MANIFESTS = { buildx: 'buildx/provenance/build/source-manifest.json', containerd: 'containerd/provenance/SOURCE-MANIFEST.sha256', runc: 'runc/provenance/build/source-manifest.json' };
const digestPattern = /^sha256:[a-f0-9]{64}$/;
const sha256Pattern = /^[a-f0-9]{64}$/;
const referencePattern = /^ghcr\.io\/[a-z0-9-]+\/open-harness-(?:coordinator|engine|hermes)@sha256:[a-f0-9]{64}$/;
const officialEnginePattern = /^docker\.io\/library\/docker:\d+\.\d+\.\d+-dind@sha256:[a-f0-9]{64}$/;
const engineInputsPattern = /^ghcr\.io\/[a-z0-9-]+\/open-harness-engine-inputs@sha256:[a-f0-9]{64}$/;
// Relative paths only; no segment may start with a dot, so no traversal or hidden files.
const engineInputPath = /^(?:apk|(?:containerd|runc|buildx)\/(?:bin|provenance))\/(?:[A-Za-z0-9_+-][A-Za-z0-9._+-]*\/)*[A-Za-z0-9_+-][A-Za-z0-9._+-]*$/;
const sha256 = data => createHash('sha256').update(data).digest('hex');
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
  assert.deepEqual(Object.keys(lock.images).sort(), RELEASE_IMAGES);
  const owners = new Set();
  for (const [name, image] of Object.entries(lock.images)) {
    assert.match(image.ref, referencePattern, `${name} must be pinned by digest.`);
    const [, owner, repository] = image.ref.match(/^ghcr\.io\/([a-z0-9-]+)\/([a-z-]+)@/);
    assert.equal(repository, `open-harness-${name}`, `Wrong repository for ${name}.`);
    owners.add(owner);
    assert.deepEqual(Object.keys(image.platforms).sort(), PLATFORMS);
    for (const digest of Object.values(image.platforms)) assert.match(digest, digestPattern);
  }
  assert.equal(owners.size, 1, 'Release images must come from one registry namespace.');
  return lock;
}

// The derived engine is assembled only from inputs reviewed in runtime/engine/inputs.lock.json.
// An architecture stays "incomplete", with every missing input named, until each input is pinned.
export function validateEngineInputsLock(lock, required = []) {
  assert.equal(lock?.schemaVersion, 2, 'Unknown engine inputs lock schema.');
  assert.match(lock.base?.ref || '', officialEnginePattern, 'The engine base must be an official Docker engine index pinned by digest.');
  assert.equal(lock.expat?.package, 'libexpat', 'The engine lock must name the reviewed Expat package.');
  assert.match(lock.expat.version || '', /^\d+\.\d+\.\d+-r\d+$/, 'Expat needs an exact Alpine package version.');
  assert.equal(lock.expat.file, `apk/${lock.expat.package}-${lock.expat.version}.apk`, 'Expat package path differs from its version.');
  assert.equal(lock.components, undefined, 'Engine components must be recorded per architecture.');
  assert.deepEqual(Object.keys(lock.architectures || {}).sort(), PLATFORMS, 'Engine inputs must list both target architectures.');
  for (const [platform, entry] of Object.entries(lock.architectures)) {
    const files = Object.entries(entry.files || {});
    for (const [path, hash] of files) {
      assert.match(path, engineInputPath, `${platform} lists an unsafe engine input path: ${path}`);
      assert.ok(hash === null || sha256Pattern.test(hash), `${platform} has an invalid hash for ${path}.`);
    }
    assert.deepEqual(Object.keys(entry.components || {}).sort(), Object.keys(ENGINE_MANIFESTS), `${platform} engine components differ from the reviewed set.`);
    for (const [name, path] of Object.entries(ENGINE_MANIFESTS)) {
      const component = entry.components[name];
      assert.ok(component && typeof component === 'object', `${platform} needs ${name} metadata.`);
      if (entry.status === 'complete' || component.version !== null) assert.match(component.version || '', /^v?\d+\.\d+\.\d+\+[0-9A-Za-z.-]+$/, `${platform} ${name} needs its stamped derived version.`);
      if (entry.status === 'complete' || component.sourceManifest !== null) assert.match(component.sourceManifest || '', sha256Pattern, `${platform} ${name} needs its reviewed source manifest.`);
      if (entry.status === 'complete' || component.sourceManifest !== null || entry.files?.[path] != null) {
        assert.equal(entry.files?.[path], component.sourceManifest, `${platform} ${name} source manifest must match its shipped file ${path}.`);
      }
    }
    if (entry.status === 'complete') {
      assert.equal(entry.missing, undefined, `${platform} is complete but still names missing inputs.`);
      assert.match(entry.inputs || '', engineInputsPattern, `${platform} inputs must be one reviewed image pinned by digest.`);
      const paths = new Set(files.map(([path]) => path));
      for (const path of [lock.expat.file, ...ENGINE_BINARIES]) assert.ok(paths.has(path), `${platform} inputs lack ${path}.`);
      assert.ok(files.every(([, hash]) => hash !== null), `${platform} has unpinned inputs.`);
    } else {
      assert.equal(entry.status, 'incomplete', `${platform} has an unknown engine input status.`);
      assert.ok(Array.isArray(entry.missing) && entry.missing.length > 0 && entry.missing.every(item => typeof item === 'string' && item.trim() !== ''), `${platform} must name every missing input.`);
      assert.ok(!required.includes(platform), `Reviewed engine inputs for ${platform} are incomplete: ${entry.missing.join(' | ')}`);
    }
  }
  return lock;
}

export function engineContext(lock, lockSha256, architecture) {
  const platform = `linux/${architecture}`;
  assert.ok(PLATFORMS.includes(platform));
  assert.match(lockSha256, sha256Pattern);
  validateEngineInputsLock(lock, [platform]);
  const entry = lock.architectures[platform];
  const lines = Object.entries(entry.files).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([path, hash]) => `${hash}  ${path}`);
  /** @type {Record<string, string>} */
  const buildArgs = { ENGINE_INPUTS: entry.inputs, ENGINE_INPUTS_LOCK_SHA256: lockSha256 };
  const records = [];
  for (const [name, component] of Object.entries(entry.components)) {
    buildArgs[`${name.toUpperCase()}_VERSION`] = component.version;
    buildArgs[`${name.toUpperCase()}_SOURCE_MANIFEST`] = component.sourceManifest;
    records.push(`- ${name}: \`${component.version}\`; source manifest SHA256 \`${component.sourceManifest}\` (\`${ENGINE_MANIFESTS[name]}\` in the inputs image).`);
  }
  const notice = `\n## Reviewed inputs for ${platform}\n\n${records.join('\n')}\n\nInputs image: \`${entry.inputs}\`.\nInputs lock SHA256: \`${lockSha256}\`.\n`;
  return { inputs: entry.inputs, lockSha256, buildxSha256: entry.files['buildx/bin/docker-buildx'], sums: `${lines.join('\n')}\n`, buildArgs, notice };
}

export function engineLabels(lock, architecture, lockSha256) {
  const labels = {
    'org.opencontainers.image.base.name': lock.base.ref,
    'dev.openharness.engine.inputs': lock.architectures[`linux/${architecture}`].inputs,
    'dev.openharness.engine.inputs-lock-sha256': lockSha256,
    'dev.openharness.engine.expat': lock.expat.version,
  };
  for (const [name, component] of Object.entries(lock.architectures[`linux/${architecture}`].components)) {
    labels[`dev.openharness.${name}.version`] = component.version;
    labels[`dev.openharness.${name}.source-manifest`] = component.sourceManifest;
  }
  return labels;
}

export function validateEngineCandidate(image, architecture, lock, lockSha256) {
  engineContext(lock, lockSha256, architecture);
  assert.equal(image.Os, 'linux'); assert.equal(image.Architecture, architecture);
  const labels = image.Config?.Labels || {};
  for (const [key, value] of Object.entries(engineLabels(lock, architecture, lockSha256))) assert.equal(labels[key], value, `Engine label ${key} must match the reviewed inputs lock.`);
  return image.Id;
}

// Release coordinators take Buildx from the same reviewed inputs image as the engine.
export function validateCoordinatorBuildx(image, architecture, lock, lockSha256) {
  const { inputs, buildxSha256 } = engineContext(lock, lockSha256, architecture);
  assert.equal(image.Config?.Labels?.['dev.openharness.buildx.inputs'], inputs, 'The coordinator must ship Buildx from the reviewed engine inputs.');
  assert.equal(image.Config?.Labels?.['dev.openharness.buildx.sha256'], buildxSha256, 'The coordinator Buildx checksum must match the reviewed binary.');
  return image.Id;
}

// Local review aid for a directory that will become one architecture's inputs image.
export function inspectEngineInputs(directory, lock, architecture) {
  const platform = `linux/${architecture}`;
  assert.ok(PLATFORMS.includes(platform));
  validateEngineInputsLock(lock);
  const expected = new Map(Object.entries(lock.architectures[platform].files || {}));
  const found = new Map(), modes = [], posix = process.platform !== 'win32';
  const walk = relative => {
    for (const name of readdirSync(join(directory, relative)).sort()) {
      const path = relative ? `${relative}/${name}` : name, stat = lstatSync(join(directory, path));
      assert.ok(!stat.isSymbolicLink(), `Engine inputs must not contain symlinks: ${path}`);
      if (stat.isDirectory()) {
        if (posix && (stat.mode & 0o777) !== 0o755) modes.push(path);
        walk(path);
        continue;
      }
      assert.ok(stat.isFile(), `Engine inputs must contain only regular files: ${path}`);
      if (posix && (stat.mode & 0o777) !== (/^(?:containerd|runc|buildx)\/bin\//.test(path) ? 0o755 : 0o644)) modes.push(path);
      found.set(path, sha256(readFileSync(join(directory, path))));
    }
  };
  walk('');
  return {
    platform,
    verified: [...expected].filter(([path, hash]) => hash !== null && found.get(path) === hash).length,
    unexpected: [...found.keys()].filter(path => !expected.has(path)),
    absent: [...expected.keys()].filter(path => !found.has(path)),
    mismatched: [...expected].filter(([path, hash]) => hash !== null && found.has(path) && found.get(path) !== hash).map(([path]) => path),
    unpinned: [...expected].filter(([path, hash]) => hash === null && found.has(path)).map(([path]) => ({ path, sha256: found.get(path) })),
    modes,
  };
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
  // Updates unpack into new directories; keep their default workspace stable.
  config.name = 'open-harness';
  // Let Compose regenerate resource names for the default or an explicit project.
  for (const group of ['volumes', 'networks']) for (const item of Object.values(config[group] || {})) if (!item.external) delete item.name;
  return config;
}

// Supplemental Debian-origin gate (scripts/debian-origin-gate.py). Before anything is tagged or pushed, its receipt
// must be complete, unaltered and for the exact scanned Hermes image, architecture and sources of this checkout.
export const DEBIAN_ORIGIN_GATE = 'debian-origin-gate';
export const DEBIAN_ORIGIN_SCHEMA = 'open-harness-debian-origin-gate/1';
export const DEBIAN_ORIGIN_STEPS = [['probe-component-root', 0], ['probe-bind', 0], ['component-scan', 0], ['check-component', 0], ['component-sbom', 0], ['check-sbom', 0], ['sbom-scan', 0], ['check-sbom-scan', 0], ['make-negative', 0], ['negative-scan', 1], ['check-negative', 0], ['image-scan', 0], ['check-image', 0]];
export const DEBIAN_ORIGIN_NEGATIVE = { source: 'chromium', version: '150.0.7871.181-1~deb13u1' };
const debianOriginFiles = ['scripts/debian-origin-gate.py', 'runtime/hermes/Dockerfile', 'runtime/readiness.ts'];
const debianOriginDirectories = ['runtime/ubuntu/helpers', 'runtime/ubuntu/lock'];
const debianOriginReports = { 'component-scan': 'reports/component-scan.json', 'component-sbom': 'reports/component.cdx.json', 'sbom-scan': 'reports/sbom-scan.json', 'make-negative': 'reports/control.cdx.json', 'negative-scan': 'reports/negative-scan.json', 'image-scan': 'reports/image-scan.json' };
const evidencePath = /^(?:calls|steps|reports)\/[A-Za-z0-9][A-Za-z0-9._-]*$/;

// The checkout files the gate hashes, computed as it does: regular files only, links refused, __pycache__ skipped.
export function debianOriginSources(root = '.') {
  /** @type {Record<string, string>} */
  const files = {};
  const walk = relative => {
    for (const name of readdirSync(join(root, relative)).sort()) {
      const path = `${relative}/${name}`, stat = lstatSync(join(root, path));
      if (stat.isDirectory() && name === '__pycache__') continue;
      assert.ok(!stat.isSymbolicLink(), `Debian-origin gate inputs must not contain links: ${path}`);
      if (stat.isDirectory()) walk(path);
      else {
        assert.ok(stat.isFile(), `Debian-origin gate inputs must be regular files: ${path}`);
        files[path] = sha256(readFileSync(join(root, path)));
      }
    }
  };
  for (const path of debianOriginFiles) {
    assert.ok(lstatSync(join(root, path)).isFile(), `${path} must be a regular file.`);
    files[path] = sha256(readFileSync(join(root, path)));
  }
  for (const path of debianOriginDirectories) {
    assert.ok(lstatSync(join(root, path)).isDirectory(), `${path} must be a directory.`);
    walk(path);
  }
  return Object.fromEntries(Object.entries(files).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

/**
 * @param {string} directory a gate output directory
 * @param {{ image: string | undefined, architecture: string, revision?: string, root?: string }} expected
 */
export function validateDebianOriginGate(directory, { image, architecture, revision, root = '.' }) {
  assert.match(image || '', digestPattern, 'The Debian-origin gate must be bound to the exact scanned Hermes image ID.');
  assert.ok(PLATFORMS.includes(`linux/${architecture}`), `Unknown architecture ${architecture}.`);
  const path = join(directory, 'receipt.json');
  assert.ok(existsSync(path), `No Debian-origin gate receipt in ${directory}: the supplemental gate must pass before publication.`);
  const bytes = readFileSync(path), receipt = JSON.parse(bytes.toString('utf8'));
  assert.equal(receipt.schema, DEBIAN_ORIGIN_SCHEMA, 'Unknown Debian-origin gate receipt schema.');
  assert.equal(receipt.ok, true, 'The Debian-origin gate did not pass.');
  assert.equal(receipt.architecture, architecture, `The Debian-origin gate ran for ${receipt.architecture}, not ${architecture}.`);
  const contract = /export const RUNTIME_CONTRACT = (\d+);/.exec(readFileSync(join(root, 'runtime', 'readiness.ts'), 'utf8'))?.[1];
  assert.ok(contract, 'runtime/readiness.ts has no RUNTIME_CONTRACT.');
  // The image the gate inspected, probed and scanned as a whole.
  const gated = receipt.image || {};
  assert.equal(gated.id, image, 'The Debian-origin gate receipt is for another image.');
  assert.deepEqual([gated.os, gated.architecture], ['linux', architecture], 'The Debian-origin gate inspected another platform.');
  assert.equal(gated.labels?.['dev.openharness.runtime'], contract, 'The gated image carries another runtime contract.');
  if (revision) assert.equal(gated.labels?.['org.opencontainers.image.revision'], revision, 'The gated image was built from another revision.');
  const scanned = receipt.reports?.['image-scan'] || {};
  assert.deepEqual([scanned.artifactName, scanned.artifactType, scanned.imageId, scanned.os, scanned.architecture], [image, 'container_image', image, 'linux', architecture], 'The Debian-origin whole-image scan must be of the exact image.');
  assert.deepEqual(['component-scan', 'component-sbom', 'sbom-scan', 'negative-scan'].map(name => receipt.reports?.[name]?.artifactType || receipt.reports?.[name]?.bomFormat), ['filesystem', 'CycloneDX', 'cyclonedx', 'cyclonedx'], 'Every Debian-origin component report must name its artifact.');
  // Sources, scanner and one unchanged database.
  assert.deepEqual(receipt.sources?.files, debianOriginSources(root), 'The Debian-origin gate ran with other gate, helper, lock, Dockerfile or readiness sources.');
  assert.equal(receipt.sources.runtimeContract, contract, 'The Debian-origin gate ran with another runtime contract.');
  assert.match(receipt.scanner?.sha256 || '', sha256Pattern, 'The Debian-origin gate must record its scanner binary.');
  const database = receipt.database || {};
  assert.match(database.sourceBefore?.['db/trivy.db'] || '', sha256Pattern, 'The Debian-origin gate must record its vulnerability database.');
  assert.match(database.sourceBefore['db/metadata.json'] || '', sha256Pattern, 'The Debian-origin gate must record its database metadata.');
  for (const key of ['usedBefore', 'sourceAfter', 'usedAfter']) assert.deepEqual(database[key], database.sourceBefore, `The scanner database changed during the Debian-origin gate (${key}).`);
  const reported = receipt.scanner.version?.VulnerabilityDB || {};
  assert.ok(database.metadata?.UpdatedAt && reported.UpdatedAt === database.metadata.UpdatedAt && reported.Version === database.metadata.Version, 'The scanner did not report the gated database.');
  // All thirteen steps in order with their expected exit codes, and every retained stream and report unchanged.
  const steps = receipt.steps || [];
  assert.deepEqual(steps.map(step => [step.name, step.expectedReturncode, step.returncode, step.timedOut]), DEBIAN_ORIGIN_STEPS.map(([name, code]) => [name, code, code, false]), 'The Debian-origin gate must record all thirteen steps with their expected exit codes.');
  for (const [name, output] of Object.entries(debianOriginReports)) assert.ok(Object.hasOwn(steps.find(step => step.name === name).outputs || {}, output), `The Debian-origin ${name} step lacks ${output}.`);
  /** @type {Map<string, string>} */
  const evidence = new Map();
  for (const record of [...(receipt.calls || []), ...steps]) for (const stream of [record.stdout, record.stderr]) evidence.set(stream?.path, stream?.sha256);
  for (const step of steps) for (const [output, digest] of Object.entries(step.outputs || {})) evidence.set(output, digest);
  for (const [item, digest] of evidence) {
    assert.match(item || '', evidencePath, `Unsafe Debian-origin evidence path: ${item}`);
    assert.match(digest || '', sha256Pattern, `Debian-origin evidence ${item} was not recorded.`);
    const file = join(directory, item);
    assert.ok(existsSync(file) && lstatSync(file).isFile(), `Debian-origin evidence ${item} is missing.`);
    assert.equal(sha256(readFileSync(file)), digest, `Debian-origin evidence ${item} changed after the gate.`);
  }
  // Checks against this checkout's lock, the component binding and the negative control.
  const lock = readJson(join(root, 'runtime', 'ubuntu', 'lock', 'runtime-inputs.lock.json'));
  const debian = Object.keys(lock.debian?.packages?.[architecture] || {}).sort(), finalPackages = Object.keys(lock.finalPackages?.[architecture] || {}).length;
  assert.ok(debian.length > 0 && finalPackages > 0, `The runtime lock has no ${architecture} packages.`);
  const checks = receipt.checks || {};
  for (const name of ['check-component', 'check-sbom-scan']) assert.deepEqual(checks[name], { architecture, packages: debian, vulnerabilities: 0, secrets: 0 }, `The Debian-origin ${name} result is incomplete.`);
  assert.deepEqual(checks['check-sbom'], { architecture, packages: debian }, 'The Debian-origin SBOM check result is incomplete.');
  assert.equal(checks['check-image']?.os, 'ubuntu', 'The whole-image scan must keep the Ubuntu OS identity.');
  assert.equal(checks['check-image'].packages, finalPackages, 'The whole-image scan must list exactly the locked package set.');
  const negative = receipt.negativeControl || {};
  assert.deepEqual([negative.source, negative.version], [DEBIAN_ORIGIN_NEGATIVE.source, DEBIAN_ORIGIN_NEGATIVE.version], 'The Debian-origin negative control must regress the reviewed Chromium source version.');
  assert.ok(Number.isInteger(negative.severeFindings) && negative.severeFindings > 0 && Number.isInteger(negative.ids) && negative.ids > 0, 'The Debian-origin negative control must prove HIGH/CRITICAL advisory lookup.');
  assert.deepEqual(negative, { ...checks['check-negative'], ...DEBIAN_ORIGIN_NEGATIVE }, 'The Debian-origin negative control summary differs from its check.');
  const probe = receipt.probe || {};
  assert.match(probe.user || '', /^[1-9]\d*:[1-9]\d*$/, 'The Debian-origin probes must run as a non-root user.');
  assert.deepEqual([probe.bind?.architecture, probe.bind?.packages, probe.componentRoot?.packages], [architecture, debian, debian], 'The Debian component must be bound to this architecture and the locked packages.');
  assert.match(probe.bind.inventoryDigest || '', sha256Pattern, 'The Debian-origin gate must record the image inventory digest.');
  assert.equal(probe.componentRoot.files, probe.bind.files + probe.bind.omittedByPolicy, 'The rebuilt component differs from the bound inventory.');
  assert.deepEqual((probe.containers || []).map(item => [item.container, ['absent', 'removed'].includes(item.action)]), ['probe-component-root', 'probe-bind'].map(name => [`oh-debian-origin-gate-${receipt.nonce}-${name}`, true]), 'Both probe containers of this gate must be gone.');
  return { receiptSha256: sha256(bytes), image, architecture, scannerSha256: receipt.scanner.sha256, database: { trivyDbSha256: database.sourceBefore['db/trivy.db'], updatedAt: database.metadata.UpdatedAt }, negativeControl: { severeFindings: negative.severeFindings, ids: negative.ids } };
}

// Manifests join only architecture candidates whose publication recorded a passing gate for their Hermes image.
/** @param {any} record @param {string} architecture */
export function validateDebianOriginRecord(record, architecture) {
  assert.ok(record && typeof record === 'object', `The linux/${architecture} candidate was published without a Debian-origin gate record.`);
  assert.equal(record.architecture, architecture, `The Debian-origin gate record is for ${record.architecture}, not ${architecture}.`);
  assert.match(record.image || '', digestPattern, 'The Debian-origin gate record must name the gated image.');
  assert.match(record.receiptSha256 || '', sha256Pattern, 'The Debian-origin gate record must name its receipt.');
  assert.match(record.scannerSha256 || '', sha256Pattern, 'The Debian-origin gate record must name its scanner.');
  assert.ok(Number.isInteger(record.negativeControl?.severeFindings) && record.negativeControl.severeFindings > 0, 'The Debian-origin negative control must have found HIGH/CRITICAL advisories.');
  return record;
}

function identity() {
  const version = readJson(resolve('package.json')).version, revision = process.env.GITHUB_SHA;
  assert.match(version, /^\d+\.\d+\.\d+-beta\.\d+$/);
  assert.match(revision || '', /^[a-f0-9]{40}$/);
  const owner = (process.env.GITHUB_REPOSITORY_OWNER || '').toLowerCase();
  assert.match(owner, /^[a-z0-9][a-z0-9-]*$/);
  return { version, revision, owner };
}

function engineLock() {
  const bytes = readFileSync(resolve(ENGINE_LOCK));
  return { lock: JSON.parse(bytes.toString('utf8')), lockSha256: sha256(bytes) };
}

function main() {
  const [operation, directory, architecture, image] = process.argv.slice(2);
  assert.ok(directory, 'Specify an output directory.');
  if (operation === 'check-engine-inputs') {
    // Read-only: reports how a local inputs directory differs from the lock for one architecture.
    const report = inspectEngineInputs(resolve(directory), engineLock().lock, architecture);
    console.log(JSON.stringify(report, null, 2));
    if (report.unexpected.length || report.absent.length || report.mismatched.length || report.unpinned.length || report.modes.length) process.exitCode = 1;
    return;
  }
  if (operation === 'verify-debian-origin-gate') {
    // Read-only: checks one gate output directory against this checkout exactly as publish-architecture will.
    const revision = /^[a-f0-9]{40}$/.test(process.env.GITHUB_SHA || '') ? process.env.GITHUB_SHA : undefined;
    console.log(JSON.stringify(validateDebianOriginGate(resolve(directory), { image, architecture, revision }), null, 2));
    return;
  }
  mkdirSync(directory, { recursive: true });
  if (operation === 'verify-engine-inputs') {
    const { lock, lockSha256 } = engineLock();
    validateEngineInputsLock(lock, PLATFORMS);
    saveJson(resolve(directory, 'engine-inputs.json'), { lock: ENGINE_LOCK, lockSha256, platforms: PLATFORMS });
  } else if (operation === 'stage-engine-context') {
    const { lock, lockSha256 } = engineLock();
    const context = engineContext(lock, lockSha256, architecture);
    const target = resolve(directory, 'engine-context');
    assert.ok(!existsSync(target), 'The engine build context must be staged fresh.');
    mkdirSync(target);
    writeFileSync(join(target, 'inputs.sha256'), context.sums);
    copyFileSync(resolve('runtime/engine/NOTICE.md'), join(target, 'NOTICE.md'));
    appendFileSync(join(target, 'NOTICE.md'), context.notice);
    if (process.env.GITHUB_ENV) appendFileSync(process.env.GITHUB_ENV, [...Object.entries(context.buildArgs).map(([key, value]) => `OPEN_HARNESS_${key}=${value}`), `OPEN_HARNESS_BUILDX_SHA256=${context.buildxSha256}`, ''].join('\n'));
  } else if (operation === 'capture-scan-inputs') {
    const { version, revision } = identity();
    assert.ok(PLATFORMS.includes(`linux/${architecture}`));
    const { lock, lockSha256 } = engineLock();
    const images = {};
    for (const name of RELEASE_IMAGES) {
      const [image] = JSON.parse(command(['image', 'inspect', `open-harness-${name}:release-candidate`]));
      if (name === 'engine') validateEngineCandidate(image, architecture, lock, lockSha256);
      if (name === 'coordinator') validateCoordinatorBuildx(image, architecture, lock, lockSha256);
      const metadata = JSON.parse(process.env[`OPEN_HARNESS_${name.toUpperCase()}_BUILD_METADATA`] || '{}');
      images[name] = captureScanInput(image, architecture, revision, metadata);
    }
    saveJson(resolve(directory, 'scanned-images.json'), { version, revision, platform: `linux/${architecture}`, engineInputsLockSha256: lockSha256, images });
  } else if (operation === 'publish-architecture') {
    const { version, revision, owner } = identity();
    assert.ok(PLATFORMS.includes(`linux/${architecture}`));
    const scanned = readJson(resolve(directory, 'scanned-images.json'));
    assert.equal(scanned.version, version); assert.equal(scanned.revision, revision); assert.equal(scanned.platform, `linux/${architecture}`);
    const { lock, lockSha256 } = engineLock();
    assert.equal(scanned.engineInputsLockSha256, lockSha256, 'The engine inputs lock changed after the scan input was recorded.');
    // The supplemental Debian-origin gate is mandatory and must have passed for the exact scanned Hermes image.
    const debianOriginGate = validateDebianOriginGate(resolve(directory, DEBIAN_ORIGIN_GATE), { image: scanned.images?.hermes?.localId, architecture, revision });
    const images = {};
    for (const name of RELEASE_IMAGES) {
      const input = scanned.images[name];
      assert.match(input.localId, digestPattern); assert.match(input.configDigest, digestPattern); assert.match(input.buildDigest, digestPattern);
      const local = `open-harness-${name}:release-candidate`;
      const [image] = JSON.parse(command(['image', 'inspect', local]));
      validateCandidateImage(image, architecture, revision, input.localId);
      if (name === 'engine') validateEngineCandidate(image, architecture, lock, lockSha256);
      if (name === 'coordinator') validateCoordinatorBuildx(image, architecture, lock, lockSha256);
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
    saveJson(resolve(directory, `${architecture}.json`), { version, revision, platform: `linux/${architecture}`, images, debianOriginGate });
  } else if (operation === 'publish-manifests') {
    const { version, revision, owner } = identity();
    const candidates = ['amd64', 'arm64'].map(architecture => readJson(resolve(directory, `${architecture}.json`)));
    for (const [index, candidate] of candidates.entries()) {
      assert.equal(candidate.version, version); assert.equal(candidate.revision, revision); assert.equal(candidate.platform, PLATFORMS[index]);
      validateDebianOriginRecord(candidate.debianOriginGate, PLATFORMS[index].split('/')[1]);
    }
    const images = {};
    for (const name of RELEASE_IMAGES) {
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
    for (const name of RELEASE_IMAGES) {
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
