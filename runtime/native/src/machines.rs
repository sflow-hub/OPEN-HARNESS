use crate::{ApiError, App, Reply, id, now, profiles, rows, runs};
use anyhow::{Context, Result, ensure};
use axum::{
    Extension, Json, Router,
    extract::{Path, Request, State},
    http::StatusCode,
    routing::{get, post},
};
use base64::{
    Engine,
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
};
use chrono::{Duration, SecondsFormat, Utc};
use open_harness_runner::harnesses;
use openssl::{
    bn::BigNum,
    encrypt::Encrypter,
    hash::MessageDigest,
    pkey::{PKey, Public},
    rand::rand_bytes,
    rsa::{Padding, Rsa},
    symm::{Cipher, encrypt_aead},
};
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;

pub const LOCAL: &str = "machine-local";
pub fn physical(machine: &str) -> &str {
    if machine == "local" { LOCAL } else { machine }
}
fn public(machine: &str) -> &str {
    if machine == LOCAL { "local" } else { machine }
}
fn stamp(seconds: i64) -> String {
    (Utc::now() + Duration::seconds(seconds)).to_rfc3339_opts(SecondsFormat::Millis, true)
}
pub fn random() -> Result<String> {
    let mut bytes = [0; 32];
    rand_bytes(&mut bytes)?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}
pub fn digest(token: &str) -> String {
    format!("{:x}", Sha256::digest(token.as_bytes()))
}
pub fn secure_eq(a: &str, b: &str) -> bool {
    a.len() == b.len() && openssl::memcmp::eq(a.as_bytes(), b.as_bytes())
}
pub fn authenticated(db: &Connection, machine: &str, token: &str) -> Result<bool> {
    let hash: Option<String> = db
        .query_row(
            "SELECT credential_hash FROM machines WHERE id=? AND revoked_at IS NULL",
            [machine],
            |r| r.get(0),
        )
        .optional()?
        .flatten();
    Ok(hash.is_some_and(|hash| secure_eq(&hash, &digest(token))))
}
pub fn enqueue(
    db: &Connection,
    machine: &str,
    agent: Option<&str>,
    kind: &str,
    payload: &Value,
) -> Result<String> {
    let command = id();
    db.execute("INSERT INTO runner_commands(id,machine_id,agent_id,kind,payload_json,state,created_at) VALUES(?,?,?,?,?,'queued',?)",params![command,physical(machine),agent,kind,payload.to_string(),now()])?;
    Ok(command)
}
pub fn info(db: &Connection, machine: &str) -> Result<Value> {
    let mut rec=rows(db,"SELECT id,name,platform,arch,last_seen_at AS lastSeenAt, reserved_agent_id AS reservedAgentId,revoked_at,capabilities_json FROM machines WHERE id=?", &[&physical(machine)])?.pop().context("Computer not found.")?;
    let caps: Value = serde_json::from_str(rec["capabilities_json"].as_str().unwrap_or("{}"))?;
    let status = if !rec["revoked_at"].is_null() {
        "revoked"
    } else if rec["lastSeenAt"]
        .as_str()
        .is_some_and(|seen| seen >= stamp(-45).as_str())
    {
        "online"
    } else {
        "offline"
    };
    let name = public(machine);
    let assigned: i64 = db.query_row(
        "SELECT count(*) FROM agent_profiles WHERE json_extract(json,'$.computer.machineId')=?",
        [name],
        |r| r.get(0),
    )?;
    let obj = rec.as_object_mut().unwrap();
    obj.remove("capabilities_json");
    obj.remove("revoked_at");
    rec["id"] = json!(name);
    rec["local"] = json!(name == "local");
    rec["capabilities"] = machine_capabilities(&caps);
    rec["status"] = json!(status);
    rec["assignedAgents"] = json!(assigned);
    Ok(rec)
}
pub fn harness_upgrade(machine: &Value, harness: &str) -> Option<String> {
    // The local worker is shipped with the coordinator, including during startup.
    if machine["local"] == true || !harnesses::is_additional(harness) {
        return None;
    }
    let supports_harness = machine["capabilities"]["harnesses"]
        .as_array()
        .is_some_and(|ids| ids.iter().any(|id| id == harness));
    if supports_harness {
        return None;
    }
    let name = harnesses::find(harness)?.name;
    Some(format!(
        "Update the Open Harness worker on this computer to use {name}."
    ))
}
fn public_key(input: &str) -> Result<PKey<Public>> {
    ensure!(input.len() < 8192, "Invalid runner key.");
    let v: Value = serde_json::from_str(input)?;
    ensure!(v["kty"] == "RSA", "Unsupported runner key.");
    let n = URL_SAFE_NO_PAD.decode(v["n"].as_str().context("Invalid RSA public key")?)?;
    let e = URL_SAFE_NO_PAD.decode(v["e"].as_str().context("Invalid RSA public exponent")?)?;
    ensure!(
        (256..=512).contains(&n.len()) && e.len() <= 4,
        "Invalid runner public key size."
    );
    Ok(PKey::from_rsa(Rsa::from_public_components(
        BigNum::from_slice(&n)?,
        BigNum::from_slice(&e)?,
    )?)?)
}
pub fn seal(db: &Connection, machine: &str, secrets: &BTreeMap<String, String>) -> Result<Value> {
    let mut sealed = json!({});
    if secrets.is_empty() {
        return Ok(sealed);
    }
    let jwk: String = db
        .query_row(
            "SELECT encryption_public_key FROM machines WHERE id=? AND revoked_at IS NULL",
            [physical(machine)],
            |r| r.get(0),
        )
        .context("Waiting for the runner encryption key")?;
    let key = public_key(&jwk)?;
    let mut rsa = Encrypter::new(&key)?;
    rsa.set_rsa_padding(Padding::PKCS1_OAEP)?;
    rsa.set_rsa_oaep_md(MessageDigest::sha256())?;
    rsa.set_rsa_mgf1_md(MessageDigest::sha256())?;
    for (name, value) in secrets {
        let mut aes = [0; 32];
        let mut iv = [0; 12];
        let mut tag = [0; 16];
        rand_bytes(&mut aes)?;
        rand_bytes(&mut iv)?;
        let mut data = encrypt_aead(
            Cipher::aes_256_gcm(),
            &aes,
            Some(&iv),
            &[],
            value.as_bytes(),
            &mut tag,
        )?;
        data.extend(tag);
        let mut wrapped = vec![0; rsa.encrypt_len(&aes)?];
        let len = rsa.encrypt(&aes, &mut wrapped)?;
        sealed[name] = json!({"version":1,"key":STANDARD.encode(&wrapped[..len]),"iv":STANDARD.encode(iv),"data":STANDARD.encode(data)});
    }
    Ok(sealed)
}
pub fn pairing(
    db: &Connection,
    name: &str,
    platform: &str,
    url: &str,
    local: bool,
) -> Result<Value> {
    let target = reqwest::Url::parse(url)?;
    let loopback = matches!(target.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
    ensure!(
        (target.scheme() == "https" || (loopback && target.scheme() == "http"))
            && target.username().is_empty()
            && target.password().is_none()
            && target.query().is_none()
            && target.fragment().is_none(),
        "Use an HTTPS coordinator address or loopback HTTP."
    );
    let code = random()?;
    let key = id();
    let expiry = stamp(600);
    let tx = db.unchecked_transaction()?;
    tx.execute("INSERT INTO machine_pairings(id,code_hash,name,platform,expires_at,created_at) VALUES(?,?,?,?,?,?)",params![key,digest(&code),name,platform,expiry,now()])?;
    if local {
        tx.execute(
            "INSERT INTO native_pairing_aliases VALUES(?,?)",
            params![key, LOCAL],
        )?;
    }
    tx.commit()?;
    // Shell-quote the operator-selected URL before presenting the command to copy.
    let quoted = url.replace('\'', "'\\''");
    Ok(
        json!({"id":key,"code":code,"platform":platform,"expiresAt":expiry,"command":format!("open-harness runner --coordinator '{quoted}' --pairing-code '{code}'")}),
    )
}
pub fn router() -> Router<App> {
    Router::new()
        .route("/v1/machines", get(list).post(new_pairing))
        .route("/v1/machines/{id}/test", post(check))
        .route("/v1/machines/{id}/reconnect", post(check))
        .route("/v1/machines/{id}/revoke", post(revoke))
        .route("/v1/runner/pair", post(pair))
        .route("/v1/runner/heartbeat", post(heartbeat))
        .route(
            "/v1/runner/launch/{agent}",
            post(crate::worker_launch::request),
        )
        .route("/v1/runner/commands", get(poll))
        .route("/v1/runner/commands/{id}/events", post(receive))
        .route("/v1/runner/commands/{id}/complete", post(complete))
        .route("/v1/agents/{id}/transfer", post(transfer))
}
async fn list(State(app): State<App>) -> Reply {
    let db = app.lock();
    let mut machines = vec![];
    for rec in rows(
        &db,
        "SELECT id FROM machines WHERE id!='local' AND revoked_at IS NULL ORDER BY local DESC,name",
        &[],
    )? {
        machines.push(info(&db, rec["id"].as_str().unwrap())?);
    }
    Ok(Json(json!({"machines":machines})))
}
async fn new_pairing(
    State(app): State<App>,
    Json(v): Json<Value>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let url = v["coordinatorUrl"]
        .as_str()
        .filter(|url| !url.trim().is_empty())
        .map(str::to_owned)
        .or_else(|| {
            std::env::var("OPEN_HARNESS_PUBLIC_URL")
                .ok()
                .filter(|url| !url.trim().is_empty())
        })
        .unwrap_or_else(|| app.local_url.to_string());
    if v["platform"] == "win32" {
        return Err(ApiError::bad(
            "Use a Linux or macOS worker. On Windows run the Linux worker under WSL2.",
        ));
    }
    Ok((
        StatusCode::CREATED,
        Json(pairing(
            &app.lock(),
            v["name"].as_str().unwrap_or("Runner"),
            v["platform"].as_str().unwrap_or("linux"),
            &url,
            false,
        )?),
    ))
}
async fn check(State(app): State<App>, Path(machine): Path<String>) -> Reply {
    let m = info(&app.lock(), &machine)?;
    let ready = m["status"] == "online" && m["capabilities"]["container"] == true;
    Ok(Json(
        json!({"ok":ready,"machine":m,"message":if ready{"Headless container execution is ready."}else{"Waiting for the worker and container engine."}}),
    ))
}
async fn revoke(State(app): State<App>, Path(machine): Path<String>) -> Reply {
    if physical(&machine) == LOCAL {
        return Err(ApiError::conflict("The local worker cannot be revoked."));
    }
    let db = app.lock();
    let tx = db.unchecked_transaction()?;
    if tx.execute(
        "UPDATE machines SET revoked_at=?,credential_hash=NULL,status='revoked' WHERE id=?",
        params![now(), machine],
    )? == 0
    {
        return Err(ApiError::missing("Computer not found."));
    }
    interrupt_machine(&tx, &machine, "This computer was revoked.")?;
    tx.commit()?;
    Ok(Json(json!({"ok":true})))
}
async fn pair(
    State(app): State<App>,
    Json(v): Json<Value>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let key = v["encryptionPublicKey"]
        .as_str()
        .map(|s| public_key(s).map(|_| s))
        .transpose()?;
    let db = app.lock();
    let tx = db.unchecked_transaction()?;
    let pairing:Option<(String,String,String)>=tx.query_row("SELECT id,name,platform FROM machine_pairings WHERE code_hash=? AND used_at IS NULL AND expires_at>?",params![digest(v["code"].as_str().unwrap_or("")),now()],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional()?;
    let (pair_id, name, platform) = pairing.ok_or_else(|| {
        ApiError::new(
            StatusCode::GONE,
            "Pairing code is invalid, used, or expired.",
        )
    })?;
    let local: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM native_pairing_aliases WHERE pairing_id=?)",
        [&pair_id],
        |r| r.get(0),
    )?;
    let machine = if local {
        LOCAL.to_owned()
    } else {
        format!("machine-{}", id())
    };
    let token = random()?;
    tx.execute(
        "UPDATE machine_pairings SET used_at=? WHERE id=?",
        params![now(), pair_id],
    )?;
    tx.execute("INSERT INTO machines(id,name,platform,arch,status,last_seen_at,local,capabilities_json,credential_hash,created_at,updated_at,encryption_public_key) VALUES(?,?,?,?,'online',?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET credential_hash=excluded.credential_hash, encryption_public_key=excluded.encryption_public_key,last_seen_at=excluded.last_seen_at,capabilities_json=excluded.capabilities_json,updated_at=excluded.updated_at",params![machine,v["name"].as_str().unwrap_or(&name),v["platform"].as_str().unwrap_or(&platform),v["arch"].as_str().unwrap_or("unknown"),now(),local,machine_capabilities(&v["capabilities"]).to_string(),digest(&token),now(),now(),key])?;
    if local {
        tx.execute("UPDATE machines SET reserved_agent_id=coalesce(reserved_agent_id,(SELECT reserved_agent_id FROM machines WHERE id='local')) WHERE id=?",[LOCAL])?;
    }
    let m = info(&tx, &machine)?;
    tx.commit()?;
    Ok((
        StatusCode::CREATED,
        Json(json!({"machineId":machine,"machine":m,"token":token})),
    ))
}
fn machine_capabilities(caps: &Value) -> Value {
    let ids: Vec<&str> = caps["harnesses"].as_array().map_or_else(
        || harnesses::LEGACY_HARNESSES.to_vec(),
        |provided| {
            harnesses::HARNESSES
                .iter()
                .map(|harness| harness.id)
                .filter(|id| provided.iter().any(|value| value == *id))
                .collect()
        },
    );
    json!({"container":caps["container"].as_bool().unwrap_or(false),"workerLaunch":caps["workerLaunch"] == true,"direct":false,"desktop":false,"virtualDesktop":false,"detail":"Headless container worker.","harnesses":ids})
}
#[derive(Clone)]
pub struct Identity(pub String);
async fn heartbeat(
    State(app): State<App>,
    Extension(Identity(machine)): Extension<Identity>,
    Json(v): Json<Value>,
) -> Reply {
    let db = app.lock();
    let tx = db.unchecked_transaction()?;
    let key = v["encryptionPublicKey"]
        .as_str()
        .map(|s| public_key(s).map(|_| s))
        .transpose()?;
    tx.execute("UPDATE machines SET status='online',last_seen_at=?,updated_at=?,capabilities_json=?,encryption_public_key=coalesce(?,encryption_public_key) WHERE id=?",params![now(),now(),machine_capabilities(&v["capabilities"]).to_string(),key,machine])?;
    if let Some(active) = v["activeCommandIds"].as_array() {
        for cmd in rows(
            &tx,
            "SELECT id,kind,payload_json FROM runner_commands WHERE machine_id=? AND state='leased' AND leased_at<?",
            &[&machine, &stamp(-45)],
        )? {
            if !active.contains(&cmd["id"]) {
                uncertain(
                    &tx,
                    &cmd,
                    "The worker restarted before confirming this command.",
                )?;
            }
        }
    }
    let machine = info(&tx, &machine)?;
    tx.commit()?;
    Ok(Json(machine))
}
fn uncertain(db: &Connection, cmd: &Value, message: &str) -> Result<()> {
    let key = cmd["id"].as_str().unwrap();
    let payload: Value = serde_json::from_str(cmd["payload_json"].as_str().unwrap())?;
    db.execute(
        "UPDATE runner_commands SET state='failed',finished_at=?,result_json=? WHERE id=?",
        params![
            now(),
            json!({"error":message,"interrupted":true}).to_string(),
            key
        ],
    )?;
    if matches!(cmd["kind"].as_str(), Some("run" | "stop")) {
        runs::finish(
            db,
            payload["runId"].as_str().unwrap_or(""),
            "interrupted",
            None,
            Some(message),
        )?;
    }
    Ok(())
}
fn interrupt_machine(db: &Connection, machine: &str, reason: &str) -> Result<()> {
    for cmd in rows(
        db,
        "SELECT id,kind,payload_json FROM runner_commands WHERE machine_id=? AND state IN ('queued','leased')",
        &[&machine],
    )? {
        uncertain(db, &cmd, reason)?;
    }
    Ok(())
}
async fn poll(State(app): State<App>, Extension(Identity(machine)): Extension<Identity>) -> Reply {
    let db = app.lock();
    let tx = db.unchecked_transaction()?;
    let mut commands = vec![];
    for cmd in rows(
        &tx,
        "SELECT id,agent_id,kind,payload_json FROM runner_commands WHERE machine_id=? AND state='queued' ORDER BY rowid LIMIT 8",
        &[&machine],
    )? {
        let key = cmd["id"].as_str().unwrap();
        tx.execute(
            "UPDATE runner_commands SET state='leased',leased_at=? WHERE id=?",
            params![now(), key],
        )?;
        commands.push(json!({"id":key,"agentId":cmd["agent_id"],"kind":cmd["kind"],"payload":serde_json::from_str::<Value>(cmd["payload_json"].as_str().unwrap())?}));
    }
    tx.commit()?;
    Ok(Json(json!({"commands":commands})))
}
fn owned(db: &Connection, machine: &str, key: &str) -> Result<Value, ApiError> {
    rows(
        db,
        "SELECT kind,state,agent_id,payload_json FROM runner_commands WHERE machine_id=? AND id=?",
        &[&machine, &key],
    )?
    .pop()
    .ok_or_else(|| ApiError::missing("Runner command not found."))
}
async fn receive(
    State(app): State<App>,
    Extension(Identity(machine)): Extension<Identity>,
    Path(key): Path<String>,
    Json(v): Json<Value>,
) -> Reply {
    let db = app.lock();
    let tx = db.unchecked_transaction()?;
    let command = owned(&tx, &machine, &key)?;
    let payload: Value = serde_json::from_str(command["payload_json"].as_str().unwrap())?;
    let run = v["runId"]
        .as_str()
        .ok_or_else(|| ApiError::bad("Missing run ID."))?;
    let event_id = v["eventId"]
        .as_str()
        .filter(|s| !s.is_empty() && s.len() <= 160)
        .ok_or_else(|| ApiError::bad("Missing event ID."))?;
    if command["kind"] != "run" || payload["runId"] != run || command["state"] == "queued" {
        return Err(ApiError::conflict(
            "Event does not belong to this leased run.",
        ));
    }
    if command["state"] == "leased"
        && tx.execute(
            "INSERT OR IGNORE INTO runner_event_receipts VALUES(?,?,?)",
            params![key, event_id, now()],
        )? == 1
    {
        runs::worker_event(&tx, run, &v["event"])?;
    }
    tx.commit()?;
    Ok(Json(json!({"ok":true})))
}

pub fn begin_transfer(app: &App, agent: &str, profile: &Value) -> Result<Value, ApiError> {
    let db = app.lock();
    let tx = db.unchecked_transaction()?;
    let staged = stage_transfer(&tx, agent, profile)?;
    tx.commit()?;
    Ok(staged)
}
pub fn stage_transfer(tx: &Connection, agent: &str, profile: &Value) -> Result<Value, ApiError> {
    let source = profiles::machine(tx, agent)?;
    let dest = profile
        .pointer("/computer/machineId")
        .and_then(Value::as_str)
        .filter(|d| *d != LOCAL)
        .ok_or_else(|| ApiError::bad("Choose a destination computer."))?;
    if profile["id"] != agent || dest == source {
        return Err(ApiError::bad("Choose a different computer for this agent."));
    }
    let destination = info(tx, dest)?;
    if destination["status"] == "revoked"
        || destination["reservedAgentId"]
            .as_str()
            .is_some_and(|owner| owner != agent)
    {
        return Err(ApiError::conflict(
            "The destination is unavailable or reserved for another agent.",
        ));
    }
    let busy:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM agent_transfers WHERE agent_id=? AND state NOT IN ('failed','completed'))",[agent],|r|r.get(0))?;
    if busy {
        return Err(ApiError::conflict(
            "A transfer is already in progress for this agent.",
        ));
    }
    if profile["computer"]["reserveMachine"] == true {
        tx.execute(
            "UPDATE machines SET reserved_agent_id=? WHERE id=?",
            params![agent, physical(dest)],
        )?;
    }
    let key = id();
    let time = now();
    tx.execute("INSERT INTO agent_transfers(id,agent_id,source_machine_id,destination_machine_id,state,created_at,updated_at,pending_profile_json) VALUES(?,?,?,?,'queued',?,?,?)",params![key,agent,source,dest,time,time,profile.to_string()])?;
    Ok(
        json!({"id":key,"agentId":agent,"sourceMachineId":source,"destinationMachineId":dest,"state":"queued","createdAt":time}),
    )
}
async fn transfer(
    State(app): State<App>,
    Path(agent): Path<String>,
    Json(v): Json<Value>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let mut profile: Value = {
        let raw: String = app
            .lock()
            .query_row(
                "SELECT json FROM agent_profiles WHERE id=?",
                [&agent],
                |r| r.get(0),
            )
            .optional()?
            .ok_or_else(|| ApiError::missing("Agent not found."))?;
        serde_json::from_str(&raw)?
    };
    profile["computer"]["machineId"] = v["destinationMachineId"].clone();
    Ok((
        StatusCode::ACCEPTED,
        Json(begin_transfer(&app, &agent, &profile)?),
    ))
}
pub fn tick(db: &Connection, root: &std::path::Path) -> Result<()> {
    let grace = std::env::var("OPEN_HARNESS_REMOTE_OFFLINE_GRACE_MS")
        .ok()
        .and_then(|s| s.parse::<i64>().ok())
        .unwrap_or(300000)
        .max(60000)
        / 1000;
    for m in rows(
        db,
        "SELECT DISTINCT c.machine_id FROM runner_commands c JOIN machines m ON m.id=c.machine_id WHERE c.kind='run' AND c.state IN ('leased','queued') AND m.last_seen_at<?",
        &[&stamp(-grace)],
    )? {
        let tx = db.unchecked_transaction()?;
        interrupt_machine(
            &tx,
            m["machine_id"].as_str().unwrap(),
            "The worker stopped checking in. Its execution outcome is uncertain.",
        )?;
        tx.commit()?;
    }
    let transfers = rows(
        db,
        "SELECT id,agent_id,source_machine_id,destination_machine_id,state,pending_profile_json FROM agent_transfers WHERE state NOT IN ('failed','completed')",
        &[],
    )?;
    for item in transfers {
        let tx = db.unchecked_transaction()?;
        if let Err(err) = advance_transfer(&tx, root, &item) {
            // The destination can change only after its checksum and profile revision agree.
            drop(tx);
            let tx = db.unchecked_transaction()?;
            tx.execute(
                "UPDATE agent_transfers SET state='failed',detail=?,updated_at=? WHERE id=?",
                params![err.to_string(), now(), item["id"].as_str()],
            )?;
            tx.execute(
                "UPDATE machines SET reserved_agent_id=NULL WHERE id=? AND reserved_agent_id=?",
                params![
                    physical(item["destination_machine_id"].as_str().unwrap()),
                    item["agent_id"].as_str()
                ],
            )?;
            tx.commit()?;
        } else {
            tx.commit()?;
        }
    }
    Ok(())
}
fn advance_transfer(db: &Connection, root: &std::path::Path, t: &Value) -> Result<()> {
    let key = t["id"].as_str().unwrap();
    let agent = t["agent_id"].as_str().unwrap();
    let src = t["source_machine_id"].as_str().unwrap();
    let dest = t["destination_machine_id"].as_str().unwrap();
    let pending: Value = serde_json::from_str(
        t["pending_profile_json"]
            .as_str()
            .context("Missing destination profile.")?,
    )?;
    if t["state"] == "queued" {
        let busy:bool=db.query_row("SELECT EXISTS(SELECT 1 FROM runs WHERE agent_id=? AND state IN ('running','waiting_approval','waiting_input'))",[agent],|r|r.get(0))?;
        if busy {
            return Ok(());
        }
        let cmd = enqueue(
            db,
            src,
            Some(agent),
            "export-agent",
            &json!({"transferId":key}),
        )?;
        db.execute(
            "INSERT INTO native_transfers VALUES(?,?,NULL)",
            params![key, cmd],
        )?;
        db.execute(
            "UPDATE agent_transfers SET state='exporting',updated_at=? WHERE id=?",
            params![now(), key],
        )?;
        return Ok(());
    }
    let (state,result,checksum):(String,Option<String>,Option<String>)=db.query_row("SELECT c.state,c.result_json,t.checksum FROM native_transfers t JOIN runner_commands c ON c.id=t.command_id WHERE t.transfer_id=?",[key],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).context("Earlier transfer was interrupted. Source files were preserved.")?;
    if matches!(state.as_str(), "queued" | "leased") {
        return Ok(());
    }
    let result: Value =
        serde_json::from_str(result.as_deref().context("Missing transfer receipt.")?)?;
    ensure!(
        state == "completed",
        "{}",
        result["error"]
            .as_str()
            .unwrap_or("Worker transfer failed.")
    );
    let digest = result["checksum"]
        .as_str()
        .filter(|s| s.len() == 64)
        .context("Missing file bundle checksum.")?;
    if t["state"] == "exporting" {
        let cmd = enqueue(
            db,
            dest,
            Some(agent),
            "import-agent",
            &json!({"transferId":key,"profile":pending,"bundle":result,"requiredSecrets":profiles::missing_transfer_secrets(db,root,&pending)?}),
        )?;
        db.execute(
            "UPDATE native_transfers SET command_id=?,checksum=? WHERE transfer_id=?",
            params![cmd, digest, key],
        )?;
        db.execute(
            "UPDATE agent_transfers SET state='importing',updated_at=? WHERE id=?",
            params![now(), key],
        )?;
    } else {
        ensure!(
            checksum.as_deref() == Some(digest),
            "Transferred files did not match their checksum."
        );
        profiles::apply_transfer(db, &pending)?;
        db.execute(
            "UPDATE machines SET reserved_agent_id=NULL WHERE id=? AND reserved_agent_id=?",
            params![physical(src), agent],
        )?;
        db.execute("UPDATE agent_transfers SET state='completed',updated_at=?,detail='Transferred files and verified the checksum.' WHERE id=?",params![now(),key])?;
    }
    Ok(())
}

async fn complete(
    State(app): State<App>,
    Extension(Identity(machine)): Extension<Identity>,
    Path(key): Path<String>,
    req: Request,
) -> Reply {
    let export = owned(&app.lock(), &machine, &key)?["kind"] == "export-agent";
    let bytes = axum::body::to_bytes(req.into_body(), if export { 32_000_000 } else { 5_000_000 })
        .await
        .map_err(|_| {
            ApiError::new(
                StatusCode::PAYLOAD_TOO_LARGE,
                "Runner completion exceeds its size limit.",
            )
        })?;
    let v: Value =
        serde_json::from_slice(&bytes).map_err(|_| ApiError::bad("Invalid completion."))?;
    let db = app.lock();
    let tx = db.unchecked_transaction()?;
    let command = owned(&tx, &machine, &key)?;
    if command["state"] == "queued" {
        return Err(ApiError::conflict("Command has not been leased."));
    }
    if command["state"] == "leased" {
        let error = v["error"].as_str();
        let result = if let Some(error) = error {
            json!({"error":error,"interrupted":v["interrupted"]==true})
        } else {
            v.get("result")
                .cloned()
                .ok_or_else(|| ApiError::bad("Missing command result."))?
        };
        tx.execute(
            "UPDATE runner_commands SET state=?,result_json=?,finished_at=? WHERE id=?",
            params![
                if error.is_some() {
                    "failed"
                } else {
                    "completed"
                },
                result.to_string(),
                now(),
                key
            ],
        )?;
        let payload: Value = serde_json::from_str(command["payload_json"].as_str().unwrap())?;
        runs::command_done(
            &tx,
            command["kind"].as_str().unwrap(),
            &payload,
            &result,
            error,
        )?;
    }
    tx.commit()?;
    Ok(Json(json!({"ok":true})))
}
