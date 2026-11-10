'use client';
import { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type WheelEvent as ReactWheelEvent } from 'react';
import { DESKTOP_HEIGHT, DESKTOP_WIDTH, type DesktopInputAction, type DesktopPointerButton } from '../lib/control-client';

// Keys the desktop accepts as chords; everything printable without a modifier is sent as text.
const NAMED: Record<string, string> = { Enter: 'Enter', Tab: 'Tab', Escape: 'Escape', Backspace: 'Backspace', Delete: 'Delete', ArrowUp: 'ArrowUp', ArrowDown: 'ArrowDown', ArrowLeft: 'ArrowLeft', ArrowRight: 'ArrowRight', Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown', Insert: 'Insert', ' ': 'Space' };
export function keyChord(event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey'>): DesktopInputAction | null {
  const modifiers = [event.ctrlKey && 'Control', event.altKey && 'Alt', event.shiftKey && 'Shift', event.metaKey && 'Meta'].filter(Boolean) as string[];
  if (['Control', 'Alt', 'Shift', 'Meta'].includes(event.key)) return null;
  const named = NAMED[event.key] || (/^F([1-9]|1[0-2])$/.test(event.key) ? event.key : '');
  if (named) return { type: 'key', key: [...modifiers.filter(item => named !== 'Space' || item !== 'Shift'), named].join('+') };
  if (event.key.length !== 1) return null;
  // A plain or shifted character is text; with Control, Alt or Meta it is a shortcut chord.
  if (!event.ctrlKey && !event.altKey && !event.metaKey) return { type: 'text', text: event.key };
  if (!/^[a-zA-Z0-9\-=[\]\\;',./`]$/.test(event.key)) return null;
  return { type: 'key', key: [...modifiers, event.key.toLowerCase()].join('+') };
}
const BUTTONS: Record<number, DesktopPointerButton> = { 0: 'left', 1: 'middle', 2: 'right' };
const DRAG_PIXELS = 6, DOUBLE_MS = 300;

// A transparent layer over the desktop image or the view-only stream. It turns the pointer,
// wheel and (when captured) the keyboard into leased desktop input, in order.
export default function DesktopInputSurface({ enabled, onInput, label }: { enabled: boolean; onInput(input: DesktopInputAction): void; label: string }) {
  const keyboardHint=useId();
  const surface = useRef<HTMLDivElement>(null), press = useRef<{ x: number; y: number; px: number; py: number; button: number } | null>(null);
  const pendingClick = useRef<{ timer: ReturnType<typeof setTimeout>; x: number; y: number } | null>(null), wheel = useRef({ x: 0, y: 0 }), text = useRef<{ value: string; timer?: ReturnType<typeof setTimeout> }>({ value: '' });
  const [capturedState, setCaptured] = useState(false), captured = enabled && capturedState;
  const point = (clientX: number, clientY: number) => {
    const bounds = surface.current!.getBoundingClientRect();
    return { x: Math.min(DESKTOP_WIDTH - 1, Math.max(0, Math.floor((clientX - bounds.left) / bounds.width * DESKTOP_WIDTH))), y: Math.min(DESKTOP_HEIGHT - 1, Math.max(0, Math.floor((clientY - bounds.top) / bounds.height * DESKTOP_HEIGHT))) };
  };
  const flushText = () => { const value = text.current.value; clearTimeout(text.current.timer); text.current = { value: '' }; if (value) onInput({ type: 'text', text: value }); };
  const flushClick = () => { const pending = pendingClick.current; if (!pending) return; clearTimeout(pending.timer); pendingClick.current = null; onInput({ type: 'click', x: pending.x, y: pending.y, button: 'left' }); };
  useEffect(() => { if (!enabled) {clearTimeout(text.current.timer);text.current={value:''};if(pendingClick.current)clearTimeout(pendingClick.current.timer);pendingClick.current=null;press.current=null;wheel.current={x:0,y:0};} }, [enabled]);
  useEffect(() => () => { clearTimeout(text.current.timer); if (pendingClick.current) clearTimeout(pendingClick.current.timer); }, []);
  useEffect(() => {
    const node=surface.current;if(!enabled||!node)return;
    // A wheel gesture targets the remote screen; keep the surrounding panel still.
    const prevent=(event:WheelEvent)=>event.preventDefault();node.addEventListener('wheel',prevent,{passive:false});
    return()=>node.removeEventListener('wheel',prevent);
  },[enabled]);
  const down = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!enabled || !BUTTONS[event.button]) return;
    event.preventDefault(); surface.current?.setPointerCapture?.(event.pointerId);
    const at = point(event.clientX, event.clientY); press.current = { ...at, px: event.clientX, py: event.clientY, button: event.button };
  };
  const up = (event: ReactPointerEvent<HTMLDivElement>) => {
    const start = press.current; press.current = null;
    if (!enabled || !start || event.button !== start.button) return;
    event.preventDefault(); flushText();
    const end = point(event.clientX, event.clientY);
    if (start.button === 0 && Math.hypot(event.clientX - start.px, event.clientY - start.py) > DRAG_PIXELS) { flushClick(); onInput({ type: 'drag', fromX: start.x, fromY: start.y, toX: end.x, toY: end.y }); return; }
    if (start.button !== 0) { flushClick(); onInput({ type: 'click', x: start.x, y: start.y, button: BUTTONS[start.button] }); return; }
    // A second left click soon after, near the first, is one double click rather than three clicks.
    const pending = pendingClick.current;
    if (pending && Math.abs(pending.x - start.x) < 12 && Math.abs(pending.y - start.y) < 12) { clearTimeout(pending.timer); pendingClick.current = null; onInput({ type: 'click', x: pending.x, y: pending.y, button: 'left', clickCount: 2 }); return; }
    flushClick();
    pendingClick.current = { x: start.x, y: start.y, timer: setTimeout(flushClick, DOUBLE_MS) };
  };
  const scroll = (event: ReactWheelEvent<HTMLDivElement>) => {
    if (!enabled) return;
    wheel.current.x += event.deltaX; wheel.current.y += event.deltaY;
    const step = 60, vertical = Math.abs(wheel.current.y) >= step, horizontal = Math.abs(wheel.current.x) >= step;
    if (!vertical && !horizontal) return;
    flushClick(); flushText();
    if (vertical) { const amount = Math.min(10, Math.max(1, Math.round(Math.abs(wheel.current.y) / step))); onInput({ type: 'scroll', direction: wheel.current.y > 0 ? 'down' : 'up', amount }); wheel.current.y = 0; }
    if (horizontal) { const amount = Math.min(10, Math.max(1, Math.round(Math.abs(wheel.current.x) / step))); onInput({ type: 'scroll', direction: wheel.current.x > 0 ? 'right' : 'left', amount }); wheel.current.x = 0; }
  };
  const key = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (!enabled || !captured) return;
    // The way out is always local: it is never forwarded to the desktop.
    if (event.key === 'Escape' && event.ctrlKey && event.altKey) { event.preventDefault(); flushText(); setCaptured(false); surface.current?.blur(); return; }
    const action = keyChord(event.nativeEvent); if (!action) return;
    event.preventDefault(); flushClick();
    if (action.type === 'text') { text.current.value += action.text; clearTimeout(text.current.timer); if (text.current.value.length >= 200) flushText(); else text.current.timer = setTimeout(flushText, 120); return; }
    flushText(); onInput(action);
  };
  return <>
    <span id={keyboardHint} hidden>When the keyboard is captured, press Control Alt Escape to release it.</span>
    <div ref={surface} className={`desktop-input-surface ${enabled ? 'enabled' : 'view-only'} ${captured ? 'captured' : ''}`} role="application" aria-label={label} aria-describedby={keyboardHint} tabIndex={enabled ? 0 : -1}
      onPointerDown={down} onPointerUp={up} onPointerCancel={() => { press.current = null; }} onContextMenu={event => event.preventDefault()} onWheel={scroll} onKeyDown={key}
      onBlur={() => { flushText(); setCaptured(false); }} />
    {!enabled && <span className="desktop-view-only">View only</span>}
    {enabled && <div className="desktop-keyboard-bar">
      {captured ? <><span role="status">Keyboard captured: keys go to the desktop. Press Ctrl+Alt+Esc or</span><button type="button" onClick={() => { flushText(); setCaptured(false); }}>Release keyboard</button></>
        : <button type="button" onClick={() => { setCaptured(true); surface.current?.focus(); }}>Type on the desktop</button>}
    </div>}
  </>;
}
