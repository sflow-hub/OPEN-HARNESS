import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { DEFAULT_COMPUTER } from '../lib/agent-profile';
import { agentMountDirs, containerNameFor, containerSignature } from '../runtime/hermes';

const prefix = 'a'.repeat(48);
const ids = [prefix + 'b'.repeat(32), prefix + 'c'.repeat(32)];

test('long agent IDs have distinct, deterministic, bounded container names', () => {
  assert.notEqual(containerNameFor(ids[0]), containerNameFor(ids[1]));
  for (const id of ids) {
    assert.equal(id.length, 80);
    const name = containerNameFor(id);
    assert.equal(name, containerNameFor(id));
    assert.equal(name.length, 'open-harness-'.length + 48);
    assert.match(name, /^open-harness-a{39}-[0-9a-f]{8}$/);
  }
});

test('short agent IDs keep legacy container names', () => {
  for (const id of ['a', 'Agent_1-test', prefix]) assert.equal(containerNameFor(id), `open-harness-${id}`);
});

test('agent mounts use the full ID for every private directory', () => {
  const dirs = ids.map(id => agentMountDirs('/state', id));
  for (const key of ['profile', 'privateDir', 'managed'] as const) assert.notEqual(dirs[0][key], dirs[1][key]);
  ids.forEach((id, index) => assert.deepEqual(dirs[index], {
    profile: join('/state', 'agents', id, 'profile'),
    privateDir: join('/state', 'agents', id, 'private'),
    managed: join('/state', 'agents', id, 'managed'),
  }));
});

test('short agent IDs keep legacy container signatures', () => {
  const legacy = containerSignature(DEFAULT_COMPUTER, 'image', '/state');
  for (const id of ['a', 'Agent_1-test', prefix]) assert.equal(containerSignature(DEFAULT_COMPUTER, 'image', '/state', [], id), legacy);
});

test('container signatures bind the full long agent ID', () => {
  const signature = (id: string) => containerSignature(DEFAULT_COMPUTER, 'image', '/state', [], id);
  assert.notEqual(signature(ids[0]), signature(ids[1]));
  assert.equal(signature(ids[0]), signature(ids[0]));
  assert.notEqual(signature(ids[0]), containerSignature(DEFAULT_COMPUTER, 'image', '/state'));
});
