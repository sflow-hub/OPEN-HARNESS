// The runtime contract ties three things together that no single tool checks: the number
// baked into the image as a label, the number the coordinator and runner compare it with,
// and the container signature that decides whether an existing container still matches.
// Plus the state-directory choice that setup makes, which must be pure to be testable.
import test from 'node:test';
import { HERMES_COMMIT, HERMES_IMAGE_TAG, HERMES_RELEASE } from '../lib/hermes-pin';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { RUNTIME_CONTRACT, RUNTIME_LABEL, classifyContract, imageContract, imageContractWith, runtimeImageMessage } from '../runtime/readiness';
import { containerSignature } from '../runtime/hermes';
import { chooseStateDir, withEnvValue } from '../runtime/state-dir';
import { DEFAULT_COMPUTER } from '../lib/agent-profile';

const root = join(import.meta.dirname, '..');

for (const file of ['runtime/hermes/Dockerfile', 'runtime/hermes/extension/Dockerfile.patch']) {
  test(`${file} declares runtime contract ${RUNTIME_CONTRACT} as the image label`, () => {
    const text = readFileSync(join(root, file), 'utf8');
    const arg = text.match(/^ARG OPEN_HARNESS_RUNTIME=(\d+)$/m);
    assert.ok(arg, 'ARG OPEN_HARNESS_RUNTIME is missing');
    assert.equal(Number(arg![1]), RUNTIME_CONTRACT, 'image contract drifted from RUNTIME_CONTRACT');
    assert.match(text, new RegExp(`^LABEL ${RUNTIME_LABEL.replaceAll('.', '\\.')}=\\$OPEN_HARNESS_RUNTIME$`, 'm'));
  });
}

test('the full Dockerfile installs managed policy files after the upstream layers', () => {
  const text = readFileSync(join(root, 'runtime/hermes/Dockerfile'), 'utf8');
  // Dependency constraints must precede installation; policy-only changes must still reuse it.
  const upstream = text.indexOf('hermes computer-use install'), ours = text.search(/^COPY runtime\/hermes\/ \/opt\/open-harness\/$/m);
  assert.ok(upstream > 0 && ours > upstream, 'The managed-policy directory copy must come after the heavy upstream layers so a policy change does not rebuild them');
  assert.ok(text.indexOf(`LABEL ${RUNTIME_LABEL}=`) > ours, 'the contract label must be the last layer so bumping it invalidates nothing');
});

test('classifyContract: no image, unlabeled image, older label, current label', () => {
  assert.equal(classifyContract({ status: 1, stdout: '', stderr: 'Error response from daemon: No such image: hermes:test' }), 'missing');
  assert.equal(classifyContract({ status: 1, stdout: '', stderr: 'Error response from daemon: {"message":"No such image: hermes:test"}' }), 'missing');
  assert.equal(classifyContract({ status: 1, stdout: '', stderr: 'permission denied' }), 'unknown');
  assert.equal(classifyContract({ status: null, stdout: '' }), 'unknown');
  assert.equal(classifyContract({ status: 0, stdout: '\n' }), 'stale');
  assert.equal(classifyContract({ status: 0, stdout: String(RUNTIME_CONTRACT - 1) }), 'stale');
  assert.equal(classifyContract({ status: 0, stdout: `${RUNTIME_CONTRACT}\n` }), 'current');
});

test('image checks retry transient lookup failures but never accept an unverified or stale image', async () => {
  for (const check of [imageContract, (run: Parameters<typeof imageContract>[0]) => imageContractWith(async (name, args) => run!(name, args))]) {
    for (const failure of [
      { status: 1, stdout: '', stderr: 'No such image: hermes:test' },
      { status: null, stdout: '', stderr: '' },
      { status: 1, stdout: '', stderr: 'daemon unavailable' },
    ]) {
      let calls = 0;
      assert.equal(await check(() => ++calls === 1 ? failure : { status: 0, stdout: String(RUNTIME_CONTRACT) }), 'current');
      assert.equal(calls, 2);
      calls = 0;
      assert.equal(await check(() => { calls++; return failure; }), classifyContract(failure));
      assert.equal(calls, 2, 'persistent failures must remain bounded');
    }
    let calls = 0;
    assert.equal(await check(() => { calls++; return { status: 0, stdout: String(RUNTIME_CONTRACT - 1) }; }), 'stale');
    assert.equal(calls, 1, 'a confirmed old contract must require an update');
  }
  assert.doesNotMatch(runtimeImageMessage('unknown'), /first-time|set up|built before/);
  assert.match(runtimeImageMessage('missing'), /current context/);
  // Every instruction must name a screen that exists in the dashboard.
  for (const contract of ['missing', 'stale'] as const) assert.match(runtimeImageMessage(contract), /Workspace settings → Run setup again/);
});

test('imageContract reads the runtime label from the pinned image', () => {
  const calls: string[][] = [];
  const result = imageContract((name, args) => { calls.push([name, ...args]); return { status: 0, stdout: `${RUNTIME_CONTRACT}` }; });
  assert.equal(result, 'current');
  assert.equal(calls.length, 1);
  assert.ok(calls[0].some(arg => arg.includes(RUNTIME_LABEL)), 'must inspect the contract label, not merely check that the image exists');
});

test('a container signature changes with the image and with nothing else', () => {
  const computer = { ...DEFAULT_COMPUTER, resources: { ...DEFAULT_COMPUTER.resources } };
  assert.equal(containerSignature(computer, 'sha256:a'), containerSignature({ ...computer, machineId: 'other', reserveMachine: true }, 'sha256:a'), 'fields that do not affect the container must not change it');
  assert.notEqual(containerSignature(computer, 'sha256:a'), containerSignature(computer, 'sha256:b'), 'a rebuilt image must invalidate the container');
  assert.notEqual(containerSignature(computer, 'sha256:a'), containerSignature({ ...computer, resources: { ...computer.resources, cpu: 4 } }, 'sha256:a'));
  // The mounts are built from the state root. Reusing a container after the data folder moved
  // left it bound to the old path, Docker recreated that path empty, and the run died with
  // "Hermes gateway exited during startup" over a log line telling the operator to rebuild the image.
  assert.notEqual(containerSignature(computer, 'sha256:a', '/home/a/state'), containerSignature(computer, 'sha256:a', '/home/b/state'),
    'a moved state directory must invalidate the container');
  assert.equal(containerSignature(computer, 'sha256:a', '/home/a/state'), containerSignature(computer, 'sha256:a', '/home/a/state/'),
    'the same directory spelled differently must not');
});

test('chooseStateDir: explicit, then existing state, then a readable project folder, then home', async () => {
  const base = { projectDefault: '/proj/.open-harness', homeDefault: '/home/u/.open-harness/proj' };
  assert.deepEqual(await chooseStateDir({ ...base, explicit: '/elsewhere', hasState: () => true, dockerCanRead: async () => false }), { path: resolve('/elsewhere'), reason: 'explicit' });
  assert.deepEqual(await chooseStateDir({ ...base, hasState: () => true, dockerCanRead: async () => false }), { path: resolve('/proj/.open-harness'), reason: 'existing' });
  assert.deepEqual(await chooseStateDir({ ...base, hasState: () => false, dockerCanRead: async () => true }), { path: resolve('/proj/.open-harness'), reason: 'project' });
  assert.deepEqual(await chooseStateDir({ ...base, hasState: () => false, dockerCanRead: async () => false }), { path: resolve('/home/u/.open-harness/proj'), reason: 'home' });
});

test('withEnvValue appends, fills an empty assignment, and never overrides a set one', () => {
  assert.equal(withEnvValue('', 'OPEN_HARNESS_STATE_DIR', '/a b'), 'OPEN_HARNESS_STATE_DIR="/a b"\n');
  assert.equal(withEnvValue('XAI_API_KEY=x', 'OPEN_HARNESS_STATE_DIR', '/a'), 'XAI_API_KEY=x\nOPEN_HARNESS_STATE_DIR="/a"\n');
  assert.equal(withEnvValue('XAI_API_KEY=x\nOPEN_HARNESS_STATE_DIR=\nOTHER=1\n', 'OPEN_HARNESS_STATE_DIR', '/a'), 'XAI_API_KEY=x\nOPEN_HARNESS_STATE_DIR="/a"\nOTHER=1\n');
  assert.equal(withEnvValue('OPEN_HARNESS_STATE_DIR=/keep\n', 'OPEN_HARNESS_STATE_DIR', '/a'), null);
  assert.equal(withEnvValue('OPEN_HARNESS_STATE_DIR="/keep"\n', 'OPEN_HARNESS_STATE_DIR', '/a'), null);
  assert.equal(withEnvValue('# OPEN_HARNESS_STATE_DIR=\n', 'OPEN_HARNESS_STATE_DIR', '/a'), '# OPEN_HARNESS_STATE_DIR=\nOPEN_HARNESS_STATE_DIR="/a"\n', 'a commented line is not an assignment');
});

test('the pinned Hermes build agrees across the constants, the Dockerfile and the release workflow', () => {
  const root = join(import.meta.dirname, '..');
  const dockerfile = readFileSync(join(root, 'runtime', 'hermes', 'Dockerfile'), 'utf8');
  // The Dockerfile cannot import the constants, so drift is caught here instead.
  assert.match(dockerfile, new RegExp(`^ARG HERMES_COMMIT=${HERMES_COMMIT}$`, 'm'));
  const release = readFileSync(join(root, '.github', 'workflows', 'release.yml'), 'utf8');
  for (const line of release.split('\n').filter(item => item.includes('open-harness-hermes:'))) {
    const tags = [...line.matchAll(/open-harness-hermes:([\w.-]+)/g)].map(match => match[1]);
    for (const tag of tags) assert.ok([HERMES_IMAGE_TAG, 'release-candidate'].includes(tag) || tag.startsWith('${{'), `unexpected image tag ${tag} in release.yml`);
  }
  assert.equal(HERMES_IMAGE_TAG, HERMES_RELEASE.replace(/^v/, ''));
});
