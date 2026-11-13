import { lookup } from 'node:dns';
import { isIP } from 'node:net';
import { Agent } from 'node:https';
import { randomUUID } from 'node:crypto';
import webpush, { type PushSubscription, type RequestOptions, type SendResult } from 'web-push';
import type { SecretStore } from './secrets';
import {sendNativePush,validateNativeDevice,type NativePushDevice} from './native-push';

export class DeliverySignals {
  private listeners = new Map<string, Set<() => void>>();
  private closed = false;
  notify(key: string) { for (const listener of this.listeners.get(key) || []) listener(); }
  close() { this.closed = true; for (const key of this.listeners.keys()) this.notify(key); }
  wait<T>(key: string, read: () => T, ready: (value: T) => boolean, options: { waitMs?: number; signal?: AbortSignal } = {}): Promise<T> {
    const wait = Math.min(25_000, Math.max(0, Number(options.waitMs) || 0));
    if (options.signal?.aborted) return Promise.reject(options.signal.reason || new Error('Request closed.'));
    const initial = read();
    if (this.closed || !wait || ready(initial)) return Promise.resolve(initial);
    return new Promise<T>((resolve, reject) => {
      const listeners = this.listeners.get(key) || new Set<() => void>(); this.listeners.set(key, listeners);
      let settled = false;
      const cleanup = () => { clearTimeout(timer); clearInterval(fallback); listeners.delete(check); if (!listeners.size) this.listeners.delete(key); options.signal?.removeEventListener('abort', abort); };
      const finish = (error?: unknown, value?: T) => { if (settled) return; settled = true; cleanup(); if (error) reject(error); else resolve(value!); };
      const check = (deadline = false) => { try { const value = read(); if (deadline || this.closed || ready(value)) finish(undefined, value); } catch (error) { finish(error); } };
      const abort = () => finish(options.signal?.reason || new Error('Request closed.'));
      const timer = setTimeout(() => check(true), wait);
      // Rechecks also cover state changes that do not append a conversation event.
      const fallback = setInterval(check, 1000);
      listeners.add(check); options.signal?.addEventListener('abort', abort, { once: true });
      if (options.signal?.aborted) abort(); else check();
    });
  }
}

export class DeliveryError extends Error { constructor(message: string, readonly status = 400) { super(message); } }
export type NotificationKind = 'approval' | 'input' | 'completed' | 'failed' | 'test';
type Subscription = { id: string; subscription?: PushSubscription; native?:NativePushDevice; actorId?:string; createdAt: string };
type Notification = { id: string; kind: NotificationKind; runId: string; recipients: string[]; attempts: number; nextAttemptAt: number; expiresAt: number };
type PushState = { publicKey: string; privateKey: string; subscriptions: Subscription[]; outbox: Notification[]; seen: Array<{ id: string; expiresAt: number }> };
type SecretStorage = Pick<SecretStore, 'environment' | 'set'>;
type Sender = (subscription: PushSubscription, payload: string, options: RequestOptions) => Promise<SendResult>;

export function publicPushAddress(address: string) {
  if (isIP(address) === 4) {
    const [a, b] = address.split('.').map(Number);
    return a !== 0 && a !== 10 && a !== 127 && a !== 169 && a < 224 && !(a === 172 && b >= 16 && b <= 31) && !(a === 192 && [0, 168].includes(b)) && !(a === 100 && b >= 64 && b <= 127) && !(a === 198 && [18, 19, 51].includes(b)) && !(a === 203 && b === 0);
  }
  // Public IPv6 unicast only; rejects mapped IPv4, loopback, link-local and ULA.
  return isIP(address) === 6 && /^[23][0-9a-f]{3}:/i.test(address) && !/^2001:(db8|0):/i.test(address);
}

export function validatePushSubscription(input: unknown): PushSubscription {
  if (!input || typeof input !== 'object') throw new DeliveryError('A browser push subscription is required.');
  const value = input as Record<string, unknown>;
  let url: URL;
  try { url = new URL(String(value.endpoint || '')); } catch { throw new DeliveryError('The browser push address is invalid.'); }
  const host = url.hostname.toLowerCase();
  const trusted = host === 'fcm.googleapis.com' || host === 'updates.push.services.mozilla.com' || host === 'push.services.mozilla.com' || host.endsWith('.push.apple.com') || host.endsWith('.notify.windows.com');
  if (url.protocol !== 'https:' || !trusted || url.username || url.password || url.port || url.hash || url.href.length > 2048) throw new DeliveryError('Use a browser push address from Apple, Google, Mozilla or Microsoft over HTTPS.');
  const keys = value.keys as Record<string, unknown> | undefined;
  const p256dh = String(keys?.p256dh || ''), auth = String(keys?.auth || '');
  if (!/^[A-Za-z0-9_-]+={0,2}$/.test(p256dh) || Buffer.from(p256dh, 'base64url').length !== 65 || Buffer.from(p256dh, 'base64url')[0] !== 4 || !/^[A-Za-z0-9_-]+={0,2}$/.test(auth) || Buffer.from(auth, 'base64url').length !== 16) throw new DeliveryError('The browser push keys are invalid. Enable notifications again in this browser.');
  return { endpoint: url.href, keys: { p256dh, auth } };
}

// Validate at socket lookup time too, so a changed DNS answer cannot target local services.
const pushAgent = new Agent({ keepAlive: false, lookup: (hostname, options, callback) => {
  lookup(hostname, { ...options, all: true }, (error, addresses) => {
    if (error) { callback(error, []); return; }
    if (!addresses.length || addresses.some(item => !publicPushAddress(item.address))) { callback(new Error('The push service did not resolve to a public address.'), []); return; }
    if (options.all) callback(null, addresses); else callback(null, addresses[0].address, addresses[0].family);
  });
} });

export class PushDelivery {
  private state?: PushState;
  private storage?: SecretStorage;
  private timer?: ReturnType<typeof setTimeout>;
  private inFlight?: Promise<{ sent: number; failed: number }>;
  private closed = false;
  constructor(private openStorage: () => SecretStorage, private sender: Sender = webpush.sendNotification.bind(webpush), private now = Date.now) {}
  private load() {
    if (this.state) return this.state;
    this.storage = this.openStorage();
    const raw = this.storage.environment().PUSH_STATE;
    if (raw) {
      let stored: PushState;
      try { stored = JSON.parse(raw); } catch { throw new DeliveryError('Saved notification settings could not be read. Nothing was changed.', 503); }
      if (!stored || typeof stored.publicKey !== 'string' || !stored.publicKey || typeof stored.privateKey !== 'string' || !stored.privateKey || !Array.isArray(stored.subscriptions)) throw new DeliveryError('Saved notification settings are incomplete. Nothing was changed.', 503);
      const state = { ...stored, outbox: stored.outbox === undefined ? [] : stored.outbox, seen: stored.seen === undefined ? [] : stored.seen };
      if (state.subscriptions.some(item => !item || typeof item.id !== 'string' || !item.id || !item.subscription&&!item.native)) throw new DeliveryError('Saved notification settings are incomplete. Nothing was changed.', 503);
      try { for (const item of state.subscriptions) if(item.native)validateNativeDevice(item.native);else validatePushSubscription(item.subscription); }
      catch { throw new DeliveryError('Saved notification settings are incomplete. Nothing was changed.', 503); }
      if (!Array.isArray(state.outbox) || !Array.isArray(state.seen) || state.outbox.some(item => !item || typeof item.id !== 'string' || !['approval','input','completed','failed','test'].includes(item.kind) || typeof item.runId !== 'string' || !Array.isArray(item.recipients) || item.recipients.some(id => typeof id !== 'string') || !Number.isSafeInteger(item.attempts) || item.attempts < 0 || !Number.isFinite(item.nextAttemptAt) || !Number.isFinite(item.expiresAt)) || state.seen.some(item => !item || typeof item.id !== 'string' || !Number.isFinite(item.expiresAt))) throw new DeliveryError('Saved notification delivery records could not be read. Nothing was changed.', 503);
      this.state = state;
    } else { const state: PushState = { ...webpush.generateVAPIDKeys(), subscriptions: [], outbox: [], seen: [] }; this.storage.set('PUSH_STATE', JSON.stringify(state)); this.state = state; }
    return this.state;
  }
  private save() { this.storage!.set('PUSH_STATE', JSON.stringify(this.state)); }
  private prune() {
    const state = this.load(), now = this.now(), ids = new Set(state.subscriptions.map(item => item.id));
    state.outbox = state.outbox.filter(item => item.expiresAt > now).map(item => { item.recipients = item.recipients.filter(id => ids.has(id)); return item; }).filter(item => item.recipients.length).slice(-500);
    state.seen = state.seen.filter(item => item.expiresAt > now).slice(-1000);
  }
  private schedule(fallback?: number) {
    clearTimeout(this.timer);
    if (this.closed) return;
    const state = this.load();
    if (!state.outbox.length) return;
    const delay = fallback ?? Math.max(100, Math.min(...state.outbox.map(item => Math.min(item.nextAttemptAt, item.expiresAt))) - this.now());
    this.timer = setTimeout(() => { void this.retryPending().catch(() => this.schedule(60_000)); }, Math.min(60 * 60_000, delay)); this.timer.unref();
  }
  start() { this.load(); this.prune(); this.save(); this.schedule(); }
  close() { this.closed = true; clearTimeout(this.timer); }
  configuration() { const state = this.load(); this.schedule(); return { publicKey: state.publicKey, subscriberCount: state.subscriptions.length, pendingCount: state.outbox.length }; }
  subscribe(input: unknown,actorId='local-owner') {
    const subscription = validatePushSubscription(input), state = this.load();
    const existing = state.subscriptions.find(item => item.subscription?.endpoint === subscription.endpoint);
    if (existing) {if((existing.actorId||'local-owner')!==actorId)for(const entry of state.outbox)entry.recipients=entry.recipients.filter(id=>id!==existing.id);existing.actorId=actorId;existing.subscription = subscription; this.save(); this.schedule(); return { id: existing.id }; }
    if (state.subscriptions.length >= 20) throw new DeliveryError('Twenty devices already receive notifications. Turn notifications off on another device first.', 409);
    const item = { id: randomUUID(), subscription,actorId, createdAt: new Date().toISOString() }; state.subscriptions.push(item); this.save(); this.schedule(); return { id: item.id };
  }
  subscribeNative(input:unknown,actorId:string){const native=validateNativeDevice(input),state=this.load(),existing=state.subscriptions.find(item=>item.native?.token===native.token&&item.native.platform===native.platform);if(existing){if(existing.actorId!==actorId)for(const entry of state.outbox)entry.recipients=entry.recipients.filter(id=>id!==existing.id);existing.native=native;existing.actorId=actorId;this.save();this.schedule();return {id:existing.id};}if(state.subscriptions.length>=20)throw new DeliveryError('Twenty devices already receive notifications. Remove a device before adding another.',409);const item={id:randomUUID(),native,actorId,createdAt:new Date().toISOString()};state.subscriptions.push(item);this.save();this.schedule();return {id:item.id};}
  unsubscribeNative(id:string,actorId:string){const state=this.load();state.subscriptions=state.subscriptions.filter(item=>item.id!==id||item.actorId!==actorId);this.prune();this.save();return {ok:true};}
  revokeActor(actorId:string){const state=this.load();state.subscriptions=state.subscriptions.filter(item=>item.actorId!==actorId);this.prune();this.save();}
  unsubscribe(idOrEndpoint: string,actorId?:string) {
    const state = this.load(), before = state.subscriptions.length;
    state.subscriptions = state.subscriptions.filter(item => (item.id !== idOrEndpoint && item.subscription?.endpoint !== idOrEndpoint)||(Boolean(actorId)&&(item.actorId||'local-owner')!==actorId));
    if (before !== state.subscriptions.length) { this.prune(); this.save(); this.schedule(); }
    return { ok: true };
  }
  async notify(kind: NotificationKind, runId = '', endpoint?: string, eventId: string = randomUUID(),actorId?:string) {
    if (!['approval', 'input', 'completed', 'failed', 'test'].includes(kind)) throw new DeliveryError('Unknown notification kind.');
    const state = this.load();
    const subscriptions = state.subscriptions.filter(item => (!endpoint || item.subscription?.endpoint === endpoint)&&(!actorId||(item.actorId||'local-owner')===actorId));
    if (endpoint && !subscriptions.length) throw new DeliveryError('Enable notifications on this device before sending a test.', 404);
    if (!subscriptions.length || this.closed) return { sent: 0, failed: 0 };
    this.prune();
    if (state.seen.some(item => item.id === eventId) || state.outbox.some(item => item.id === eventId)) { this.schedule(); return { sent: 0, failed: 0 }; }
    if (typeof eventId !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(eventId)) throw new DeliveryError('Notification event ID is invalid.');
    const expiresAt = this.now() + 24 * 60 * 60_000;
    state.outbox.push({ id: eventId, kind, runId: /^[A-Za-z0-9_-]{1,100}$/.test(runId) ? runId : '', recipients: subscriptions.map(item => item.id), attempts: 0, nextAttemptAt: this.now(), expiresAt });
    state.seen.push({ id: eventId, expiresAt }); this.prune();
    // Persist before sending. A restart can repeat a status, but cannot lose queued work.
    try { this.save(); } catch (error) { this.schedule(60_000); throw error; }
    return this.retryPending(eventId);
  }
  async retryPending(preferredId?: string): Promise<{ sent: number; failed: number }> {
    if (this.closed) return { sent: 0, failed: 0 };
    if (this.inFlight) { await this.inFlight; return this.retryPending(preferredId); }
    const state = this.load(); this.prune(); this.save();
    const due = state.outbox.filter(item => item.nextAttemptAt <= this.now());
    const notification = due.find(item => item.id === preferredId) || due[0];
    if (!notification) { this.save(); this.schedule(); return { sent: 0, failed: 0 }; }
    const operation = Promise.resolve().then(async () => {
      let sent = 0, failed = 0;
      await Promise.all([...notification.recipients].map(async id => {
        const item = state.subscriptions.find(candidate => candidate.id === id);
        if (!item) { notification.recipients = notification.recipients.filter(candidate => candidate !== id); return; }
        try {
          if(item.native)await sendNativePush(validateNativeDevice(item.native),{kind:notification.kind,runId:notification.runId},notification.id,Math.max(1,Math.floor((notification.expiresAt-this.now())/1000)),this.storage!.environment());
          else {const subscription=validatePushSubscription(item.subscription),workspaceId=process.env.OPEN_HARNESS_WORKSPACE_ID||'';await this.sender(subscription, JSON.stringify({ kind: notification.kind, runId: notification.runId, ...(/^[A-Za-z0-9_-]{1,100}$/.test(workspaceId)?{workspaceId}:{}) }), { TTL: Math.max(1, Math.floor((notification.expiresAt - this.now()) / 1000)), urgency: notification.kind === 'approval' || notification.kind === 'input' ? 'high' : 'normal', timeout: 10_000, agent: pushAgent, vapidDetails: { subject: 'https://github.com/sflow-hub/OPEN-HARNESS', publicKey: state.publicKey, privateKey: state.privateKey } });}
          sent++; notification.recipients = notification.recipients.filter(candidate => candidate !== id);
        } catch (error) {
          failed++;
          if ([404, 410].includes(Number((error as { statusCode?: unknown })?.statusCode))) {
            state.subscriptions = state.subscriptions.filter(candidate => candidate.id !== id);
            notification.recipients = notification.recipients.filter(candidate => candidate !== id);
          }
        }
      }));
      notification.attempts++;
      notification.nextAttemptAt = this.now() + Math.min(60 * 60_000, 5_000 * 2 ** Math.min(notification.attempts - 1, 10));
      this.prune(); this.save();
      return { sent, failed };
    });
    this.inFlight = operation;
    try { return await operation; }
    finally { this.inFlight = undefined; this.schedule(); }
  }
}
