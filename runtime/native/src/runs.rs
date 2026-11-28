use crate::{ApiError, App, Reply, id, machines, now, profiles, rows, workspace};
use anyhow::{Context, Result, bail, ensure};
use axum::{
    Json, Router,
    extract::{Path, Query, State},
    http::{HeaderMap, StatusCode},
    routing::{get, post},
};
use openssl::{hash::MessageDigest, pkey::PKey, sign::Signer};
use rusqlite::{Connection, OptionalExtension, params};
use serde::Deserialize;
use serde_json::{Value, json};
use std::time::Duration;

pub fn router() -> Router<App> {
    Router::new()
        .route("/v1/runs", get(list).post(submit))
        .route("/v1/runs/{id}", get(one))
        .route("/v1/runs/{id}/events", get(events))
        .route("/v1/runs/stop-all", post(stop_all))
        .route("/v1/runs/{id}/stop", post(stop))
        .route("/v1/runs/{id}/steer", post(steer))
        .route("/v1/runs/{id}/approval", post(approve))
        .route("/v1/agents/{id}/stop", post(stop_agent))
        .route("/internal/{kind}", post(internal))
}
pub fn record(db: &Connection, run: &str, kind: &str, payload: &Value) -> Result<()> {
    db.execute(
        "INSERT INTO events(id,run_id,type,payload_json,created_at) VALUES(?,?,?,?,?)",
        params![id(), run, kind, payload.to_string(), now()],
    )?;
    Ok(())
}
pub(crate) fn get_run(db: &Connection, key: &str) -> Result<Value> {
    let mut run = rows(db, "SELECT * FROM runs WHERE id=?", &[&key])?
        .pop()
        .context("Run not found.")?;
    let machine = db
        .query_row(
            "SELECT machine_id FROM native_run_bindings WHERE run_id=?",
            [key],
            |r| r.get::<_, String>(0),
        )
        .optional()?
        .or_else(|| profiles::machine(db, run["agent_id"].as_str().unwrap()).ok());
    if let Some(m) = machine {
        run["machine_connection"] = machines::info(db, &m)
            .ok()
            .map(|r| r["status"].clone())
            .unwrap_or(Value::Null);
        run["machine_id"] = json!(m);
    }
    Ok(run)
}
pub fn create(db: &Connection, input: &Value) -> Result<Value> {
    let agent = input["agentId"].as_str().context("Agent ID is required.")?;
    let prompt = input["prompt"]
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .context("Enter a prompt.")?;
    ensure!(prompt.len() <= 1_000_000, "Prompt is too large.");
    ensure!(
        db.query_row(
            "SELECT EXISTS(SELECT 1 FROM agent_profiles WHERE id=?)",
            [agent],
            |r| r.get::<_, bool>(0)
        )?,
        "Agent profile not found."
    );
    let parent = input["parentRunId"].as_str();
    let mut depth = 0;
    if let Some(parent) = parent {
        let (parent_depth, state): (i64, String) = db
            .query_row("SELECT depth,state FROM runs WHERE id=?", [parent], |r| {
                Ok((r.get(0)?, r.get(1)?))
            })
            .context("Parent run not found.")?;
        ensure!(
            matches!(
                state.as_str(),
                "running" | "waiting_input" | "waiting_approval"
            ),
            "Parent run is no longer active."
        );
        depth = parent_depth + 1;
        ensure!(depth <= 2, "Delegation depth is limited to two.");
        let cycle:bool=db.query_row("WITH RECURSIVE parents(id,agent_id,parent_run_id) AS (SELECT id,agent_id,parent_run_id FROM runs WHERE id=?1 UNION SELECT r.id,r.agent_id,r.parent_run_id FROM runs r JOIN parents p ON r.id=p.parent_run_id) SELECT EXISTS(SELECT 1 FROM parents WHERE agent_id=?2)",params![parent,agent],|r|r.get(0))?;
        ensure!(!cycle, "Cyclic agent handoffs are not allowed.");
    }
    let queued: i64 = db.query_row("SELECT count(*) FROM runs WHERE state='queued'", [], |r| {
        r.get(0)
    })?;
    let max = std::env::var("MAX_TASK_QUEUE")
        .ok()
        .and_then(|n| n.parse::<i64>().ok())
        .unwrap_or(100)
        .max(1);
    ensure!(queued < max, "The task queue is full.");
    let key = id();
    let conversation = input["conversationId"]
        .as_str()
        .map(str::to_owned)
        .unwrap_or_else(id);
    let stamp = now();
    db.execute_batch("SAVEPOINT create_native_run")?;
    let result = (|| -> Result<Value> {
        db.execute("INSERT INTO runs(id,agent_id,conversation_id,prompt,state,parent_run_id,depth,created_at,updated_at) VALUES(?,?,?,?,'queued',?,?,?,?)",params![key,agent,conversation,prompt,parent,depth,stamp,stamp])?;
        record(db, &key, "run.queued", &json!({"position":queued+1}))?;
        get_run(db, &key)
    })();
    if result.is_err() {
        db.execute_batch("ROLLBACK TO create_native_run")?;
    }
    db.execute_batch("RELEASE create_native_run")?;
    result
}
pub fn finish(
    db: &Connection,
    key: &str,
    state: &str,
    answer: Option<&str>,
    error: Option<&str>,
) -> Result<()> {
    if db.execute("UPDATE runs SET state=?,result=?,error=?,updated_at=? WHERE id=? AND state IN ('queued','running','waiting_input','waiting_approval')",params![state,answer,error,now(),key])?==1 {
        record(db,key,&format!("run.{state}"),&json!({"result":answer,"error":error}))?;
        db.execute("UPDATE approvals SET state='expired',resolved_at=? WHERE run_id=? AND state IN ('pending','resolving')",params![now(),key])?;
        workspace::run_changed(db,key)?;
    }
    Ok(())
}
pub fn command_done(
    db: &Connection,
    kind: &str,
    payload: &Value,
    result: &Value,
    error: Option<&str>,
) -> Result<()> {
    let Some(key) = payload["runId"].as_str() else {
        return Ok(());
    };
    match kind {
        "run" => {
            let stopping = db
                .query_row(
                    "SELECT stopping FROM native_run_bindings WHERE run_id=?",
                    [key],
                    |r| r.get::<_, bool>(0),
                )
                .optional()?
                .unwrap_or(false);
            if let Some(error) = error {
                if !stopping {
                    finish(
                        db,
                        key,
                        if result["interrupted"] == true {
                            "interrupted"
                        } else {
                            "failed"
                        },
                        None,
                        Some(error),
                    )?;
                }
            } else {
                let answer = ["text", "final_response", "message", "result"]
                    .iter()
                    .find_map(|f| result[*f].as_str())
                    .or_else(|| result.as_str())
                    .unwrap_or("");
                finish(db, key, "completed", Some(answer), None)?;
            }
        }
        "stop" => {
            if let Some(err) = error {
                finish(db, key, "interrupted", None, Some(err))?;
            } else {
                finish(db, key, "cancelled", None, None)?;
            }
        }
        "steer" => {
            record(
                db,
                key,
                if error.is_some() {
                    "control.failed"
                } else {
                    "run.steered"
                },
                &json!({"text":payload["text"],"error":error}),
            )?;
        }
        "approval" => {
            let approval = payload["approvalId"].as_str().unwrap_or_default();
            if let Some(err) = error {
                db.execute(
                    "UPDATE approvals SET state='pending' WHERE id=? AND state='resolving'",
                    [approval],
                )?;
                record(
                    db,
                    key,
                    "control.failed",
                    &json!({"approvalId":approval,"error":err}),
                )?;
            } else {
                db.execute(
                    "UPDATE approvals SET state=?,resolved_at=? WHERE id=? AND state='resolving'",
                    params![
                        if payload["decision"] == "deny" {
                            "deny"
                        } else {
                            "approve"
                        },
                        now(),
                        approval
                    ],
                )?;
                db.execute("UPDATE runs SET state='running',updated_at=? WHERE id=? AND state='waiting_approval' AND NOT EXISTS(SELECT 1 FROM approvals WHERE run_id=? AND state IN ('resolving','pending'))",params![now(),key,key])?;
                record(
                    db,
                    key,
                    "approval.resolved",
                    &json!({"approvalId":approval,"decision":payload["decision"]}),
                )?;
            }
        }
        _ => {}
    }
    Ok(())
}
pub fn worker_event(db: &Connection, run: &str, event: &Value) -> Result<()> {
    let kind = event["type"]
        .as_str()
        .or_else(|| event["event"].as_str())
        .context("Missing worker event type.")?;
    let mut payload = event
        .get("payload")
        .or_else(|| event.get("data"))
        .unwrap_or(event)
        .clone();
    let active:bool=db.query_row("SELECT EXISTS(SELECT 1 FROM runs WHERE id=? AND state IN ('running','waiting_input','waiting_approval'))",[run],|r|r.get(0))?;
    if !active {
        return Ok(());
    }
    if kind == "provider.auth" {
        let state = payload["state"]
            .as_str()
            .context("Missing provider sign-in state.")?;
        ensure!(
            matches!(state, "connected" | "signedOut" | "signInRequired"),
            "Invalid provider sign-in state."
        );
        db.execute("UPDATE worker_plan_bindings SET auth_state=? WHERE (agent_id,binding) IN
            (SELECT agent_id,json_extract(json,'$.planBinding') FROM run_profiles WHERE run_id=? AND json_extract(json,'$.modelAuth')='chatgpt-plan')",params![state,run])?;
        return record(db, run, kind, &json!({"state":state}));
    }
    if let Some(sid) = event["session_id"].as_str() {
        db.execute(
            "UPDATE runs SET session_id=coalesce(session_id,?) WHERE id=?",
            params![sid, run],
        )?;
    }
    match kind {
        "approval.request" => {
            let key = id();
            let gateway = payload["request_id"]
                .as_str()
                .or_else(|| payload["id"].as_str())
                .context("Missing approval request ID.")?;
            db.execute("INSERT INTO approvals(id,run_id,gateway_request_id,payload_json,state,created_at) VALUES(?,?,?,?,'pending',?)",params![key,run,gateway,payload.to_string(),now()])?;
            db.execute(
                "UPDATE runs SET state='waiting_approval',updated_at=? WHERE id=?",
                params![now(), run],
            )?;
            payload["approvalId"] = json!(key);
        }
        "clarify.request" | "secret.request" | "sudo.request" => {
            db.execute(
                "UPDATE runs SET state='waiting_input',updated_at=? WHERE id=?",
                params![now(), run],
            )?;
        }
        "message.delta" => {
            if let Some(text) = payload["text"].as_str() {
                db.execute(
                    "UPDATE task_runs SET output=substr(output || ?,-20000) WHERE run_id=?",
                    params![text, run],
                )?;
            }
        }
        _ => {}
    }
    record(db, run, kind, &payload)
}
pub fn agent_token(app: &App, agent: &str, key: &str) -> Result<String> {
    let mac = PKey::hmac(app.token.as_bytes())?;
    let mut signer = Signer::new(MessageDigest::sha256(), &mac)?;
    signer.update(format!("run:{agent}:{key}").as_bytes())?;
    Ok(signer
        .sign_to_vec()?
        .iter()
        .map(|n| format!("{n:02x}"))
        .collect())
}
fn admit(db: &Connection, candidate: &Value, snapshot: &Value, machine: &str) -> Result<bool> {
    let m = match machines::info(db, machine) {
        Ok(m) => m,
        Err(_) => return Ok(false),
    };
    if m["status"] != "online"
        || m["reservedAgentId"]
            .as_str()
            .is_some_and(|owner| candidate["agent_id"] != owner)
    {
        return Ok(false);
    }
    let occupied = rows(
        db,
        "SELECT r.agent_id,r.depth,b.machine_id FROM runs r LEFT JOIN native_run_bindings b ON b.run_id=r.id WHERE r.state IN ('running','waiting_input','waiting_approval')",
        &[],
    )?;
    if occupied.len() >= 4
        || (candidate["depth"] == 0 && occupied.iter().filter(|r| r["depth"] == 0).count() >= 2)
        || occupied
            .iter()
            .any(|r| r["agent_id"] == candidate["agent_id"])
    {
        return Ok(false);
    }
    let cap = snapshot
        .pointer("/computer/resources/concurrency")
        .and_then(Value::as_u64)
        .unwrap_or(2);
    if occupied
        .iter()
        .filter(|r| r["machine_id"] == machine)
        .count() as u64
        >= cap
    {
        return Ok(false);
    }
    let task_limit = std::env::var("MAX_TASK_RUNS")
        .ok()
        .and_then(|s| s.parse::<i64>().ok())
        .unwrap_or(3)
        .max(1);
    let constrained:bool=db.query_row("SELECT EXISTS(SELECT 1 FROM task_runs WHERE run_id=?1) AND (SELECT count(*) FROM task_runs t JOIN runs r ON r.id=t.run_id WHERE r.state IN ('running','waiting_input','waiting_approval'))>=?2",params![candidate["id"].as_str(),task_limit],|r|r.get(0))?;
    if constrained {
        return Ok(false);
    }
    let moving:bool=db.query_row("SELECT EXISTS(SELECT 1 FROM agent_transfers WHERE agent_id=? AND state NOT IN ('completed','failed'))",[candidate["agent_id"].as_str().unwrap()],|r|r.get(0))?;
    Ok(!moving)
}
pub fn pump(app: &App) -> Result<()> {
    let candidates = rows(
        &app.lock(),
        "SELECT id,agent_id,state,prompt,depth,(SELECT w.kind FROM worker_launch_requests w WHERE w.run_id=runs.id LIMIT 1) AS launch_kind FROM runs WHERE state='queued' ORDER BY created_at,rowid",
        &[],
    )?;
    for run in candidates {
        let key = run["id"].as_str().unwrap();
        let agent = run["agent_id"].as_str().unwrap();
        let outcome = (|| -> Result<()> {
            let snapshot = {
                let db = app.lock();
                let snap = profiles::snapshot(&db, agent)?;
                let machine = snap
                    .pointer("/computer/machineId")
                    .and_then(Value::as_str)
                    .unwrap_or("local");
                if !admit(&db, &run, &snap, machine)? {
                    return Ok(());
                }
                snap
            };
            let machine = snapshot
                .pointer("/computer/machineId")
                .and_then(Value::as_str)
                .unwrap_or("local");
            let terminal = run["launch_kind"] == "terminal";
            let secrets = if terminal {
                Default::default()
            } else {
                profiles::run_secrets(app, &snapshot)?
            };
            let db = app.lock();
            let tx = db.unchecked_transaction()?;
            if profiles::snapshot(&tx, agent)? != snapshot || !admit(&tx, &run, &snapshot, machine)?
            {
                return Ok(());
            }
            if tx.execute(
                "UPDATE runs SET state='running',updated_at=? WHERE id=? AND state='queued'",
                params![now(), key],
            )? == 0
            {
                return Ok(());
            }
            let assigned = machines::info(&tx, machine)?;
            if let Some(detail) = snapshot["harness"]
                .as_str()
                .and_then(|harness| machines::harness_upgrade(&assigned, harness))
            {
                bail!("{detail}");
            }
            let capabilities = &assigned["capabilities"];
            ensure!(
                capabilities["container"] == true,
                "Start the assigned worker's container engine before running this agent."
            );
            if terminal || snapshot["modelAuth"] == "chatgpt-plan" {
                ensure!(
                    capabilities["workerLaunch"] == true,
                    "Update the assigned Open Harness worker to use subscriptions and interactive terminals."
                );
            }
            let sealed = machines::seal(&tx, machine, &secrets)?;
            let token = agent_token(app, agent, key)?;
            let cmd = machines::enqueue(
                &tx,
                machine,
                Some(agent),
                "run",
                &json!({"snapshot":snapshot,"mode":if terminal {"terminal"}else{"task"},"runId":key,"prompt":run["prompt"],"coordinationToken":token,"encryptedSecrets":sealed}),
            )?;
            tx.execute(
                "INSERT INTO native_run_bindings(run_id,command_id,machine_id) VALUES(?,?,?)",
                params![key, cmd, machine],
            )?;
            tx.execute(
                "INSERT INTO run_profiles(run_id,agent_id,revision,json) VALUES(?,?,?,?)",
                params![
                    key,
                    agent,
                    snapshot["revision"].as_i64(),
                    snapshot.to_string()
                ],
            )?;
            record(
                &tx,
                key,
                "run.started",
                &json!({"runId":key,"agentId":agent,"machineId":machine}),
            )?;
            record(
                &tx,
                key,
                "profile.applied",
                &json!({"revision":snapshot["revision"],"harness":snapshot["harness"],"model":snapshot["effectiveModel"],"modelAuth":snapshot["modelAuth"],"allowedTools":snapshot["allowedTools"],"computer":snapshot["computer"]}),
            )?;
            workspace::run_changed(&tx, key)?;
            tx.commit()?;
            Ok(())
        })();
        if let Err(err) = outcome {
            let db = app.lock();
            let tx = db.unchecked_transaction()?;
            finish(&tx, key, "failed", None, Some(&err.to_string()))?;
            tx.commit()?;
        }
    }
    Ok(())
}
pub fn stop_tree(db: &Connection, key: &str) -> Result<Value> {
    let runs = rows(
        db,
        "WITH RECURSIVE children(id) AS (SELECT id FROM runs WHERE id=?1 UNION SELECT r.id FROM runs r JOIN children p ON r.parent_run_id=p.id) SELECT r.id,r.state,r.agent_id,b.command_id,b.machine_id,b.stopping,c.state AS lease FROM children JOIN runs r USING(id) LEFT JOIN native_run_bindings b ON b.run_id=r.id LEFT JOIN runner_commands c ON c.id=b.command_id",
        &[&key],
    )?;
    ensure!(!runs.is_empty(), "Run not found.");
    let mut stopped = 0;
    let mut pending = false;
    for r in runs {
        let key = r["id"].as_str().unwrap();
        if r["state"] == "queued" {
            finish(db, key, "cancelled", None, None)?;
            stopped += 1;
            continue;
        }
        if !matches!(
            r["state"].as_str(),
            Some("running" | "waiting_input" | "waiting_approval")
        ) {
            continue;
        }
        if r["lease"] == "queued" {
            db.execute(
                "UPDATE runner_commands SET state='failed',finished_at=?,result_json=? WHERE id=?",
                params![
                    now(),
                    r#"{"error":"Cancelled before dispatch."}"#,
                    r["command_id"].as_str()
                ],
            )?;
            finish(db, key, "cancelled", None, None)?;
        } else if r["stopping"] != 1 {
            machines::enqueue(
                db,
                r["machine_id"].as_str().context("No assigned worker.")?,
                r["agent_id"].as_str(),
                "stop",
                &json!({"runId":key,"commandId":r["command_id"]}),
            )?;
            db.execute(
                "UPDATE native_run_bindings SET stopping=1 WHERE run_id=?",
                [key],
            )?;
            record(
                db,
                key,
                "stop.pending",
                &json!({"machineId":r["machine_id"]}),
            )?;
            pending = true;
        } else {
            pending = true;
        }
        stopped += 1;
    }
    Ok(json!({"ok":true,"stopped":stopped,"pending":pending}))
}
async fn list(State(app): State<App>) -> Reply {
    let db = app.lock();
    let mut runs = vec![];
    for v in rows(
        &db,
        "SELECT id FROM runs ORDER BY created_at DESC,rowid DESC LIMIT 100",
        &[],
    )? {
        runs.push(get_run(&db, v["id"].as_str().unwrap())?);
    }
    Ok(Json(json!({"runs":runs})))
}
async fn submit(
    State(app): State<App>,
    Json(v): Json<Value>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    Ok((StatusCode::ACCEPTED, Json(create(&app.lock(), &v)?)))
}
async fn one(State(app): State<App>, Path(key): Path<String>) -> Reply {
    Ok(Json(
        get_run(&app.lock(), &key).map_err(|_| ApiError::missing("Run not found."))?,
    ))
}
#[derive(Deserialize, Default)]
struct Cursor {
    #[serde(default)]
    after: i64,
}
async fn events(
    State(app): State<App>,
    Path(key): Path<String>,
    Query(cursor): Query<Cursor>,
) -> Reply {
    let db = app.lock();
    let run = get_run(&db, &key).map_err(|_| ApiError::missing("Run not found."))?;
    let mut events = rows(
        &db,
        "SELECT seq,id,run_id AS runId,type,payload_json,created_at AS createdAt FROM events WHERE run_id=? AND seq>? ORDER BY seq LIMIT 500",
        &[&key, &cursor.after],
    )?;
    for e in &mut events {
        let raw = e.as_object_mut().unwrap().remove("payload_json").unwrap();
        e["payload"] = serde_json::from_str(raw.as_str().unwrap())?;
    }
    Ok(Json(json!({"run":run,"events":events})))
}
async fn stop(State(app): State<App>, Path(key): Path<String>) -> Reply {
    let db = app.lock();
    let tx = db.unchecked_transaction()?;
    let v = stop_tree(&tx, &key)?;
    tx.commit()?;
    Ok(Json(v))
}
fn stop_many(app: &App, agent: Option<&str>) -> Reply {
    let db = app.lock();
    let tx = db.unchecked_transaction()?;
    let mut n = 0;
    for r in rows(
        &tx,
        "SELECT id FROM runs WHERE (agent_id=?1 OR (?1 IS NULL AND depth=0)) AND state IN ('queued','running','waiting_input','waiting_approval')",
        &[&agent],
    )? {
        n += stop_tree(&tx, r["id"].as_str().unwrap())?["stopped"]
            .as_i64()
            .unwrap_or(0);
    }
    tx.commit()?;
    Ok(Json(json!({"ok":true,"stopped":n})))
}
async fn stop_all(State(app): State<App>) -> Reply {
    stop_many(&app, None)
}
async fn stop_agent(State(app): State<App>, Path(agent): Path<String>) -> Reply {
    stop_many(&app, Some(&agent))
}
fn control(app: &App, key: &str, kind: &str, v: &Value) -> Reply {
    let db = app.lock();
    let tx = db.unchecked_transaction()?;
    let (machine,cmd,agent,harness):(String,String,String,String)=tx.query_row("SELECT b.machine_id,b.command_id,r.agent_id,coalesce(json_extract(p.json,'$.harness'),'hermes') FROM native_run_bindings b JOIN runs r ON r.id=b.run_id JOIN run_profiles p ON p.run_id=b.run_id WHERE b.run_id=? AND b.stopping=0 AND r.state IN ('running','waiting_approval','waiting_input')",[key],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).optional()?.ok_or_else(||ApiError::conflict("Run is not active."))?;
    if harness != "hermes" {
        return Err(ApiError::conflict(
            "This harness accepts new messages after the current turn finishes.",
        ));
    }
    let mut payload = json!({"runId":key,"commandId":cmd});
    if kind == "approval" {
        let approval = v["approvalId"]
            .as_str()
            .ok_or_else(|| ApiError::bad("Missing approval ID."))?;
        let gateway=tx.query_row("SELECT gateway_request_id FROM approvals WHERE id=? AND run_id=? AND state='pending'",params![approval,key],|r|r.get::<_,String>(0)).optional()?.ok_or_else(||ApiError::conflict("This approval is no longer pending."))?;
        payload["approvalId"] = json!(approval);
        payload["requestId"] = json!(gateway);
        payload["decision"] = json!(match v["decision"].as_str() {
            Some("approve" | "once") => "once",
            Some("session") => "session",
            Some("always") => "always",
            Some("deny") => "deny",
            _ => return Err(ApiError::bad("Choose an approval decision.")),
        });
        tx.execute(
            "UPDATE approvals SET state='resolving' WHERE id=?",
            [approval],
        )?;
    } else {
        payload["text"] = json!(
            v["text"]
                .as_str()
                .filter(|s| !s.trim().is_empty())
                .ok_or_else(|| ApiError::bad("Enter a message."))?
        );
    }
    machines::enqueue(&tx, &machine, Some(&agent), kind, &payload)?;
    tx.commit()?;
    Ok(Json(json!({"ok":true,"pending":true})))
}
async fn steer(State(app): State<App>, Path(key): Path<String>, Json(v): Json<Value>) -> Reply {
    control(&app, &key, "steer", &v)
}
async fn approve(State(app): State<App>, Path(key): Path<String>, Json(v): Json<Value>) -> Reply {
    control(&app, &key, "approval", &v)
}
async fn internal(
    State(app): State<App>,
    Path(kind): Path<String>,
    headers: HeaderMap,
    Json(v): Json<Value>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let header = |name: &str| {
        headers
            .get(name)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
    };
    let agent = header("x-open-harness-agent");
    let key = header("x-open-harness-run");
    let supplied = header("authorization")
        .strip_prefix("Bearer ")
        .unwrap_or("");
    let valid = if agent.is_empty() || key.is_empty() || supplied.is_empty() {
        false
    } else if machines::secure_eq(supplied, &agent_token(&app, agent, key)?) {
        true
    } else {
        // Only an already-dispatched legacy job can use the credential in its original envelope.
        let token:Option<String>=app.lock().query_row(
            "SELECT json_extract(c.payload_json,'$.coordinationToken') FROM native_legacy_leases l
             JOIN runner_commands c ON l.command_id=c.id JOIN runs r ON r.id=l.run_id
             WHERE r.id=?1 AND r.agent_id=?2 AND c.agent_id=?2 AND c.state='leased'
             AND r.state IN ('running','waiting_approval','waiting_input')",
            params![key,agent],|r|r.get(0)).optional()?.flatten();
        token.is_some_and(|expected| machines::secure_eq(supplied, &expected))
    };
    if !valid {
        return Err(ApiError::new(
            StatusCode::UNAUTHORIZED,
            "Invalid run credential.",
        ));
    }
    let tool = match kind.as_str() {
        "task" => "mcp__open_harness__task",
        "schedule" => "mcp__open_harness__create_open_harness_routine",
        "handoff" => "mcp__open_harness__delegate_named_agent",
        _ => return Err(ApiError::missing("Unknown coordination tool.")),
    };
    let child = {
        let db = app.lock();
        let tx = db.unchecked_transaction()?;
        let snapshot=tx.query_row("SELECT p.json FROM run_profiles p JOIN runs r ON p.run_id=r.id WHERE r.id=? AND r.agent_id=? AND r.state IN ('running','waiting_input','waiting_approval')",params![key,agent],|r|r.get::<_,String>(0)).optional()?.ok_or_else(||ApiError::new(StatusCode::FORBIDDEN,"This run is no longer active."))?;
        let profile: Value = serde_json::from_str(&snapshot)?;
        if !profile["allowedTools"]
            .as_array()
            .is_some_and(|tools| tools.iter().any(|v| v == tool))
        {
            return Err(ApiError::new(
                StatusCode::FORBIDDEN,
                "Tool is disabled for this run.",
            ));
        }
        if kind == "task" {
            let (status, value) = workspace::agent_task(&tx, &profile, &v)?;
            tx.commit()?;
            return Ok((status, Json(value)));
        }
        if kind == "schedule" {
            let value = workspace::agent_schedule(&tx, agent, &v)?;
            tx.commit()?;
            return Ok((StatusCode::CREATED, value));
        }
        let to = v["agentId"].as_str().unwrap_or("");
        if !workspace::shares_team(&tx, agent, to)? {
            return Err(ApiError::new(
                StatusCode::FORBIDDEN,
                "The agents must share an active team.",
            ));
        }
        let child = create(
            &tx,
            &json!({"agentId":to,"prompt":v["prompt"],"parentRunId":key}),
        )?;
        record(
            &tx,
            key,
            "handoff.created",
            &json!({"childRunId":child["id"],"targetAgentId":to}),
        )?;
        tx.commit()?;
        child["id"].as_str().unwrap().to_owned()
    };
    let until = tokio::time::Instant::now() + Duration::from_secs(1800);
    loop {
        let run = get_run(&app.lock(), &child)?;
        if matches!(
            run["state"].as_str(),
            Some("completed" | "failed" | "interrupted" | "cancelled")
        ) {
            let result = json!({"runId":child,"state":run["state"],"result":run["result"],"error":run["error"]});
            record(&app.lock(), key, "handoff.completed", &result)?;
            return Ok((StatusCode::OK, Json(result)));
        }
        if *app.shutdown.borrow() || tokio::time::Instant::now() >= until {
            return Ok((
                StatusCode::ACCEPTED,
                Json(json!({"runId":child,"state":run["state"]})),
            ));
        }
        tokio::time::sleep(Duration::from_millis(250)).await;
    }
}
