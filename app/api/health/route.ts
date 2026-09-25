export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  const base = String(process.env.OPEN_HARNESS_INTERNAL_CONTROL_URL || 'http://127.0.0.1:4317').replace(/\/$/, '');
  try {
    const response = await fetch(`${base}/v1/bootstrap`, {
      cache: 'no-store',
      headers: { Host: '127.0.0.1' },
      signal: AbortSignal.timeout(2_000),
    });
    if (!response.ok) throw new Error(`Coordinator returned HTTP ${response.status}.`);
    return Response.json({ ok: true }, { headers: { 'Cache-Control': 'no-store' } });
  } catch {
    return Response.json(
      { ok: false },
      { status: 503, headers: { 'Cache-Control': 'no-store', 'Retry-After': '2' } },
    );
  }
}
