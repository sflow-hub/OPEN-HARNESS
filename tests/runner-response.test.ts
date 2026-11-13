import test from 'node:test';
import assert from 'node:assert/strict';
import { readRunnerResponse } from '../runtime/runner-response';

test('runner reads bounded JSON across chunks and counts received bytes independently of headers', async () => {
  const encode = (value: string) => new TextEncoder().encode(value);
  const chunks = [encode('{"commands":['), encode('{"name":"雪"}'), encode(']}')];
  assert.deepEqual(await readRunnerResponse(new Response(new ReadableStream({ pull(controller) { if (chunks.length) controller.enqueue(chunks.shift()); else controller.close(); } })), 64), { commands: [{ name: '雪' }] });
  let cancelled = false, pulled = 0;
  const response = new Response(new ReadableStream({ pull(controller) { pulled++; controller.enqueue(encode('x'.repeat(32))); }, cancel() { cancelled = true; } }), { headers: { 'content-length': '1' } });
  await assert.rejects(readRunnerResponse(response, 64), /oversized response/); assert.equal(cancelled, true); assert.ok(pulled <= 5);
});

test('runner rejects oversized headers without reading and never includes invalid response contents in errors', async () => {
  let cancelled = false;
  const response = new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { 'content-length': '1000' } });
  await assert.rejects(readRunnerResponse(response, 64), /oversized response/); assert.equal(cancelled, true);
  const secret = 'private-cookie-value';
  await assert.rejects(readRunnerResponse(new Response(`{"private":"${secret}"`), 128), error => error instanceof Error && !error.message.includes(secret) && /invalid/.test(error.message));
});
