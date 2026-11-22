mod catalog;
mod credentials;
mod files;
mod model;
mod vault;

use crate::{ApiError, App, Reply};
use anyhow::{Context, Result, ensure};
use axum::{
    Json, Router,
    extract::{Path, State},
    routing::{get, post},
};
pub use model::valid_id as valid_agent_id;
use model::{Model, Profile};
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};
pub use vault::control_token;

pub fn init(db: &Connection) -> Result<()> {
    crate::worker_launch::init(db)?;
    db.execute_batch("CREATE TABLE IF NOT EXISTS agents(id TEXT PRIMARY KEY,name TEXT NOT NULL,role TEXT NOT NULL,instructions TEXT NOT NULL,config_json TEXT NOT NULL DEFAULT '{}',updated_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS agent_profiles(id TEXT PRIMARY KEY, revision INTEGER NOT NULL, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS profile_revisions(agent_id TEXT NOT NULL, revision INTEGER NOT NULL, json TEXT NOT NULL, PRIMARY KEY(agent_id,revision));
      CREATE TABLE IF NOT EXISTS workspace_settings(id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS run_profiles(run_id TEXT PRIMARY KEY,agent_id TEXT NOT NULL,revision INTEGER NOT NULL,json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tool_catalogs(agent_id TEXT PRIMARY KEY,json TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS credentials(ref TEXT PRIMARY KEY,label TEXT NOT NULL,provider TEXT NOT NULL DEFAULT '',fingerprint TEXT NOT NULL DEFAULT '',length INTEGER NOT NULL DEFAULT 0,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,last_used_at TEXT);
      CREATE UNIQUE INDEX IF NOT EXISTS credentials_label ON credentials(label COLLATE NOCASE);
      CREATE INDEX IF NOT EXISTS credentials_provider ON credentials(provider);
      CREATE TABLE IF NOT EXISTS native_credential_deletions(ref TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS machine_harness_installations(machine_id TEXT NOT NULL,harness TEXT NOT NULL,command_id TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(machine_id,harness));
      CREATE TABLE IF NOT EXISTS connectors(id TEXT PRIMARY KEY,agent_id TEXT NOT NULL,name TEXT NOT NULL,command TEXT NOT NULL,args_json TEXT NOT NULL DEFAULT '[]',secret_ref TEXT,enabled INTEGER NOT NULL DEFAULT 1,status TEXT NOT NULL DEFAULT 'unchecked',last_error TEXT,updated_at TEXT NOT NULL,UNIQUE(agent_id,name));
      CREATE TABLE IF NOT EXISTS migrations(key TEXT PRIMARY KEY,payload_json TEXT NOT NULL,created_at TEXT NOT NULL);")?;
    let legacy=db.prepare("SELECT id,name,role,instructions,config_json FROM agents WHERE id NOT IN(SELECT id FROM agent_profiles) ORDER BY rowid")?.query_map([],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?,r.get::<_,String>(3)?,r.get::<_,String>(4)?)))?.collect::<rusqlite::Result<Vec<_>>>()?;
    if !legacy.is_empty() {
        let migrated: Option<String> = db
            .query_row(
                "SELECT payload_json FROM migrations WHERE key='browser-v1'",
                [],
                |r| r.get(0),
            )
            .optional()?;
        let saved: Value = serde_json::from_str(migrated.as_deref().unwrap_or("{}"))?;
        for (id, name, role, instructions, config) in legacy {
            let mut value = json!({"id":id,"name":name,"role":role,"instructions":instructions,"config":serde_json::from_str::<Value>(&config)?});
            if let Some(v) = saved["agents"]
                .as_array()
                .and_then(|items| items.iter().find(|v| v["id"] == id))
            {
                for (k, v) in v.as_object().context("Invalid saved agent.")? {
                    if k != "config" {
                        value[k] = v.clone()
                    }
                }
            }
            import(db, &value)?;
        }
    }
    // Preserve old revisions and completed run snapshots. A queued run will observe
    // the new headless revision when it starts, even after another service restart.
    let prior = db.prepare("SELECT json FROM agent_profiles WHERE json_extract(json,'$.computer.access')='direct' OR json_extract(json,'$.computer.desktop') IN ('virtual','existing') OR EXISTS (SELECT 1 FROM json_each(agent_profiles.json,'$.allowedTools') WHERE value='computer_use')")?
        .query_map([],|r|r.get::<_,String>(0))?.collect::<rusqlite::Result<Vec<_>>>()?;
    for raw in prior {
        let mut p = serde_json::from_str::<Profile>(&raw)?.validate(true)?;
        write_revision(db, &mut p)?;
    }
    Ok(())
}
fn get_profile(db: &Connection, id: &str) -> Result<Option<Profile>> {
    let raw: Option<String> = db
        .query_row("SELECT json FROM agent_profiles WHERE id=?1", [id], |r| {
            r.get(0)
        })
        .optional()?;
    raw.map(|s| serde_json::from_str::<Profile>(&s)?.validate(true))
        .transpose()
}
fn profile(db: &Connection, id: &str) -> Result<Profile, ApiError> {
    if !model::valid_id(id) {
        return Err(ApiError::bad("Invalid agent ID."));
    }
    get_profile(db, id)?.ok_or_else(|| ApiError::missing("Agent profile not found."))
}
fn list(db: &Connection) -> Result<Vec<Profile>> {
    let mut statement = db.prepare("SELECT json FROM agent_profiles ORDER BY rowid")?;
    statement
        .query_map([], |r| r.get::<_, String>(0))?
        .map(|r| serde_json::from_str::<Profile>(&r?)?.validate(true))
        .collect()
}
fn defaults(db: &Connection) -> Result<(i64, Model)> {
    let row: Option<(i64, String)> = db
        .query_row(
            "SELECT revision,json FROM workspace_settings WHERE id=1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?;
    match row {
        Some((rev, s)) => Ok((rev, serde_json::from_str(&s)?)),
        None => Ok((0, Model::default())),
    }
}
fn workspace_set(db: &Connection, rev: i64, model: &Model) -> Result<()> {
    db.execute("INSERT INTO workspace_settings VALUES(1,?1,?2) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,json=excluded.json",params![rev+1,serde_json::to_string(&model)?])?;
    Ok(())
}
fn write_revision(db: &Connection, p: &mut Profile) -> Result<()> {
    crate::worker_launch::set_access(
        db,
        &p.id,
        &p.computer.machine_id,
        p.worker_launch,
        &p.harness,
        &p.model_auth,
    )?;
    p.revision += 1;
    let raw = serde_json::to_string(&p)?;
    db.execute("INSERT INTO agent_profiles VALUES(?1,?2,?3) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,json=excluded.json",params![p.id,p.revision,raw])?;
    db.execute(
        "INSERT INTO profile_revisions VALUES(?1,?2,?3)",
        params![p.id, p.revision, raw],
    )?;
    db.execute("INSERT INTO agents(id,name,role,instructions,config_json,updated_at) VALUES(?1,?2,?3,?4,'{}',?5) ON CONFLICT(id) DO UPDATE SET name=excluded.name,role=excluded.role,instructions=excluded.instructions,updated_at=excluded.updated_at",params![p.id,p.name,p.role,p.prompt.text,crate::now()])?;
    Ok(())
}
fn import(db: &Connection, agent: &Value) -> Result<Profile> {
    if let Some(id) = agent["id"].as_str()
        && let Some(p) = get_profile(db, id)?
    {
        return Ok(p);
    }
    let mut p = draft(db, agent)?;
    write_revision(db, &mut p)?;
    Ok(p)
}
fn draft(db: &Connection, agent: &Value) -> Result<Profile> {
    let mut p = Profile::draft(agent)?;
    if agent.get("profile").is_none() {
        let rows=db.prepare("SELECT id,name,command,args_json,secret_ref,enabled FROM connectors WHERE agent_id=?1")?.query_map([&p.id],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?,r.get::<_,String>(2)?,r.get::<_,String>(3)?,r.get::<_,Option<String>>(4)?,r.get::<_,bool>(5)?)))?.collect::<rusqlite::Result<Vec<_>>>()?;
        for (id, name, command, args, reference, enabled) in rows {
            p.connectors.push(model::Connector {
                id,
                name,
                command,
                args: serde_json::from_str(&args)?,
                secret_ref: reference.unwrap_or_default(),
                enabled,
                kind: None,
            });
        }
        p = p.validate(true)?;
    }
    Ok(p)
}
pub fn apply_transfer(db: &Connection, value: &Value) -> Result<()> {
    let mut p: Profile = serde_json::from_value(value.clone())?;
    p.worker_launch = false;
    p = p.validate(false)?;
    let old = get_profile(db, &p.id)?.context("The transferred agent is missing.")?;
    ensure!(
        p.revision == old.revision,
        "The source profile changed during transfer. Its current assignment and files were preserved."
    );
    write_revision(db, &mut p)?;
    Ok(())
}
pub fn snapshot(db: &Connection, agent: &str) -> Result<Value> {
    let p = get_profile(db, agent)?.context("Agent profile not found.")?;
    resolved(db, &p)
}
fn resolved(db: &Connection, p: &Profile) -> Result<Value> {
    let (revision, workspace_model) = defaults(db)?;
    let effective = if p.model.inherit {
        &workspace_model
    } else {
        &p.model.choice
    };
    let mut v = serde_json::to_value(p)?;
    if p.model_auth == "chatgpt-plan" {
        // Transfer validation also resolves proposed destination profiles before assignment.
        let binding = db
            .query_row(
                "SELECT binding FROM worker_plan_bindings WHERE agent_id=? AND machine_id=?",
                params![p.id, crate::machines::physical(&p.computer.machine_id)],
                |r| r.get::<_, String>(0),
            )
            .optional()?;
        v["planBinding"] = json!(binding);
    }
    v["effectiveModel"] = serde_json::to_value(effective)?;
    v["allowedTools"] = json!(p.grants());
    v["workspaceRevision"] = json!(revision);
    Ok(v)
}
pub fn machine(db: &Connection, agent: &str) -> Result<String> {
    Ok(get_profile(db, agent)?
        .context("Agent profile not found.")?
        .computer
        .machine_id)
}
fn selected_refs(snapshot: &Value, include_model: bool) -> BTreeSet<&str> {
    std::iter::once(&snapshot["effectiveModel"]["credentialRef"])
        .filter(|_| include_model && snapshot["modelAuth"] != "chatgpt-plan")
        .chain(
            snapshot["connectors"]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|c| c["enabled"] == true)
                .map(|c| &c["secretRef"]),
        )
        .filter_map(Value::as_str)
        .filter(|r| model::valid_ref(r, 80))
        .collect()
}
fn stored_value<'a>(
    db: &Connection,
    vault: &'a vault::Vault,
    reference: &str,
) -> Result<Option<&'a String>> {
    let deleted: bool = db.query_row(
        "SELECT EXISTS(SELECT 1 FROM native_credential_deletions WHERE ref=?)",
        [reference],
        |r| r.get(0),
    )?;
    Ok(if deleted {
        None
    } else {
        vault.values.get(reference).filter(|v| !v.is_empty())
    })
}
pub fn run_secrets(app: &App, snapshot: &Value) -> Result<BTreeMap<String, String>> {
    let refs = selected_refs(snapshot, true);
    if refs.is_empty() {
        return Ok(BTreeMap::new());
    }
    let db = app.lock();
    let vault = vault::Vault::load(&app.root)?;
    let mut result = BTreeMap::new();
    let stamp = crate::now();
    for reference in refs {
        if let Some(value) = stored_value(&db, &vault, reference)? {
            result.insert(reference.to_owned(), value.clone());
            db.execute(
                "UPDATE credentials SET last_used_at=?1 WHERE ref=?2",
                params![stamp, reference],
            )?;
        }
    }
    Ok(result)
}
pub fn missing_transfer_secrets(
    db: &Connection,
    root: &std::path::Path,
    pending_profile: &Value,
) -> Result<Vec<String>> {
    let pending = serde_json::from_value::<Profile>(pending_profile.clone())?.validate(false)?;
    let snapshot = resolved(db, &pending)?;
    let vault = vault::Vault::load(root)?;
    let mut missing = vec![];
    let terminal = pending.worker_launch && pending.harness == "claude-code";
    for reference in selected_refs(&snapshot, !terminal) {
        if stored_value(db, &vault, reference)?.is_none() {
            missing.push(reference.to_owned());
        }
    }
    Ok(missing)
}
pub fn recover_credentials(db: &Connection, root: &std::path::Path) -> Result<()> {
    let mut vault = vault::Vault::load(root)?;
    let removed = db
        .prepare("SELECT ref FROM native_credential_deletions")?
        .query_map([], |row| row.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    if !removed.is_empty() {
        for key in removed {
            if model::valid_ref(&key, 81) {
                vault.values.remove(&key);
            }
        }
        vault.save()?;
        db.execute("DELETE FROM native_credential_deletions", [])?;
    }
    credentials::adopt(db, &vault)
}
pub fn credential_summary(app: &App) -> Result<Value> {
    let db = app.lock();
    let vault = vault::Vault::load(&app.root)?;
    let rows = credentials::records(&db, &vault)?;
    Ok(
        json!({"credentials":rows,"backend":vault.backend,"secrets":vault.values.keys().filter(|s|model::valid_ref(s,81)).collect::<Vec<_>>() }),
    )
}
pub fn router() -> Router<App> {
    Router::new()
        .route("/v1/agents", get(agents).post(create))
        .route("/v1/agents/sync", post(sync_agents))
        .route("/v1/agents/{id}/profile", get(get_one).put(save))
        .route(
            "/v1/agents/{id}/credential",
            axum::routing::put(select_credential),
        )
        .route("/v1/workspace/model", get(workspace).put(put_workspace))
        .route("/v1/workspace/model/import", post(import_workspace))
        .merge(credentials::router())
        .merge(files::router())
        .merge(catalog::router())
}
async fn agents(State(app): State<App>) -> Reply {
    Ok(Json(
        json!({"agents":list(&app.lock())?.iter().map(Profile::agent).collect::<Vec<_>>()}),
    ))
}
async fn create(
    State(app): State<App>,
    Json(v): Json<Value>,
) -> Result<(axum::http::StatusCode, Json<Value>), ApiError> {
    let db = app.lock();
    let tx = db.unchecked_transaction()?;
    if let Some(raw) = v.get("profile").filter(|v| !v.is_null()) {
        serde_json::from_value::<Profile>(raw.clone())
            .map_err(|e| ApiError::bad(e.to_string()))?
            .validate(false)?;
    }
    let mut p = draft(&tx, &v).map_err(|e| ApiError::bad(e.to_string()))?;
    if get_profile(&tx, &p.id)?.is_some() {
        return Err(ApiError::conflict("This agent ID already exists."));
    }
    if let Some(machine) = v.get("machineId") {
        let machine = machine
            .as_str()
            .filter(|id| model::valid_id(id))
            .ok_or_else(|| ApiError::bad("Choose a valid machine ID."))?;
        let machine = if machine == crate::machines::LOCAL {
            "local"
        } else {
            machine
        };
        if v["profile"].is_object() && p.computer.machine_id != machine {
            return Err(ApiError::bad(
                "The machine ID must match the agent profile.",
            ));
        }
        p.computer.machine_id = machine.to_owned();
    }
    check_assignment(&tx, &p)?;
    files::agent_dir(&app.root, &p.id)?;
    write_revision(&tx, &mut p)?;
    reserve_assignment(&tx, &p)?;
    catalog::queue_install(&tx, &p, false)?;
    tx.commit()?;
    Ok((axum::http::StatusCode::CREATED, Json(p.agent())))
}
async fn sync_agents(State(app): State<App>, Json(v): Json<Value>) -> Reply {
    let db = app.lock();
    let tx = db.unchecked_transaction()?;
    let agents = v["agents"]
        .as_array()
        .ok_or_else(|| ApiError::bad("Expected a list of agents."))?;
    for v in agents {
        let p = import(&tx, v).map_err(|e| ApiError::bad(e.to_string()))?;
        files::agent_dir(&app.root, &p.id)?;
    }
    tx.commit()?;
    Ok(Json(
        json!({"synced":agents.len(),"agents":list(&db)?.iter().map(Profile::agent).collect::<Vec<_>>()}),
    ))
}
fn response(app: &App, db: &Connection, p: &Profile) -> Result<Value> {
    let mut out = json!({"profile":p,"effectiveModel":snapshot(db,&p.id)?["effectiveModel"],"harnessInstallation":catalog::status(db,p)?});
    let live:Option<String>=db.query_row("SELECT rp.json FROM run_profiles rp JOIN runs r ON r.id=rp.run_id WHERE r.agent_id=?1 AND r.state IN ('running','waiting_approval','waiting_input') ORDER BY r.created_at LIMIT 1",[&p.id],|r|r.get(0)).optional()?;
    let active: Value = serde_json::from_str(live.as_deref().unwrap_or("null"))?;
    let machine = crate::machines::info(db, &p.computer.machine_id).ok();
    // A freshly started coordinator can serve the dashboard before its worker pairs.
    let offline = json!({"id":p.computer.machine_id,"status":"offline"});
    out["workerAccess"] =
        crate::worker_launch::status(db, &p.id, machine.as_ref().unwrap_or(&offline))?;
    if let Some(machine) = machine {
        out["machine"] = machine;
    }
    out["activeRevision"] = active["revision"].clone();
    out["pending"] = json!(
        !active.is_null()
            && (active["revision"] != p.revision
                || active["effectiveModel"] != out["effectiveModel"]
                || active["computer"] != out["profile"]["computer"])
    );
    let vault = vault::Vault::load(&app.root)?;
    out["secretNames"] = json!(
        vault
            .values
            .keys()
            .filter(|r| model::valid_ref(r, 81))
            .collect::<Vec<_>>()
    );
    out["credentials"] = json!(credentials::records(db, &vault)?);
    let transfer:Option<(String,Option<String>)>=db.query_row("SELECT state,detail FROM agent_transfers WHERE agent_id=? ORDER BY created_at DESC LIMIT 1",[&p.id],|r|Ok((r.get(0)?,r.get(1)?))).optional()?;
    out["transfer"] = transfer
        .map(|(state, detail)| json!({"state":state,"detail":detail}))
        .unwrap_or(Value::Null);
    Ok(out)
}
async fn get_one(State(app): State<App>, Path(id): Path<String>) -> Reply {
    let db = app.lock();
    Ok(Json(response(&app, &db, &profile(&db, &id)?)?))
}
async fn save(State(app): State<App>, Path(id): Path<String>, Json(v): Json<Value>) -> Reply {
    let mut p: Profile =
        serde_json::from_value(v).map_err(|e| ApiError::bad(format!("Invalid profile: {e}")))?;
    if p.id != id {
        return Err(ApiError::bad("Profile ID does not match this agent."));
    }
    p = p
        .validate(false)
        .map_err(|e| ApiError::bad(e.to_string()))?;
    let db = app.lock();
    let tx = db.unchecked_transaction()?;
    let current = get_profile(&tx, &id)?;
    if p.revision != current.as_ref().map(|v| v.revision).unwrap_or(0) {
        return Err(ApiError::conflict(
            "This profile changed elsewhere. Reload the saved profile before saving again.",
        ));
    }
    let active:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM agent_transfers WHERE agent_id=? AND state IN ('queued','exporting','importing','verifying'))",[&id],|r|r.get(0))?;
    if active {
        return Err(ApiError::conflict(
            "A transfer is in progress for this agent.",
        ));
    }
    check_assignment(&tx, &p)?;
    if let Some(old) = current.filter(|old| old.computer.machine_id != p.computer.machine_id) {
        // The final verified import creates the destination revision. A failed
        // transfer leaves both the source assignment and its revision unchanged.
        crate::machines::stage_transfer(&tx, &id, &serde_json::to_value(&p)?)?;
        catalog::queue_install(&tx, &p, false)?;
        tx.commit()?;
        return Ok(Json(response(&app, &db, &old)?));
    }
    files::agent_dir(&app.root, &p.id)?;
    write_revision(&tx, &mut p)?;
    reserve_assignment(&tx, &p)?;
    catalog::queue_install(&tx, &p, false)?;
    tx.commit()?;
    Ok(Json(response(&app, &db, &p)?))
}

fn check_assignment(db: &Connection, p: &Profile) -> Result<(), ApiError> {
    let target = crate::machines::physical(&p.computer.machine_id);
    let reservation = db
        .query_row(
            "SELECT reserved_agent_id FROM machines WHERE id=? AND revoked_at IS NULL",
            [target],
            |r| r.get::<_, Option<String>>(0),
        )
        .optional()?;
    if target != crate::machines::LOCAL && reservation.is_none() {
        return Err(ApiError::missing("The assigned machine is unavailable."));
    }
    if reservation.flatten().is_some_and(|owner| owner != p.id) {
        return Err(ApiError::conflict(
            "This computer is reserved for another agent.",
        ));
    }
    Ok(())
}

fn reserve_assignment(db: &Connection, p: &Profile) -> Result<()> {
    db.execute("UPDATE machines SET reserved_agent_id=?1 WHERE id=?2 AND (reserved_agent_id IS NULL OR reserved_agent_id=?3)",
        params![p.computer.reserve_machine.then_some(&p.id),crate::machines::physical(&p.computer.machine_id),p.id])?;
    Ok(())
}
async fn select_credential(
    State(app): State<App>,
    Path(id): Path<String>,
    Json(v): Json<Value>,
) -> Reply {
    let db = app.lock();
    let tx = db.unchecked_transaction()?;
    let mut p = profile(&tx, &id)?;
    if v["inherit"] == true {
        p.model.inherit = true;
    } else {
        let r = v["ref"].as_str().unwrap_or("");
        if !r.is_empty()
            && !tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM credentials WHERE ref=?)",
                [r],
                |r| r.get::<_, bool>(0),
            )?
        {
            return Err(ApiError::missing("That credential no longer exists."));
        }
        if p.model.inherit {
            p.model.choice = defaults(&tx)?.1;
        }
        p.model.inherit = false;
        p.model.choice.credential_ref = r.into();
    }
    p = p
        .validate(false)
        .map_err(|e| ApiError::bad(e.to_string()))?;
    write_revision(&tx, &mut p)?;
    tx.commit()?;
    Ok(Json(response(&app, &db, &p)?))
}
async fn workspace(State(app): State<App>) -> Reply {
    let (revision, model) = defaults(&app.lock())?;
    Ok(Json(json!({"model":model,"revision":revision})))
}
fn set_workspace(app: &App, input: &Value, import: bool) -> Reply {
    let db = app.lock();
    let tx = db.unchecked_transaction()?;
    let (rev, old) = defaults(&tx)?;
    if import && rev > 0 {
        return Ok(Json(json!({"model":old,"revision":rev})));
    }
    if !import && input["revision"].as_i64() != Some(rev) {
        return Err(ApiError::conflict(
            "Workspace settings changed elsewhere. Reload before saving.",
        ));
    }
    let value: Model =
        serde_json::from_value(input["model"].clone()).map_err(|e| ApiError::bad(e.to_string()))?;
    value.validate().map_err(|e| ApiError::bad(e.to_string()))?;
    workspace_set(&tx, rev, &value)?;
    tx.commit()?;
    Ok(Json(json!({"model":value,"revision":rev+1})))
}
async fn put_workspace(State(app): State<App>, Json(input): Json<Value>) -> Reply {
    set_workspace(&app, &input, false)
}
async fn import_workspace(State(app): State<App>, Json(input): Json<Value>) -> Reply {
    set_workspace(&app, &input, true)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::os::unix::fs::PermissionsExt;

    #[test]
    fn all_harnesses_require_headless_snapshots_and_keep_saved_grants() -> Result<()> {
        let db = Connection::open_in_memory()?;
        init(&db)?;
        for harness in ["hermes", "claude-code", "codex"] {
            let draft = json!({"id":harness,"name":harness,"harness":harness,"instructions":"Persist this."});
            let p = import(&db, &draft)?;
            assert_eq!(p.revision, 1);
            let snapshot = snapshot(&db, harness)?;
            assert_eq!(snapshot["computer"]["desktop"], "none");
            assert_eq!(snapshot["computer"]["access"], "private");
            assert!(
                !snapshot["allowedTools"]
                    .as_array()
                    .unwrap()
                    .contains(&json!("computer_use"))
            );
            let mut bad = p.clone();
            bad.computer.desktop = "virtual".into();
            assert!(bad.validate(false).is_err());
            let mut direct = p;
            direct.computer.access = "direct".into();
            assert!(direct.validate(false).is_err());
        }
        let mut p = profile(&db, "hermes")?;
        p.allowed_tools = vec![
            "mcp_open_harness_task".into(),
            "mcp_ghost_unconfigured".into(),
            "read_file".into(),
        ];
        let p = p.validate(false)?;
        assert_eq!(p.grants(), vec![model::TASK, "read_file"]);
        Ok(())
    }

    #[test]
    fn upgrading_in_a_transaction_keeps_old_revisions_and_migrates_desktop_once() -> Result<()> {
        let db = Connection::open_in_memory()?;
        init(&db)?;
        db.execute(
            "INSERT INTO agents VALUES('old','Old','Reviewer','Remember','{}','then')",
            [],
        )?;
        let tx = db.unchecked_transaction()?;
        init(&tx)?;
        tx.commit()?;
        let mut p = profile(&db, "old")?;
        assert_eq!(p.prompt.text, "Remember");
        p.computer.access = "direct".into();
        p.computer.desktop = "existing".into();
        p.allowed_tools = vec!["read_file".into(), "computer_use".into()];
        let raw = serde_json::to_string(&p)?;
        db.execute("UPDATE agent_profiles SET json=? WHERE id='old'", [&raw])?;
        db.execute(
            "UPDATE profile_revisions SET json=? WHERE agent_id='old'",
            [&raw],
        )?;
        db.execute(
            "INSERT INTO run_profiles VALUES('historic','old',1,?)",
            [&raw],
        )?;
        let tx = db.unchecked_transaction()?;
        init(&tx)?;
        tx.commit()?;
        init(&db)?;
        let p = profile(&db, "old")?;
        assert_eq!(p.revision, 2);
        assert_eq!(p.computer.access, "private");
        assert_eq!(p.computer.desktop, "none");
        assert_eq!(p.grants(), vec!["read_file", model::TASK]);
        let old: String = db.query_row(
            "SELECT json FROM run_profiles WHERE run_id='historic'",
            [],
            |r| r.get(0),
        )?;
        assert_eq!(raw, old);
        let count: i64 = db.query_row(
            "SELECT COUNT(*) FROM profile_revisions WHERE agent_id='old'",
            [],
            |r| r.get(0),
        )?;
        assert_eq!(count, 2);
        Ok(())
    }

    #[test]
    fn verified_transfer_creates_a_revision_and_rejects_a_stale_source() -> Result<()> {
        let db = Connection::open_in_memory()?;
        init(&db)?;
        let original = import(&db, &json!({"id":"worker","name":"Worker"}))?;
        let mut desired = serde_json::to_value(&original)?;
        desired["computer"]["machineId"] = json!("machine-other");
        let mut edited = original.clone();
        edited.prompt.text = "another editor changed this".into();
        write_revision(&db, &mut edited)?;
        assert!(apply_transfer(&db, &desired).is_err());
        assert_eq!(machine(&db, "worker")?, "local");
        desired = serde_json::to_value(&edited)?;
        desired["computer"]["machineId"] = json!("machine-other");
        apply_transfer(&db, &desired)?;
        let applied = profile(&db, "worker")?;
        assert_eq!(applied.revision, edited.revision + 1);
        assert_eq!(applied.computer.machine_id, "machine-other");
        assert_eq!(applied.prompt.text, edited.prompt.text);
        let old: String = db.query_row(
            "SELECT json FROM profile_revisions WHERE agent_id=? AND revision=?",
            params![edited.id, edited.revision],
            |r| r.get(0),
        )?;
        assert_eq!(
            serde_json::from_str::<Value>(&old)?["computer"]["machineId"],
            "local"
        );
        Ok(())
    }

    #[test]
    fn transfers_validate_only_missing_destination_credentials() -> Result<()> {
        let root = tempfile::tempdir()?;
        let db = Connection::open_in_memory()?;
        init(&db)?;
        vault::atomic(&root.path().join("secrets.backend"), b"file")?;
        vault::atomic(&root.path().join("secrets.json"),br#"{"controlToken":"test","SAVED_KEY":"available","DELETED_KEY":"pending vault erase"}"#)?;
        db.execute(
            "INSERT INTO native_credential_deletions VALUES('DELETED_KEY')",
            [],
        )?;
        let mut p = Profile::draft(&json!({"id":"test","name":"Test"}))?;
        let model = Model {
            credential_ref: "DEST_MODEL".into(),
            ..Model::default()
        };
        workspace_set(&db, 0, &model)?;
        for (name, reference, enabled) in [
            ("first", "SAVED_KEY", true),
            ("second", "DEST_CONNECTOR", true),
            ("same", "DEST_MODEL", true),
            ("deleted", "DELETED_KEY", true),
            ("disabled", "OFF_KEY", false),
        ] {
            p.connectors.push(super::model::Connector {
                id: name.into(),
                name: name.into(),
                args: vec![],
                command: "fixture".into(),
                secret_ref: reference.into(),
                enabled,
                kind: None,
            });
        }
        assert_eq!(
            missing_transfer_secrets(&db, root.path(), &serde_json::to_value(&p)?)?,
            vec!["DELETED_KEY", "DEST_CONNECTOR", "DEST_MODEL"]
        );
        p.model.inherit = false;
        p.model.choice.credential_ref = "SAVED_KEY".into();
        p.connectors.clear();
        assert!(missing_transfer_secrets(&db, root.path(), &serde_json::to_value(&p)?)?.is_empty());
        let mut claude =
            Profile::draft(&json!({"id":"editor","name":"Editor","harness":"claude-code"}))?;
        assert_eq!(
            missing_transfer_secrets(&db, root.path(), &serde_json::to_value(&claude)?)?,
            vec!["ANTHROPIC_API_KEY"]
        );
        claude.worker_launch = true;
        let pending = serde_json::to_value(&claude)?;
        assert!(missing_transfer_secrets(&db, root.path(), &pending)?.is_empty());
        assert!(selected_refs(&resolved(&db, &claude)?, true).contains("ANTHROPIC_API_KEY"));
        Ok(())
    }

    #[test]
    fn credential_metadata_adopts_references_without_exposing_values_or_control_token() -> Result<()>
    {
        let dir = tempfile::tempdir()?;
        let root = dir.path();
        vault::atomic(&root.join("secrets.backend"), b"file")?;
        vault::atomic(&root.join("secrets.json"),br#"{"controlToken":"existing-token","OPENAI_API_KEY":"existing-key","SLACK_BOT_TOKEN":"xoxb-muted"}"#)?;
        assert_eq!(control_token(root)?, "existing-token");
        let db = Connection::open_in_memory()?;
        db.execute_batch(include_str!("schema.sql"))?;
        init(&db)?;
        let mut p = Profile::draft(&json!({"id":"hermes","name":"Hermes"}))?;
        p.model.inherit = false;
        p.model.choice.credential_ref = "OPENAI_API_KEY".into();
        write_revision(&db, &mut p)?;
        let vault = vault::Vault::load(root)?;
        let meta = credentials::records(&db, &vault)?;
        assert_eq!(meta.len(), 2);
        let openai = meta.iter().find(|m| m["ref"] == "OPENAI_API_KEY").unwrap();
        assert_eq!(openai["usage"]["agentCount"], 1);
        assert!(openai["fingerprint"].as_str().unwrap().len() == 6);
        let json = serde_json::to_string(&meta)?;
        for s in [
            "existing-key",
            "existing-token",
            "controlToken",
            "xoxb-muted",
        ] {
            assert!(!json.contains(s))
        }
        let snapshot = snapshot(&db, "hermes")?;
        assert_eq!(
            snapshot["effectiveModel"]["credentialRef"],
            "OPENAI_API_KEY"
        );
        assert_eq!(
            fs::metadata(root.join("secrets.json"))?
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
        Ok(())
    }
}
