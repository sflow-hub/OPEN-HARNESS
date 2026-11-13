'use client';
import { Trash2 } from 'lucide-react';
import type { Agent } from '../lib/types';

export default function AgentDelete({ agent, disabled, onDelete }: { agent: Agent; disabled?: boolean; onDelete: (agent: Agent) => void }) {
  return <button className="subtle-button" aria-label="Delete agent" title={`Delete ${agent.name}`} disabled={disabled} onClick={() => onDelete(agent)}><Trash2 size={13} /> Delete agent</button>;
}
