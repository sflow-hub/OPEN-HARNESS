#[test]
fn ssh_disconnect_reattaches_to_the_same_local_terminal() {
    terminal_lifecycle("local");
}
#[test]
fn ssh_disconnect_reattaches_to_the_same_paired_terminal() {
    terminal_lifecycle("paired");
}
fn terminal_lifecycle(machine: &str) {
    let fixture = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/worker_terminal.py");
    let status = std::process::Command::new("python3")
        .arg(fixture)
        .arg(env!("CARGO_BIN_EXE_open-harness"))
        .arg(machine)
        .status()
        .expect("run the Unix PTY fixture");
    assert!(status.success(), "the worker terminal lifecycle failed");
}
