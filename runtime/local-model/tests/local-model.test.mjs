import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { guidePrivateEdit } from '../server.mjs';
import { prepareWeights } from '../weights.mjs';

const dirs = [];
afterEach(async () => { for (const path of dirs.splice(0)) await rm(path, { recursive: true, force: true }); });
async function cache() {
  const path = await mkdtemp(join(tmpdir(), 'open-harness-weights-'));
  dirs.push(path);
  return path;
}
const bytes = Buffer.from('valid model fixture');
const weight = { filename: 'example.gguf', url: 'https://example.invalid/model', bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') };
const report = () => {};

test('resumes a partial transfer, atomically publishes verified bytes and reuses them offline', async () => {
  const dir = await cache();
  const partial = join(dir, weight.filename + '.part');
  await writeFile(partial, bytes.subarray(0, 5));
  const statuses = [];
  const path = await prepareWeights(dir, weight, (...args) => statuses.push(args), async (url, { headers }) => {
    assert.equal(headers.range, 'bytes=5-');
    return new Response(bytes.subarray(5), { status: 206, headers: { 'content-range': 'bytes 5-' + (bytes.length - 1) + '/' + bytes.length } });
  });
  assert.deepEqual(await readFile(path), bytes);
  assert.equal(statuses.at(-1)[0], 'verifying');
  await assert.rejects(stat(partial), { code: 'ENOENT' });
  assert.equal(await prepareWeights(dir, weight, report, () => assert.fail('verified cache must work offline')), path);
});

test('accepts a full response from servers that decline resume and rejects corrupt bytes', async () => {
  const dir = await cache(), path = join(dir, weight.filename);
  await writeFile(path + '.part', Buffer.from('bad '));
  await assert.rejects(prepareWeights(dir, weight, report, async () => new Response(Buffer.alloc(bytes.length))), /checksum/);
  await assert.rejects(stat(path), { code: 'ENOENT' });
  await assert.rejects(stat(path + '.part'), { code: 'ENOENT' });
  await prepareWeights(dir, weight, report, async () => new Response(bytes));
  assert.deepEqual(await readFile(path), bytes);
});

test('a failed HTTP request keeps its partial bytes; a dishonest range is not appended', async () => {
  const dir = await cache(), part = join(dir, weight.filename + '.part');
  await writeFile(part, bytes.subarray(0, 4));
  await assert.rejects(prepareWeights(dir, weight, report, async () => new Response('', { status: 503 })), /HTTP 503/);
  await assert.rejects(prepareWeights(dir, weight, report, async () => new Response(bytes, { status: 206, headers: { 'content-range': 'bytes 0-18/19' } })), /invalid download range/);
  assert.deepEqual(await readFile(part), bytes.subarray(0, 4));
});

test('the private edit asks for a native opening action and releases the requirement after a result', () => {
  const user = { role: 'user', content: 'Edit the private dashboard source at /workspace/private/improvement-test' };
  const first = { messages: [user], tools: [{ type: 'function' }], tool_choice: 'auto' };
  guidePrivateEdit(first);
  assert.equal(first.tool_choice, 'required');
  assert.equal(first.messages[0].role, 'system');
  assert.match(first.messages[0].content, /native tool call/);
  const later = { messages: [{ role: 'system', content: 'Keep existing user files.' }, user, { role: 'tool', content: 'Found the file' }], tools: [{}], tool_choice: 'auto' };
  guidePrivateEdit(later);
  assert.equal(later.tool_choice, 'auto');
  assert.match(later.messages[0].content, /^Keep existing user files/);
  const plain = { messages: [{ role: 'user', content: 'Hello' }], tools: [{}] };
  guidePrivateEdit(plain);
  assert.equal(plain.messages.length, 1);
  assert.equal(plain.tool_choice, undefined);
});
