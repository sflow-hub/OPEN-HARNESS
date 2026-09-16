#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{collections::HashMap, net::{TcpListener, TcpStream}, sync::Mutex, thread, time::{Duration, Instant}};
use tauri::{menu::{Menu, MenuItem}, tray::TrayIconBuilder, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder, WindowEvent};
use tauri_plugin_shell::{process::{CommandChild, CommandEvent}, ShellExt};
use tauri_plugin_updater::UpdaterExt;

struct RuntimeProcesses(Mutex<Vec<CommandChild>>);

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

fn spawn_node(app: &tauri::App, working_directory: &std::path::Path, args: &[String], env: HashMap<String, String>) -> Result<CommandChild, String> {
    let (mut receiver, child) = app.shell().sidecar("node").map_err(|error| error.to_string())?
        .args(args).envs(env).current_dir(working_directory).spawn().map_err(|error| error.to_string())?;
    tauri::async_runtime::spawn(async move {
        while let Some(event) = receiver.recv().await {
            match event {
                CommandEvent::Stdout(bytes) => println!("{}", String::from_utf8_lossy(&bytes)),
                CommandEvent::Stderr(bytes) => eprintln!("{}", String::from_utf8_lossy(&bytes)),
                _ => {}
            }
        }
    });
    Ok(child)
}

fn stop_runtime(handle: &tauri::AppHandle) {
    let state = handle.state::<RuntimeProcesses>();
    if let Ok(mut children) = state.0.lock() {
        for child in children.drain(..) { let _ = child.kill(); }
    };
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
            let service = spawn_node(app, &runtime_directory, &["service.mjs".into()], service_env).map_err(std::io::Error::other)?;
            let mut web_env = HashMap::new(); web_env.insert("PORT".into(), app_port.to_string()); web_env.insert("HOST".into(), "127.0.0.1".into());
            let web = spawn_node(app, &app_directory, &["server.js".into()], web_env).map_err(std::io::Error::other)?;
            { let state = app.state::<RuntimeProcesses>(); state.0.lock().map_err(|_| std::io::Error::other("runtime lock failed"))?.extend([service, web]); }
            if !wait_for_port(control_port, Duration::from_secs(30)) || !wait_for_port(app_port, Duration::from_secs(30)) {
                return Err(std::io::Error::other("Open Harness could not start. Open the tray menu and choose Quit, then launch it again.").into());
            }
            let url = format!("http://127.0.0.1:{app_port}/?controlPort={control_port}").parse()?;
            WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url)).title("Open Harness").inner_size(1440.0, 960.0).min_inner_size(390.0, 640.0).build()?;
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
