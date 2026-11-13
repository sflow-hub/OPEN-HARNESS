import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { providerModelList } from '../runtime/provider-models';

test('provider discovery authenticates using the selected key and provider protocol', async () => {
  const requests: Array<{ url: string; authorization?: string; apiKey?: string; version?: string }> = [];
  const server = createServer((request, response) => {
    requests.push({ url: request.url || '', authorization: request.headers.authorization, apiKey: request.headers['x-api-key'] as string, version: request.headers['anthropic-version'] as string });
    if (request.url === '/denied/models') { response.writeHead(401).end('private provider diagnostic'); return; }
    if (request.url === '/redirect/models') { response.writeHead(302, { Location: '/v1/models' }).end(); return; }
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ data: [{ id: 'model-b' }, { id: 'model-a' }, { id: 'model-a' }] }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    assert.deepEqual(await providerModelList(`${base}/v1`, 'openai-secret', 'openai'), { ok: true, status: 200, models: ['model-a', 'model-b'] });
    assert.deepEqual(requests[0], { url: '/v1/models', authorization: 'Bearer openai-secret', apiKey: undefined, version: undefined });
    await providerModelList(`${base}/v1`, 'anthropic-secret', 'anthropic');
    assert.deepEqual(requests[1], { url: '/v1/models', authorization: undefined, apiKey: 'anthropic-secret', version: '2023-06-01' });
    assert.deepEqual(await providerModelList(`${base}/denied`, 'rejected-secret', 'openai'), { ok: false, status: 401, models: [] });
    await assert.rejects(providerModelList(`${base}/redirect`, 'redirect-secret', 'openai'));
    assert.equal(requests.length, 4, 'discovery must not forward the key through a redirect');
  } finally { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); }
});
