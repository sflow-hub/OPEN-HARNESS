'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import '@xterm/xterm/css/xterm.css';
import { parseTerminalMessage, type ControlClient, type TerminalClientMessage } from '../lib/control-client';

type Phase = { state: 'connecting' | 'open' | 'closed' | 'error'; message: string };
// Touch keyboards cannot drive a terminal emulator reliably, so a few control keys are buttons.
const KEYS: Array<[string, string]> = [['Ctrl+C', '\u0003'], ['Tab', '\t'], ['Up', '\u001b[A'], ['Down', '\u001b[B'], ['Esc', '\u001b'], ['Ctrl+D', '\u0004']];

// The human terminal is a shell in this agent's own execution container. Only the person in
// control receives a ticket; nothing typed or shown here is stored by this page.
export default function WorkspaceTerminal({ client, agentId, leaseId, machineName }: { client: ControlClient; agentId: string; leaseId: string; machineName: string }) {
  const host = useRef<HTMLDivElement>(null), socket = useRef<WebSocket | null>(null);
  const [phase, setPhase] = useState<Phase>({ state: 'connecting', message: 'Opening your terminal…' });
  const [attempt, setAttempt] = useState(0), [line, setLine] = useState('');
  const send = useCallback((message: TerminalClientMessage) => { const ws = socket.current; if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message)); }, []);
  useEffect(() => {
    let cancelled = false, cleanup = () => {};
    void (async () => {
      const [{ Terminal }, { FitAddon }, ticket] = await Promise.all([import('@xterm/xterm'), import('@xterm/addon-fit'), client.terminalTicket(agentId, leaseId)]);
      if (cancelled || !host.current) return;
      const terminal = new Terminal({ convertEol: false, cursorBlink: true, fontSize: 13, scrollback: 2000, theme: { background: '#111315' } }), fit = new FitAddon();
      terminal.loadAddon(fit); terminal.open(host.current);
      const ws = new WebSocket(client.websocketUrl(ticket.path)); socket.current = ws;
      const deadline = setTimeout(() => { if (!cancelled && ws.readyState !== WebSocket.OPEN) { setPhase({ state: 'error', message: 'The terminal did not connect. Reconnect to try again.' }); ws.close(); } }, 15000);
      const resize = () => { try { fit.fit(); } catch { /* Hidden while another tab is shown. */ } if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'resize', cols: terminal.cols, rows: terminal.rows })); };
      const observer = new ResizeObserver(resize); observer.observe(host.current);
      const input = terminal.onData(data => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'input', data })); });
      ws.onopen = () => { clearTimeout(deadline); if (cancelled) return; setPhase({ state: 'open', message: `Connected to this agent’s workspace on ${machineName}.` }); resize(); terminal.focus(); };
      ws.onerror = () => { clearTimeout(deadline); if (cancelled) return; setPhase({ state: 'error', message: 'The terminal connection failed. Reconnect to try again.' }); ws.close(); };
      ws.onmessage = event => {
        if (cancelled) return;
        const message = parseTerminalMessage(event.data); if (!message) return;
        if (message.type === 'output') terminal.write(message.data);
        else if (message.type === 'exit') { setPhase({ state: 'closed', message: `The shell exited (code ${message.code}). Reconnect to start a new one.` }); }
        else setPhase({ state: 'error', message: message.message });
      };
      ws.onclose = () => { clearTimeout(deadline); if (cancelled) return; setPhase(current => current.state === 'open' || current.state === 'connecting' ? { state: 'closed', message: 'The terminal disconnected. Earlier output is not kept. Reconnect to open a new shell.' } : current); };
      cleanup = () => { clearTimeout(deadline); observer.disconnect(); input.dispose(); ws.onopen = null; ws.onerror = null; ws.onmessage = null; ws.onclose = null; ws.close(); terminal.dispose(); socket.current = null; };
      if (cancelled) cleanup();
    })().catch(error => { if (!cancelled) setPhase({ state: 'error', message: error instanceof Error ? error.message : 'The terminal could not open.' }); });
    return () => { cancelled = true; cleanup(); };
  }, [client, agentId, leaseId, machineName, attempt]);
  const open = phase.state === 'open';
  return <section className="workspace-terminal" aria-label="Workspace terminal">
    <p role="status" className={phase.state === 'error' ? 'task-error' : ''}>{phase.message}</p>
    <div ref={host} className="workspace-terminal-screen" data-testid="workspace-terminal-screen" />
    <div className="workspace-terminal-keys">{KEYS.map(([label, data]) => <button key={label} type="button" disabled={!open} onClick={() => send({ type: 'input', data })}>{label}</button>)}
      {!open && <button type="button" className="light-button" disabled={phase.state === 'connecting'} onClick={() => { setPhase({ state: 'connecting', message: 'Opening your terminal…' }); setAttempt(value => value + 1); }}>Reconnect terminal</button>}
    </div>
    <form className="desktop-text-form" onSubmit={event => { event.preventDefault(); if (!line) return; send({ type: 'input', data: `${line}\r` }); setLine(''); }}>
      <label>Command line (for touch keyboards)<input aria-label="Terminal command" autoComplete="off" autoCapitalize="off" spellCheck={false} value={line} maxLength={4000} disabled={!open} onChange={event => setLine(event.target.value)} /></label>
      <button type="submit" disabled={!open || !line}>Run</button>
    </form>
  </section>;
}
