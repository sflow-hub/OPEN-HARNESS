import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { DEBIAN_ORIGIN_GATE, DEBIAN_ORIGIN_NEGATIVE, DEBIAN_ORIGIN_STEPS, debianOriginSources, ENGINE_BINARIES, ENGINE_MANIFESTS, engineLabels, PLATFORMS, validateDebianOriginGate, validateDebianOriginRecord } from '../scripts/release-images.mjs';

// Offline: synthetic gate receipts and a fake docker CLI. scripts/debian-origin-gate.py itself is exercised with fake
// Docker and Trivy CLIs in tests/ubuntu-runtime/test_release_gate.py, which also runs this validator on its receipt.
const repositoryRoot = join(import.meta.dirname, '..');
const releaseImages = join(repositoryRoot, 'scripts', 'release-images.mjs');
const hash = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
const digest = (value: string) => `sha256:${hash(value)}`;
const revision = 'a'.repeat(40), image = digest('3'), architecture = 'arm64';
const debian = ['chromium', 'chromium-common', 'libjpeg62-turbo'];
const steps = DEBIAN_ORIGIN_STEPS as [string, number][];

type Stream = { path: string; sha256: string };
type Step = { name: string; command: string[]; expectedReturncode: number; returncode: number | null; timedOut: boolean; seconds: number; stdout: Stream; stderr: Stream; outputs: Record<string, string | null> };
type Receipt = {
  schema: string; ok: boolean; nonce: string; architecture: string;
  image: { id: string; os: string; architecture: string; labels: Record<string, string> };
  sources: { files: Record<string, string>; runtimeContract: string };
  scanner: { sha256: string; version: { Version: string; VulnerabilityDB: { Version: number; UpdatedAt: string } } };
  database: { sourceBefore: Record<string, string>; usedBefore: Record<string, string>; sourceAfter: Record<string, string>; usedAfter: Record<string, string>; metadata: { Version: number; UpdatedAt: string } };
  probe: { user: string; bind: { architecture: string; packages: string[]; inventoryDigest: string; files: number; omittedByPolicy: number; links: number }; componentRoot: { root: string; packages: string[]; files: number }; containers: { container: string; action: string; id?: string }[] };
  calls: { name: string; stdout: Stream; stderr: Stream }[];
  steps: Step[];
  reports: Record<string, Record<string, string>>;
  checks: Record<string, Record<string, unknown>>;
  negativeControl: { source: string; version: string; severeFindings: number; ids: number };
};

// A checkout holding the files the gate hashes; the lock lists the Debian packages and five final packages.
function checkout(root: string) {
  const files: Record<string, string> = {
    'scripts/debian-origin-gate.py': 'gate\n', 'runtime/hermes/Dockerfile': 'FROM scratch\n', 'runtime/readiness.ts': 'export const RUNTIME_CONTRACT = 7;\n',
    'runtime/ubuntu/helpers/debian_origin.py': 'helper\n', 'runtime/ubuntu/helpers/ohpkg.py': 'ohpkg\n', 'runtime/ubuntu/lock/ubuntu-os-packages.txt': 'curl\n',
    'runtime/ubuntu/lock/runtime-inputs.lock.json': `${JSON.stringify({ debian: { packages: Object.fromEntries(PLATFORMS.map(platform => [platform.split('/')[1], Object.fromEntries(debian.map(name => [name, {}]))])) }, finalPackages: Object.fromEntries(PLATFORMS.map(platform => [platform.split('/')[1], Object.fromEntries(['curl', 'tini', ...debian].map(name => [name, ['1', platform.split('/')[1]]]))])) })}\n`,
  };
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), text);
  }
}

// A complete passing gate directory for `image`, shaped like scripts/debian-origin-gate.py output.
function gate(root: string, directory: string, gated = image, arch = architecture): Receipt {
  for (const name of ['calls', 'steps', 'reports']) mkdirSync(join(directory, name), { recursive: true });
  const stream = (path: string, text: string): Stream => { writeFileSync(join(directory, path), text); return { path, sha256: hash(text) }; };
  const reports: Record<string, string> = { 'component-scan': 'reports/component-scan.json', 'component-sbom': 'reports/component.cdx.json', 'sbom-scan': 'reports/sbom-scan.json', 'make-negative': 'reports/control.cdx.json', 'negative-scan': 'reports/negative-scan.json', 'image-scan': 'reports/image-scan.json' };
  const database = { 'db/metadata.json': hash('metadata'), 'db/trivy.db': hash('database') }, metadata = { Version: 2, UpdatedAt: '2026-09-29T00:00:00Z' }, nonce = '0123456789abcdef';
  const receipt: Receipt = {
    schema: 'open-harness-debian-origin-gate/1', ok: true, nonce, architecture: arch,
    image: { id: gated, os: 'linux', architecture: arch, labels: { 'dev.openharness.runtime': '7', 'org.opencontainers.image.revision': revision } },
    sources: { files: debianOriginSources(root), runtimeContract: '7' },
    scanner: { sha256: hash('trivy'), version: { Version: '0.74.0', VulnerabilityDB: metadata } },
    database: { sourceBefore: database, usedBefore: { ...database }, sourceAfter: { ...database }, usedAfter: { ...database }, metadata },
    probe: { user: '1001:118', bind: { architecture: arch, packages: debian, inventoryDigest: hash('inventory'), files: 48, omittedByPolicy: 5, links: 2 }, componentRoot: { root: '/out/component', packages: debian, files: 53 }, containers: ['probe-component-root', 'probe-bind'].map(name => ({ container: `oh-debian-origin-gate-${nonce}-${name}`, action: 'absent' })) },
    calls: [{ name: '00-docker-version', stdout: stream('calls/00-docker-version.stdout', '{}'), stderr: stream('calls/00-docker-version.stderr', '') }],
    steps: steps.map(([name, code]) => ({ name, command: ['synthetic', name], expectedReturncode: code, returncode: code, timedOut: false, seconds: 1, stdout: stream(`steps/${name}.stdout`, `${name}\n`), stderr: stream(`steps/${name}.stderr`, ''), outputs: reports[name] ? { [reports[name]]: stream(reports[name], JSON.stringify({ step: name })).sha256 } : {} })),
    reports: { 'component-scan': { artifactName: '/gate/work/probe/component', artifactType: 'filesystem' }, 'component-sbom': { bomFormat: 'CycloneDX', componentName: '/gate/work/probe/component' }, 'sbom-scan': { artifactName: '/gate/reports/component.cdx.json', artifactType: 'cyclonedx' }, 'negative-scan': { artifactName: '/gate/reports/control.cdx.json', artifactType: 'cyclonedx' }, 'image-scan': { artifactName: gated, artifactType: 'container_image', imageId: gated, os: 'linux', architecture: arch } },
    checks: { 'check-component': { architecture: arch, packages: debian, vulnerabilities: 0, secrets: 0 }, 'check-sbom': { architecture: arch, packages: debian }, 'check-sbom-scan': { architecture: arch, packages: debian, vulnerabilities: 0, secrets: 0 }, 'check-negative': { ...DEBIAN_ORIGIN_NEGATIVE, severeFindings: 468, ids: 234 }, 'check-image': { os: 'ubuntu', packages: 5, debianOriginSeenAsUbuntu: debian } },
    negativeControl: { ...DEBIAN_ORIGIN_NEGATIVE, severeFindings: 468, ids: 234 },
  };
  writeFileSync(join(directory, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`);
  return receipt;
}

function workspace(t: { after: (fn: () => void) => void }) {
  const root = mkdtempSync(join(tmpdir(), 'open-harness-debian-origin-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  checkout(root);
  return root;
}

test('Debian-origin sources mirror the gate: regular files only, links refused, bytecode caches skipped', t => {
  const root = workspace(t);
  const sources = debianOriginSources(root);
  assert.deepEqual(Object.keys(sources), ['runtime/hermes/Dockerfile', 'runtime/readiness.ts', 'runtime/ubuntu/helpers/debian_origin.py', 'runtime/ubuntu/helpers/ohpkg.py', 'runtime/ubuntu/lock/runtime-inputs.lock.json', 'runtime/ubuntu/lock/ubuntu-os-packages.txt', 'scripts/debian-origin-gate.py']);
  assert.equal(sources['runtime/readiness.ts'], hash('export const RUNTIME_CONTRACT = 7;\n'));
  mkdirSync(join(root, 'runtime/ubuntu/helpers/__pycache__'));
  writeFileSync(join(root, 'runtime/ubuntu/helpers/__pycache__/ohpkg.cpython-312.pyc'), 'never read');
  assert.deepEqual(debianOriginSources(root), sources);
  writeFileSync(join(root, 'runtime/ubuntu/helpers/new_helper.py'), 'new\n');
  assert.equal(debianOriginSources(root)['runtime/ubuntu/helpers/new_helper.py'], hash('new\n'));
  if (process.platform !== 'win32') {
    symlinkSync('runtime-inputs.lock.json', join(root, 'runtime/ubuntu/lock/alias.json'));
    assert.throws(() => debianOriginSources(root), /must not contain links: runtime\/ubuntu\/lock\/alias\.json/);
    unlinkSync(join(root, 'runtime/ubuntu/lock/alias.json'));
    unlinkSync(join(root, 'runtime/readiness.ts'));
    symlinkSync('../package.json', join(root, 'runtime/readiness.ts'));
    assert.throws(() => debianOriginSources(root), /runtime\/readiness\.ts must be a regular file/);
  }
});

test('the Debian-origin receipt binds image, sources, database, steps and evidence', t => {
  const root = workspace(t), directory = join(root, 'release-images', DEBIAN_ORIGIN_GATE);
  gate(root, directory);
  const summary = validateDebianOriginGate(directory, { image, architecture, revision, root });
  assert.deepEqual(summary, { receiptSha256: hash(readFileSync(join(directory, 'receipt.json'))), image, architecture, scannerSha256: hash('trivy'), database: { trivyDbSha256: hash('database'), updatedAt: '2026-09-29T00:00:00Z' }, negativeControl: { severeFindings: 468, ids: 234 } });
  assert.equal(validateDebianOriginRecord(summary, architecture), summary);
});

test('publication refuses missing, foreign, altered or incomplete Debian-origin evidence', t => {
  const root = workspace(t), base = join(root, 'base');
  gate(root, base);
  let index = 0;
  const refuse = (message: RegExp, change: (receipt: Receipt, directory: string) => void, expected: { image?: string; architecture?: string; revision?: string } = {}) => {
    const directory = join(root, `case-${index++}`);
    cpSync(base, directory, { recursive: true });
    const receipt: Receipt = JSON.parse(readFileSync(join(directory, 'receipt.json'), 'utf8'));
    change(receipt, directory);
    if (existsSync(join(directory, 'receipt.json'))) writeFileSync(join(directory, 'receipt.json'), JSON.stringify(receipt));
    assert.throws(() => validateDebianOriginGate(directory, { image, architecture, revision, root, ...expected }), message, message.source);
  };
  const step = (receipt: Receipt, name: string) => receipt.steps.find(item => item.name === name) as Step;
  refuse(/No Debian-origin gate receipt/, (_, directory) => { unlinkSync(join(directory, 'receipt.json')); writeFileSync(join(directory, 'failure.json'), '{"ok": false}'); });
  refuse(/did not pass/, receipt => { receipt.ok = false; });
  refuse(/Unknown Debian-origin gate receipt schema/, receipt => { receipt.schema = 'open-harness-debian-origin-gate/0'; });
  refuse(/ran for amd64, not arm64/, receipt => { receipt.architecture = 'amd64'; });
  refuse(/receipt is for another image/, () => undefined, { image: digest('other') });
  refuse(/exact scanned Hermes image ID/, () => undefined, { image: 'open-harness-hermes:release-candidate' });
  refuse(/another platform/, receipt => { receipt.image.architecture = 'amd64'; });
  refuse(/another runtime contract/, receipt => { receipt.image.labels['dev.openharness.runtime'] = '6'; });
  refuse(/built from another revision/, () => undefined, { revision: 'b'.repeat(40) });
  refuse(/whole-image scan must be of the exact image/, receipt => { receipt.reports['image-scan'].imageId = digest('other'); });
  refuse(/whole-image scan must be of the exact image/, receipt => { receipt.reports['image-scan'].artifactName = 'open-harness-hermes:release-candidate'; });
  refuse(/Every Debian-origin component report must name its artifact/, receipt => { receipt.reports['negative-scan'].artifactType = 'repository'; });
  refuse(/Every Debian-origin component report must name its artifact/, receipt => { delete receipt.reports['component-sbom']; });
  refuse(/other gate, helper, lock, Dockerfile or readiness sources/, receipt => { receipt.sources.files['runtime/ubuntu/helpers/debian_origin.py'] = hash('older helper'); });
  refuse(/must record its scanner binary/, receipt => { receipt.scanner.sha256 = ''; });
  refuse(/must record its vulnerability database/, receipt => { delete receipt.database.sourceBefore['db/trivy.db']; });
  refuse(/database changed during the Debian-origin gate \(usedAfter\)/, receipt => { receipt.database.usedAfter['db/trivy.db'] = hash('changed'); });
  refuse(/database changed during the Debian-origin gate \(sourceAfter\)/, receipt => { receipt.database.sourceAfter = {}; });
  refuse(/did not report the gated database/, receipt => { receipt.scanner.version.VulnerabilityDB.UpdatedAt = '2020-01-01T00:00:00Z'; });
  refuse(/all thirteen steps/, receipt => { receipt.steps = receipt.steps.filter(item => item.name !== 'check-negative'); });
  refuse(/all thirteen steps/, receipt => { receipt.steps.reverse(); });
  refuse(/all thirteen steps/, receipt => { step(receipt, 'negative-scan').returncode = 0; });
  refuse(/all thirteen steps/, receipt => { step(receipt, 'image-scan').timedOut = true; });
  refuse(/image-scan step lacks reports\/image-scan\.json/, receipt => { step(receipt, 'image-scan').outputs = {}; });
  refuse(/evidence steps\/check-image\.stdout changed after the gate/, (_, directory) => { writeFileSync(join(directory, 'steps/check-image.stdout'), 'edited'); });
  refuse(/evidence reports\/negative-scan\.json changed after the gate/, (_, directory) => { writeFileSync(join(directory, 'reports/negative-scan.json'), '{"step": "copied from another run"}'); });
  refuse(/evidence reports\/image-scan\.json is missing/, (_, directory) => { unlinkSync(join(directory, 'reports/image-scan.json')); });
  refuse(/Unsafe Debian-origin evidence path: \.\.\/receipt\.json/, receipt => { step(receipt, 'check-image').stdout.path = '../receipt.json'; });
  refuse(/check-component result is incomplete/, receipt => { receipt.checks['check-component'].vulnerabilities = 1; });
  refuse(/check-sbom-scan result is incomplete/, receipt => { receipt.checks['check-sbom-scan'].architecture = 'amd64'; });
  refuse(/SBOM check result is incomplete/, receipt => { delete receipt.checks['check-sbom']; });
  refuse(/exactly the locked package set/, receipt => { receipt.checks['check-image'].packages = 329; });
  refuse(/keep the Ubuntu OS identity/, receipt => { receipt.checks['check-image'].os = 'debian'; });
  refuse(/prove HIGH\/CRITICAL advisory lookup/, receipt => { receipt.negativeControl.severeFindings = 0; });
  refuse(/regress the reviewed Chromium source version/, receipt => { receipt.negativeControl.version = '154.0.8037.57-1~deb13u1'; });
  refuse(/summary differs from its check/, receipt => { receipt.negativeControl.severeFindings = 1; });
  refuse(/non-root user/, receipt => { receipt.probe.user = '0:0'; });
  refuse(/bound to this architecture and the locked packages/, receipt => { receipt.probe.bind.architecture = 'amd64'; });
  refuse(/bound to this architecture and the locked packages/, receipt => { receipt.probe.componentRoot.packages = ['chromium']; });
  refuse(/rebuilt component differs from the bound inventory/, receipt => { receipt.probe.componentRoot.files = 52; });
  refuse(/Both probe containers of this gate must be gone/, receipt => { receipt.probe.containers.pop(); });
  refuse(/Both probe containers of this gate must be gone/, receipt => { receipt.probe.containers[1].action = 'left-running'; });
  refuse(/Both probe containers of this gate must be gone/, receipt => { receipt.probe.containers[0].container = 'oh-debian-origin-gate-ffffffffffffffff-probe-component-root'; });
});

test('manifests join only candidates published with a passing Debian-origin gate record', () => {
  const record = { receiptSha256: hash('receipt'), image, architecture, scannerSha256: hash('trivy'), negativeControl: { severeFindings: 468, ids: 234 } };
  assert.equal(validateDebianOriginRecord(record, 'arm64'), record);
  assert.throws(() => validateDebianOriginRecord(undefined, 'arm64'), /linux\/arm64 candidate was published without a Debian-origin gate record/);
  assert.throws(() => validateDebianOriginRecord(record, 'amd64'), /record is for arm64, not amd64/);
  assert.throws(() => validateDebianOriginRecord({ ...record, receiptSha256: undefined }, 'arm64'), /must name its receipt/);
  assert.throws(() => validateDebianOriginRecord({ ...record, negativeControl: { severeFindings: 0 } }, 'arm64'), /must have found HIGH\/CRITICAL advisories/);
});

// Publication with a fake docker CLI that logs every call and answers only `image inspect` for the local candidates.
function publisher(t: { after: (fn: () => void) => void }) {
  const root = workspace(t);
  const lock = { schemaVersion: 2, base: { ref: `docker.io/library/docker:28.1.1-dind@${digest('base')}` }, expat: { package: 'libexpat', version: '2.7.1-r0', file: 'apk/libexpat-2.7.1-r0.apk' }, architectures: {} as Record<string, unknown> };
  for (const [index, platform] of PLATFORMS.entries()) {
    const paths = [lock.expat.file, ...ENGINE_BINARIES, ...Object.values(ENGINE_MANIFESTS)];
    lock.architectures[platform] = { status: 'complete', inputs: `ghcr.io/sflow-hub/open-harness-engine-inputs@${digest(String(index))}`, files: Object.fromEntries(paths.map(path => [path, hash(`${platform} ${path}`)])), components: Object.fromEntries(Object.entries(ENGINE_MANIFESTS).map(([name, path]) => [name, { version: `v1.2.3+fixture.${platform.split('/')[1]}`, sourceManifest: hash(`${platform} ${path}`) }])) };
  }
  const lockText = `${JSON.stringify(lock, null, 2)}\n`, lockSha256 = hash(lockText);
  mkdirSync(join(root, 'runtime', 'engine'), { recursive: true }); mkdirSync(join(root, 'bin')); mkdirSync(join(root, 'release-images'));
  writeFileSync(join(root, 'runtime', 'engine', 'inputs.lock.json'), lockText);
  writeFileSync(join(root, 'package.json'), JSON.stringify({ version: '0.3.0-beta.1' }));
  const entry = lock.architectures['linux/arm64'] as { inputs: string; files: Record<string, string> };
  const candidate = (id: string, labels: Record<string, string>) => ({ Id: digest(id), Os: 'linux', Architecture: 'arm64', Config: { Labels: { ...labels, 'org.opencontainers.image.revision': revision } } });
  const images = { coordinator: candidate('2', { 'dev.openharness.buildx.inputs': entry.inputs, 'dev.openharness.buildx.sha256': entry.files['buildx/bin/docker-buildx'] }), engine: candidate('1', engineLabels(lock, 'arm64', lockSha256)), hermes: candidate('3', {}) };
  writeFileSync(join(root, 'images.json'), JSON.stringify(images));
  writeFileSync(join(root, 'release-images', 'scanned-images.json'), JSON.stringify({ version: '0.3.0-beta.1', revision, platform: 'linux/arm64', engineInputsLockSha256: lockSha256, images: Object.fromEntries(Object.entries(images).map(([name, item]) => [name, { localId: item.Id, configDigest: item.Id, buildDigest: digest('9') }])) }));
  writeFileSync(join(root, 'fake-docker.mjs'), [
    "import { appendFileSync, readFileSync } from 'node:fs';",
    "const args = process.argv.slice(2), images = JSON.parse(readFileSync('images.json', 'utf8'));",
    "appendFileSync('docker-calls.log', `${JSON.stringify(args)}\\n`);",
    "const name = /^open-harness-([a-z]+):release-candidate$/.exec(args[2] || '')?.[1];",
    "if (args[0] === 'image' && args[1] === 'inspect' && name && images[name]) process.stdout.write(JSON.stringify([images[name]]));",
    "else { process.stderr.write(`unexpected docker ${args.join(' ')}`); process.exitCode = 1; }",
    '',
  ].join('\n'));
  writeFileSync(join(root, 'bin', 'docker'), `#!/bin/sh\nexec '${process.execPath}' '${join(root, 'fake-docker.mjs')}' "$@"\n`);
  chmodSync(join(root, 'bin', 'docker'), 0o755);
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${join(root, 'bin')}${delimiter}${process.env.PATH}`, GITHUB_SHA: revision, GITHUB_REPOSITORY_OWNER: 'sflow-hub' };
  const run = (...args: string[]) => spawnSync(process.execPath, [releaseImages, ...args], { cwd: root, encoding: 'utf8', env });
  const calls = () => (existsSync(join(root, 'docker-calls.log')) ? readFileSync(join(root, 'docker-calls.log'), 'utf8').trim().split('\n').map(line => JSON.parse(line) as string[]) : []);
  return { root, run, calls, lockText };
}

test('publish-architecture refuses before any docker call unless the gate passed for the exact scanned image', t => {
  if (process.platform === 'win32') { t.skip('The fake docker CLI is a POSIX shell script.'); return; }
  const { root, run, calls, lockText } = publisher(t);
  const directory = join(root, 'release-images', DEBIAN_ORIGIN_GATE);
  const missing = run('publish-architecture', 'release-images', 'arm64');
  assert.notEqual(missing.status, 0); assert.match(missing.stderr, /No Debian-origin gate receipt/);
  assert.deepEqual(calls(), []);
  gate(root, directory, digest('another image'));
  const foreign = run('publish-architecture', 'release-images', 'arm64');
  assert.notEqual(foreign.status, 0); assert.match(foreign.stderr, /receipt is for another image/);
  assert.deepEqual(calls(), []);
  rmSync(directory, { recursive: true });
  gate(root, directory);
  const amd64 = run('publish-architecture', 'release-images', 'amd64');
  assert.notEqual(amd64.status, 0); assert.match(amd64.stderr, /AssertionError/);
  assert.deepEqual(calls(), []);
  // A passing gate for the scanned Hermes image lets publication reach docker; the fake then refuses to tag.
  const passed = run('publish-architecture', 'release-images', 'arm64');
  assert.notEqual(passed.status, 0); assert.match(passed.stderr, /unexpected docker tag open-harness-coordinator:release-candidate/);
  assert.deepEqual(calls().map(args => args.slice(0, 2)), [['image', 'inspect'], ['tag', 'open-harness-coordinator:release-candidate']]);
  assert.ok(!existsSync(join(root, 'release-images', 'arm64.json')));
  // The engine lock check still comes first.
  writeFileSync(join(root, 'runtime', 'engine', 'inputs.lock.json'), lockText.trim());
  rmSync(join(root, 'docker-calls.log'));
  const drifted = run('publish-architecture', 'release-images', 'arm64');
  assert.notEqual(drifted.status, 0); assert.match(drifted.stderr, /engine inputs lock changed after the scan/);
  assert.deepEqual(calls(), []);
});

test('publish-manifests refuses candidates without their own passing gate record before any docker call', t => {
  if (process.platform === 'win32') { t.skip('The fake docker CLI is a POSIX shell script.'); return; }
  const { root, run, calls } = publisher(t);
  const record = { receiptSha256: hash('receipt'), image, scannerSha256: hash('trivy'), negativeControl: { severeFindings: 468, ids: 234 } };
  const write = (records: Record<string, object | undefined>) => {
    for (const platform of PLATFORMS) {
      const arch = platform.split('/')[1];
      writeFileSync(join(root, 'release-images', `${arch}.json`), JSON.stringify({ version: '0.3.0-beta.1', revision, platform, images: {}, debianOriginGate: records[arch] }));
    }
  };
  write({ amd64: undefined, arm64: { ...record, architecture: 'arm64' } });
  const unrecorded = run('publish-manifests', 'release-images');
  assert.notEqual(unrecorded.status, 0); assert.match(unrecorded.stderr, /linux\/amd64 candidate was published without a Debian-origin gate record/);
  write({ amd64: { ...record, architecture: 'arm64' }, arm64: { ...record, architecture: 'arm64' } });
  const swapped = run('publish-manifests', 'release-images');
  assert.notEqual(swapped.status, 0); assert.match(swapped.stderr, /record is for arm64, not amd64/);
  assert.deepEqual(calls(), []);
});

test('verify-debian-origin-gate checks a gate directory read-only', t => {
  const root = workspace(t), directory = join(root, 'gate-output');
  gate(root, directory);
  const run = (...args: string[]) => spawnSync(process.execPath, [releaseImages, 'verify-debian-origin-gate', ...args], { cwd: root, encoding: 'utf8', env: { PATH: process.env.PATH, NODE_ENV: 'test', GITHUB_SHA: revision } });
  const verified = run(directory, 'arm64', image);
  assert.equal(verified.status, 0, verified.stderr);
  assert.equal(JSON.parse(verified.stdout).receiptSha256, hash(readFileSync(join(directory, 'receipt.json'))));
  assert.match(run(directory, 'arm64', digest('another image')).stderr, /receipt is for another image/);
  const absent = run(join(root, 'absent'), 'arm64', image);
  assert.notEqual(absent.status, 0); assert.match(absent.stderr, /No Debian-origin gate receipt/);
  assert.ok(!existsSync(join(root, 'absent')), 'verification never creates the directory');
  const wrongRevision = spawnSync(process.execPath, [releaseImages, 'verify-debian-origin-gate', directory, 'arm64', image], { cwd: root, encoding: 'utf8', env: { PATH: process.env.PATH, NODE_ENV: 'test', GITHUB_SHA: 'b'.repeat(40) } });
  assert.match(wrongRevision.stderr, /built from another revision/);
});

test('release workflow gates the exact scanned Hermes image before it is exercised or published', () => {
  const release = readFileSync(join(repositoryRoot, '.github', 'workflows', 'release.yml'), 'utf8');
  const at = (text: string) => { const index = release.indexOf(text); assert.ok(index >= 0, text); return index; };
  const order = ['\n  images:', 'name: Record immutable scan inputs', 'name: Scan Hermes image', 'name: Require the scanner and Python for the Debian-origin gate', 'name: Download one vulnerability database for the Debian-origin gate', 'name: Gate the Debian-origin packages of the exact scanned Hermes image', 'name: Exercise real Hermes protocol and tool enforcement', 'name: Publish only the scanned and exercised architecture candidates', 'name: Preserve native runtime evidence', '\n  package:'];
  assert.deepEqual(order.map(at), order.map(at).slice().sort((a, b) => a - b), 'The gate runs inside the images job between the Hermes scan and any exercise or publication.');
  for (const required of ['trivy=$(command -v trivy) ||', "sys.exit(sys.version_info < (3, 11))", '--download-db-only', "require('./release-images/scanned-images.json').images.hermes.localId", 'python3 -I -B scripts/debian-origin-gate.py --image "$image"', '--trivy "$OPEN_HARNESS_TRIVY"', '--out release-images/debian-origin-gate', "node scripts/release-images.mjs verify-debian-origin-gate release-images/debian-origin-gate '${{ matrix.architecture }}' \"$image\"", 'release-images/debian-origin-gate/reports/', 'release-images/debian-origin-gate/steps/', 'release-images/debian-origin-gate/*.json']) assert.ok(release.includes(required), required);
  assert.equal((release.match(/scanners: vuln,secret/g) || []).length, 3, 'The engine, coordinator and whole-Hermes scans stay unchanged.');
  assert.doesNotMatch(release, /continue-on-error|ignore-unfixed: true|exit-code: '0'|--skip-dirs|--skip-files/);
  const actions = [...new Set([...release.matchAll(/uses: (\S+)/g)].map(match => match[1]))].sort();
  assert.deepEqual(actions, ['actions/checkout@v4', 'actions/download-artifact@v4', 'actions/setup-node@v4', 'actions/setup-python@v5', 'actions/upload-artifact@v4', 'aquasecurity/trivy-action@v0.36.0', 'docker/build-push-action@v6', 'docker/login-action@v3', 'docker/setup-buildx-action@v3'], 'No new or re-versioned actions.');
});
