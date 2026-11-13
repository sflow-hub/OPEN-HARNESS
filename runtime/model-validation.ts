import type { ModelChoice } from '../lib/agent-profile';

const endpoints: Record<string, string> = {
  xai: 'https://api.x.ai/v1', openrouter: 'https://openrouter.ai/api/v1',
  openai: 'https://api.openai.com/v1', anthropic: 'https://api.anthropic.com/v1',
};

export const COMPOSE_LOCAL_MODEL_MESSAGE = 'This Docker browser installation cannot use localhost or Docker host aliases for a model server on your computer. Use a hosted provider or a model server network address reachable from both the coordinator and agent containers.';

export function modelEndpointIssue(baseUrl?: string): string | null {
  if (process.env.OPEN_HARNESS_DEPLOYMENT !== 'compose' || !baseUrl) return null;
  let host: string;
  try { host = new URL(baseUrl).hostname.toLowerCase().replace(/\.$/, ''); } catch { return null; }
  // The coordinator, nested engine and operator host have different loopback
  // interfaces. A successful coordinator probe cannot validate these agent URLs.
  return host === 'localhost' || host.endsWith('.localhost') || /^127\./.test(host) || ['0.0.0.0', '[::]', '[::1]', 'host.docker.internal', 'gateway.docker.internal', '[::ffff:0:0]'].includes(host) || /^\[::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}\]$/.test(host)
    ? COMPOSE_LOCAL_MODEL_MESSAGE : null;
}

async function failure(response: Response, key: string) {
  const fallback: Record<number, string> = { 401: 'The API key was rejected.', 402: 'The provider account needs credits.', 403: 'The provider denied access.', 404: 'The model server address was not found.', 429: 'The provider rate limit was reached. Try again shortly.' };
  try {
    const body = await response.json() as { error?: string | { message?: string }; message?: string };
    const detail = typeof body.error === 'string' ? body.error : body.error?.message || body.message;
    if (detail) return (key ? String(detail).replaceAll(key, '[redacted]') : String(detail)).trim().slice(0, 500);
  } catch { /* Provider errors need not be JSON. */ }
  return fallback[response.status] || `The provider returned HTTP ${response.status}.`;
}

// Draft credentials stay in memory until both checks pass. This is also used on a
// runner so a hosted coordinator never needs to persist an untested credential.
export async function testModelConnection(model: ModelChoice, apiKey: string): Promise<{ ok: boolean; message: string }> {
  const base = (model.baseUrl || endpoints[model.provider] || '').replace(/\/$/, '');
  const endpointIssue = modelEndpointIssue(base);
  if (endpointIssue) return { ok: false, message: endpointIssue };
  if (process.env.OPEN_HARNESS_MOCK === '1') return { ok: false, message: 'Mock mode is active, so no model provider was contacted. Restart with npm run dev to test this API key and run real tasks.' };
  if (!base) return { ok: false, message: 'Enter the address of your model server.' };
  if (!apiKey && !['local', 'custom'].includes(model.provider)) return { ok: false, message: 'Enter an API key for this provider.' };
  const anthropic = model.provider === 'anthropic' && !model.baseUrl;
  const headers: Record<string, string> = { 'Content-Type': 'application/json', ...(anthropic ? { 'anthropic-version': '2023-06-01', 'x-api-key': apiKey } : apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) };
  try {
    const catalog = await fetch(`${base}/models`, { headers, signal: AbortSignal.timeout(15_000), redirect: 'error' });
    if (!catalog.ok) return { ok: false, message: await failure(catalog, apiKey) };
    const rows = await catalog.json() as { data?: Array<{ id?: string }> };
    if (!Array.isArray(rows.data) || !rows.data.some(row => row.id === model.model)) return { ok: false, message: `The provider connection works, but model ${model.model} is not available to this API key.` };
    const completion = await fetch(`${base}/${anthropic ? 'messages' : 'chat/completions'}`, {
      method: 'POST', headers, signal: AbortSignal.timeout(30_000), redirect: 'error',
      body: JSON.stringify({ model: model.model, messages: [{ role: 'user', content: 'Reply with OK.' }], ...(model.provider === 'openai' ? { max_completion_tokens: 16 } : { max_tokens: 16 }), stream: false }),
    });
    if (!completion.ok) return { ok: false, message: await failure(completion, apiKey) };
    const result = await completion.json() as { choices?: unknown[]; content?: unknown[] };
    if (!(anthropic ? Array.isArray(result.content) : Array.isArray(result.choices) && result.choices.length)) return { ok: false, message: 'The model server returned an invalid completion response.' };
    return { ok: true, message: 'Provider authenticated and the selected model accepted a live test request.' };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Could not reach the model provider.';
    return { ok: false, message: apiKey ? message.replaceAll(apiKey, '[redacted]') : message };
  }
}
