// The GUI binary must not open a console window on Windows.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// Desktop builds start here. Mobile builds never reach this file: Android and iOS load the
// library and call run() through tauri::mobile_entry_point instead.
fn main() {
    open_harness_lib::run();
}
