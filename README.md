# Open Harness

A small, MIT-licensed agent workspace inspired by the named-agent workflow in Grok Bot. Independent software; not affiliated with xAI. Start with a working core, then customize it.

## Run locally

Requires Node.js 22.13+ and npm.

```bash
nvm use                  # if you use nvm
npm ci
cp .env.example .env
npm run dev
```

Open the local URL printed by the server (normally http://localhost:3000).

Choose an agent and click **Try a guided run** to create a real example file without credentials. The guided run is explicitly scripted, not an AI response.

For real tasks, open **Settings**, choose xAI or OpenRouter, enter a model ID supporting function calling, and paste your provider API key. Keys entered in the UI live only in memory until the page reloads. Provider usage is billed by your provider. The app does not include free inference.

Alternatively, set `XAI_API_KEY` or `OPENROUTER_API_KEY` in `.env` and restart. For Ollama, LM Studio, or another compatible server:

```dotenv
MODEL_BASE_URL=http://localhost:11434/v1
MODEL_NAME=your-installed-tool-capable-model
MODEL_API_KEY=
```

Choose **Local / custom server** in Settings. The endpoint is set by the server administrator, never arbitrary browser input. A hosted deployment cannot reach the Ollama server on your laptop without separately configured connectivity. Model availability varies; use your provider's exact current model ID.

## What works

- Create, edit, and delete named agents with their own instructions and memory.
- Persistent local conversations, search, Markdown responses, and copy.
- Real model → tool → result → model loop with 4, 8, or 12-step limits.
- Visible model/tool activity, stop controls, timeouts, and provider errors.
- Shared text files: upload, list, read, create, update, preview, download, delete.
- Export/import portable workspace backups; keys are excluded.
- Responsive interface and keyboard shortcuts (Enter, Shift+Enter, Cmd/Ctrl+K, Escape).

Files are limited to 100 KB each and 40 per workspace. All agent and file data is **device-local browser storage**. Runs require an open tab and stop when the connection closes. Export regularly to move or back up your workspace. Files and relevant recent conversation content are sent to your selected provider during a task.

## Small, inspectable architecture

| File                      | Responsibility                                                   |
| ------------------------- | ---------------------------------------------------------------- |
| `app/page.tsx`            | Workspace UI, persistence, conversations, event consumption      |
| `lib/harness.ts`          | Bounded agent loop and four tool implementations                 |
| `lib/provider.ts`         | Compatible chat-completions transport, timeouts, provider errors |
| `lib/types.ts`            | Data model and three starter agent definitions                   |
| `app/api/run/route.ts`    | Input validation and streamed activity/result events             |
| `app/api/status/route.ts` | Non-secret provider configuration status                         |
| `tests/harness.test.ts`   | Multi-step behavior, tool errors, updates, cancellation, limits  |

To add a tool: add its JSON schema to `toolDefinitions`, implement its handler in `runHarness`, and add a behavioral test. To change defaults: edit `initialWorkspace` (existing users keep their saved agents). The event protocol is newline-delimited JSON. Model responses arrive per step; token-by-token model streaming is not implemented.

## Deliberately bounded v0.1

This is a first working harness, not full Grok Bot parity. It does not yet include terminal execution, browser control, scheduled/background jobs, MCP connectors, group-agent coordination, image generation, or cross-device sync. Those need a separate persistent worker and a permissions boundary; the current tool registry is the extension point. The UI exposes only implemented capabilities.

The development server binds locally. Sites deployments use owner-only access by default. **Do not expose a deployment with server API keys publicly without adding authentication, request quotas, and rate limits.** The app's same-origin check is not authentication.

## Verify and build

```bash
npm test
npm run typecheck
npm run lint
npm run build
```

This project uses React, TypeScript, Vinext/Vite, and the Sites Cloudflare build plugin. `npm run build` produces Worker-compatible output under `dist/`. `npm start` serves the production build locally. No hosted service is required for development or local inference.

## References

Workflow reference: [Grok Bot overview](https://docs.x.ai/grok-bot/overview).
Provider protocol: [xAI Chat Completions API](https://docs.x.ai/developers/rest-api-reference/inference/chat-completions).

## License

MIT. See [LICENSE](LICENSE). The license covers this project's original code and assets; dependencies retain their own licenses.
