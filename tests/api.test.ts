import test from "node:test";
import assert from "node:assert/strict";
import { POST } from "../app/api/run/route";
import { initialWorkspace } from "../lib/types";
const payload = {
  agent: initialWorkspace.agents[0],
  files: [],
  messages: [{ id: "u1", role: "user", content: "Create a brief." }],
  provider: "xai",
  model: "test",
  apiKey: "test-key",
  maxSteps: 4,
};
const req = (body: unknown, origin = "http://localhost:3000") =>
  new Request("http://localhost:3000/api/run", {
    method: "POST",
    headers: { "Content-Type": "application/json", origin },
    body: JSON.stringify(body),
  });
test("route rejects malformed and cross-origin requests", async () => {
  assert.equal((await POST(req(null))).status, 400);
  assert.equal((await POST(req({}))).status, 400);
  assert.equal(
    (await POST(req(payload, "https://untrusted.example"))).status,
    403,
  );
  assert.equal(
    (await POST(req({ ...payload, provider: "__proto__" }))).status,
    400,
  );
});
test("HTTP provider response feeds tools and streams the final deliverable", async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (input, init) => {
    assert.equal(input, "https://api.x.ai/v1/chat/completions");
    const body = JSON.parse(String(init?.body));
    assert.equal(body.model, "test");
    if (calls++ === 0)
      return Response.json({
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                {
                  id: "tool1",
                  type: "function",
                  function: {
                    name: "write_file",
                    arguments: JSON.stringify({
                      name: "brief.md",
                      content: "# A real deliverable",
                    }),
                  },
                },
              ],
            },
          },
        ],
      });
    assert.ok(
      body.messages.some(
        (m: { role: string; content: string }) =>
          m.role === "tool" && m.content.includes("Saved brief.md"),
      ),
    );
    return Response.json({
      choices: [{ message: { content: "Your brief is ready." } }],
    });
  };
  try {
    const response = await POST(req(payload));
    assert.equal(response.status, 200);
    const events = (await response.text())
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.ok(
      events.some((e) => e.type === "file" && e.file.name === "brief.md"),
    );
    assert.ok(
      events.some(
        (e) => e.type === "text" && e.text.includes("Your brief is ready."),
      ),
    );
    assert.equal(events.at(-1).type, "done");
    assert.equal(calls, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
test("provider errors are visible without leaking response bodies or credentials", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response("sensitive upstream body", { status: 401 });
  try {
    const response = await POST(req(payload));
    const text = await response.text();
    assert.match(text, /API key was rejected/);
    assert.doesNotMatch(text, /sensitive upstream body|test-key/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
