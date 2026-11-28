'use client';

import { useEffect, useRef, useState } from 'react';

type Overlay = { back: () => void };
const overlays: Overlay[] = [];
let armed = false, removing = false, scheduled = false, listening = false;
function reconcile() {
  scheduled = false;
  if (removing) return;
  if (overlays.length && !armed) {
    window.history.pushState({ ...window.history.state, openHarnessOverlay: true }, '');
    armed = true;
  } else if (!overlays.length && armed) {
    armed = false; removing = true; window.history.back();
  }
}
function schedule() {
  if (scheduled) return;
  scheduled = true;
  // All overlay effects must commit before deciding whether a handoff needs a history entry.
  queueMicrotask(reconcile);
}
function onPopState() {
  if (removing) { removing = false; schedule(); return; }
  if (!armed) return;
  armed = false;
  overlays.at(-1)?.back();
}

// One same-URL entry protects the workspace. Each Back dismisses the top overlay, then the
// next committed render rearms it for any remaining panel, including a refused dirty close.
export function useMobileBackGuard(active: boolean, onBack: () => void) {
  const latest = useRef(onBack);
  const [, render] = useState(0);
  useEffect(() => { latest.current = onBack; });
  useEffect(() => {
    if (!active) return;
    if (!listening) { window.addEventListener('popstate', onPopState); listening = true; }
    const overlay = { back: () => { latest.current(); render(value => value + 1); } };
    const media = window.matchMedia('(max-width: 760px)');
    const update = () => {
      const index = overlays.indexOf(overlay);
      if (media.matches && index < 0) overlays.push(overlay);
      else if (!media.matches && index >= 0) overlays.splice(index, 1);
      schedule();
    };
    update(); media.addEventListener('change', update);
    return () => { media.removeEventListener('change', update); const index = overlays.indexOf(overlay); if (index >= 0) overlays.splice(index, 1); schedule(); };
  }, [active]);
  useEffect(() => { if (active) schedule(); });
}

export function trackKeyboardInset() {
  const viewport = window.visualViewport;
  if (!viewport) return () => {};
  const root = document.documentElement;
  const update = () => {
    // Pinch zoom also shrinks the viewport; it must not be mistaken for a keyboard.
    const inset = viewport.scale === 1 ? Math.max(0, Math.round(window.innerHeight - viewport.height - viewport.offsetTop)) : 0;
    root.style.setProperty('--keyboard-inset', `${inset}px`);
    root.toggleAttribute('data-keyboard-open', inset > 0);
  };
  update(); viewport.addEventListener('resize', update); viewport.addEventListener('scroll', update);
  return () => { viewport.removeEventListener('resize', update); viewport.removeEventListener('scroll', update); root.style.removeProperty('--keyboard-inset'); root.removeAttribute('data-keyboard-open'); };
}
