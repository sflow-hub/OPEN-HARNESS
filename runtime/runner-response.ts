import { AGENT_TRANSFER_WIRE_LIMIT } from './transfer-files';

export async function readRunnerResponse(response: Response, limit = AGENT_TRANSFER_WIRE_LIMIT + 1_000_000): Promise<unknown> {
  const failure = () => new Error('The coordinator returned an invalid or oversized response.');
  if (Number(response.headers.get('content-length')) > limit) { await response.body?.cancel().catch(() => {}); throw failure(); }
  const reader = response.body?.getReader(); if (!reader) throw failure();
  const chunks: Uint8Array[] = []; let total = 0;
  try {
    for (;;) { const { value, done } = await reader.read(); if (done) break; total += value.byteLength; if (total > limit) throw failure(); chunks.push(value); }
    return JSON.parse(Buffer.concat(chunks, total).toString('utf8'));
  } catch { await reader.cancel().catch(() => {}); throw failure(); }
  finally { reader.releaseLock(); }
}
