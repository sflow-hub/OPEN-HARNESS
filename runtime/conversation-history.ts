export type ConversationTurn = { role: 'user' | 'assistant'; content: string };
type PastRun = { prompt: string; result?: string | null; error?: string | null; state: string };

// Seed a fresh gateway with completed conversation turns. Replaying only text (not
// tool calls) preserves follow-up context without resuming uncertain side effects,
// and lets each new run apply its own immutable model/tool/profile revision.
export function conversationHistory(runs: PastRun[]): ConversationTurn[] {
  return runs.flatMap(run => {
    const result = run.result || (run.state === 'completed' ? '' : `[Previous run ${run.state}${run.error ? `: ${run.error}` : ''}. Do not assume unfinished actions succeeded.]`);
    return [{ role: 'user' as const, content: run.prompt }, ...(result ? [{ role: 'assistant' as const, content: result }] : [])];
  });
}
