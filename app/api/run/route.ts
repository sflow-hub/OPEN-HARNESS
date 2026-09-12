import { runHarness } from "../../../lib/harness";
import { createModel, PROVIDERS } from "../../../lib/provider";
import type { Provider } from "../../../lib/provider";
import type { Agent, Artifact, Message } from "../../../lib/types";
export async function POST(request: Request) {
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin)
    return Response.json(
      { error: "Cross-origin requests are not allowed." },
      { status: 403 },
    );
  let body;
  try {
    const text = await request.text();
    if (text.length > 2_000_000)
      return Response.json(
        {
          error:
            "Workspace is too large for one run. Remove old files or start a new conversation.",
        },
        { status: 413 },
      );
    body = JSON.parse(text);
  } catch {
    return Response.json({ error: "Invalid request." }, { status: 400 });
  }
  if (!body || typeof body !== "object" || Array.isArray(body))
    return Response.json({ error: "Invalid request." }, { status: 400 });
  const { agent, files, messages, provider, model, apiKey, maxSteps } =
    body as {
      agent: Agent;
      files: Artifact[];
      messages: Message[];
      provider: Provider;
      model: string;
      apiKey?: string;
      maxSteps: number;
    };
  if (
    !agent ||
    typeof agent.id !== "string" ||
    typeof agent.instructions !== "string" ||
    agent.instructions.length > 12000 ||
    !Array.isArray(agent.memory) ||
    agent.memory.length > 50 ||
    agent.memory.some((m) => typeof m !== "string" || m.length > 500) ||
    !Array.isArray(files) ||
    files.length > 40 ||
    files.some(
      (f) =>
        !f ||
        typeof f.name !== "string" ||
        typeof f.content !== "string" ||
        f.content.length > 100000,
    ) ||
    !Array.isArray(messages) ||
    !messages.length ||
    messages.length > 200 ||
    messages.some(
      (m) =>
        !m ||
        !["user", "assistant"].includes(m.role) ||
        typeof m.content !== "string" ||
        m.content.length > 100000,
    ) ||
    !Object.hasOwn(PROVIDERS, provider) ||
    typeof model !== "string" ||
    model.length > 200 ||
    (apiKey !== undefined &&
      (typeof apiKey !== "string" || apiKey.length > 1000))
  )
    return Response.json(
      { error: "Invalid agent, messages, files, or provider settings." },
      { status: 400 },
    );
  let modelFn;
  try {
    modelFn = createModel({ provider, model, apiKey, env: process.env });
  } catch (error) {
    return Response.json({ error: (error as Error).message }, { status: 400 });
  }
  const abort = new AbortController();
  const signal = AbortSignal.any([
    request.signal,
    abort.signal,
    AbortSignal.timeout(300_000),
  ]);
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const emit = (event: unknown) => {
        if (!abort.signal.aborted)
          controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
      };
      try {
        await runHarness({
          agent,
          files,
          messages,
          maxSteps: Math.max(1, Math.min(12, Number(maxSteps) || 8)),
          model: modelFn,
          signal,
          emit,
        });
      } catch (error) {
        if (!abort.signal.aborted)
          emit({
            type: "error",
            message: signal.aborted
              ? "Run stopped or timed out. Completed work is preserved."
              : error instanceof Error
                ? error.message
                : "The run failed.",
          });
      } finally {
        if (!abort.signal.aborted) controller.close();
      }
    },
    cancel() {
      abort.abort();
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
