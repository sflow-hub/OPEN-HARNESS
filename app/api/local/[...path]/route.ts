export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Context = { params: Promise<{ path: string[] }> };

// The coordinator decides "is this caller on my machine?" from the socket's remote
// address. Every request arriving through this proxy originates from the Next server,
// which is always loopback, so that check cannot distinguish a local browser from the
// public internet. The proxy therefore has to make that call itself.
const BOOTSTRAP_PATH = 'v1/bootstrap';
const LOOPBACK_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;

// The versioned public API plus the agent coordination endpoints. /internal/* belongs
// here because an agent on a remote runner reaches handoff, scheduling and board tasks
// over HTTP through this proxy (runtime/hermes/coordination.mjs sends them to
// OPEN_HARNESS_CONTROL_URL when it has no unix socket); those routes authenticate the
// caller's agent token and check its per-run tool grant. Anything else is closed.
const PROXYABLE_ROOTS = new Set(['v1', 'internal']);
function proxyable(path: string[]) {
  return path.length > 0 && PROXYABLE_ROOTS.has(path[0]);
}

// /v1/bootstrap returns the master control token, which authorizes arbitrary run
// creation, host-path container mounts and direct OS-account execution. Serve it only
// when the dashboard was reached over loopback, unless the operator has explicitly
// accepted responsibility for authenticating remote access in front of this app.
function bootstrapAllowed(request: Request) {
  if (process.env.OPEN_HARNESS_ALLOW_REMOTE_DASHBOARD === '1') return true;
  const host = request.headers.get('host');
  return Boolean(host && LOOPBACK_HOST.test(host));
}

async function proxy(request: Request, context: Context) {
  const { path } = await context.params;
  if (!proxyable(path)) return Response.json({ error: 'This path is not available through the dashboard.' }, { status: 404 });
  if (path.join('/') === BOOTSTRAP_PATH && !bootstrapAllowed(request)) {
    return Response.json({
      error: 'Open Harness will not hand the control token to a remote dashboard. Reach it over localhost, or put it behind an authenticated HTTPS reverse proxy and set OPEN_HARNESS_ALLOW_REMOTE_DASHBOARD=1.',
    }, { status: 403 });
  }
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
