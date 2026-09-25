'use client';

import { useEffect, useRef } from 'react';

// Keep one browser-history entry per open overlay so Back can dismiss it safely.
// Reconcile after render: switching overlays leaves the count unchanged, and
// nothing is pushed during a navigation event. URLs stay unchanged on reload.

type Entry = { onBack: () => void };

const stack: Entry[] = [];
// Entries we have pushed and the browser has not yet consumed. Kept equal to stack.length.
let pushed = 0;
// Pops we caused ourselves, so the popstate they produce is not read as a Back press.
let selfPops = 0;
let listening = false;

function reconcile() {
  if (typeof window === 'undefined') return;
  while (pushed > stack.length) {
    pushed -= 1;
    selfPops += 1;
    window.history.back();
  }
  while (pushed < stack.length) {
    pushed += 1;
    window.history.pushState({ openHarnessOverlay: pushed }, '');
  }
}

function onPopState() {
  if (selfPops > 0) { selfPops -= 1; return; }
  if (!pushed) return;
  // The browser consumed one of ours to deliver this event.
  pushed -= 1;
  // Closing updates React state; the effect below then sees the counts already agree and
  // leaves history alone.
  stack[stack.length - 1]?.onBack();
}

export function useBackGuard(active: boolean, onBack: () => void) {
  // Kept in a ref so a re-rendered handler does not tear the entry down and recreate it,
  // which would churn history on every keystroke behind an open overlay.
  const latest = useRef(onBack);
  useEffect(() => { latest.current = onBack; }, [onBack]);

  useEffect(() => {
    if (!active || typeof window === 'undefined') return;
    if (!listening) { window.addEventListener('popstate', onPopState); listening = true; }
    const entry: Entry = { onBack: () => latest.current() };
    stack.push(entry);
    return () => {
      const index = stack.indexOf(entry);
      if (index >= 0) stack.splice(index, 1);
    };
  }, [active]);

  // Deliberately un-keyed: this is the one place history is touched, and it runs after the
  // commit that opened or closed something, when the stack is already correct.
  useEffect(reconcile);
}
