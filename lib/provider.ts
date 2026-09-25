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
