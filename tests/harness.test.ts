import test from "node:test";
import assert from "node:assert/strict";
import {
  runHarness,
  type Model,
  type ModelMessage,
  type ModelReply,
} from "../lib/harness";
import { initialWorkspace, type RunEvent } from "../lib/types";
import { createModel } from "../lib/provider";
const call = (name: string, args: unknown) => ({
  id: crypto.randomUUID(),
  type: "function" as const,
  function: { name, arguments: JSON.stringify(args) },
});
async function run(replies: ModelReply[], maxSteps = 8) {
  const events: RunEvent[] = [];
  const requests: ModelMessage[][] = [];
  const model: Model = async (messages) => {
    requests.push(structuredClone(messages));
    const reply = replies.shift();
    assert.ok(reply, "unexpected extra model call");
    return reply;
  };
  await runHarness({
    agent: structuredClone(initialWorkspace.agents[0]),
    files: [],
    messages: [
      { id: "u", role: "user", content: "Write a plan and remember my style." },
    ],
    maxSteps,
    model,
    signal: new AbortController().signal,
    emit: (e) => events.push(e),
  });
  return { events, requests };
}
test("multi-step tool loop creates a file, remembers context, and returns results to the model", async () => {
  const { events, requests } = await run([
    {
      content: "I will write a plan.",
      tool_calls: [
        call("write_file", {
          name: "plan.md",
          content: "# Plan\nShip one useful thing.",
        }),
        call("remember", { fact: "Prefers concise plans." }),
      ],
    },
    { tool_calls: [call("read_file", { name: "plan.md" })] },
    { content: "Your plan is ready." },
  ]);
  assert.equal(events.filter((e) => e.type === "file").length, 1);
  assert.ok(
    events.some(
      (e) => e.type === "memory" && e.memory.includes("Prefers concise plans."),
    ),
  );
  assert.ok(
    requests[2].some(
      (m) =>
        m.role === "tool" && m.content === "# Plan\nShip one useful thing.",
    ),
  );
  assert.equal(events.at(-1)?.type, "done");
});
test("invalid tools and path traversal produce errors the model can recover from", async () => {
  const { events, requests } = await run([
    {
      tool_calls: [
        call("write_file", { name: "../secret", content: "bad" }),
        call("execute_shell", { command: "whoami" }),
      ],
    },
    { content: "I cannot use those tools." },
  ]);
  assert.equal(events.filter((e) => e.type === "file").length, 0);
  assert.equal(
    events.filter((e) => e.type === "activity" && e.activity.status === "error")
      .length,
    2,
  );
  assert.ok(
    requests[1]
      .filter((m) => m.role === "tool")
      .every((m) => m.content?.startsWith("Tool error:")),
  );
});
test("step limit ends a looping model without discarding completed artifacts", async () => {
  const { events } = await run(
    [
      {
        tool_calls: [
          call("write_file", { name: "partial.md", content: "Partial result" }),
        ],
      },
    ],
    1,
  );
  assert.equal(events.filter((e) => e.type === "file").length, 1);
  assert.equal(events.at(-1)?.type, "error");
});
test("cancellation prevents further model or tool execution", async () => {
  const controller = new AbortController();
  controller.abort();
  let called = false;
  await assert.rejects(
    runHarness({
      agent: initialWorkspace.agents[0],
      files: [],
      messages: [],
      maxSteps: 2,
      model: async () => {
        called = true;
        return { content: "No" };
      },
      signal: controller.signal,
      emit: () => {},
    }),
  );
  assert.equal(called, false);
});
test("updates preserve file identity and do not mutate the input snapshot", async () => {
  const files = [
    {
      id: "existing",
      name: "plan.md",
      content: "Old",
      agentId: "atlas",
      updatedAt: "2026-01-01",
    },
  ];
  const events: RunEvent[] = [];
  let turn = 0;
  await runHarness({
    agent: initialWorkspace.agents[0],
    files,
    messages: [],
    maxSteps: 2,
    model: async () =>
      turn++
        ? { content: "Done." }
        : {
            tool_calls: [
              call("write_file", { name: "plan.md", content: "New" }),
            ],
          },
    signal: new AbortController().signal,
    emit: (e) => events.push(e),
  });
  const event = events.find((e) => e.type === "file");
  assert.equal(event?.type === "file" && event.file.id, "existing");
  assert.equal(files[0].content, "Old");
});
test("provider requires real credentials and a configured custom endpoint", () => {
  assert.throws(
    () => createModel({ provider: "xai", model: "test", env: {} }),
    /Connect a model/,
  );
  assert.throws(
    () => createModel({ provider: "local", model: "test", env: {} }),
    /MODEL_BASE_URL/,
  );
});
