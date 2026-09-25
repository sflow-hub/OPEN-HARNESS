# Building the Android app

The phone app is the same dashboard as the desktop app, shipped as static files inside a
Tauri 2 shell. It has no coordinator of its own: it pairs with one over HTTPS and talks to it
with a revocable per-device credential. It is a companion for sending tasks, following runs,
and approvals. Agents execute on a connected computer; the phone cannot lease runner commands.

## Toolchain

This machine's root filesystem is full and has no JDK, so the whole Android toolchain lives on
the external drive alongside the checkout, including `rustup` and `cargo`, which normally live
in `$HOME`. One file sets everything up:

```bash
source /run/media/jarom/3a83bdac-8385-4c9f-b90e-ddcee2fd23c8/android-toolchain/env.sh
```

| Component | Version | Why this one |
| --- | --- | --- |
| Temurin JDK | 17.0.20.1 | Gradle and the Android tools need a JDK; 17 is the safe common denominator for AGP 8. |
| Android SDK platform | android-36 | Matches what the generated Gradle project compiles against. |
| Build tools | 36.0.0 | Gradle also pulls 35.0.0 on first run. |
| NDK | 27.3.13750724 | Last r27, the LTS line, well tested with Tauri 2.x. |
| Rust | 1.98.1 via rustup | The system `rustc` only ships host standard libraries, so it cannot cross-compile. |

Rust targets installed: `aarch64-linux-android`, `armv7-linux-androideabi`,
`i686-linux-android`, `x86_64-linux-android`.

Google's SDK licenses were accepted to download these packages. They are recorded in
`$ANDROID_HOME/licenses`.

## Building

```bash
source /run/media/.../android-toolchain/env.sh

npm run build:mobile     # static dashboard into dist/client
npx tauri android build --config src-tauri/tauri.mobile.conf.json --apk --debug --target aarch64
```

Use `--target x86_64` for an emulator on an Intel or AMD machine, or omit `--target` to build
every ABI. The APK lands in `src-tauri/gen/android/app/build/outputs/apk/`.

A debug APK is around 200 MB because the Rust library keeps its debug symbols. Release builds
are far smaller.

## How the mobile build differs

- `next.config.ts` switches to `output: 'export'` when `OPEN_HARNESS_TARGET=mobile`, so the
  dashboard becomes static files with no server.
- `vite.config.ts` drops the Cloudflare and Sites plugins in that mode and aliases
  `cloudflare:workers` to a stub, because the coordinator route handlers are still compiled
  even though the export skips them.
- `src-tauri/tauri.mobile.conf.json` uses its own identifier, `dev.openharness.mobile`, so it
  never collides with the desktop app or its signed updater.
- The Rust crate builds a library for mobile. Everything desktop-only, meaning the tray,
  single-instance, the updater, and the Node sidecars, is gated behind `#[cfg(desktop)]` and is
  not compiled for Android at all.
- The device credential and its private encryption key live in a Stronghold encrypted snapshot
  under the app-private data directory. A former web-storage value is migrated once and removed.
- `package.json` has a `tauri` passthrough script because the generated Gradle project shells
  out to `npm run tauri` for the Rust build step.

## CI and signed releases

The `Verify` workflow builds an ARM64 debug APK on every pull request and push. Tagged releases
build an ARM64 APK and AAB and refuse to continue unless all four repository secrets exist:

- `ANDROID_KEYSTORE_BASE64`
- `ANDROID_KEYSTORE_PASSWORD`
- `ANDROID_KEY_ALIAS`
- `ANDROID_KEY_PASSWORD`

The release workflow decodes the keystore only into the runner's temporary directory, injects
the signing configuration into the generated Gradle project, and uploads the signed artifacts
with the desktop packages.

## iOS

Not possible on Linux. Building for iOS needs macOS with Xcode.

## Running it on an emulator

```bash
source /run/media/.../android-toolchain/env.sh
export ANDROID_AVD_HOME="$ANDROID_TOOLCHAIN/avd"

"$ANDROID_HOME/emulator/emulator" -avd openharness-test -no-window -no-audio -gpu swiftshader_indirect &
adb wait-for-device

# Build for the emulator's architecture, not the phone's.
npx tauri android build --config src-tauri/tauri.mobile.conf.json --apk --debug --target x86_64
adb install -r src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk

# Let the emulator reach a coordinator running on this machine.
adb reverse tcp:4317 tcp:4317
```

An AVD named `openharness-test` (Android 15, x86_64) is already created. KVM is available
through a file ACL, so the emulator is hardware accelerated.

Pair it against a local coordinator started with `OPEN_HARNESS_MOCK=1`, using
`http://127.0.0.1:4317` as the hub address. Loopback over plain HTTP is accepted only because
it cannot leave the device; a real hub must be HTTPS.

## Testing without a device

The pairing screen, the stored credential, and the hub-backed dashboard can all run in a
desktop browser: setting `localStorage["open-harness.force-mobile"] = "1"` (or adding
`?mobile=1`) makes `isMobileApp()` true without Tauri, and every native capability falls
back to its web equivalent. `tests/browser/phone.spec.ts` uses this in the Playwright
`mobile` project to pair against the mock coordinator with a code created the way the
desktop creates it, reload, disconnect from the phone, and confirm a hub-side revocation
sends the phone back to pairing. Run it with `npm run test:browser`.

The browser cannot stand in for the Tauri side: Stronghold, the native HTTP client, the QR
scanner, deep links, and notifications need the emulator or a phone.

## What the emulator proved this round

Each of these built clean, passed the browser suite, and was wrong or unknown until the app
ran on a device.

1. **Back quit the app from anywhere.** The dashboard is a static export with no router, so
   the webview had no history and the shell finished the activity. Fixed by keeping one
   history entry per open overlay. Two earlier shapes failed here first: pushing and popping
   per overlay broke the Settings-to-onboarding handoff, and one shared entry re-pushed from
   inside the popstate handler broke the stacked case, because that push did not survive the
   navigation delivering the event. Verified: Back closes Settings, then the sidebar, then
   exits.
2. **Pairing with a coordinator that has no agents crashed the dashboard.** A paired client
   reads the hub's agents rather than seeding its own, so an empty workspace is normal, and
   the agent lookup fell through to `undefined`. Every spec seeded agents first, so no test
   could reach it.
3. **Downloads now actually produce a file.** Confirmed by reading it back off the device
   with `adb shell run-as`.
4. **The safe-area CSS started working.** `chromium: E2E_Used ViewportFitCover` and
   `E2E_Used SafeAreaInsetBottom` appear in logcat once the viewport sets `viewport-fit=cover`;
   before that those rules were dead code.

### Known limitation: the keyboard covers the composer

The packaged app is told nothing about the soft keyboard. With the keyboard shown and the
composer focused, the webview reports `visualViewport.height === window.innerHeight` exactly,
so neither `interactive-widget=resizes-content` nor `trackKeyboardInset()` can help, and
adding `android:windowSoftInputMode="adjustResize"` to the generated manifest changed nothing
either — Android 15 ignores it for an edge-to-edge window.

The fix belongs in the Android activity, which has to apply the IME window insets to the
webview, and that file is generated by `tauri android init`. A phone browser is unaffected.

To re-measure after a Tauri upgrade:

```bash
adb shell cat /proc/net/unix | grep -o "webview_devtools_remote_[0-9]*"
adb forward tcp:9222 localabstract:webview_devtools_remote_<pid>
# then evaluate visualViewport.height against window.innerHeight over CDP
```

## Four things that only surfaced by running the app

Each of these built and rendered perfectly while being wrong, which is why the emulator run
mattered more than the compile.

1. **`NEXT_PUBLIC_OPEN_HARNESS_TARGET` was never set.** The build script set
   `OPEN_HARNESS_TARGET`, which switches the build config, but the client reads the
   `NEXT_PUBLIC_` variant, which is inlined into the bundle. Without it every phone-specific
   path was dead and the app showed the desktop workspace. Both are set now.
2. **The Tauri JavaScript plugins were never installed.** Only the Rust crates were added, so
   `import('@tauri-apps/plugin-http')` failed at runtime, the app silently fell back to the
   webview's `fetch`, and the request was blocked by CSP. The packages are dependencies now
   and are imported statically so the bundler includes them.
3. **The CSP and the HTTP plugin scope both rejected the loopback hub.** Requests made through
   the plugin come from Rust and ignore CSP, but the fallback path does not. Both now allow
   `http://127.0.0.1:*` and `http://localhost:*` alongside `https:`.
4. **The connect effect did not depend on the pairing.** After pairing, the dashboard appeared
   but kept showing the starter agents the app ships with, because the effect that talks to the
   hub only ran on mount. It now re-runs when the pairing changes.

There was also a hydration mismatch: deciding "am I a phone?" during the first render made the
client disagree with the prerendered HTML, so React discarded it. That decision now happens
after mount. The app logs no console errors at all.
