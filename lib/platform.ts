// Browser capabilities shared by the dashboard and the desktop webview.

export type KeyValueStore = {
  get<T>(key: string): Promise<T | null>;
  set(key: string, value: unknown): Promise<void>;
  remove(key: string): Promise<void>;
};

// Resolve after mount so the initial render agrees with the server.
export const PHONE_LAYOUT_QUERY = '(max-width: 760px), (pointer: coarse) and (max-width: 1024px)';
export function isPhoneLayout() {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  try { return window.matchMedia(PHONE_LAYOUT_QUERY).matches; } catch { return false; }
}

export async function platformFetch(): Promise<typeof fetch> {
  return globalThis.fetch.bind(globalThis);
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

// Keep the existing origin-storage key so paired browsers stay connected.
export const secureStore: KeyValueStore = webStore('open-harness.secure.');

export async function notificationsGranted(): Promise<boolean> {
  return typeof Notification !== 'undefined' && Notification.permission === 'granted';
}

export async function requestNotificationPermission(): Promise<boolean> {
  if (typeof Notification === 'undefined') return false;
  if (Notification.permission === 'granted') return true;
  try { return (await Notification.requestPermission()) === 'granted'; } catch { return false; }
}

// Sending never prompts: permission is requested from Settings.
export async function notify(title: string, body: string, tag?: string) {
  try {
    if (typeof Notification !== 'undefined' && Notification.permission === 'granted') new Notification(title, { body, ...(tag ? { tag } : {}) });
  } catch { /* Notifications must never interrupt a run. */ }
}

// Reduce polling on small screens and while the page is hidden.
export function eventPollIntervalMs(hidden: boolean) {
  if (isPhoneLayout()) return hidden ? 6000 : 1500;
  return hidden ? 4000 : 500;
}

// The task board refreshes on its own clock: quickly while something is moving, slowly
// otherwise. Same reasoning as above for the phone.
export function taskPollIntervalMs(active: boolean) {
  if (isPhoneLayout()) return active ? 4000 : 15000;
  return active ? 2000 : 8000;
}

// Keep the composer above a browser's soft keyboard using the visual viewport.
export function trackKeyboardInset(): () => void {
  if (typeof window === 'undefined') return () => {};
  const viewport = window.visualViewport;
  const root = document.documentElement;
  if (!viewport) return () => {};
  const apply = () => {
    // Anything the visual viewport has lost off the bottom is keyboard, or another
    // on-screen widget occupying the same space.
    const inset = Math.max(0, Math.round(window.innerHeight - viewport.height - viewport.offsetTop));
    root.style.setProperty('--keyboard-inset', `${inset}px`);
  };
  apply();
  viewport.addEventListener('resize', apply);
  viewport.addEventListener('scroll', apply);
  return () => {
    viewport.removeEventListener('resize', apply);
    viewport.removeEventListener('scroll', apply);
    root.style.removeProperty('--keyboard-inset');
  };
}
