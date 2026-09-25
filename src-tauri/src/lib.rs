//! Shared entry point for every platform Open Harness runs on.
//!
//! Tauri's mobile targets build a library rather than a binary, so the real entry point has
//! to live here; `main.rs` is only a shim for desktop builds. The two platforms share almost
//! nothing beyond this function, because the desktop app hosts its own coordinator and the
//! phone app connects to someone else's.

#[cfg(desktop)]
pub mod desktop;
#[cfg(mobile)]
pub mod mobile;

#[cfg(desktop)]
pub fn run() {
    desktop::run();
}

#[cfg(mobile)]
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    mobile::configure(tauri::Builder::default())
        .run(tauri::generate_context!())
        .expect("failed to start Open Harness");
}
