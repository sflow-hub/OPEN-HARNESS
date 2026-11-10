"use client";

import { memo, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { Message } from '../lib/types';

// Every message is rendered Markdown, and a long conversation used to mount all of it at
// once: 1,000 messages meant tens of thousands of nodes before the newest one was visible.
// Only the newest batch is mounted; earlier batches are added when someone asks for them.
const BATCH = 60;
// Within this distance of the end still counts as reading the newest message.
const FOLLOW_SLACK = 64;
// The transcript's CSS asks for smooth scrolling. Opening a chat or following a stream has
// to land at once, and a smooth scroll in flight reads as the user scrolling away.
const jump = (el: HTMLElement, top: number) => el.scrollTo({ top, behavior: 'instant' });

// The message at the top of the view and how far below the transcript's top edge it sits.
type Anchor = { id: string; top: number };
type Bounds = { width: number; height: number; end: number };
function returnedToEnd(el: HTMLElement, bounds: Bounds | null, lastTop: number) {
  return bounds && el.clientWidth === bounds.width && el.clientHeight === bounds.height
    && el.scrollTop > lastTop && Math.abs(el.scrollTop - bounds.end) <= FOLLOW_SLACK;
}
function capture(el: HTMLElement): Anchor | null {
  const rows = el.querySelectorAll<HTMLElement>('[data-message-id]');
  const edge = el.getBoundingClientRect().top;
  // Rows are in document order, so a binary search finds the first one still showing
  // without measuring every message on each scroll event.
  let low = 0, high = rows.length - 1;
  while (low < high) { const mid = (low + high) >> 1; if (rows[mid].getBoundingClientRect().bottom > edge) high = mid; else low = mid + 1; }
  const row = rows[low];
  return row?.dataset.messageId ? { id: row.dataset.messageId, top: row.getBoundingClientRect().top - edge } : null;
}
// Keeps whoever is at the end there, and everyone else on the message they were reading.
// WebKit has no scroll anchoring of its own, so a reflow above (a narrower window, the
// workspace panel, a batch of earlier messages) would otherwise move the text being read.
function hold(el: HTMLElement, following: boolean, anchor: Anchor | null) {
  if (following) return jump(el, el.scrollHeight);
  const node = anchor && el.querySelector<HTMLElement>(`[data-message-id="${CSS.escape(anchor.id)}"]`);
  if (!anchor || !node) return;
  const shift = node.getBoundingClientRect().top - el.getBoundingClientRect().top - anchor.top;
  if (Math.abs(shift) >= 1) jump(el, el.scrollTop + shift);
}

// Re-renders only when its message or the render function changes, so a parent that keeps
// renderMessage stable stops streaming text from re-rendering every other message.
const Row = memo(function Row({ message, render }: { message: Message; render: (message: Message) => ReactNode }) {
  return <>{render(message)}</>;
});

// scrollToEndOn: a value that turns truthy when the person acts here, such as sending a
// message. Their own action brings them back to the newest message even from older ones.
export default function ConversationTranscript({ conversationId, messages, renderMessage, empty, footer, scrollToEndOn }: {
  conversationId: string; messages: Message[]; renderMessage: (message: Message) => ReactNode; empty: ReactNode; footer?: ReactNode; scrollToEndOn?: unknown;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  // start null follows the newest batch. A number pins the first mounted message, so new
  // messages can't slide the window out from under someone reading or after Load earlier.
  const [view, setView] = useState<{ conversationId: string; start: number | null }>({ conversationId, start: null });
  // Another conversation starts over on its newest batch; the old pin must not come back
  // when switching back, so it is dropped rather than kept per conversation.
  if (view.conversationId !== conversationId) setView({ conversationId, start: null });
  const pinned = view.conversationId === conversationId ? view.start : null;
  const start = pinned === null ? Math.max(0, messages.length - BATCH) : Math.min(pinned, messages.length);
  const following = useRef(true);
  const reading = useRef<Anchor | null>(null);
  const lastTop = useRef(0);
  const bounds = useRef<Bounds | null>(null);
  const shown = useRef(conversationId);
  const refocus = useRef(false);
  const asked = useRef(scrollToEndOn);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (shown.current !== conversationId) { shown.current = conversationId; following.current = true; reading.current = null; }
    hold(el, following.current, reading.current);
    lastTop.current = el.scrollTop;
    bounds.current = { width: el.clientWidth, height: el.clientHeight, end: el.scrollHeight - el.clientHeight };
    if (refocus.current) { refocus.current = false; el.focus({ preventScroll: true }); }
  }, [conversationId, start]);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el && scrollToEndOn && scrollToEndOn !== asked.current) { following.current = true; jump(el, el.scrollHeight); lastTop.current = el.scrollTop; }
    asked.current = scrollToEndOn;
  }, [scrollToEndOn]);
  // Anything that changes a height re-applies the same rule: streamed text, appended
  // messages, the footer, and the transcript itself resizing with the workspace panel, the
  // window, or a phone keyboard. One observer replaces re-measuring on every parent render.
  useLayoutEffect(() => {
    const el = ref.current, inner = content.current;
    if (!el || !inner) return;
    // Layout can also move scrollTop (clamping when the content shrinks, the browser's own
    // anchoring); recording it here keeps the scroll event that follows from reading as a move up.
    const observer = new ResizeObserver(() => {
      // A new delta can grow the content before the scroll event for returning to its old
      // end arrives. Recognize that move before restoring the previous reading position.
      if (returnedToEnd(el, bounds.current, lastTop.current)) following.current = true;
      hold(el, following.current, reading.current);
      lastTop.current = el.scrollTop;
      bounds.current = { width: el.clientWidth, height: el.clientHeight, end: el.scrollHeight - el.clientHeight };
    });
    observer.observe(el);
    observer.observe(inner);
    return () => observer.disconnect();
  }, []);

  function onScroll() {
    const el = ref.current;
    if (!el) return;
    const top = el.scrollTop;
    // A scroll event also follows our own jumps and content resizing, and can arrive after
    // the content grew again, looking far from the end. Only moving up is the reader leaving.
    if (el.scrollHeight - top - el.clientHeight <= FOLLOW_SLACK || returnedToEnd(el, bounds.current, lastTop.current)) following.current = true;
    else if (top < lastTop.current) following.current = false;
    lastTop.current = top;
    if (following.current) return;
    reading.current = capture(el);
    if (pinned === null) setView({ conversationId, start });
  }
  function loadEarlier() {
    const el = ref.current;
    if (!el) return;
    reading.current = capture(el);
    following.current = false;
    // The button goes away with the last batch; focus stays in the transcript, not on <body>.
    refocus.current = start <= BATCH;
    setView({ conversationId, start: Math.max(0, start - BATCH) });
  }

  return <div className="transcript" aria-live="polite" ref={ref} onScroll={onScroll} tabIndex={-1} style={{ scrollBehavior: 'auto' }}>
    <div ref={content}>{!messages.length ? empty : <>
      {start > 0 && <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6, margin: '4px auto 18px' }}>
        <button type="button" className="subtle-button" onClick={loadEarlier}>Load earlier messages</button>
        <small className="muted">Showing the latest {messages.length - start} of {messages.length} messages.</small>
      </div>}
      {messages.slice(start).map(message => <div key={message.id} data-message-id={message.id}><Row message={message} render={renderMessage} /></div>)}
    </>}
    {footer}</div>
  </div>;
}
