// The GUI binary must not open a console window on Windows.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod desktop;

fn main() {
    desktop::run();
}
