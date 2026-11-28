use super::{
    credentials,
    model::{Connector, Model, Profile},
    profile, response,
    vault::Vault,
};
use crate::{ApiError, App, Reply, machines};
use anyhow::{Context, Result, ensure};
use axum::{
    Json, Router,
    extract::{Path, State},
    routing::{get, post},
};
use open_harness_runner::harnesses as registry;
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Value, json};
use std::{collections::BTreeMap, time::Duration};

pub(super) fn router() -> Router<App> {
    Router::new()
        .route("/v1/harnesses", get(harnesses))
        .route("/v1/onboarding/model-test", post(onboarding_model))
        .route("/v1/machines/{id}/secrets", get(machine_secrets))
        .route("/v1/agents/{id}/harness", get(super::get_one).post(install))
        .route("/v1/agents/{id}/tools", get(tools))
        .route("/v1/agents/{id}/models", get(models))
        .route("/v1/agents/{id}/connection-check", post(connection))
        .route("/v1/agents/{id}/connector-check", post(connector))
}
async fn harnesses() -> Json<Value> {
    let entries: Vec<Value> = registry::HARNESSES
        .iter()
        .map(|harness| {
            let mut entry = json!({"id":harness.id,"name":harness.name,"description":harness.description,"headless":true});
            if registry::is_additional(harness.id) {
                entry["modelProviders"] = json!(registry::MODEL_PROVIDERS);
            }
            entry
        })
        .collect();
    Json(json!({"harnesses":entries}))
}
pub(super) fn status(db: &Connection, p: &Profile) -> Result<Value> {
    let machine = &p.computer.machine_id;
    if registry::is_additional(&p.harness)
        && let Ok(assigned) = machines::info(db, machine)
        && let Some(detail) = machines::harness_upgrade(&assigned, &p.harness)
    {
        return Ok(
            json!({"harness":p.harness,"state":"failed","detail":detail,"updatedAt":"","workerUpgradeRequired":true}),
        );
    }
    let row:Option<(String,Option<String>,String)>=db.query_row("SELECT c.state,c.result_json,h.updated_at FROM machine_harness_installations h JOIN runner_commands c ON h.command_id=c.id WHERE h.machine_id=?1 AND h.harness=?2",params![machine,p.harness],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional()?;
    let (state, mut detail, stamp) = match row {
        Some((state, raw, stamp)) => {
            let result: Value = serde_json::from_str(raw.as_deref().unwrap_or("null"))?;
            let (s, d) = match state.as_str() {
                "completed" => ("ready", "The headless harness is installed."),
                "leased" => (
                    "installing",
                    "Preparing the headless harness on its assigned computer.",
                ),
                "queued" => ("queued", "Installation is queued on the assigned computer."),
                _ => (
                    "failed",
                    result["error"]
                        .as_str()
                        .unwrap_or("The harness could not be installed."),
                ),
            };
            (s, d.to_owned(), stamp)
        }
        None => (
            "not-installed",
            "Install this harness on the assigned computer.".into(),
            String::new(),
        ),
    };
    if crate::mock_mode() && state == "ready" {
        detail = "Mock harness is ready.".into();
    }
    Ok(json!({"harness":p.harness,"state":state,"detail":detail,"updatedAt":stamp}))
}
pub(super) fn queue_install(db: &Connection, p: &Profile, retry: bool) -> Result<()> {
    let prior = status(db, p)?;
    if prior["workerUpgradeRequired"] == true
        || matches!(prior["state"].as_str(), Some("queued" | "installing"))
        || (prior["state"] == "ready" && !retry)
    {
        return Ok(());
    }
    let cmd = machines::enqueue(
        db,
        &p.computer.machine_id,
        Some(&p.id),
        "install-harness",
        &json!({"harness":p.harness}),
    )?;
    db.execute("INSERT INTO machine_harness_installations VALUES(?,?,?,?) ON CONFLICT(machine_id,harness) DO UPDATE SET command_id=excluded.command_id,updated_at=excluded.updated_at",params![p.computer.machine_id,p.harness,cmd,crate::now()])?;
    Ok(())
}
async fn install(State(app): State<App>, Path(id): Path<String>) -> Reply {
    let db = app.lock();
    let tx = db.unchecked_transaction()?;
    let p = profile(&tx, &id)?;
    queue_install(&tx, &p, true)?;
    tx.commit()?;
    Ok(Json(response(&app, &db, &p)?))
}
fn cli_tools(harness: &str) -> Value {
    let definition = registry::find(harness);
    let ids = definition.map_or(&[][..], |item| item.tool_ids);
    let tools = ids
        .iter()
        .copied()
        .map(|id| {
            let (name, group, description) = match id {
                "terminal" => (
                    "Terminal",
                    "terminal",
                    "Run commands in this agent’s container.",
                ),
                "read_file" => ("Read files", "files", "Read workspace files."),
                "write_file" => ("Write files", "files", "Create workspace files."),
                "patch" => ("Edit files", "files", "Edit workspace files."),
                "search_files" => ("Search files", "files", "Search workspace files."),
                "web_search" => ("Web search", "web", "Search the web."),
                _ => ("Read web pages", "web", "Retrieve a web page."),
            };
            json!({"id":id,"name":name,"group":group,"description":description,"available":true})
        })
        .collect::<Vec<_>>();
    let mut catalog = json!({"source":"runtime","tools":tools});
    if let Some(definition) = definition.filter(|item| !item.tool_group.is_empty()) {
        catalog["toolGrantGroup"] = json!(definition.tool_group);
    }
    catalog
}
async fn probe(
    app: &App,
    p: &Profile,
    kind: &str,
    input: Value,
    mut keys: BTreeMap<String, String>,
) -> Result<Value> {
    let key = {
        let db = app.lock();
        ensure!(
            machines::info(&db, &p.computer.machine_id)?["status"] == "online",
            "The assigned computer is offline."
        );
        let mut snapshot = serde_json::to_value(p)?;
        let (_, default) = super::defaults(&db)?;
        snapshot["effectiveModel"] = serde_json::to_value(if p.model.inherit {
            &default
        } else {
            &p.model.choice
        })?;
        let action = input["action"].as_str();
        let model_ref = snapshot["effectiveModel"]["credentialRef"]
            .as_str()
            .unwrap_or("")
            .to_owned();
        // Inventory is available before a provider is configured. A probe should receive
        // only credentials used by that particular inventory or connection check.
        if action == Some("mcp") || !keys.contains_key(&model_ref) {
            snapshot["effectiveModel"]["credentialRef"] = json!("");
        }
        let mut selected = std::collections::HashSet::<String>::new();
        if let Some(r) = snapshot["effectiveModel"]["credentialRef"]
            .as_str()
            .filter(|r| !r.is_empty())
        {
            selected.insert(r.into());
        }
        for conn in snapshot["connectors"]
            .as_array_mut()
            .context("Invalid probe profile.")?
        {
            let r = conn["secretRef"].as_str().unwrap_or("");
            if kind == "probe-tools"
                && conn["enabled"] == true
                && (r.is_empty() || keys.contains_key(r))
            {
                selected.insert(r.into());
            } else {
                conn["enabled"] = json!(false);
            }
        }
        if let Some(r) = input["secretRef"].as_str() {
            selected.insert(r.into());
        }
        keys.retain(|r, _| selected.contains(r));
        snapshot["allowedTools"]
            .as_array_mut()
            .context("Invalid tool selection.")?
            .retain(|v| {
                !v.as_str()
                    .is_some_and(|s| s.starts_with("mcp__open_harness__"))
            });
        let encrypted = machines::seal(&db, &p.computer.machine_id, &keys)?;
        machines::enqueue(
            &db,
            &p.computer.machine_id,
            Some(&p.id),
            kind,
            &json!({"profile":snapshot,"input":input,"encryptedSecrets":encrypted,"coordinationToken":""}),
        )?
    };
    let wait = async {
        loop {
            let (state, result): (String, Option<String>) = app.lock().query_row(
                "SELECT state,result_json FROM runner_commands WHERE id=?",
                [&key],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )?;
            if state == "completed" || state == "failed" {
                let result: Value = serde_json::from_str(result.as_deref().unwrap_or("{}"))?;
                ensure!(
                    state == "completed",
                    "{}",
                    result["error"]
                        .as_str()
                        .unwrap_or("The worker could not complete this check.")
                );
                return Ok(result);
            }
            tokio::time::sleep(Duration::from_millis(150)).await;
        }
    };
    tokio::time::timeout(Duration::from_secs(50), wait)
        .await
        .context("The worker did not complete the check in time.")?
}
fn selected(app: &App, p: &Profile) -> Result<BTreeMap<String, String>> {
    let snapshot = {
        let db = app.lock();
        super::snapshot(&db, &p.id)?
    };
    super::run_secrets(app, &snapshot)
}
fn cached(db: &Connection, id: &str) -> Result<Value> {
    let raw: Option<String> = db
        .query_row(
            "SELECT json FROM tool_catalogs WHERE agent_id=?",
            [id],
            |r| r.get(0),
        )
        .optional()?;
    Ok(serde_json::from_str(
        raw.as_deref().unwrap_or("{\"tools\":[]}"),
    )?)
}
fn cache(db: &Connection, id: &str, value: &Value) -> Result<()> {
    db.execute("INSERT INTO tool_catalogs(agent_id,json) VALUES(?,?) ON CONFLICT(agent_id) DO UPDATE SET json=excluded.json",params![id,value.to_string()])?;
    Ok(())
}
async fn tools(State(app): State<App>, Path(id): Path<String>) -> Reply {
    let p = profile(&app.lock(), &id)?;
    if p.harness != "hermes" {
        return Ok(Json(cli_tools(&p.harness)));
    }
    let keys = selected(&app, &p)?;
    let result = probe(&app, &p, "probe-tools", Value::Null, keys).await;
    let db = app.lock();
    let old = cached(&db, &id)?;
    let mut v = match result {
        Ok(v) if v["source"] != "unavailable" && v["tools"].is_array() => v,
        error => {
            let message = match error {
                Ok(v) => v["error"].as_str().unwrap_or("Tools unavailable.").into(),
                Err(e) => e.to_string(),
            };
            let mut saved = old["tools"].as_array().cloned().unwrap_or_default();
            saved.retain(|t| t["id"] != "computer_use");
            for t in &mut saved {
                t["available"] = json!(false);
                t["reason"] = json!(message);
            }
            return Ok(Json(
                json!({"tools":saved,"source":if saved.is_empty(){"unavailable"}else{"cached"},"error":message}),
            ));
        }
    };
    let items = v["tools"].as_array_mut().unwrap();
    for t in old["tools"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|t| t["group"] == "mcp")
    {
        if !items.iter().any(|n| n["id"] == t["id"]) {
            let mut t = t.clone();
            t["available"] = json!(false);
            t["reason"] = json!("Test this connection again to confirm availability.");
            items.push(t);
        }
    }
    cache(&db, &id, &v)?;
    Ok(Json(v))
}
async fn models(State(app): State<App>, Path(id): Path<String>) -> Reply {
    let p = profile(&app.lock(), &id)?;
    if p.harness != "hermes" {
        return Ok(Json(
            json!({"models":[],"error":"Enter a model ID supported by this harness."}),
        ));
    }
    let keys = selected(&app, &p)?;
    Ok(Json(
        probe(&app, &p, "probe-models", Value::Null, keys)
            .await
            .unwrap_or_else(|e| json!({"models":[],"error":e.to_string()})),
    ))
}
async fn connection(State(app): State<App>, Path(id): Path<String>, Json(v): Json<Value>) -> Reply {
    let mut p = profile(&app.lock(), &id)?;
    let model: Model =
        serde_json::from_value(v["model"].clone()).map_err(|e| ApiError::bad(e.to_string()))?;
    model.validate()?;
    if p.harness != "hermes" {
        return Ok(Json(
            json!({"ok":false,"message":"This harness checks model authentication when a task starts."}),
        ));
    }
    let vault = Vault::load(&app.root)?;
    let mut keys = BTreeMap::new();
    if !model.credential_ref.is_empty() {
        let Some(secret) = vault.values.get(&model.credential_ref) else {
            return Ok(Json(
                json!({"ok":false,"message":format!("Add the {} credential first.",model.credential_ref)}),
            ));
        };
        keys.insert(model.credential_ref.clone(), secret.clone());
    }
    if crate::mock_mode() {
        return Ok(Json(
            json!({"ok":true,"message":"Deterministic test connection is ready."}),
        ));
    }
    let base = endpoint(&model);
    if base.is_empty() {
        return Ok(Json(
            json!({"ok":false,"message":"This provider checks authentication when a task starts."}),
        ));
    }
    let input = json!({"action":"connection","baseUrl":base,"credentialRef":model.credential_ref});
    p.model.inherit = false;
    p.model.choice = model;
    Ok(Json(
        probe(&app, &p, "probe-runtime", input, keys)
            .await
            .unwrap_or_else(|e| json!({"ok":false,"message":e.to_string()})),
    ))
}
async fn connector(State(app): State<App>, Path(id): Path<String>, Json(v): Json<Value>) -> Reply {
    let mut p = profile(&app.lock(), &id)?;
    let conn: Connector =
        serde_json::from_value(v["connector"].clone()).map_err(|e| ApiError::bad(e.to_string()))?;
    p.connectors = vec![conn];
    p = p.validate(false)?;
    let conn = &p.connectors[0];
    let mut keys = BTreeMap::new();
    if !conn.secret_ref.is_empty() {
        let vault = Vault::load(&app.root)?;
        let Some(value) = vault.values.get(&conn.secret_ref) else {
            return Ok(Json(
                json!({"status":"missing_credentials","error":format!("Add secret {}.",conn.secret_ref),"tools":[]}),
            ));
        };
        keys.insert(conn.secret_ref.clone(), value.clone());
    }
    let result = if conn.kind.as_deref() == Some("slack") {
        let check =
            credentials::slack_check(keys.get(&conn.secret_ref).map(String::as_str).unwrap_or(""))
                .await;
        if check["ok"] != true {
            return Ok(Json(
                json!({"status":"failed","error":check["message"],"tools":[]}),
            ));
        }
        json!({"status":"authenticated","message":check["message"],"tools":[{"name":"list_channels","description":"List visible Slack channels."},{"name":"read_channel","description":"Read messages in a Slack channel."},{"name":"send_message","description":"Post a message to Slack."}]})
    } else {
        let input = json!({"action":"mcp","command":conn.command,"args":conn.args,"secretRef":conn.secret_ref});
        match probe(&app, &p, "probe-runtime", input, keys).await {
            Ok(v) => v,
            Err(e) => {
                return Ok(Json(
                    json!({"status":"failed","tools":[],"error":e.to_string()}),
                ));
            }
        }
    };
    let mut result = result;
    let prefix = format!("mcp__{}__", conn.name);
    let tools=result["tools"].as_array().into_iter().flatten().filter_map(|t|{
        let name=t["name"].as_str()?;Some(json!({"id":format!("{prefix}{name}"),"name":name,"description":t["description"],"group":"mcp","available":true}))
    }).collect::<Vec<_>>();
    let db = app.lock();
    let mut old = cached(&db, &id)?;
    let items = old["tools"]
        .as_array_mut()
        .context("Invalid stored tool catalog.")?;
    items.retain(|t| !t["id"].as_str().is_some_and(|id| id.starts_with(&prefix)));
    items.extend(tools.clone());
    cache(&db, &id, &old)?;
    result["tools"] = json!(tools);
    Ok(Json(result))
}

fn endpoint(model: &Model) -> &str {
    if !model.base_url.is_empty() {
        model.base_url.as_str()
    } else {
        match model.provider.as_str() {
            "openai" => "https://api.openai.com/v1",
            "xai" => "https://api.x.ai/v1",
            "openrouter" => "https://openrouter.ai/api/v1",
            _ => "",
        }
    }
}
async fn machine_secrets(State(app): State<App>, Path(id): Path<String>) -> Reply {
    machines::info(&app.lock(), &id).map_err(|_| ApiError::missing("Computer not found."))?;
    let mut summary = super::credential_summary(&app)?;
    summary["storage"] = json!("coordinator");
    Ok(Json(summary))
}
async fn onboarding_model(State(app): State<App>, Json(input): Json<Value>) -> Reply {
    let model: Model =
        serde_json::from_value(input["model"].clone()).map_err(|e| ApiError::bad(e.to_string()))?;
    model.validate()?;
    if crate::mock_mode() {
        return Ok(Json(
            json!({"ok":true,"message":"Model connection is ready."}),
        ));
    }
    let base = endpoint(&model).trim_end_matches('/');
    if base.is_empty() {
        return Ok(Json(
            json!({"ok":false,"message":"Enter the address of your model server."}),
        ));
    }
    let key = if model.credential_ref.is_empty() {
        None
    } else {
        let vault = Vault::load(&app.root)?;
        let Some(key) = vault.values.get(&model.credential_ref).cloned() else {
            return Ok(Json(
                json!({"ok":false,"message":"Save your API key first."}),
            ));
        };
        Some(key)
    };
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| ApiError::bad("Could not open the model connection."))?;
    let mut request = client.get(format!("{base}/models"));
    if let Some(key) = key {
        request = request.bearer_auth(key);
    }
    let message = match request.send().await {
        Ok(response) if response.status().is_success() => {
            return Ok(Json(
                json!({"ok":true,"message":"Model connection is ready."}),
            ));
        }
        Ok(response) => match response.status().as_u16() {
            401 => "The API key was rejected.".into(),
            403 => "The provider denied access.".into(),
            404 => "The model server address was not found.".into(),
            429 => "The provider rate limit was reached. Try again shortly.".into(),
            n => format!("The provider returned HTTP {n}."),
        },
        Err(_) => "Could not reach the model provider.".into(),
    };
    Ok(Json(json!({"ok":false,"message":message})))
}
