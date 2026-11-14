import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { dockerStatus, dockerStatusCached, ensureContainer, stateSharingAsync } from '../runtime/hermes';
import { onboardingStatus, qualifiedImage, RUNTIME_CONTRACT } from '../runtime/readiness';

test('every runtime image reference is fully qualified, including custom overrides', () => {
  assert.equal(qualifiedImage('open-harness-hermes:2026.9.11'), 'docker.io/library/open-harness-hermes:2026.9.11');
  assert.equal(qualifiedImage('hermes-dev:ci'), 'docker.io/library/hermes-dev:ci');
  assert.equal(qualifiedImage('myorg/hermes:dev'), 'docker.io/myorg/hermes:dev');
  assert.equal(qualifiedImage('docker.io/library/open-harness-hermes:x'), 'docker.io/library/open-harness-hermes:x');
  assert.equal(qualifiedImage(`ghcr.io/org/hermes@sha256:${'a'.repeat(64)}`), `ghcr.io/org/hermes@sha256:${'a'.repeat(64)}`);
  assert.equal(qualifiedImage('localhost/hermes:dev'), 'localhost/hermes:dev');
  assert.equal(qualifiedImage('registry:5000/hermes:dev'), 'registry:5000/hermes:dev');
});

test('an unshared data folder gets the file-sharing advice, and only a Docker failure says Docker is not responding', { skip: process.platform === 'win32' }, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'harness-sharing-')), state = join(dir, 'probe');
  const oldPath = process.env.PATH, oldMock = process.env.OPEN_HARNESS_MOCK;
  t.after(() => {
    if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
    if (oldMock === undefined) delete process.env.OPEN_HARNESS_MOCK; else process.env.OPEN_HARNESS_MOCK = oldMock;
    rmSync(dir, { recursive: true, force: true });
  });
  writeFileSync(join(dir, 'docker'), `#!/usr/bin/env node
const [code, message] = require('node:fs').readFileSync(${JSON.stringify(state)}, 'utf8').split('|');
console.error(message); process.exit(Number(code));
`, { mode: 0o755 });
  process.env.PATH = dir + delimiter + oldPath;
  process.env.OPEN_HARNESS_MOCK = '0';
  const probe = async (code: number, message: string, fresh = true) => { writeFileSync(state, `${code}|${message}`); return (await stateSharingAsync(join(dir, 'state'), fresh)).detail; };
  // Docker Desktop on Linux: the container starts, but the unshared folder is empty.
  assert.match(await probe(1, 'cat: /probe/canary: No such file or directory'), /File sharing/);
  assert.match(await probe(125, 'docker: Error response from daemon: mounts denied: The path is not shared from the host'), /File sharing/);
  assert.match(await probe(125, 'docker: Cannot connect to the Docker daemon'), /Docker is responding/);
  // A failure is reused briefly so callers do not each start a new probe, then expires.
  assert.match(await probe(1, 'cat: /probe/canary: No such file or directory', false), /Docker is responding/);
  const now = Date.now(); t.mock.method(Date, 'now', () => now + 16_000);
  assert.match(await probe(1, 'cat: /probe/canary: No such file or directory', false), /File sharing/);
});

test('failed inspection is not setup, and a stale negative cache waits for Docker recovery', { skip: process.platform === 'win32' }, async t => {
  const dir = mkdtempSync(join(tmpdir(), 'harness-readiness-')), state = join(dir, 'probe');
  const oldPath = process.env.PATH, oldMock = process.env.OPEN_HARNESS_MOCK;
  t.after(() => {
    if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
    if (oldMock === undefined) delete process.env.OPEN_HARNESS_MOCK; else process.env.OPEN_HARNESS_MOCK = oldMock;
    rmSync(dir, { recursive: true, force: true });
  });
  writeFileSync(join(dir, 'docker'), `#!/usr/bin/env node
const fs = require('node:fs');
const mode = fs.readFileSync(${JSON.stringify(state)}, 'utf8');
if (process.argv[2] === 'version' || process.argv[2] === '--version') { console.log('29.5.3'); process.exit(0); }
if (process.argv[2] !== 'image') { console.error('Unexpected Docker operation'); process.exit(2); }
// Reproduce Docker Desktop resolving the qualified name but rejecting shorthand.
if (process.argv.at(-1).startsWith('open-harness-hermes:')) { console.error('No such image: ' + process.argv.at(-1)); process.exit(1); }
if (mode === 'current') { console.log(${RUNTIME_CONTRACT}); process.exit(0); }
console.error(mode === 'missing' ? 'No such image: hermes:test' : 'Docker daemon did not respond');
process.exit(1);
`, { mode: 0o755 });
  process.env.PATH = dir + delimiter + oldPath;
  process.env.OPEN_HARNESS_MOCK = '0';
  writeFileSync(state, 'unknown');
  assert.match(dockerStatus().message, /could not check/);
  const readiness = await onboardingStatus([], dir);
  assert.equal(readiness.executionReady, false);
  assert.equal(readiness.checks.find(check => check.id === 'agent-runtime')?.action, undefined, 'do not prescribe a rebuild after an inconclusive probe');
  await assert.rejects(async () => ensureContainer('atlas', dir), /could not check/);
  writeFileSync(state, 'missing');
  const missing = await dockerStatusCached();
  assert.equal(missing.available, false);
  assert.match(missing.message, /not set up/);
  writeFileSync(state, 'current');
  const now = Date.now();
  t.mock.method(Date, 'now', () => now + 6_000);
  const recovered = await dockerStatusCached();
  assert.equal(recovered.available, true, 'the first request after expiry must receive the refreshed answer');
});
