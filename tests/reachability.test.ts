import test from 'node:test';
import assert from 'node:assert/strict';
import { addressIsReachable } from '../lib/reachability';
import { reachability } from '../runtime/reachability';

test('an address is only reachable when another device could actually use it', () => {
  assert.equal(addressIsReachable('https://agents.example.com'), true);
  assert.equal(addressIsReachable('https://beast.tail34fc9d.ts.net'), true);
  // Resolves on the coordinator's own machine and nowhere else.
  assert.equal(addressIsReachable('http://127.0.0.1:4317'), false);
  assert.equal(addressIsReachable('http://localhost:3000/api/local'), false);
  // A bind address is not somewhere a phone can send a request.
  assert.equal(addressIsReachable('http://0.0.0.0:4317'), false);
  // lib/hub.ts refuses plain HTTP off loopback, so offering one would only mislead.
  assert.equal(addressIsReachable('http://agents.example.com'), false);
  assert.equal(addressIsReachable(''), false);
  assert.equal(addressIsReachable('not a url'), false);
});

test('a configured HTTPS address is reported as ready and nothing else is suggested', () => {
  const result = reachability({ publicUrl: 'https://agents.example.com/', bind: '0.0.0.0', port: 4317 });
  assert.equal(result.reachable, true);
  // The trailing slash would otherwise be concatenated into every paired URL.
  assert.equal(result.publicUrl, 'https://agents.example.com');
  assert.equal(result.loopbackOnly, false);
  assert.deepEqual(result.options.map(option => option.id), ['configured']);
  assert.equal(result.options[0].url, 'https://agents.example.com');
});

test('a loopback-only coordinator is told how to get an address, not just that it lacks one', () => {
  const result = reachability({ publicUrl: '', bind: '127.0.0.1', port: 4317 });
  assert.equal(result.reachable, false);
  assert.equal(result.loopbackOnly, true);
  const ids = result.options.map(option => option.id);
  // Both routes are offered: a tunnel for a home computer, a proxy for a VPS.
  assert.ok(ids.includes('tailscale'), 'a home computer has no public address and needs a tunnel');
  assert.ok(ids.includes('proxy'), 'a VPS with a domain terminates HTTPS in front');
  // Every suggestion is actionable rather than a description of the problem.
  for (const option of result.options) assert.ok(option.command || option.url, `${option.id} gives the user nothing to do`);
  const proxy = result.options.find(option => option.id === 'proxy')!;
  assert.match(proxy.command!, /OPEN_HARNESS_PUBLIC_URL=https:/);
  const tunnel = result.options.find(option => option.id === 'tailscale')!;
  assert.match(tunnel.command!, /tailscale serve .*4317/);
});

test('an http address that is not loopback still counts as unreachable', () => {
  // Reachable over the network, but pairing would refuse it, so it must not be offered.
  const result = reachability({ publicUrl: 'http://192.168.1.10:4317', bind: '0.0.0.0', port: 4317 });
  assert.equal(result.reachable, false);
  assert.ok(result.options.length > 0);
});
