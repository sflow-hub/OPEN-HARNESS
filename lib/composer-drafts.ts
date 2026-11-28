"use client";

import { useMemo, useSyncExternalStore } from 'react';

// Read one draft at a time. A revision distinguishes two edits with identical text,
// including edits made by another tab while the coordinator is accepting a send.
class DraftStore {
  private readonly prefix: string | null;
  private readonly memory = new Map<string, string>();
  private readonly changes = new EventTarget();

  constructor(scope: string | null) {
    this.prefix = scope ? `open-harness.draft.v1:${encodeURIComponent(scope)}:` : null;
  }

  read(key: string) {
    if (this.memory.has(key)) return this.memory.get(key)!;
    try { return this.prefix ? localStorage.getItem(this.prefix + key) || '' : ''; }
    catch { return ''; }
  }

  write(key: string, value: string) {
    this.memory.set(key, value);
    if (this.prefix) {
      try {
        if (value) localStorage.setItem(this.prefix + key, value);
        else localStorage.removeItem(this.prefix + key);
        this.memory.delete(key);
      } catch { /* Keep the edit in this tab when browser storage is unavailable. */ }
    }
    this.changes.dispatchEvent(new Event('change'));
  }

  clearIfUnedited(key: string, sent: string) {
    if (sent && this.read(key) === sent) this.write(key, '');
  }

  subscribe = (notify: () => void) => {
    const sync = (event: StorageEvent) => {
      if (this.prefix && (!event.key || event.key.startsWith(this.prefix))) notify();
    };
    this.changes.addEventListener('change', notify);
    window.addEventListener('storage', sync);
    return () => {
      this.changes.removeEventListener('change', notify);
      window.removeEventListener('storage', sync);
    };
  };
}

export function useComposerDraft(scope: string | null, key: string) {
  const drafts = useMemo(() => new DraftStore(scope), [scope]);
  const saved = useSyncExternalStore(drafts.subscribe, () => drafts.read(key), () => '');
  // The first line holds the revision. Everything after it is the original multiline text.
  const input = saved.slice(saved.indexOf('\n') + 1);
  function edit(text: string) {
    const revision = text ? `${crypto.randomUUID()}\n${text}` : '';
    drafts.write(key, revision);
    return revision;
  }
  return { drafts, saved, input, edit };
}
