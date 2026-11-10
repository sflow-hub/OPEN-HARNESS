import { test, expect } from '@playwright/test';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';

test('the built dashboard permits real loopback computer WebSockets under its production CSP', async ({ page, request }) => {
  const response = await request.get('/'), policy = response.headers()['content-security-policy'];
  expect(policy).toBeTruthy();
  const connect = policy.split(';').find(value => value.trim().startsWith('connect-src '))!.trim().split(/\s+/).slice(1);
  expect(connect.filter(value => /^wss?:/.test(value)).sort()).toEqual(['ws://127.0.0.1:*','ws://localhost:*','wss://127.0.0.1:*','wss://localhost:*'].sort());
  expect(connect).not.toContain('*');
  const server = createServer(), sockets = new WebSocketServer({ server });
  sockets.on('connection', socket => socket.send('actual-loopback-stream'));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); const address = server.address(); expect(address && typeof address !== 'string').toBeTruthy();
  try {
    await page.goto(`/?controlPort=${process.env.OPEN_HARNESS_TEST_PORT || 4317}`);
    for (const hostname of ['127.0.0.1','localhost']) {
      const value = await page.evaluate(url => new Promise<string>((resolve, reject) => {
        const socket = new WebSocket(url), timer = setTimeout(() => { socket.close(); reject(new Error('Loopback WebSocket did not connect.')); }, 5000);
        socket.onmessage = event => { clearTimeout(timer); socket.close(); resolve(String(event.data)); };
        socket.onerror = () => { clearTimeout(timer); socket.close(); reject(new Error('Loopback WebSocket was blocked.')); };
      }), `ws://${hostname}:${(address as {port:number}).port}/computer-policy-check`);
      expect(value).toBe('actual-loopback-stream');
    }
  } finally { for (const socket of sockets.clients) socket.terminate(); sockets.close(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
