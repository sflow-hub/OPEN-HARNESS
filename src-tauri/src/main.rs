#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{collections::HashMap, net::{TcpListener, TcpStream}, sync::{atomic::{AtomicBool, Ordering}, Arc, Mutex}, thread, time::{Duration, Instant}};
use tauri::{menu::{Menu, MenuItem}, tray::TrayIconBuilder, webview::NewWindowResponse, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_shell::{process::{CommandChild, CommandEvent}, ShellExt};
use tauri_plugin_updater::UpdaterExt;

/// A supervised Node process, plus a flag the event pump sets when it goes away.
struct Supervised { name: &'static str, child: CommandChild, exited: Arc<AtomicBool> }

struct RuntimeProcesses(Mutex<Vec<Supervised>>);

fn free_port() -> Result<u16, String> {
    let listener = TcpListener::bind(("127.0.0.1", 0)).map_err(|error| error.to_string())?;
    Ok(listener.local_addr().map_err(|error| error.to_string())?.port())
}

fn wait_for_port(port: u16, timeout: Duration) -> bool {
    let started = Instant::now();
    while started.elapsed() < timeout {
        if TcpStream::connect_timeout(&format!("127.0.0.1:{port}").parse().unwrap(), Duration::from_millis(300)).is_ok() { return true; }
        thread::sleep(Duration::from_millis(150));
    }
    false
}

/// The dashboard is served from loopback; anything else belongs in the user's browser.
fn is_dashboard(url: &tauri::Url) -> bool {
    !matches!(url.scheme(), "http" | "https")
        || matches!(url.host_str(), Some("127.0.0.1") | Some("localhost") | Some("[::1]") | Some("::1"))
}

fn open_externally(url: &tauri::Url) {
    if let Err(error) = open::that_detached(url.as_str()) {
        eprintln!("Could not open {url} in the browser: {error}");
    }
}

fn spawn_node(app: &tauri::App, name: &'static str, working_directory: &std::path::Path, args: &[String], env: HashMap<String, String>) -> Result<Supervised, String> {
    let (mut receiver, child) = app.shell().sidecar("node").map_err(|error| error.to_string())?
        .args(args).envs(env).current_dir(working_directory).spawn().map_err(|error| error.to_string())?;
    let exited = Arc::new(AtomicBool::new(false));
    let flag = exited.clone();
    tauri::async_runtime::spawn(async move {
        while let Some(event) = receiver.recv().await {
            match event {
                CommandEvent::Stdout(bytes) => println!("[{name}] {}", String::from_utf8_lossy(&bytes).trim_end()),
                CommandEvent::Stderr(bytes) => eprintln!("[{name}] {}", String::from_utf8_lossy(&bytes).trim_end()),
                // Without this the shutdown path below has no way to tell a process that
                // stopped cleanly from one still working, and a crash would go unnoticed.
                CommandEvent::Terminated(payload) => {
                    flag.store(true, Ordering::SeqCst);
                    eprintln!("[{name}] stopped with code {:?}", payload.code);
                }
                _ => {}
            }
        }
        flag.store(true, Ordering::SeqCst);
    });
    Ok(Supervised { name, child, exited })
}

/// Stop the Node processes the way the tray item promises: cleanly.
///
/// `CommandChild::kill` is SIGKILL, which the coordinator cannot trap — so killing it
/// outright skips its shutdown handler and leaves agent containers running under
/// `--restart unless-stopped`, to come back on every Docker start. Ask over stdin
/// first (the coordinator listens when OPEN_HARNESS_STDIN_CONTROL=1), give it a few
/// seconds, and only then fall back to killing whatever is left.
fn stop_runtime(handle: &tauri::AppHandle) {
    let state = handle.state::<RuntimeProcesses>();
    let Ok(mut children) = state.0.lock() else { return };
    if children.is_empty() { return; }
    for entry in children.iter_mut() {
        if !entry.exited.load(Ordering::SeqCst) { let _ = entry.child.write(b"shutdown\n"); }
    }
    let deadline = Instant::now() + Duration::from_secs(10);
    while Instant::now() < deadline && children.iter().any(|entry| !entry.exited.load(Ordering::SeqCst)) {
        thread::sleep(Duration::from_millis(100));
    }
    for entry in children.drain(..) {
        if entry.exited.load(Ordering::SeqCst) { continue; }
        eprintln!("{} did not stop in time; forcing it. Agent containers may still be running.", entry.name);
        let _ = entry.child.kill();
    }
}

fn main() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            if let Some(window) = app.get_webview_window("main") { let _ = window.show(); let _ = window.set_focus(); }
        }))
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(RuntimeProcesses(Mutex::new(Vec::new())))
        .setup(|app| {
            let resource = app.path().resource_dir()?.join("resources").join("bundle");
            let data = app.path().app_data_dir()?; std::fs::create_dir_all(&data)?;
            let control_port = free_port().map_err(std::io::Error::other)?;
            let app_port = free_port().map_err(std::io::Error::other)?;
            let runtime_directory = resource.join("runtime");
            let app_directory = resource.join("app");
            let mut service_env = HashMap::new();
            service_env.insert("OPEN_HARNESS_PORT".into(), control_port.to_string());
            service_env.insert("OPEN_HARNESS_STATE_DIR".into(), data.to_string_lossy().into_owned());
            service_env.insert("OPEN_HARNESS_STDIN_CONTROL".into(), "1".into());
            // A desktop install must never inherit the deterministic test adapter
            // from a shell or launcher environment. Installed chats are always live.
            service_env.insert("OPEN_HARNESS_MOCK".into(), "0".into());
            let service = spawn_node(app, "coordinator", &runtime_directory, &["service.mjs".into()], service_env).map_err(std::io::Error::other)?;
            let mut web_env = HashMap::new(); web_env.insert("PORT".into(), app_port.to_string()); web_env.insert("HOST".into(), "127.0.0.1".into());
            let web = spawn_node(app, "dashboard", &app_directory, &["server.js".into()], web_env).map_err(std::io::Error::other)?;
            { let state = app.state::<RuntimeProcesses>(); state.0.lock().map_err(|_| std::io::Error::other("runtime lock failed"))?.extend([service, web]); }
            if !wait_for_port(control_port, Duration::from_secs(30)) || !wait_for_port(app_port, Duration::from_secs(30)) {
                return Err(std::io::Error::other("Open Harness could not start. Open the tray menu and choose Quit, then launch it again.").into());
            }
            let url = format!("http://127.0.0.1:{app_port}/?controlPort={control_port}").parse()?;
            // The dashboard is a remote-origin page, so it has no Tauri bridge to call.
            // Without these two handlers the webview silently swallows every target="_blank",
            // which is what onboarding's "Install Docker" and "Get a key" links are — they
            // look clickable and do nothing. Hand anything off-origin to the real browser.
            WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url))
                .title("Open Harness")
                .inner_size(1440.0, 960.0)
                .min_inner_size(390.0, 640.0)
                .on_new_window(move |url, _features| { if !is_dashboard(&url) { open_externally(&url); } NewWindowResponse::Deny })
                .on_navigation(move |url| {
                    // Keep the window itself on the dashboard: a stray external navigation
                    // would strand the user with no back button and no address bar.
                    if is_dashboard(url) { return true; }
                    open_externally(url);
                    false
                })
                .build()?;
            let open = MenuItem::with_id(app, "open", "Open Open Harness", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Quit and stop local services", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&open, &quit])?;
            TrayIconBuilder::new().icon(app.default_window_icon().cloned().unwrap()).menu(&menu).on_menu_event(|app, event| match event.id.as_ref() {
                "open" => if let Some(window) = app.get_webview_window("main") { let _ = window.show(); let _ = window.set_focus(); },
                "quit" => { stop_runtime(app); app.exit(0); },
                _ => {}
            }).build(app)?;
            if let (Some(endpoint), Some(pubkey)) = (option_env!("OPEN_HARNESS_UPDATE_ENDPOINT"), option_env!("OPEN_HARNESS_UPDATE_PUBKEY")) {
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    let url = match endpoint.parse() { Ok(value) => value, Err(error) => { eprintln!("Invalid update endpoint: {error}"); return; } };
                    let builder = match handle.updater_builder().endpoints(vec![url]) { Ok(value) => value.pubkey(pubkey), Err(error) => { eprintln!("Could not configure updates: {error}"); return; } };
                    let updater = match builder.build() { Ok(value) => value, Err(error) => { eprintln!("Could not initialize updates: {error}"); return; } };
                    match updater.check().await {
                        Ok(Some(update)) => if let Err(error) = update.download_and_install(|_, _| {}, || {}).await { eprintln!("Could not install update: {error}"); } else { stop_runtime(&handle); handle.restart(); },
                        Ok(None) => {},
                        Err(error) => eprintln!("Could not check for updates: {error}"),
                    }
                });
            }
            Ok(())
        })
        .on_window_event(|window, event| if let WindowEvent::CloseRequested { api, .. } = event { api.prevent_close(); let _ = window.hide(); })
        .build(tauri::generate_context!())
        .expect("failed to build Open Harness desktop");
    app.run(|handle, event| if matches!(event, RunEvent::Exit | RunEvent::ExitRequested { .. }) { stop_runtime(handle); });
}
