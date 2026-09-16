import { toolDefinitions, type Model, type ModelReply } from "./harness";
export const PROVIDERS = {
  xai: { label: "xAI", baseURL: "https://api.x.ai/v1", model: "grok-4.6" },
  openai: { label: "OpenAI", baseURL: "https://api.openai.com/v1", model: "gpt-5.4" },
  openrouter: {
    label: "OpenRouter",
    baseURL: "https://openrouter.ai/api/v1",
    model: "",
  },
  local: { label: "Local / custom server", baseURL: "", model: "" },
} as const;
export type Provider = keyof typeof PROVIDERS;
export function createModel(options: {
  provider: Provider;
  model: string;
  apiKey?: string;
  env: Record<string, string | undefined>;
}): Model {
  const { provider, model, env } = options;
  const key =
    options.apiKey?.trim() ||
    (provider === "xai"
      ? env.XAI_API_KEY
      : provider === "openai"
        ? env.OPENAI_API_KEY
      : provider === "openrouter"
        ? env.OPENROUTER_API_KEY
        : env.MODEL_API_KEY);
  const baseURL =
    provider === "local" ? env.MODEL_BASE_URL : PROVIDERS[provider]?.baseURL;
  if (!baseURL)
    throw new Error(
      "Set MODEL_BASE_URL on the server to connect a local or custom model endpoint.",
    );
  if (provider !== "local" && !key)
    throw new Error(
      "Connect a model in Settings first, or try the guided run.",
    );
  if (!model.trim()) throw new Error("Enter a model ID in Settings.");
  return async (messages, signal) => {
    const response = await fetch(
      `${baseURL.replace(/\/$/, "")}/chat/completions`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(key ? { Authorization: `Bearer ${key}` } : {}),
        },
        body: JSON.stringify({
          model,
          messages,
          tools: toolDefinitions,
          tool_choice: "auto",
          stream: false,
        }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)]),
        redirect: "error",
      },
    );
    if (!response.ok) {
      const labels: Record<number, string> = {
        401: "API key was rejected. Check your key in Settings.",
        402: "Your model provider requires credits.",
        403: "Your provider denied access to this model.",
        404: "Model or endpoint not found. Check the model ID.",
        429: "Provider rate limit reached. Please retry shortly.",
      };
      throw new Error(
        labels[response.status] ||
          `The model provider returned HTTP ${response.status}. Try again or change models.`,
      );
    }
    const data = (await response.json()) as {
      choices?: { message?: ModelReply }[];
    };
    const reply = data.choices?.[0]?.message;
    if (
      !reply ||
      (reply.content !== null &&
        reply.content !== undefined &&
        typeof reply.content !== "string") ||
      (reply.tool_calls &&
        (!Array.isArray(reply.tool_calls) ||
          reply.tool_calls.some(
            (c: {
              id?: unknown;
              function?: { name?: unknown; arguments?: unknown };
            }) =>
              typeof c.id !== "string" ||
              typeof c.function?.name !== "string" ||
              typeof c.function?.arguments !== "string",
          )))
    )
      throw new Error(
        "The provider returned an unsupported response. Use a model with function calling.",
      );
    return reply;
  };
}
