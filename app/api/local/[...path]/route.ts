export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ path: string[] }> };

async function proxy(request: Request, context: Context) {
  const { path } = await context.params;
  const incoming = new URL(request.url);
  const base = String(process.env.OPEN_HARNESS_INTERNAL_CONTROL_URL || 'http://127.0.0.1:4317').replace(/\/$/, '');
  const target = `${base}/${path.map(encodeURIComponent).join('/')}${incoming.search}`;
  const headers = new Headers();
  for (const name of ['authorization', 'content-type', 'x-open-harness-machine', 'x-open-harness-agent', 'x-open-harness-run', 'oai-sites-authorization']) {
    const value = request.headers.get(name); if (value) headers.set(name, value);
  }
  try {
    const response = await fetch(target, { method: request.method, headers, body: ['GET', 'HEAD'].includes(request.method) ? undefined : await request.arrayBuffer(), redirect: 'manual', cache: 'no-store' });
    return new Response(response.body, { status: response.status, headers: { 'Content-Type': response.headers.get('content-type') || 'application/octet-stream', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
  } catch (error) {
    return Response.json({ error: error instanceof Error ? error.message : 'The coordinator is unavailable.' }, { status: 502 });
  }
}

export const GET = proxy;
export const POST = proxy;
export const PUT = proxy;
export const DELETE = proxy;
