/* This worker handles notifications only. It never caches requests or private work. */
self.addEventListener('install', () => { self.skipWaiting(); });
self.addEventListener('activate', event => { event.waitUntil(self.clients.claim()); });
self.addEventListener('push', event => {
  let data = {};
  try { const parsed = event.data ? event.data.json() : {}; data = parsed && typeof parsed === 'object' ? parsed : {}; } catch { /* Show a generic notification if the service payload is unreadable. */ }
  const messages = { approval: 'A task needs your approval.', input: 'A task has a question for you.', completed: 'A task is complete.', failed: 'A task needs your attention.', test: 'Notifications are ready on this device.' };
  const kind = Object.hasOwn(messages, data.kind) ? data.kind : 'input';
  const runId = typeof data.runId === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(data.runId) ? data.runId : '';
  const workspaceId = typeof data.workspaceId === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(data.workspaceId) ? data.workspaceId : '';
  const target = new URL('/', self.location.origin);
  if (runId) target.searchParams.set('run', runId);
  if (workspaceId) target.searchParams.set('workspace', workspaceId);
  event.waitUntil(self.registration.showNotification('Open Harness', { body: messages[kind], icon: '/open-harness-icon.svg', tag: runId ? `run-${workspaceId}-${runId}-${kind}` : 'open-harness-test', data: { url: target.pathname + target.search } }));
});
self.addEventListener('notificationclick', event => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || '/', self.location.origin);
  if (target.origin !== self.location.origin) return;
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(async clients => {
    for (const client of clients) if (new URL(client.url).origin === target.origin) {
      if (!target.searchParams.has('run') && !target.searchParams.has('workspace')) return client.focus();
      const opened = await client.navigate(target.href);
      if (opened) return opened.focus();
    }
    return self.clients.openWindow(target.href);
  }));
});
