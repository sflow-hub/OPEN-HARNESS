mod legacy;
mod onboarding;
use crate::{ApiError, App, Reply, dashboard, machines, now, profiles, runs, workspace};
use anyhow::{Context, Result, ensure};
use axum::{
    Json, Router,
    extract::{ConnectInfo, DefaultBodyLimit, Request, State},
    http::{HeaderValue, Method, StatusCode, header},
    middleware::{self, Next},
    response::{IntoResponse, Response},
    routing::{get, post},
};
use rusqlite::{Connection, params};
use serde_json::{Value, json};
use std::{
    fs,
    net::{IpAddr, SocketAddr},
    os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
    process::Stdio,
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{
    net::TcpListener,
    process::Command,
    signal::unix::{SignalKind, signal},
    sync::watch,
};

pub fn state_dir(path: &Path) -> Result<PathBuf> {
    fs::DirBuilder::new()
        .recursive(true)
        .mode(0o700)
        .create(path)?;
    let m = path.symlink_metadata()?;
    ensure!(
        m.is_dir() && m.uid() == unsafe { libc::geteuid() },
        "State directory must be a real directory owned by the service user."
    );
    if m.mode() & 0o077 != 0 {
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    }
    Ok(path.canonicalize()?)
}
fn database(path: &Path) -> Result<Connection> {
    let db = Connection::open(path)?;
    db.busy_timeout(Duration::from_secs(5))?;
    let version: i64 = db.pragma_query_value(None, "user_version", |r| r.get(0))?;
    ensure!(
        version <= 1,
        "This workspace uses a newer database format ({version})."
    );
    #[cfg(target_os = "macos")]
    let journal = {
        let kind = rustix::fs::statfs(path)?.f_fstypename.map(|c| c as u8);
        // Apple's VM-shared filesystem can return stale WAL-index pages across processes.
        if kind.starts_with(b"AppleVirtIOFS\0") {
            "delete"
        } else {
            "wal"
        }
    };
    #[cfg(not(target_os = "macos"))]
    let journal = "wal";
    let active: String = db.pragma_update_and_check(None, "journal_mode", journal, |r| r.get(0))?;
    ensure!(
        journal != "delete" || active == "delete",
        "Could not enable SQLite rollback journaling on the shared workspace volume."
    );
    db.pragma_update(None, "foreign_keys", true)?;
    let tx = db.unchecked_transaction()?;
    tx.execute_batch(include_str!("schema.sql"))?;
    for (table, column) in [
        ("machines", "encryption_public_key"),
        ("agent_transfers", "pending_profile_json"),
    ] {
        let exists: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM pragma_table_info(?) WHERE name=?)",
            params![table, column],
            |r| r.get(0),
        )?;
        if !exists {
            tx.execute_batch(&format!("ALTER TABLE {table} ADD COLUMN {column} TEXT"))?;
        }
    }
    profiles::init(&tx)?;
    legacy::reconcile(&tx)?;
    // Native workers retain durable command leases and outboxes across a coordinator restart.
    // An older inline worker has no receipt to recover. Preserve its history without executing it again.
    tx.execute("UPDATE runs SET state='interrupted',error='The previous coordinator exited before confirming completion.',updated_at=? WHERE state IN ('running','waiting_input','waiting_approval') AND NOT EXISTS(SELECT 1 FROM native_run_bindings b WHERE b.run_id=runs.id)",[now()])?;
    workspace::init(&tx)?;
    onboarding::init(&tx)?;
    tx.execute_batch("PRAGMA user_version=1")?;
    tx.commit()?;
    Ok(db)
}
pub fn loopback_host(host: &str) -> bool {
    !host.contains('@')
        && host
            .parse::<axum::http::uri::Authority>()
            .ok()
            .is_some_and(|a| matches!(a.host(), "localhost" | "127.0.0.1" | "[::1]"))
}
async fn access(State(app): State<App>, mut req: Request, next: Next) -> Response {
    let path = req.uri().path().to_string();
    let host = req
        .headers()
        .get(header::HOST)
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");
    let origin = req.headers().get(header::ORIGIN).cloned();
    if let Some(o) = origin.as_ref() {
        let allowed = o
            .to_str()
            .ok()
            .and_then(|s| s.parse::<axum::http::Uri>().ok())
            .is_some_and(|uri| {
                matches!(uri.scheme_str(), Some("http" | "https"))
                    && uri.authority().is_some_and(|a| {
                        a.as_str().eq_ignore_ascii_case(host)
                            || (path != "/v1/bootstrap"
                                && loopback_host(a.as_str())
                                && loopback_host(host))
                    })
            });
        if !allowed {
            return ApiError::new(StatusCode::FORBIDDEN, "Browser origin is not authorized.")
                .into_response();
        }
    }
    let browser = path == "/" || path.starts_with("/assets/") || path.starts_with("/ui/");
    let token = req
        .headers()
        .get(header::AUTHORIZATION)
        .and_then(|h| h.to_str().ok())
        .and_then(|s| s.strip_prefix("Bearer "))
        .unwrap_or("");
    let operator = machines::secure_eq(token, &app.token);
    let mut response = if req.method() == Method::OPTIONS {
        StatusCode::NO_CONTENT.into_response()
    } else {
        if path == "/v1/bootstrap" {
            let local_peer = req
                .extensions()
                .get::<ConnectInfo<SocketAddr>>()
                .is_some_and(|a| a.0.ip().is_loopback());
            if !(operator || (local_peer && loopback_host(host))) {
                return ApiError::new(
                    StatusCode::FORBIDDEN,
                    "A local operator token is required for this connection.",
                )
                .into_response();
            }
        } else if path.starts_with("/v1/runner/") && path != "/v1/runner/pair" {
            let machine = req
                .headers()
                .get("x-open-harness-machine")
                .and_then(|h| h.to_str().ok())
                .unwrap_or("")
                .to_owned();
            if !machines::authenticated(&app.lock(), &machine, token).unwrap_or(false) {
                return ApiError::new(
                    StatusCode::UNAUTHORIZED,
                    "Invalid or revoked runner credential.",
                )
                .into_response();
            }
            req.extensions_mut().insert(machines::Identity(machine));
        } else if !browser
            && !path.starts_with("/internal/")
            && !matches!(path.as_str(), "/v1/runner/pair" | "/api/health")
            && !operator
        {
            return ApiError::new(StatusCode::UNAUTHORIZED, "Invalid local control token.")
                .into_response();
        }
        next.run(req).await
    };
    let h = response.headers_mut();
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    h.insert(
        header::X_CONTENT_TYPE_OPTIONS,
        HeaderValue::from_static("nosniff"),
    );
    h.insert("referrer-policy", HeaderValue::from_static("same-origin"));
    h.insert("content-security-policy",HeaderValue::from_static("default-src 'self'; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'"));
    if let Some(o) = origin {
        h.insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, o);
        h.insert(header::VARY, HeaderValue::from_static("Origin"));
        h.insert(
            header::ACCESS_CONTROL_ALLOW_HEADERS,
            HeaderValue::from_static("authorization,content-type"),
        );
        h.insert(
            header::ACCESS_CONTROL_ALLOW_METHODS,
            HeaderValue::from_static("GET,POST,PUT,PATCH,DELETE,OPTIONS"),
        );
    }
    response
}
fn runtime_status(app: &App) -> Value {
    let ready = machines::info(&app.lock(), "local")
        .is_ok_and(|v| v["status"] == "online" && v["capabilities"]["container"] == true);
    json!({"available":ready,"version":null,"message":if ready{"Headless worker online."}else{"Waiting for the local worker and its container engine."}})
}
async fn bootstrap(State(app): State<App>) -> Json<Value> {
    Json(
        json!({"token":app.token.as_str(),"mode":if crate::mock_mode(){"test"}else{"live"},"runtime":runtime_status(&app),"version":env!("CARGO_PKG_VERSION"),"hermes":{"release":"v2026.9.11","commit":"939e45c91d751fadd94dcd1b873ac3cb44846213"}}),
    )
}
async fn health(State(app): State<App>) -> Reply {
    let runtime = runtime_status(&app);
    let summary = profiles::credential_summary(&app)?;
    let db = app.lock();
    let (active,queued):(i64,i64)=db.query_row("SELECT count(*) FILTER(WHERE state IN ('running','waiting_input','waiting_approval')),count(*) FILTER(WHERE state='queued') FROM runs",[],|r|Ok((r.get(0)?,r.get(1)?)))?;
    Ok(Json(
        json!({"ok":true,"runtime":runtime,"activeRuns":active,"queuedRuns":queued,"secrets":summary["secrets"],"secretStorage":summary["backend"]}),
    ))
}
async fn support(State(app): State<App>) -> Reply {
    let runtime = runtime_status(&app);
    let creds = profiles::credential_summary(&app)?;
    Ok(Json(
        json!({"version":env!("CARGO_PKG_VERSION"),"generatedAt":now(),"platform":std::env::consts::OS,"arch":std::env::consts::ARCH,"runtime":runtime,"secretStorage":creds["backend"],"headless":true}),
    ))
}
async fn shutdown(State(app): State<App>) -> Json<Value> {
    app.shutdown.send_replace(true);
    Json(json!({"ok":true}))
}
fn router(app: App) -> Router {
    Router::new()
        .route("/v1/bootstrap", get(bootstrap))
        .route(
            "/api/health",
            get(|| async { Json(json!({"ok":true,"implementation":"rust"})) }),
        )
        .route("/v1/health", get(health))
        .route("/v1/support-bundle", get(support))
        .route("/v1/shutdown", post(shutdown))
        .merge(onboarding::router())
        .merge(dashboard::router())
        .merge(profiles::router())
        .merge(workspace::router())
        .merge(runs::router())
        .merge(machines::router())
        .layer(DefaultBodyLimit::max(5_000_000))
        .layer(middleware::from_fn_with_state(app.clone(), access))
        .with_state(app)
}
async fn worker_loop(app: App, mut stop: watch::Receiver<bool>) {
    while !*stop.borrow() {
        let result=async {
            let mut worker=Command::new(std::env::current_exe()?);
            worker.arg("local-worker").arg("--state-dir").arg(app.root.as_path()).arg("--url").arg(app.local_url.as_str()).stdin(Stdio::piped()).kill_on_drop(true);
            if !app.root.join("rust-connection.json").exists(){
                let pairing=machines::pairing(&app.lock(),"This computer",std::env::consts::OS,&app.local_url,true)?;
                worker.env("OPEN_HARNESS_LOCAL_PAIR_CODE",pairing["code"].as_str().unwrap());
            }
            let mut child=worker.spawn()?;let _owner_pipe=child.stdin.take();let pid=child.id().context("Worker PID unavailable")?;
            tokio::select!{
                status=child.wait()=>{anyhow::bail!("local worker exited ({})",status?)}
                _=stop.changed()=>{
                    // Send TERM to this exact child and let it confirm Docker cleanup before exit.
                    unsafe{libc::kill(pid as i32,libc::SIGTERM);}
                    match tokio::time::timeout(open_harness_runner::STOP_TIMEOUT,child.wait()).await {
                        Ok(status) => { status?; }
                        Err(_) => child.kill().await?,
                    }
                    Ok::<(),anyhow::Error>(())
                }
            }
        }.await;
        if let Err(e) = result {
            eprintln!("Local worker: {e:#}");
        }
        if !*stop.borrow() {
            tokio::select! {_=tokio::time::sleep(Duration::from_secs(3))=>{},_=stop.changed()=>{}}
        }
    }
}
pub async fn serve(path: &Path, bind: IpAddr, port: u16) -> Result<()> {
    ensure!(
        unsafe { libc::geteuid() } != 0,
        "Run Open Harness as the non-root owner of its workspace."
    );
    let listener = TcpListener::bind(SocketAddr::new(bind, port))
        .await
        .context("Could not bind the coordinator listener")?;
    let actual = listener.local_addr()?;
    let ip = if bind.is_loopback() {
        bind
    } else if bind.is_ipv6() {
        std::net::Ipv6Addr::LOCALHOST.into()
    } else {
        std::net::Ipv4Addr::LOCALHOST.into()
    };
    let mut listeners = vec![listener];
    if !bind.is_unspecified() && !bind.is_loopback() {
        listeners.push(
            TcpListener::bind(SocketAddr::new(ip, actual.port()))
                .await
                .context("Could not open a loopback listener for the local worker")?,
        );
    }
    let root = state_dir(path)?;
    let lock = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(root.join("native-control.lock"))?;
    lock.try_lock()
        .context("Another native coordinator is using this workspace")?;
    let token = profiles::control_token(&root)?;
    let db = database(&root.join("state.db"))?;
    profiles::recover_credentials(&db, &root)?;
    let local_url = format!("http://{}", SocketAddr::new(ip, actual.port()));
    let (shutdown, mut done) = watch::channel(false);
    let app = App {
        db: Arc::new(Mutex::new(db)),
        root: Arc::new(root),
        token: Arc::new(token),
        local_url: Arc::new(local_url),
        shutdown,
    };
    println!(
        "Open Harness {} serving {} (headless)",
        env!("CARGO_PKG_VERSION"),
        app.local_url
    );
    let (http_end, _) = watch::channel(false);
    let mut servers = tokio::task::JoinSet::new();
    let routes = router(app.clone());
    for listener in listeners {
        let mut http_stop = http_end.subscribe();
        servers.spawn(
            axum::serve(
                listener,
                routes
                    .clone()
                    .into_make_service_with_connect_info::<SocketAddr>(),
            )
            .with_graceful_shutdown(async move {
                let _ = http_stop.wait_for(|s| *s).await;
            })
            .into_future(),
        );
    }
    let worker = tokio::spawn(worker_loop(app.clone(), done.clone()));
    let mut sigterm = signal(SignalKind::terminate())?;
    let mut tick = tokio::time::interval(Duration::from_millis(250));
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut cycles = 0u32;
    loop {
        tokio::select! {
            _=tokio::signal::ctrl_c()=>break, _=sigterm.recv()=>break, _=done.wait_for(|s|*s)=>break,
            _=tick.tick()=>{
                if cycles.is_multiple_of(8) {
                    if let Err(e)=machines::tick(&app.lock(), &app.root){eprintln!("Machine maintenance: {e:#}");}
                    if let Err(e)=workspace::tick(&app){eprintln!("Routine scheduler: {e:#}");}
                }
                if let Err(e)=runs::pump(&app){eprintln!("Run queue: {e:#}");}
                cycles=cycles.wrapping_add(1);
            }
        }
    }
    app.shutdown.send_replace(true);
    worker.await?;
    http_end.send_replace(true);
    while let Some(result) = servers.join_next().await {
        result??;
    }
    Ok(())
}
