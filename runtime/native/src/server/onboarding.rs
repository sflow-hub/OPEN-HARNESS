use crate::{ApiError, App, Reply, mock_mode, now, profiles};
use axum::{
    Json, Router,
    extract::State,
    http::StatusCode,
    routing::{get, post},
};
use rusqlite::{OptionalExtension, params};
use serde_json::{Value, json};
use std::{process::Stdio, time::Duration};

pub fn router() -> Router<App> {
    Router::new()
        .route("/v1/onboarding/status", get(status))
        .route("/v1/onboarding/action", post(action))
}
pub fn init(db: &rusqlite::Connection) -> rusqlite::Result<()> {
    db.execute_batch("CREATE TABLE IF NOT EXISTS native_onboarding(id INTEGER PRIMARY KEY CHECK(id=1), action TEXT NOT NULL,state TEXT NOT NULL,message TEXT,updated_at TEXT NOT NULL)")?;
    db.execute("UPDATE native_onboarding SET state='failed',message='The coordinator restarted during setup. Retry the setup step.',updated_at=? WHERE state='running'",[now()])?;
    Ok(())
}
fn report(app: &App) -> Result<Value, ApiError> {
    let runtime = super::runtime_status(app);
    let daemon = runtime["available"] == true;
    let creds = profiles::credential_summary(app)?;
    let db = app.lock();
    let job=db.query_row("SELECT action,state,message FROM native_onboarding WHERE id=1",[],|r|Ok(json!({"action":r.get::<_,String>(0)?,"state":r.get::<_,String>(1)?,"message":r.get::<_,Option<String>>(2)?}))).optional()?;
    let state = if daemon { "ready" } else { "action" };
    let prepared=mock_mode() || job.as_ref().is_some_and(|j|j["action"]=="prepare-runtime"&&j["state"]=="succeeded") ||
        db.query_row("SELECT EXISTS(SELECT 1 FROM runner_commands WHERE machine_id='machine-local' AND (kind='install-harness' OR kind='run') AND state='completed')",[],|r|r.get::<_,bool>(0))?;
    Ok(
        json!({"platform":if cfg!(target_os="macos"){"darwin"}else{std::env::consts::OS},"platformLabel":std::env::consts::OS,
        "recommendedAccess":"private","credentialMode":"coordinator","credentialNames":creds["secrets"],"executionReady":daemon && prepared,"setupJob":job,
        "checks":[{"id":"coordinator","label":"Coordinator","state":"ready","detail":"Rust coordinator is online."},
        {"id":"container-engine","label":"Container engine","state":state,"detail":runtime["message"],"action":"start-container-engine","actionLabel":"Start container engine"},
        {"id":"agent-runtime","label":"Agent runtime","state":if prepared{"ready"}else{"action"},"detail":"Each selected harness uses a pinned headless image.","action":"prepare-runtime","actionLabel":"Prepare runtime"}]}),
    )
}
async fn status(State(app): State<App>) -> Reply {
    Ok(Json(report(&app)?))
}
async fn start_engine() -> anyhow::Result<()> {
    if mock_mode() {
        return Ok(());
    }
    let (cmd, args) = if cfg!(target_os = "macos") {
        ("docker", vec!["desktop", "start"])
    } else {
        (
            "systemctl",
            vec!["--user", "--no-ask-password", "start", "docker.service"],
        )
    };
    let status = tokio::time::timeout(
        Duration::from_secs(90),
        tokio::process::Command::new(cmd)
            .args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .status(),
    )
    .await??;
    anyhow::ensure!(
        status.success(),
        "Start the container engine on the worker and retry."
    );
    Ok(())
}
async fn action(
    State(app): State<App>,
    Json(v): Json<Value>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let name = match v["action"].as_str() {
        Some("prepare-runtime") => "prepare-runtime",
        Some("start-container-engine") => "start-container-engine",
        _ => return Err(ApiError::bad("Choose an available setup action.")),
    };
    let harness = match v["harness"].as_str().unwrap_or("hermes") {
        "hermes" => "hermes",
        "claude-code" => "claude-code",
        "codex" => "codex",
        _ => return Err(ApiError::bad("Unknown harness.")),
    };
    let n=app.lock().execute("INSERT INTO native_onboarding VALUES(1,?,'running',NULL,?) ON CONFLICT(id) DO UPDATE SET action=excluded.action,state='running',message=NULL,updated_at=excluded.updated_at WHERE native_onboarding.state!='running'",params![name,now()])?;
    if n == 0 {
        return Err(ApiError::conflict("A setup action is already running."));
    }
    let task = app.clone();
    tokio::spawn(async move {
        let res = if name == "prepare-runtime" {
            open_harness_runner::install(harness).await
        } else {
            start_engine().await
        };
        let state = if res.is_ok() { "succeeded" } else { "failed" };
        let error = res.err().map(|e| e.to_string());
        if let Err(e) = task.lock().execute(
            "UPDATE native_onboarding SET state=?,message=?,updated_at=? WHERE id=1",
            params![state, error, now()],
        ) {
            eprintln!("Could not save setup outcome: {e}");
        }
    });
    Ok((StatusCode::ACCEPTED, Json(report(&app)?)))
}
