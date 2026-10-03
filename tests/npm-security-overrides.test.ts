import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const load = createRequire(import.meta.url);
const CachePolicy = load('../runtime/hermes/vendor/http-cache-semantics/index.js');
const request = { url: 'https://registry.example/package', method: 'GET', headers: {} };
const staleRequest = { ...request, headers: { 'cache-control': 'max-stale=999999' } };
function policy(headers: Record<string, string>, shared = true) {
  const value = new CachePolicy(request, { status: 200, headers }, { shared });
  value.age = () => 100;
  return value;
}

test('max-stale cannot expose shared cookies or bypass revalidation directives', () => {
  const cases: Record<string, string>[] = [
    { 'set-cookie': 'session=another-user', 'cache-control': 'max-age=0' },
    { 'cache-control': 'proxy-revalidate, max-age=0' },
    { 'cache-control': 'no-cache, max-age=0' },
  ];
  for (const headers of cases) {
    const value = policy(headers);
    assert.equal(value.satisfiesWithoutRevalidation(staleRequest), false);
    const result = value.evaluateRequest(staleRequest);
    assert.equal(result.response, undefined);
    assert.equal(result.revalidation.synchronous, true);
  }
});

test('ordinary stale public responses and private cookies retain cache behavior', () => {
  for (const value of [policy({ 'cache-control': 'public, max-age=0' }),
    policy({ 'cache-control': 'public, max-age=0', 'set-cookie': 'public-cookie' }),
    policy({ 'cache-control': 'max-age=0', 'set-cookie': 'private-cookie' }, false)]) {
    assert.equal(value.satisfiesWithoutRevalidation(staleRequest), true);
  }
});
