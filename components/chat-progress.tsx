'use client';

import { useEffect, useState } from 'react';
import type { PersistentRun } from '../lib/control-client';
import type { Activity, Message } from '../lib/types';

const toolLabels: Record<string, string> = {
  read_file: 'Reading a file…', write_file: 'Writing a file…', patch: 'Editing a file…',
  search_files: 'Searching files…', web_search: 'Searching the web…', web_extract: 'Reading a page…',
  terminal: 'Running a command…', execute_code: 'Running code…',
};

export default function ChatProgress({ run, phase, activities, hasText = false, reconnecting = false, label }: {
  run?: PersistentRun; phase?: Message['progress']; activities?: Activity[]; hasText?: boolean; reconnecting?: boolean; label?: string;
}) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const parsed = Date.parse(run?.created_at || ''), started = Number.isFinite(parsed) ? parsed : Date.now();
    const timer = setInterval(() => setElapsed(Math.max(0, Math.floor((Date.now() - started) / 1000))), 1000);
    return () => clearInterval(timer);
  }, [run?.id, run?.created_at]);
  const tool = activities?.findLast(item => item.status === 'running');
  const state = label ? 'sending' : reconnecting ? 'reconnecting' : run?.state === 'queued' ? 'queued'
    : run?.state === 'waiting_approval' || run?.state === 'waiting_input' ? 'waiting'
      : tool ? 'tool' : phase === 'finishing' ? 'finishing' : phase === 'thinking' ? 'thinking' : hasText ? 'responding' : 'starting';
  const text = label || (state === 'reconnecting' ? 'Reconnecting — your agent is still working…'
    : state === 'queued' ? 'Queued…' : run?.state === 'waiting_approval' ? 'Waiting for your approval…'
      : run?.state === 'waiting_input' ? 'Waiting for your answer…'
        : state === 'tool' && tool ? toolLabels[tool.name] || `Using ${tool.name.replaceAll('_', ' ')}…`
          : state === 'finishing' ? 'Finishing up…' : state === 'responding' ? 'Responding…'
            : state === 'thinking' ? 'Thinking…' : 'Getting ready…');
  return <div className="working chat-progress" data-state={state}>
    <span className="chat-progress-dots" aria-hidden="true"><i /><i /><i /></span>
    <span role="status" className="chat-progress-label">{text}</span>
    {elapsed >= 2 && <span className="chat-progress-time" aria-hidden="true">{elapsed < 60 ? `${elapsed}s` : `${Math.floor(elapsed / 60)}m ${elapsed % 60}s`}</span>}
  </div>;
}
