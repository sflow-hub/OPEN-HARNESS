import test from "node:test";
import assert from "node:assert/strict";
import { GET as health } from "../app/api/health/route";
import { GET as proxyGet } from "../app/api/local/[...path]/route";

test("health reports only coordinator reachability", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => Response.json({ token: "must-not-leak", secrets: ["also-private"] });
    const ready = await health();
    assert.equal(ready.status, 200);
    assert.deepEqual(await ready.json(), { ok: true });

    globalThis.fetch = async () => { throw new Error("offline"); };
    const unavailable = await health();
    assert.equal(unavailable.status, 503);
    assert.deepEqual(await unavailable.json(), { ok: false });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("remote bootstrap stays closed unless the proxy trust switch is explicit", async () => {
  const originalFetch = globalThis.fetch;
  const originalTrust = process.env.OPEN_HARNESS_ALLOW_REMOTE_DASHBOARD;
  const context = { params: Promise.resolve({ path: ["v1", "bootstrap"] }) };
  try {
    delete process.env.OPEN_HARNESS_ALLOW_REMOTE_DASHBOARD;
    const denied = await proxyGet(new Request("https://agents.example.com/api/local/v1/bootstrap", { headers: { Host: "agents.example.com" } }), context);
    assert.equal(denied.status, 403);

    globalThis.fetch = async () => Response.json({ token: "test-token" });
    const local = await proxyGet(new Request("http://localhost:3000/api/local/v1/bootstrap", { headers: { Host: "localhost:3000" } }), context);
    assert.equal(local.status, 200);

    process.env.OPEN_HARNESS_ALLOW_REMOTE_DASHBOARD = "1";
    const trusted = await proxyGet(new Request("https://agents.example.com/api/local/v1/bootstrap", { headers: { Host: "agents.example.com" } }), context);
    assert.equal(trusted.status, 200);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalTrust === undefined) delete process.env.OPEN_HARNESS_ALLOW_REMOTE_DASHBOARD;
    else process.env.OPEN_HARNESS_ALLOW_REMOTE_DASHBOARD = originalTrust;
  }
});

test("the dashboard proxy forwards only coordinator paths and no hosted dispatch header", async () => {
  const originalFetch = globalThis.fetch;
  try {
    const blocked = await proxyGet(new Request("http://localhost:3000/api/local/etc/passwd", { headers: { Host: "localhost:3000" } }), { params: Promise.resolve({ path: ["etc", "passwd"] }) });
    assert.equal(blocked.status, 404);

    let forwarded = new Headers();
    globalThis.fetch = async (_input, init) => { forwarded = new Headers(init?.headers); return Response.json({ ok: true }); };
    await proxyGet(new Request("http://localhost:3000/api/local/v1/runs", { headers: { Host: "localhost:3000", Authorization: "Bearer token", "OAI-Sites-Authorization": "Bearer dispatch" } }), { params: Promise.resolve({ path: ["v1", "runs"] }) });
    assert.equal(forwarded.get("authorization"), "Bearer token");
    assert.equal(forwarded.get("oai-sites-authorization"), null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
