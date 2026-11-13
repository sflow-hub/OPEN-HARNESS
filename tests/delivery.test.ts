import test from 'node:test';
import assert from 'node:assert/strict';
import { DeliverySignals, PushDelivery, publicPushAddress, validatePushSubscription } from '../runtime/delivery';
import { generateKeyPairSync } from 'node:crypto';

const publicKey = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).publicKey.export({ format: 'jwk' });
const p256dh = Buffer.concat([Buffer.from([4]), Buffer.from(publicKey.x!, 'base64url'), Buffer.from(publicKey.y!, 'base64url')]).toString('base64url');
const subscription = (suffix = 'first') => ({ endpoint: `https://fcm.googleapis.com/fcm/send/${suffix}`, keys: { p256dh, auth: Buffer.alloc(16, 1).toString('base64url') } });
const success = { statusCode: 201, body: '', headers: {} };
function storage() { const values: Record<string,string> = {}; return { values, environment: () => values, set: (key: string, value: string) => { values[key] = value; } }; }

test('long polling wakes on new data and replays an already available cursor without waiting', async () => {
  const signals = new DeliverySignals(), records: number[] = [];
  const waiting = signals.wait('run:a', () => [...records], value => Boolean(value.length), { waitMs: 25_000 });
  records.push(7); signals.notify('run:a');
  assert.deepEqual(await waiting, [7]);
  assert.deepEqual(await signals.wait('run:a', () => [...records], value => Boolean(value.length), { waitMs: 25_000 }), [7]);
});

test('long polling removes cancelled listeners and resolves at its deadline or shutdown', async () => {
  const signals = new DeliverySignals(), controller = new AbortController();
  const waiting = signals.wait('run:a', () => [], () => false, { waitMs: 25_000, signal: controller.signal });
  controller.abort(); await assert.rejects(waiting, { name: 'AbortError' });
  assert.deepEqual(await signals.wait('run:a', () => [], () => false, { waitMs: 5 }), []);
  const shuttingDown = signals.wait('run:a', () => ['final'], () => false, { waitMs: 25_000 }); signals.close();
  assert.deepEqual(await shuttingDown, ['final']);
});

test('push subscriptions reject local addresses, credentials, untrusted suffixes and malformed browser keys', () => {
  for (const endpoint of ['http://fcm.googleapis.com/a', 'https://localhost/a', 'https://127.0.0.1/a', 'https://fcm.googleapis.com.attacker.example/a', 'https://user:password@fcm.googleapis.com/a', 'https://fcm.googleapis.com:8443/a', 'https://example.com/a']) {
    assert.throws(() => validatePushSubscription({ ...subscription(), endpoint }), /push address/);
  }
  assert.throws(() => validatePushSubscription({ ...subscription(), keys: { p256dh: 'bad', auth: 'bad' } }), /keys/);
  assert.deepEqual(validatePushSubscription(subscription()), subscription());
  for (const address of ['127.0.0.1', '10.1.2.3', '169.254.169.254', '172.16.2.3', '192.168.1.1', '100.64.0.1', '0.0.0.0', '224.0.0.1', '::1', '::ffff:127.0.0.1', 'fc00::1', 'fe80::1', '2001:db8::1']) assert.equal(publicPushAddress(address), false, address);
  for (const address of ['8.8.8.8', '142.250.72.42', '2607:f8b0:4007:80b::200a']) assert.equal(publicPushAddress(address), true, address);
});

test('push keys persist separately, broadcasts carry no work content and duplicate subscriptions update in place', async () => {
  const secret = storage(), delivered: string[] = [];
  const delivery = new PushDelivery(() => secret, async (_subscription, payload) => { delivered.push(payload); return success; });
  const configured = delivery.configuration();
  assert.ok(configured.publicKey); assert.equal('privateKey' in configured, false);
  const first = delivery.subscribe(subscription()); assert.deepEqual(delivery.subscribe(subscription()), first);
  assert.equal(delivery.configuration().subscriberCount, 1);
  assert.deepEqual(await delivery.notify('approval', 'run_123'), { sent: 1, failed: 0 });
  assert.deepEqual(JSON.parse(delivered[0]), { kind: 'approval', runId: 'run_123' });
  const restarted = new PushDelivery(() => secret);
  assert.equal(restarted.configuration().publicKey, configured.publicKey);
  assert.equal(restarted.configuration().subscriberCount, 1);
  restarted.unsubscribe(first.id); assert.equal(restarted.configuration().subscriberCount, 0);
});

test('expired push subscriptions are revoked while transient delivery failures remain retryable', async () => {
  const secret = storage();
  const delivery = new PushDelivery(() => secret, async value => { throw { statusCode: value.endpoint.endsWith('expired') ? 410 : 503 }; });
  delivery.subscribe(subscription('expired')); delivery.subscribe(subscription('temporary'));
  assert.deepEqual(await delivery.notify('completed', 'a'), { sent: 0, failed: 2 });
  assert.equal(delivery.configuration().subscriberCount, 1);
  await assert.rejects(delivery.notify('test', '', subscription('unregistered').endpoint), /Enable notifications/);
  delivery.close();
});

test('web push identifies its managed workspace and omits invalid workspace identifiers', async () => {
  const previous = process.env.OPEN_HARNESS_WORKSPACE_ID, delivered: string[] = [], secret = storage();
  const delivery = new PushDelivery(() => secret, async (_subscription, payload) => { delivered.push(payload); return success; });
  try {
    delivery.subscribe(subscription()); process.env.OPEN_HARNESS_WORKSPACE_ID = 'workspace-123';
    await delivery.notify('completed', 'run-1');
    assert.deepEqual(JSON.parse(delivered[0]), { kind: 'completed', runId: 'run-1', workspaceId: 'workspace-123' });
    process.env.OPEN_HARNESS_WORKSPACE_ID = '../invalid?workspace=other'; await delivery.notify('completed', 'run-2');
    assert.deepEqual(JSON.parse(delivered[1]), { kind: 'completed', runId: 'run-2' });
  } finally { delivery.close(); if (previous === undefined) delete process.env.OPEN_HARNESS_WORKSPACE_ID; else process.env.OPEN_HARNESS_WORKSPACE_ID = previous; }
});

test('an unreadable saved push store is not replaced with new signing keys', () => {
  const secret = storage(); secret.values.PUSH_STATE = 'broken';
  assert.throws(() => new PushDelivery(() => secret).configuration(), /Nothing was changed/);
  assert.equal(secret.values.PUSH_STATE, 'broken');
});

test('malformed saved delivery records never become cached state and can be repaired without restarting', () => {
  const secret = storage(), first = new PushDelivery(() => secret); first.configuration(); first.close();
  const valid = secret.values.PUSH_STATE;
  for (const changes of [{ outbox: 'invalid' }, { outbox: [null] }, { seen: {} }, { subscriptions: [null] }]) {
    const raw = JSON.stringify({ ...JSON.parse(valid), ...changes }); secret.values.PUSH_STATE = raw;
    const delivery = new PushDelivery(() => secret);
    assert.throws(() => delivery.configuration(), /Nothing was changed/);
    assert.throws(() => delivery.configuration(), /Nothing was changed/);
    assert.equal(secret.values.PUSH_STATE, raw);
    secret.values.PUSH_STATE = valid;
    assert.equal(delivery.configuration().publicKey, JSON.parse(valid).publicKey); delivery.close();
  }
});

test('new signing keys are not exposed until their initial persistence succeeds', () => {
  const secret = storage(); let writable = false;
  const delivery = new PushDelivery(() => ({ environment: secret.environment, set: (key, value) => { if (!writable) throw new Error('Vault is locked.'); secret.set(key, value); } }));
  assert.throws(() => delivery.configuration(), /Vault is locked/);
  assert.equal(secret.values.PUSH_STATE, undefined);
  writable = true;
  assert.equal(delivery.configuration().publicKey, JSON.parse(secret.values.PUSH_STATE).publicKey); delivery.close();
});

test('opening settings after a locked-vault startup resumes durable notifications without a new event', { timeout: 3000 }, async t => {
  const secret = storage(); let now = 1_000_000;
  const first = new PushDelivery(() => secret, async () => { throw { statusCode: 503 }; }, () => now);
  first.subscribe(subscription()); await first.notify('approval', 'run1', undefined, 'event1'); first.close(); now += 5000;
  let unlocked = false, acknowledge: () => void = () => {};
  const delivered = new Promise<void>(resolve => { acknowledge = resolve; });
  const resumed = new PushDelivery(() => { if (!unlocked) throw new Error('Vault is locked.'); return secret; }, async () => { acknowledge(); return success; }, () => now);
  t.after(() => resumed.close());
  assert.throws(() => resumed.start(), /Vault is locked/);
  unlocked = true; assert.equal(resumed.configuration().pendingCount, 1);
  let deadline:ReturnType<typeof setTimeout>|undefined;
  try{await Promise.race([delivered,new Promise<never>((_,reject)=>{deadline=setTimeout(()=>reject(new Error('Saved notification did not resume after unlocking.')),2000);})]);}finally{clearTimeout(deadline);}
  await new Promise<void>(resolve => setImmediate(resolve));
  assert.equal(resumed.configuration().pendingCount, 0);
  assert.equal(JSON.parse(secret.values.PUSH_STATE).outbox.length, 0);
});

test('pending push survives restart, backs off and deduplicates an event without resending successful recipients', async () => {
  const secret = storage(); let now = 1_000_000, firstSends = 0;
  const first = new PushDelivery(() => secret, async item => { firstSends++; if (item.endpoint.endsWith('retry')) throw { statusCode: 503 }; return success; }, () => now);
  first.subscribe(subscription('success')); first.subscribe(subscription('retry'));
  assert.deepEqual(await first.notify('approval', 'run1', undefined, 'event1'), { sent: 1, failed: 1 });
  assert.equal(firstSends, 2); assert.equal(first.configuration().pendingCount, 1);
  first.close();
  const delivered: string[] = [];
  const restarted = new PushDelivery(() => secret, async item => { delivered.push(item.endpoint); return success; }, () => now);
  restarted.start();
  assert.deepEqual(await restarted.retryPending(), { sent: 0, failed: 0 });
  now += 5000;
  assert.deepEqual(await restarted.retryPending(), { sent: 1, failed: 0 });
  assert.deepEqual(delivered, [subscription('retry').endpoint]);
  assert.equal(restarted.configuration().pendingCount, 0);
  assert.deepEqual(await restarted.notify('approval', 'run1', undefined, 'event1'), { sent: 0, failed: 0 });
  assert.equal(delivered.length, 1); restarted.close();
});

test('revocation and 24-hour expiry remove pending notifications and the persisted queue stays bounded', async () => {
  const secret = storage(); let now = 1_000_000;
  const delivery = new PushDelivery(() => secret, async () => { throw { statusCode: 503 }; }, () => now);
  const device = delivery.subscribe(subscription());
  await delivery.notify('input', 'run1'); assert.equal(delivery.configuration().pendingCount, 1);
  delivery.unsubscribe(device.id); assert.equal(delivery.configuration().pendingCount, 0);
  const next = delivery.subscribe(subscription());
  await delivery.notify('completed', 'run2'); now += 24 * 60 * 60_000 + 1;
  await delivery.retryPending(); assert.equal(delivery.configuration().pendingCount, 0); delivery.close();
  const saved = JSON.parse(secret.values.PUSH_STATE);
  saved.outbox = Array.from({ length: 502 }, (_, index) => ({ id: `event-${index}`, kind: 'input', runId: 'run1', recipients: [next.id], attempts: 0, nextAttemptAt: now, expiresAt: now + 1000 }));
  secret.values.PUSH_STATE = JSON.stringify(saved);
  const restored = new PushDelivery(() => secret, async () => success, () => now); restored.start(); restored.close();
  assert.equal(restored.configuration().pendingCount, 500);
  assert.equal(JSON.parse(secret.values.PUSH_STATE).outbox.length, 500);
  assert.deepEqual(await restored.retryPending(), { sent: 0, failed: 0 });
});

test('enqueuing while another notification is sending preserves both delivery acknowledgments', async () => {
  const secret = storage(); let release: () => void = () => {};
  const gate = new Promise<void>(resolve => { release = resolve; }); let sends = 0;
  const delivery = new PushDelivery(() => secret, async () => { sends++; await gate; return success; });
  delivery.subscribe(subscription());
  const first = delivery.notify('completed', 'run1', undefined, 'event1');
  const second = delivery.notify('completed', 'run2', undefined, 'event2');
  release(); await Promise.all([first, second]);
  assert.equal(sends, 2); assert.equal(delivery.configuration().pendingCount, 0); delivery.close();
});
