// Everything the dashboard needs from the device it is running on, behind one interface.
//
// The same React code ships three ways: a desktop webview pointed at a loopback server, a
// browser against a self-hosted or hosted coordinator, and a phone app with no server of its
// own. Only the phone has Tauri plugins available, and importing them at module scope would
// break the other two. So every native capability is loaded lazily and falls back to a web
// equivalent, which also lets the Playwright mobile project exercise these paths in Chromium.

export type KeyValueStore = {
  get<T>(key: string): Promise<T | null>;
  set(key: string, value: unknown): Promise<void>;
  remove(key: string): Promise<void>;
};

declare global {
  interface Window { __TAURI_INTERNALS__?: unknown }
}

export function hasTauri() {
  return typeof window !== 'undefined' && Boolean(window.__TAURI_INTERNALS__);
}

// Tauri plugins are imported normally so the bundler includes them. Importing is harmless
// outside the phone app; only calling into one without a Tauri runtime fails, which is why
// every call below is behind hasTauri(). An earlier version assembled the specifier at
// runtime to keep the bundler out of it, which silently produced an app whose imports could
// never resolve, so the phone fell back to the webview's fetch and was blocked by CSP.
export async function loadTauriPlugin<T = Record<string, unknown>>(name: string): Promise<T | null> {
  if (!hasTauri()) return null;
  try {
    switch (name) {
      case 'http': return await import('@tauri-apps/plugin-http') as T;
      case 'notification': return await import('@tauri-apps/plugin-notification') as T;
      case 'store': return await import('@tauri-apps/plugin-store') as T;
      case 'stronghold': return await import('@tauri-apps/plugin-stronghold') as T;
      case 'deep-link': return await import('@tauri-apps/plugin-deep-link') as T;
      case 'barcode-scanner': return await import('@tauri-apps/plugin-barcode-scanner') as T;
      case 'dialog': return await import('@tauri-apps/plugin-dialog') as T;
      case 'clipboard-manager': return await import('@tauri-apps/plugin-clipboard-manager') as T;
      case 'fs': return await import('@tauri-apps/plugin-fs') as T;
      default: return null;
    }
  } catch { return null; }
}

// Playwright drives the phone layouts in a desktop browser, and a developer may want to try
// the hub flow without building the app. Both need a way in that does not fake Tauri itself.
function forcedMobile() {
  if (typeof window === 'undefined') return false;
  try {
    if (window.localStorage.getItem('open-harness.force-mobile') === '1') return true;
  } catch { /* Private mode and blocked site data both throw here; treat as not forced. */ }
  return new URLSearchParams(window.location.search).get('mobile') === '1';
}

export function isMobileApp() {
  return (hasTauri() && process.env.NEXT_PUBLIC_OPEN_HARNESS_TARGET === 'mobile') || forcedMobile();
}

// The phone talks to a hub on a different origin. The browser's fetch would need CORS and
// would attach an Origin header the coordinator rejects; Tauri's HTTP plugin makes the
// request from Rust instead, so neither applies.
let cachedFetch: typeof fetch | null = null;
export async function platformFetch(): Promise<typeof fetch> {
  if (cachedFetch) return cachedFetch;
  const plugin = await loadTauriPlugin<{ fetch: typeof fetch }>('http');
  // Outside the phone app window.fetch is the right answer, not a fallback.
  cachedFetch = plugin?.fetch || globalThis.fetch.bind(globalThis);
  return cachedFetch;
}

function webStore(prefix: string): KeyValueStore {
  return {
    async get<T>(key: string) {
      try { const raw = window.localStorage.getItem(prefix + key); return raw ? JSON.parse(raw) as T : null; }
      catch { return null; }
    },
    async set(key, value) {
      try { window.localStorage.setItem(prefix + key, JSON.stringify(value)); } catch { /* Quota or blocked storage: the caller re-reads from the hub instead. */ }
    },
    async remove(key) {
      try { window.localStorage.removeItem(prefix + key); } catch { /* Nothing to clean up if storage was never writable. */ }
    },
  };
}

export const settingsStore: KeyValueStore = webStore('open-harness.settings.');

const legacySecureStore = webStore('open-harness.secure.');
let nativeSecureStore: Promise<KeyValueStore> | null = null;
async function encryptedNativeStore(): Promise<KeyValueStore> {
  if (!hasTauri()) return legacySecureStore;
  if (nativeSecureStore) return nativeSecureStore;
  nativeSecureStore = (async () => {
    const stronghold = await loadTauriPlugin<typeof import('@tauri-apps/plugin-stronghold')>('stronghold');
    const storePlugin = await loadTauriPlugin<typeof import('@tauri-apps/plugin-store')>('store');
    if (!stronghold || !storePlugin) throw new Error('The encrypted device credential vault is unavailable. Update or reinstall Open Harness.');
    const { appDataDir, join } = await import('@tauri-apps/api/path');
    const metadata = await storePlugin.load('device-vault.json', { autoSave: false });
    let vaultKey = await metadata.get<string>('vault-key.v1');
    if (!vaultKey) {
      const bytes = crypto.getRandomValues(new Uint8Array(32));
      vaultKey = btoa(String.fromCharCode(...bytes));
      await metadata.set('vault-key.v1', vaultKey);
      await metadata.save();
    }
    const hold = await stronghold.Stronghold.load(await join(await appDataDir(), 'open-harness-device.hold'), vaultKey);
    let client: InstanceType<typeof stronghold.Client>;
    try { client = await hold.loadClient('open-harness-device'); }
    catch { client = await hold.createClient('open-harness-device'); }
    const store = client.getStore();
    return {
      async get<T>(key: string) {
        const data = await store.get(key);
        if (!data) return null;
        try { return JSON.parse(new TextDecoder().decode(data)) as T; }
        catch { return null; }
      },
      async set(key: string, value: unknown) {
        await store.insert(key, [...new TextEncoder().encode(JSON.stringify(value))]);
        await hold.save();
      },
      async remove(key: string) {
        await store.remove(key);
        await hold.save();
      },
    };
  })();
  return nativeSecureStore;
}

// Browser previews use origin storage. The packaged phone uses Stronghold's encrypted
// snapshot in the application-private data directory and migrates the former web value once.
export const secureStore: KeyValueStore = {
  async get<T>(key: string) {
    const store = await encryptedNativeStore();
    const value = await store.get<T>(key);
    if (value !== null || !hasTauri()) return value;
    const legacy = await legacySecureStore.get<T>(key);
    if (legacy !== null) { await store.set(key, legacy); await legacySecureStore.remove(key); }
    return legacy;
  },
  async set(key, value) { await (await encryptedNativeStore()).set(key, value); if (hasTauri()) await legacySecureStore.remove(key); },
  async remove(key) { await (await encryptedNativeStore()).remove(key); await legacySecureStore.remove(key); },
};

type NotificationPlugin = {
  isPermissionGranted(): Promise<boolean>;
  requestPermission(): Promise<string>;
  sendNotification(options: { title: string; body: string }): void;
};

// The Android WebView has no web Notification API at all, so every notification decision
// goes through here: the plugin on the phone, the web API in a browser, and "no" anywhere
// that has neither. Restoring a saved preference on launch uses this rather than reading
// Notification.permission, which is undefined on the phone.
export async function notificationsGranted(): Promise<boolean> {
  const plugin = await loadTauriPlugin<NotificationPlugin>('notification');
  if (plugin) {
    try { return await plugin.isPermissionGranted(); } catch { return false; }
  }
  return typeof Notification !== 'undefined' && Notification.permission === 'granted';
}

// Asks once, from a user gesture. False means the platform has no notifications or the
// person declined; the caller words the follow-up for its platform.
export async function requestNotificationPermission(): Promise<boolean> {
  const plugin = await loadTauriPlugin<NotificationPlugin>('notification');
  if (plugin) {
    try { return (await plugin.isPermissionGranted()) || (await plugin.requestPermission()) === 'granted'; }
    catch { return false; }
  }
  if (typeof Notification === 'undefined') return false;
  if (Notification.permission === 'granted') return true;
  try { return (await Notification.requestPermission()) === 'granted'; } catch { return false; }
}

// Sending never prompts: permission is a decision the person makes in Settings, and a
// prompt appearing while a run finishes in the background would be answered blind.
export async function notify(title: string, body: string, tag?: string) {
  const plugin = await loadTauriPlugin<NotificationPlugin>('notification');
  if (plugin) {
    try {
      if (!(await plugin.isPermissionGranted())) return;
      plugin.sendNotification({ title, body });
      return;
    } catch { /* Falls through to the web Notification API. */ }
  }
  try {
    if (typeof Notification !== 'undefined' && Notification.permission === 'granted') new Notification(title, { body, ...(tag ? { tag } : {}) });
  } catch { /* Notifications are a courtesy; never let one break a run. */ }
}

// A phone radio and a locked screen make a twice-a-second poll wasteful. The event cursor
// already makes a slower poll safe: nothing is missed, it just arrives a little later.
export function eventPollIntervalMs(hidden: boolean) {
  if (isMobileApp()) return hidden ? 6000 : 1500;
  return hidden ? 4000 : 500;
}

// The task board refreshes on its own clock: quickly while something is moving, slowly
// otherwise. Same reasoning as above for the phone.
export function taskPollIntervalMs(active: boolean) {
  if (isMobileApp()) return active ? 4000 : 15000;
  return active ? 2000 : 8000;
}
