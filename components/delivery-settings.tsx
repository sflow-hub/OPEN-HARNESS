'use client';

import { useEffect, useState } from 'react';
import { Bell, BellOff, LoaderCircle, Smartphone } from 'lucide-react';
import type { ControlClient } from '../lib/control-client';

type Configuration = { publicKey: string; subscriberCount: number };
function keyBytes(value: string) { return Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')), char => char.charCodeAt(0)); }

export default function DeliverySettings({ client }: { client: ControlClient }) {
  const [configuration, setConfiguration] = useState<Configuration | null>(null);
  const [subscription, setSubscription] = useState<PushSubscription | null>(null);
  const [supported, setSupported] = useState(false), [busy, setBusy] = useState(false), [message, setMessage] = useState('');
  useEffect(() => {
    let cancelled = false;
    const available = window.isSecureContext && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
    Promise.resolve().then(() => { if (!cancelled) setSupported(available); });
    client.request<Configuration>('/v1/delivery').then(value => { if (!cancelled) setConfiguration(value); }, error => { if (!cancelled) setMessage(error instanceof Error ? error.message : 'Notification settings could not be loaded.'); });
    if (available) navigator.serviceWorker.getRegistration('/').then(registration => registration?.pushManager.getSubscription()).then(value => { if (!cancelled) setSubscription(value || null); }).catch(() => {});
    return () => { cancelled = true; };
  }, [client]);

  async function enable() {
    if (!configuration || !supported) return;
    setBusy(true); setMessage('');
    try {
      // Permission must be requested directly from the user's tap, including on iOS.
      if (await Notification.requestPermission() !== 'granted') throw new Error('Notifications are blocked. Allow them in this browser’s site settings, then try again.');
      await navigator.serviceWorker.register('/open-harness-sw.js', { scope: '/' });
      const registration = await navigator.serviceWorker.ready;
      const current = await registration.pushManager.getSubscription();
      const next = current || await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(configuration.publicKey) });
      await client.request('/v1/delivery/subscriptions', { method: 'POST', body: JSON.stringify(next.toJSON()) });
      setSubscription(next); setMessage('This device will receive approvals, questions, completed tasks and failures even when this page is closed.');
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Notifications could not be enabled.'); }
    finally { setBusy(false); }
  }
  async function disable() {
    if (!subscription) return;
    setBusy(true); setMessage('');
    try {
      await client.request('/v1/delivery/subscriptions', { method: 'DELETE', body: JSON.stringify({ endpoint: subscription.endpoint }) });
      await subscription.unsubscribe(); setSubscription(null); setMessage('Notifications are off on this device.');
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Notifications could not be turned off.'); }
    finally { setBusy(false); }
  }
  async function test() {
    if (!subscription) return;
    setBusy(true); setMessage('');
    try {
      const result = await client.request<{ sent: number; failed: number }>('/v1/delivery/test', { method: 'POST', body: JSON.stringify({ endpoint: subscription.endpoint }) });
      setMessage(result.sent ? 'Test sent to your browser’s push service. Check this device’s notifications.' : 'The push service could not accept the test. Your notification is saved and will retry automatically.');
    } catch (error) { setMessage(error instanceof Error ? error.message : 'The test could not be sent.'); }
    finally { setBusy(false); }
  }
  return <section aria-label="Phone and notifications" className="settings-section">
    <h3><Smartphone size={17} aria-hidden="true" /> Phone and notifications</h3>
    <p>Keep your coordinator and agent computer running to finish work while you are away. Open your dashboard through an authenticated HTTPS address on your phone.</p>
    <p>On iPhone or iPad (iOS 16.4 or later), open the dashboard in Safari, choose Share → Add to Home Screen, then open it from that icon and enable notifications here. On Android or desktop, use your browser’s Install app option.</p>
    <p>Notifications contain only a task status. Open the dashboard to see private work; no transcript, password or approval details are sent in a notification.</p>
    {!supported && <p>Push needs HTTPS and a browser with Web Push support. On iPhone, open the installed Home Screen app first. A localhost dashboard works only on the computer hosting it.</p>}
    <div className="onboarding-actions">
      {subscription ? <><button type="button" className="subtle-button" disabled={busy} onClick={disable}><BellOff size={15} /> Turn off on this device</button><button type="button" className="subtle-button" disabled={busy} onClick={test}>Send test notification</button></> : <button type="button" className="subtle-button" disabled={busy || !supported || !configuration} onClick={enable}>{busy ? <LoaderCircle className="spin" size={15} /> : <Bell size={15} />} Enable on this device</button>}
    </div>
    {message && <p role="status">{message}</p>}
  </section>;
}
