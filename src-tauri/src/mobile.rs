//! The phone application.
//!
//! The desktop app is a process supervisor: it starts a coordinator and a dashboard server
//! and points a window at loopback. A phone can do none of that. iOS cannot spawn processes
//! at all, neither platform ships Node or Docker, and the coordinator needs `node:sqlite`.
//!
//! So the phone is a client. The dashboard is bundled as static files, and it talks to a
//! coordinator somewhere else over HTTPS using a credential it earns by pairing. Everything
//! this module needs is provided by Tauri plugins, which is why there is so little here.

pub fn configure(builder: tauri::Builder<tauri::Wry>) -> tauri::Builder<tauri::Wry> {
    // This lifecycle-only plugin has no JavaScript API. It resizes the native
    // content view, so the existing web viewport listeners observe the real space.
    #[cfg(target_os = "android")]
    let builder = builder.plugin(tauri_plugin_ime_insets::init());
    builder
        // Requests are made from Rust rather than the webview, so the coordinator sees no
        // Origin header and the browser's CORS rules never enter into it.
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        // The WebView supplies a random per-install password kept in the app-private data
        // directory. Hash it to the 32-byte Stronghold key expected by the native engine.
        .plugin(tauri_plugin_stronghold::Builder::new(|password| {
            use sha2::{Digest, Sha256};
            Sha256::digest(password).to_vec()
        }).build())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_opener::init())
        // Pairing: scan the QR shown on the computer, or open its openharness:// link.
        .plugin(tauri_plugin_barcode_scanner::init())
        .plugin(tauri_plugin_deep_link::init())
}
