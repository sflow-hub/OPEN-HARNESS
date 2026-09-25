# Android window insets

This local Tauri plugin uses the supported Android `Plugin.load(WebView)` lifecycle
hook. The generated activity stays untouched, so `tauri android init` can safely
regenerate the Android project.

The Android content view applies the maximum system-bar, display-cutout and keyboard
insets as padding. It forwards zeroed handled insets to the WebView to prevent a
second application by modern Chromium. Hiding the keyboard restores system-bar
padding. The web dashboard receives ordinary viewport resize events; it must not
add a second native keyboard inset. No JavaScript API or capability permission is
required because the plugin exposes no commands.

After `tauri android init` and an Android build have generated the plugin module
mapping, run the native view-layout regression tests:

```sh
cd src-tauri/gen/android
./gradlew :tauri-plugin-ime-insets:testDebugUnitTest
```

Robolectric checks show/hide, repeated dispatch, zeroed child insets and the native
content bounds on Android 10 and Android 15. It does not run Chromium. These tests do not replace a device
check: focus the chat composer, type with the keyboard shown, dismiss it, then
repeat in Agent settings and after rotation. The focused control must remain
visible and the viewport must recover its original height after dismissal.

Implementation references: [Tauri mobile plugin lifecycle](https://v2.tauri.app/develop/plugins/develop-mobile/)
and [Android WebView inset handling](https://developer.android.com/develop/ui/views/layout/webapps/understand-window-insets).
