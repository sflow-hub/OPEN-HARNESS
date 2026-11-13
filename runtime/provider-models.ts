// Picking a model was a bare text box in every first-run and workspace screen: the operator
// saved a key and then had to already know an exact model ID, and for OpenRouter the field
// started empty. The provider's own /models endpoint is already fetched to validate the key,
// and its body was thrown away. One helper, so the list is available wherever a model is chosen
// without starting a container the way the per-agent catalogue has to.
export const PROVIDER_ENDPOINTS: Record<string, string> = { xai: 'https://api.x.ai/v1', openrouter: 'https://openrouter.ai/api/v1', openai: 'https://api.openai.com/v1', anthropic: 'https://api.anthropic.com/v1' };
export async function providerModelList(baseUrl: string, key: string, provider: string) {
  const headers: Record<string, string> = provider === 'anthropic' ? { 'anthropic-version': '2023-06-01', ...(key ? { 'x-api-key': key } : {}) } : key ? { Authorization: `Bearer ${key}` } : {};
  const response = await fetch(`${baseUrl}/models`, { headers, signal: AbortSignal.timeout(15_000), redirect: 'error' });
  if (!response.ok) return { ok: false, status: response.status, models: [] as string[] };
  let models: string[] = [];
  try {
    const payload = await response.json() as { data?: unknown; models?: unknown };
    const entries = Array.isArray(payload.data) ? payload.data : Array.isArray(payload.models) ? payload.models : [];
    models = [...new Set(entries.map(entry => {
      const row = entry as { id?: unknown; name?: unknown };
      return String(row?.id ?? row?.name ?? '').trim();
    }).filter(Boolean))].sort().slice(0, 500);
  } catch { /* a provider that answers 200 with something else still proves the key works */ }
  return { ok: true, status: response.status, models };
}
