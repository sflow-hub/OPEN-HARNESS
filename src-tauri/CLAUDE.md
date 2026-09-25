# src-tauri/ — desktop and Android shell

One Rust crate, two products. Read [../CLAUDE.md](../CLAUDE.md) first; the Android toolchain
and emulator workflow are in [../ANDROID.md](../ANDROID.md).

- `tauri.conf.json` — desktop app (`dev.openharness.desktop` family): tray, single instance,
  signed updater, Node sidecars.
- `tauri.mobile.conf.json` — Android app, identifier `dev.openharness.mobile` so it never
  collides with the desktop app or its updater. Builds `npm run build:mobile` first.
- `src/lib.rs` is the real entry point (mobile calls it through `tauri::mobile_entry_point`);
  `src/main.rs` is a desktop shim. `src/desktop.rs` / `src/mobile.rs` hold the split.
- `capabilities/default.json` and `capabilities/mobile.json` — keep permissions per target.
- `gen/`, `target/`, `binaries/`, `resources/bundle/` are generated and gitignored. Never
  edit anything under `gen/android/` by hand; `tauri android init` regenerates it.

## Rules

- **Desktop-only things must stay behind the platform split.** Tray, single-instance, updater,
  the shell plugin, and the Node sidecars are declared under
  `cfg(not(any(target_os = "android", target_os = "ios")))` in `Cargo.toml` and `cfg(desktop)`
  in `lib.rs`. Several of them do not compile for Android at all, so adding a dependency to
  the shared `[dependencies]` block is how you break the mobile build.
- **The phone is a companion, not an agent host.** It pairs over HTTPS with a revocable
  per-device credential kept in a Stronghold snapshot, and runner command endpoints reject
  that credential. Do not give it coordinator or runner capabilities.
- **A Rust crate added for mobile needs its JavaScript plugin too.** Adding only the crate
  makes `import('@tauri-apps/plugin-*')` fail at runtime and silently fall back to the
  webview, which CSP then blocks. Add the npm package and import it statically.
- **Both configs carry their own CSP.** Anything new the app talks to has to be allowed in
  the CSP *and* in the plugin's scope — requests through the Rust HTTP plugin ignore CSP,
  the `fetch` fallback does not, and only one of those paths breaks.
- `NEXT_PUBLIC_OPEN_HARNESS_TARGET` must be set alongside `OPEN_HARNESS_TARGET`; the client
  reads the `NEXT_PUBLIC_` one and it is inlined at build time.
- Building compiles cleanly while being wrong in ways only a run reveals — pairing, CSP,
  plugin loading, and effect dependencies all did exactly that. Verify on the emulator
  (`openharness-test` AVD, `adb reverse tcp:4317 tcp:4317`) before calling mobile work done.
- Without a device, force-mobile mode in a browser covers the pairing and dashboard paths:
  `localStorage["open-harness.force-mobile"] = "1"` or `?mobile=1`, exercised by the
  Playwright `mobile` project in `tests/browser/phone.spec.ts`. It cannot stand in for
  Stronghold, the native HTTP client, the QR scanner, deep links, or notifications.
- Release signing needs the four `ANDROID_*` repository secrets; the tagged release workflow
  refuses to continue without them. iOS needs macOS and has no build here.
