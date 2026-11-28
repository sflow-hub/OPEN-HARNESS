use crate::{ApiError, App, Reply, machines, profiles, runs};
use anyhow::{Context, Result};
use axum::{
    Extension, Json,
    extract::{Path, State},
    http::StatusCode,
};
use openssl::{hash::MessageDigest, pkey::PKey, sign::Signer};
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Value, json};

pub fn init(db: &Connection) -> Result<()> {
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS worker_launch_grants (
            agent_id TEXT PRIMARY KEY, machine_id TEXT NOT NULL, generation TEXT UNIQUE NOT NULL,
            harness TEXT NOT NULL, model_auth TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS worker_plan_bindings (
            agent_id TEXT PRIMARY KEY, machine_id TEXT NOT NULL, binding TEXT UNIQUE NOT NULL,
            auth_state TEXT NOT NULL DEFAULT 'unknown'
        );
        CREATE TABLE IF NOT EXISTS worker_launch_requests (
            generation TEXT NOT NULL, request_id TEXT NOT NULL, run_id TEXT NOT NULL, kind TEXT NOT NULL,
            PRIMARY KEY(generation,request_id)
        );
        CREATE INDEX IF NOT EXISTS worker_launch_run ON worker_launch_requests(run_id);"
    )?;
    Ok(())
}

pub fn set_access(
    db: &Connection,
    agent: &str,
    machine: &str,
    enabled: bool,
    harness: &str,
    auth: &str,
) -> Result<()> {
    let machine = machines::physical(machine);
    db.execute("DELETE FROM worker_plan_bindings WHERE agent_id=? AND (machine_id!=? OR ?!='chatgpt-plan')", params![agent,machine,auth])?;
    if auth == "chatgpt-plan" {
        db.execute(
            "INSERT OR IGNORE INTO worker_plan_bindings(agent_id,machine_id,binding) VALUES(?,?,?)",
            params![agent, machine, crate::id()],
        )?;
    }
    let old: Option<(String, String, String, String)> = db.query_row(
        "SELECT generation,machine_id,harness,model_auth FROM worker_launch_grants WHERE agent_id=?",
        [agent], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
    ).optional()?;
    if let Some((generation, old_machine, old_harness, old_auth)) = old {
        if enabled && old_machine == machine && old_harness == harness && old_auth == auth {
            return Ok(());
        }
        db.execute("DELETE FROM worker_launch_grants WHERE agent_id=?", [agent])?;
        let active = crate::rows(
            db,
            "SELECT DISTINCT r.id FROM runs r JOIN worker_launch_requests w ON r.id=w.run_id WHERE w.generation=? AND (r.state='queued' OR (w.kind='terminal' AND r.state IN ('running','waiting_input','waiting_approval')))",
            &[&generation],
        )?;
        for run in active {
            runs::stop_tree(db, run["id"].as_str().context("Missing worker run ID")?)?;
        }
    }
    if enabled {
        db.execute("INSERT INTO worker_launch_grants(agent_id,machine_id,generation,harness,model_auth) VALUES(?,?,?,?,?)",
            params![agent, machine, crate::id(), harness, auth])?;
    }
    Ok(())
}

pub fn status(db: &Connection, agent: &str, machine: &Value) -> Result<Value> {
    let state = db
        .query_row(
            "SELECT auth_state FROM worker_plan_bindings WHERE agent_id=? AND machine_id=?",
            params![
                agent,
                machines::physical(machine["id"].as_str().unwrap_or(""))
            ],
            |r| r.get::<_, String>(0),
        )
        .optional()?;
    Ok(
        json!({"state":state.as_deref().unwrap_or("unknown"),"machineId":machine["id"],
        "capable":machine["capabilities"]["workerLaunch"]==true,"online":machine["status"]=="online"}),
    )
}

fn denied() -> ApiError {
    ApiError::new(
        StatusCode::FORBIDDEN,
        "Worker launch access is unavailable. Check the assigned machine and enable worker launches in Agent settings.",
    )
}

// Only the grant generation is persisted. It rotates when the operator withdraws access,
// changes the harness or moves the agent. The bearer never enters a run or its history.
fn bearer(secret: &str, generation: &str) -> Result<String> {
    let key = PKey::hmac(secret.as_bytes())?;
    let mut signer = Signer::new(MessageDigest::sha256(), &key)?;
    signer.update(b"open-harness/worker-launch/")?;
    signer.update(generation.as_bytes())?;
    use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
    Ok(URL_SAFE_NO_PAD.encode(signer.sign_to_vec()?))
}

pub async fn request(
    State(app): State<App>,
    Extension(machines::Identity(machine)): Extension<machines::Identity>,
    Path(agent): Path<String>,
    Json(v): Json<Value>,
) -> Reply {
    let db = app.lock();
    let tx = db.unchecked_transaction()?;
    let grant: Option<String> = tx.query_row(
        "SELECT g.generation FROM worker_launch_grants g JOIN machines m ON m.id=g.machine_id WHERE g.agent_id=? AND g.machine_id=? AND m.revoked_at IS NULL",
        params![agent,machine], |r| r.get(0)).optional()?;
    let generation = grant.ok_or_else(denied)?;
    let profile = profiles::snapshot(&tx, &agent)?;
    if profile["workerLaunch"] != true
        || machines::physical(profile["computer"]["machineId"].as_str().unwrap_or("")) != machine
    {
        return Err(denied());
    }
    let expected = bearer(&app.token, &generation)?;
    let action = v["action"].as_str().unwrap_or("");
    if action != "authorize" && !machines::secure_eq(v["grant"].as_str().unwrap_or(""), &expected) {
        return Err(denied());
    }
    let value = match action {
        "authorize" => {
            json!({"agentId":agent,"machineId":profile["computer"]["machineId"],"harness":profile["harness"],"modelAuth":profile["modelAuth"],"planBinding":profile["planBinding"],"workerLaunch":true,"grant":expected})
        }
        "status" => {
            let state = v["state"].as_str().unwrap_or("");
            if !matches!(state, "connected" | "signedOut" | "signInRequired")
                || profile["modelAuth"] != "chatgpt-plan"
            {
                return Err(ApiError::bad("Invalid ChatGPT sign-in status."));
            }
            tx.execute(
                "UPDATE worker_plan_bindings SET auth_state=? WHERE agent_id=? AND binding=?",
                params![state, agent, profile["planBinding"].as_str()],
            )?;
            json!({"state":state})
        }
        "read" => {
            let run = v["runId"].as_str().unwrap_or("");
            let allowed: bool = tx.query_row("SELECT EXISTS(SELECT 1 FROM worker_launch_requests WHERE generation=? AND run_id=?)",params![generation,run],|r|r.get(0))?;
            if !allowed {
                return Err(denied());
            }
            runs::get_run(&tx, run)?
        }
        "run" if profile["harness"] == "codex" && profile["modelAuth"] == "chatgpt-plan" => {
            submit(&tx, &agent, &generation, action, &v)?
        }
        "terminal" if profile["harness"] == "claude-code" => {
            submit(&tx, &agent, &generation, action, &v)?
        }
        _ => {
            return Err(ApiError::bad(
                "Choose a ChatGPT-plan Codex run or a Claude Code terminal for this agent.",
            ));
        }
    };
    tx.commit()?;
    Ok(Json(value))
}

fn submit(
    db: &Connection,
    agent: &str,
    generation: &str,
    kind: &str,
    v: &Value,
) -> Result<Value, ApiError> {
    let request = v["requestId"]
        .as_str()
        .filter(|s| uuid::Uuid::parse_str(s).is_ok())
        .ok_or_else(|| ApiError::bad("A worker request UUID is required."))?;
    let prompt = if kind == "terminal" {
        "Interactive Claude Code terminal"
    } else {
        v["prompt"].as_str().unwrap_or("").trim()
    };
    if let Some((run, old_kind)) = db
        .query_row(
            "SELECT run_id,kind FROM worker_launch_requests WHERE generation=? AND request_id=?",
            params![generation, request],
            |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
        )
        .optional()?
    {
        let result = runs::get_run(db, &run)?;
        if kind != old_kind || result["prompt"] != prompt {
            return Err(ApiError::conflict(
                "The worker request ID already belongs to a different launch.",
            ));
        }
        return Ok(result);
    }
    // An SSH reconnect attaches to the original queued or active terminal, including
    // the interval between admission and the worker creating its TTY.
    let existing: Option<String> = if kind == "terminal" {
        db.query_row("SELECT w.run_id FROM worker_launch_requests w JOIN runs r ON r.id=w.run_id WHERE w.generation=? AND w.kind='terminal' AND r.state IN ('queued','running','waiting_input','waiting_approval') LIMIT 1",[generation],|r| r.get(0)).optional()?
    } else {
        None
    };
    let run = match existing {
        Some(key) => runs::get_run(db, &key)?,
        None => runs::create(db, &json!({"agentId":agent,"prompt":prompt}))
            .map_err(|e| ApiError::bad(e.to_string()))?,
    };
    db.execute(
        "INSERT INTO worker_launch_requests(generation,request_id,run_id,kind) VALUES(?,?,?,?)",
        params![generation, request, run["id"].as_str(), kind],
    )?;
    Ok(run)
}
