'use client';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { ControlClient } from '../lib/control-client';
// The live view is always view-only: noVNC never sends input. Pointer and keyboard input from
// the person in control goes through the leased desktop input request, drawn as `overlay`.
export default function DesktopStream({ client, agentId, overlay, onFallback }: { client: ControlClient; agentId: string; overlay?: ReactNode; onFallback(): void }) {
  const target = useRef<HTMLDivElement>(null), [state, setState] = useState('Connecting to the desktop…');
  useEffect(() => {
    let cancelled = false, close: (() => void) | undefined, timer: ReturnType<typeof setTimeout> | undefined, generation = 0, failures = 0;
    const connect = async () => {
      const attempt = ++generation; clearTimeout(timer); close?.(); close = undefined;
      const retry = () => {
        if (cancelled || attempt !== generation) return;
        ++generation; clearTimeout(timer); close?.(); close = undefined;
        if (++failures >= 3) { setState('The live desktop is unavailable. Showing image previews instead.'); onFallback(); return; }
        setState('Reconnecting to the live desktop…'); timer = setTimeout(() => void connect(), 1000);
      };
      try {
        const [{ default: RFB }, ticket] = await Promise.all([import('@novnc/novnc'), client.request<{ path: string; sessionSeconds?: number }>(`/v1/agents/${encodeURIComponent(agentId)}/desktop/stream`, { method: 'POST', body: '{}' })]);
        if (cancelled || attempt !== generation || !target.current) return;
        const rfb = new RFB(target.current, client.websocketUrl(ticket.path), { shared: true });
        rfb.viewOnly = true; rfb.scaleViewport = true; rfb.resizeSession = false; rfb.focusOnClick = false;
        close = () => rfb.disconnect();
        rfb.addEventListener('connect', () => {
          if (cancelled || attempt !== generation) return;
          clearTimeout(timer);
          failures = 0; setState('Live desktop · view only; input goes through your control session');
          // Renew the read-only viewer before its bounded server lifetime, without changing ownership.
          timer = setTimeout(() => void connect(), Math.max(1000, Math.min(285000, ((ticket.sessionSeconds || 300) - 15) * 1000)));
        });
        rfb.addEventListener('disconnect', retry);
        timer=setTimeout(retry,15000);
      } catch { retry(); }
    };
    void connect();
    return () => { cancelled = true; ++generation; clearTimeout(timer); close?.(); };
  }, [client, agentId, onFallback]);
  return <div><p role="status">{state}</p><div className="desktop-screen"><div ref={target} className="desktop-screen-media" />{overlay}</div></div>;
}
