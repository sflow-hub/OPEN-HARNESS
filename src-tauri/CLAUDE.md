# src-tauri/ — desktop shell

Read [../CLAUDE.md](../CLAUDE.md) first.

- `tauri.conf.json` — desktop app (`dev.openharness.desktop`): tray, single instance,
  signed updater, Node sidecars.
- `src/main.rs` starts the app; `src/desktop.rs` supervises the coordinator and dashboard.
- `capabilities/default.json` scopes permissions to the desktop window and Node sidecar.
- `gen/`, `target/`, `binaries/`, `resources/bundle/` are generated and gitignored.

## Rules

- Keep the desktop CSP and native capability scopes aligned with the APIs the app uses.
  The bundled dashboard is served over HTTP and also needs the headers in `next.config.ts`.
- The app must stop its managed sidecars on startup failure and normal quit. Closing the
  window keeps work running in the tray.
- Run `npm run desktop:prepare` before native builds to refresh the bundled runtime.
- Compilation alone does not verify packaging: check startup, dashboard rendering,
  signed-release configuration, and sidecar cleanup on each supported desktop platform.
