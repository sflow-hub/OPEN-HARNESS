import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import nextConfig from '../next.config';

const socketSources = ['ws://127.0.0.1:*','ws://localhost:*','wss://127.0.0.1:*','wss://localhost:*'];
function check(policy: string) {
  const connect = policy.split(';').find(value => value.trim().startsWith('connect-src '))!.trim().split(/\s+/).slice(1);
  assert.deepEqual(connect.filter(value => /^wss?:/.test(value)).sort(), socketSources.sort());
  assert.ok(!connect.includes('*')); assert.ok(policy.includes("object-src 'none'")); assert.ok(policy.includes("base-uri 'none'"));
}
test('production dashboard and desktop shell permit only explicit loopback WebSocket hosts', async () => {
  const environment: Record<string,string|undefined> = process.env, previous = environment.NODE_ENV; environment.NODE_ENV = 'production';
  try {
    const headers = await nextConfig.headers!();
    const policy = headers.find(value => value.source === '/(.*)')!.headers.find(value => value.key === 'Content-Security-Policy')!.value;
    check(policy);
    check(JSON.parse(readFileSync(new URL('../src-tauri/tauri.conf.json', import.meta.url), 'utf8')).app.security.csp);
  } finally { if (previous === undefined) delete environment.NODE_ENV; else environment.NODE_ENV = previous; }
});
