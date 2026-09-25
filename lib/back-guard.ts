'use client';

import { useEffect, useRef } from 'react';

// Android's Back button, and the gesture that stands in for it, is the system-wide "go back
// one step". The Tauri shell asks the webview first and finishes the activity when the
// webview reports it has nowhere to go back to.
//
// The dashboard is a static export with no router: every overlay is a piece of useState, so
// the webview genuinely had no history and Back always quit the app — from a modal, from the
// full-screen agent editor, from the task drawer. Worse, the only discard guard for unsaved
// profile edits was bound to Escape, which a phone does not have, so Back destroyed work.
//
// The rule here is one history entry per open overlay, kept true after every render. Two
// earlier shapes were tried on the device and both failed:
//
//   - Pushing and popping per overlay, eagerly. Closing one overlay while opening another
//     (Settings → "Run setup again") queued a history.back() that swallowed the entry the
//     incoming overlay had just pushed, and the arriving popstate closed it instantly.
//   - One shared entry, re-pushed from inside the popstate handler. The re-push did not
//     survive the navigation that delivered the event, so with two overlays open the second
//     Back left the app instead of closing the one underneath.
//
// Reconciling a count after commit avoids both: a handoff leaves the count unchanged and so
// touches history not at all, and nothing is ever pushed mid-navigation.
//
// The entries carry no URL change, which matters for a static export: a different path would
// 404 on reload.

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
