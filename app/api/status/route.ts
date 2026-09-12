export function GET() {
  return Response.json(
    {
      xai: Boolean(process.env.XAI_API_KEY),
      openrouter: Boolean(process.env.OPENROUTER_API_KEY),
      local: Boolean(process.env.MODEL_BASE_URL),
      localModel: process.env.MODEL_NAME || "",
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
