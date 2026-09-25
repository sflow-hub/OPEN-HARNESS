'use client';

import { useEffect, useRef } from 'react';

// Android's Back button, and the gesture that stands in for it, is the system-wide "go back
// one step". The Tauri shell asks the webview first and finishes the activity when the
// webview says it has nowhere to go back to.
//
// The dashboard is a static export with no router: every overlay is a piece of useState, so
// the webview genuinely had no history and Back always quit the app — from a modal, from the
// full-screen agent editor, from the task drawer. Worse, the only discard guard for unsaved
// profile edits was bound to Escape, which a phone does not have, so Back destroyed work.
//
// One history entry is kept while any overlay is open, rather than one entry per overlay.
// Per-overlay entries looked simpler and were wrong: closing one overlay while opening
// another (Settings → "Run setup again") queued a history.back() that then swallowed the
// entry the incoming overlay had just pushed, and the arriving popstate closed it again
// immediately. Sharing one entry means that transition touches history not at all.
//
// The entry carries no URL change, which matters for a static export: a different path
// would 404 on reload.

type Entry = { onBack: () => void };

const stack: Entry[] = [];
let guardPushed = false;
// Set while we pop our own entry, so the popstate that results is not mistaken for the
// person pressing Back.
let selfPop = false;
let listening = false;

function pushGuard() {
  if (guardPushed || typeof window === 'undefined') return;
  window.history.pushState({ openHarnessOverlay: true }, '');
  guardPushed = true;
}

function dropGuard() {
  if (!guardPushed || typeof window === 'undefined') return;
  guardPushed = false;
  selfPop = true;
  window.history.back();
}

function onPopState() {
  if (selfPop) { selfPop = false; return; }
  if (!guardPushed) return;
  // The browser consumed our entry to deliver this event.
  guardPushed = false;
  const top = stack[stack.length - 1];
  if (!top) return;
  // Checked before closing, because closing removes it from the stack on the next commit.
  const othersRemain = stack.length > 1;
  top.onBack();
  // Still something open underneath, so Back needs somewhere to go for it too.
  if (othersRemain) pushGuard();
}

export function useBackGuard(active: boolean, onBack: () => void) {
  // Kept in a ref so a re-rendered handler does not tear down and re-create the entry, which
  // would churn history on every keystroke behind an open overlay.
  const latest = useRef(onBack);
  useEffect(() => { latest.current = onBack; }, [onBack]);

  useEffect(() => {
    if (!active || typeof window === 'undefined') return;
    if (!listening) { window.addEventListener('popstate', onPopState); listening = true; }
    const entry: Entry = { onBack: () => latest.current() };
    stack.push(entry);
    pushGuard();
    return () => {
      const index = stack.indexOf(entry);
      if (index >= 0) stack.splice(index, 1);
      // Closed some other way — a close button, a save, Escape on a keyboard. Give the
      // entry back only once nothing is left open, or the next Back would do nothing.
      if (!stack.length) dropGuard();
    };
  }, [active]);
}
