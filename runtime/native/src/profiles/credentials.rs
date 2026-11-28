use super::{defaults, list, model::valid_ref, vault::Vault, workspace_set, write_revision};
use crate::{ApiError, App, Reply, now};
use anyhow::{Context, Result, ensure};
use axum::{
    Json, Router,
    extract::{Path, Query, State},
    http::StatusCode,
    routing::{get, post},
};
use openssl::{hash::MessageDigest, pkey::PKey, sign::Signer};
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};

fn known(reference: &str) -> (&'static str, String) {
    let (provider, label) = match reference {
        "XAI_API_KEY" => ("xai", "xAI API key"),
        "OPENAI_API_KEY" => ("openai", "OpenAI API key"),
        "OPENROUTER_API_KEY" => ("openrouter", "OpenRouter API key"),
        "ANTHROPIC_API_KEY" => ("anthropic", "Anthropic API key"),
        "SLACK_BOT_TOKEN" => ("slack", "Slack bot token"),
        "MODEL_API_KEY" => ("", "Model API key"),
        _ => ("", ""),
    };
    if !label.is_empty() {
        return (provider, label.into());
    }
    let mut s = reference.to_ascii_lowercase().replace('_', " ");
    if let Some(first) = s.get_mut(0..1) {
        first.make_ascii_uppercase();
    }
    (provider, s)
}
fn fingerprint(vault: &Vault, value: &str) -> Result<String> {
    let key = PKey::hmac(
        vault
            .values
            .get("controlToken")
            .context("Workspace credentials are unavailable.")?
            .as_bytes(),
    )?;
    let mut signer = Signer::new(MessageDigest::sha256(), &key)?;
    signer.update(value.as_bytes())?;
    Ok(signer.sign_to_vec()?[..3]
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect())
}
fn taken(db: &Connection, label: &str, except: &str) -> Result<bool> {
    Ok(db.query_row(
        "SELECT EXISTS(SELECT 1 FROM credentials WHERE label=?1 COLLATE NOCASE AND ref!=?2)",
        [label, except],
        |r| r.get(0),
    )?)
}
fn has(db: &Connection, reference: &str) -> Result<bool> {
    Ok(db.query_row(
        "SELECT EXISTS(SELECT 1 FROM credentials WHERE ref=?)",
        [reference],
        |r| r.get(0),
    )?)
}
pub(super) fn adopt(db: &Connection, vault: &Vault) -> Result<()> {
    let stamp = now();
    for (reference, value) in vault.values.iter().filter(|(r, _)| valid_ref(r, 81)) {
        if db.query_row(
            "SELECT EXISTS(SELECT 1 FROM native_credential_deletions WHERE ref=?)",
            [reference],
            |r| r.get::<_, bool>(0),
        )? {
            continue;
        }
        let fp = fingerprint(vault, value)?;
        if has(db, reference)? {
            db.execute(
                "UPDATE credentials SET fingerprint=?,length=? WHERE ref=? AND fingerprint<>?",
                params![fp, value.encode_utf16().count(), reference, fp],
            )?;
            continue;
        }
        let (provider, label) = known(reference);
        let base = label.chars().take(55).collect::<String>();
        let mut label = base.clone();
        let mut n = 2;
        while taken(db, &label, "")? {
            label = format!("{base} {n}");
            n += 1;
        }
        db.execute(
            "INSERT INTO credentials VALUES(?,?,?,?,?,?,?,NULL)",
            params![
                reference,
                label,
                provider,
                fp,
                value.encode_utf16().count(),
                stamp,
                stamp
            ],
        )?;
    }
    Ok(())
}
fn usage(db: &Connection, reference: &str) -> Result<Value> {
    let mut uses = vec![];
    let mut agents = HashSet::new();
    if defaults(db)?.1.credential_ref == reference {
        uses.push(json!({"kind":"workspace-default"}));
    }
    for p in list(db)? {
        if !p.model.inherit && p.model.choice.credential_ref == reference {
            uses.push(json!({"kind":"agent-model","agentId":p.id,"agentName":p.name}));
            agents.insert(p.id.clone());
        }
        for c in p.connectors.iter().filter(|c| c.secret_ref == reference) {
            let mut v = json!({"kind":"agent-connector","agentId":p.id,"agentName":p.name,"connectorName":c.name,"enabled":c.enabled});
            if c.kind.as_deref() == Some("slack") {
                v["connectorKind"] = json!("slack");
            }
            uses.push(v);
            agents.insert(p.id.clone());
        }
    }
    let active:i64=db.query_row("SELECT COUNT(*) FROM run_profiles rp JOIN runs r ON r.id=rp.run_id WHERE r.state IN ('running','waiting_approval','waiting_input') AND (json_extract(rp.json,'$.effectiveModel.credentialRef')=?1 OR EXISTS(SELECT 1 FROM json_each(rp.json,'$.connectors') c WHERE json_extract(c.value,'$.enabled') AND json_extract(c.value,'$.secretRef')=?1))",[reference],|r|r.get(0))?;
    Ok(json!({"uses":uses,"agentCount":agents.len(),"activeRuns":active}))
}
fn meta(db: &Connection, reference: &str) -> Result<Option<Value>> {
    Ok(db.query_row("SELECT ref,label,provider,fingerprint,length,created_at,updated_at,last_used_at FROM credentials WHERE ref=?",[reference],|r|Ok(json!({"ref":r.get::<_,String>(0)?,"label":r.get::<_,String>(1)?,"provider":r.get::<_,String>(2)?,"fingerprint":r.get::<_,String>(3)?,"length":r.get::<_,u64>(4)?,"createdAt":r.get::<_,String>(5)?,"updatedAt":r.get::<_,String>(6)?,"lastUsedAt":r.get::<_,Option<String>>(7)?}))).optional()?)
}
fn record(db: &Connection, vault: &Vault, reference: &str) -> Result<Value, ApiError> {
    let mut m = meta(db, reference)?
        .ok_or_else(|| ApiError::missing("That credential no longer exists."))?;
    m["present"] = json!(vault.values.get(reference).is_some_and(|v| !v.is_empty()));
    m["usage"] = usage(db, reference)?;
    Ok(m)
}
pub(super) fn records(db: &Connection, vault: &Vault) -> Result<Vec<Value>> {
    adopt(db, vault)?;
    let refs = db
        .prepare("SELECT ref FROM credentials ORDER BY label COLLATE NOCASE")?
        .query_map([], |r| r.get::<_, String>(0))?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    refs.iter().map(|s| Ok(record(db, vault, s)?)).collect()
}
fn check_provider(s: &str) -> Result<()> {
    ensure!(
        s.is_empty()
            || (s.len() <= 100
                && s.bytes()
                    .next()
                    .is_some_and(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
                && s.bytes().all(|b| b.is_ascii_lowercase()
                    || b.is_ascii_digit()
                    || matches!(b, b'-' | b'_'))),
        "Invalid provider."
    );
    Ok(())
}
fn label(db: &Connection, label: &str, except: &str) -> Result<String, ApiError> {
    let label = label.trim();
    if label.is_empty() || label.encode_utf16().count() > 60 {
        return Err(ApiError::bad(
            "Give this credential a name of up to 60 characters.",
        ));
    }
    if taken(db, label, except)? {
        return Err(ApiError::conflict(
            "Another credential already uses that name.",
        ));
    }
    Ok(label.to_owned())
}
fn checked_value(provider: &str, s: &str) -> Result<String, ApiError> {
    if s.trim().is_empty() || s.encode_utf16().count() > 10000 {
        return Err(ApiError::bad(
            "Paste a credential value of up to 10000 characters.",
        ));
    }
    if provider == "slack" {
        let s = s.trim();
        if !s
            .strip_prefix("xoxe.")
            .unwrap_or(s)
            .strip_prefix("xoxb-")
            .is_some_and(|v| {
                !v.is_empty() && v.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
            })
        {
            return Err(ApiError::bad(
                "Paste a Slack bot token beginning with xoxb- or xoxe.xoxb-.",
            ));
        }
        return Ok(s.to_owned());
    }
    Ok(s.to_owned())
}
fn generate_ref(db: &Connection, vault: &Vault, label: &str) -> Result<String> {
    let mut head = String::new();
    for c in label.chars().take(100) {
        if c.is_ascii_alphanumeric() {
            head.push(c.to_ascii_uppercase())
        } else if !head.is_empty() && !head.ends_with('_') {
            head.push('_')
        }
    }
    let head = head.trim_matches('_').chars().take(56).collect::<String>();
    let seed = if head.is_empty() {
        "CREDENTIAL".into()
    } else if !valid_ref(&head, 56) {
        format!("KEY_{head}")
    } else {
        head
    };
    for n in 1..1000 {
        let s = if n == 1 {
            seed.clone()
        } else {
            format!("{seed}_{n}")
        };
        if !has(db, &s)? && !vault.values.contains_key(&s) {
            return Ok(s);
        }
    }
    anyhow::bail!("Choose a more distinct credential name.")
}
pub(super) fn router() -> Router<App> {
    Router::new()
        .route("/v1/credentials", get(all).post(create))
        .route(
            "/v1/credentials/{reference}",
            get(one).put(relabel).delete(remove),
        )
        .route("/v1/credentials/{reference}/value", post(rotate))
        .route("/v1/credentials/{reference}/check", post(check))
        .route("/v1/secrets", post(legacy))
}
async fn all(State(app): State<App>) -> Reply {
    let db = app.lock();
    let vault = Vault::load(&app.root)?;
    Ok(Json(
        json!({"credentials":records(&db,&vault)?,"backend":vault.backend}),
    ))
}
async fn one(State(app): State<App>, Path(reference): Path<String>) -> Reply {
    let db = app.lock();
    let vault = Vault::load(&app.root)?;
    adopt(&db, &vault)?;
    Ok(Json(record(&db, &vault, &reference)?))
}
fn store_value(
    db: &Connection,
    vault: &mut Vault,
    reference: &str,
    value: String,
) -> Result<(), ApiError> {
    let fp = fingerprint(vault, &value)?;
    db.execute(
        "UPDATE credentials SET length=?1,fingerprint=?2,updated_at=?3 WHERE ref=?4",
        params![value.encode_utf16().count(), fp, now(), reference],
    )?;
    vault.values.insert(reference.to_owned(), value);
    vault.save()?;
    Ok(())
}
fn create_in(db: &Connection, vault: &mut Vault, v: &Value) -> Result<String, ApiError> {
    let input = v["ref"].as_str().unwrap_or("");
    let (default_provider, default_label) = known(input);
    let provider = v["provider"].as_str().unwrap_or(default_provider);
    check_provider(provider)?;
    let label = label(db, v["label"].as_str().unwrap_or(&default_label), "")?;
    let reference = if input.is_empty() {
        generate_ref(db, vault, &label)?
    } else {
        input.to_owned()
    };
    if !valid_ref(&reference, 64) {
        return Err(ApiError::bad(
            "Use an uppercase credential reference of 2 to 64 characters.",
        ));
    }
    if has(db, &reference)? {
        return Err(ApiError::conflict(
            "A credential with this reference already exists.",
        ));
    }
    let value = checked_value(provider, v["value"].as_str().unwrap_or(""))?;
    let stamp = now();
    db.execute(
        "DELETE FROM native_credential_deletions WHERE ref=?",
        [&reference],
    )?;
    db.execute(
        "INSERT INTO credentials VALUES(?,?,?,'',0,?,?,NULL)",
        params![reference, label, provider, stamp, stamp],
    )?;
    store_value(db, vault, &reference, value)?;
    Ok(reference)
}
async fn create(
    State(app): State<App>,
    Json(v): Json<Value>,
) -> Result<(StatusCode, Json<Value>), ApiError> {
    let db = app.lock();
    let mut vault = Vault::load(&app.root)?;
    let tx = db.unchecked_transaction()?;
    adopt(&tx, &vault)?;
    let r = create_in(&tx, &mut vault, &v)?;
    tx.commit()?;
    Ok((StatusCode::CREATED, Json(record(&db, &vault, &r)?)))
}
async fn legacy(State(app): State<App>, Json(v): Json<Value>) -> Reply {
    let db = app.lock();
    let mut vault = Vault::load(&app.root)?;
    let tx = db.unchecked_transaction()?;
    adopt(&tx, &vault)?;
    let r = v["name"].as_str().unwrap_or("");
    if let Some(m) = meta(&tx, r)? {
        let value = checked_value(
            m["provider"].as_str().unwrap_or(""),
            v["value"].as_str().unwrap_or(""),
        )?;
        store_value(&tx, &mut vault, r, value)?;
    } else {
        create_in(&tx, &mut vault, &json!({"ref":r,"value":v["value"]}))?;
    }
    tx.commit()?;
    Ok(Json(json!({"ok":true,"name":r})))
}
async fn rotate(State(app): State<App>, Path(r): Path<String>, Json(v): Json<Value>) -> Reply {
    let db = app.lock();
    let mut vault = Vault::load(&app.root)?;
    let tx = db.unchecked_transaction()?;
    adopt(&tx, &vault)?;
    let m = record(&tx, &vault, &r)?;
    let value = checked_value(
        m["provider"].as_str().unwrap_or(""),
        v["value"].as_str().unwrap_or(""),
    )?;
    store_value(&tx, &mut vault, &r, value)?;
    tx.commit()?;
    Ok(Json(record(&db, &vault, &r)?))
}
async fn relabel(State(app): State<App>, Path(r): Path<String>, Json(v): Json<Value>) -> Reply {
    let db = app.lock();
    let mut vault = Vault::load(&app.root)?;
    let tx = db.unchecked_transaction()?;
    adopt(&tx, &vault)?;
    let m = record(&tx, &vault, &r)?;
    let name = label(
        &tx,
        v["label"].as_str().unwrap_or(m["label"].as_str().unwrap()),
        &r,
    )?;
    let provider = v["provider"]
        .as_str()
        .unwrap_or(m["provider"].as_str().unwrap());
    check_provider(provider)?;
    if provider == "slack"
        && let Some(old) = vault.values.get(&r)
    {
        let value = checked_value(provider, old)?;
        if value != *old {
            store_value(&tx, &mut vault, &r, value)?;
        }
    }
    tx.execute(
        "UPDATE credentials SET label=?,provider=?,updated_at=? WHERE ref=?",
        params![name, provider, now(), r],
    )?;
    tx.commit()?;
    Ok(Json(record(&db, &vault, &r)?))
}
async fn remove(
    State(app): State<App>,
    Path(r): Path<String>,
    Query(query): Query<HashMap<String, String>>,
) -> Reply {
    let db = app.lock();
    let mut vault = Vault::load(&app.root)?;
    adopt(&db, &vault)?;
    let current = record(&db, &vault, &r)?;
    let uses = &current["usage"];
    let tx = db.unchecked_transaction()?;
    let mut reassigned = Vec::new();
    if let Some(to) = query.get("reassignTo").filter(|s| !s.is_empty()) {
        if r == *to || !has(&tx, to)? {
            return Err(ApiError::bad("Choose a different saved credential."));
        }
        let mut profiles = list(&tx)?;
        if profiles.iter().any(|p| {
            p.connectors
                .iter()
                .any(|c| c.secret_ref == r && c.kind.as_deref() == Some("slack"))
        }) {
            let target = meta(&tx, to)?.context("Missing target credential.")?;
            if target["provider"] != "slack" {
                return Err(ApiError::bad("Choose a saved Slack bot token."));
            }
            checked_value(
                "slack",
                vault.values.get(to).map(String::as_str).unwrap_or(""),
            )?;
        }
        let (rev, mut model) = defaults(&tx)?;
        if model.credential_ref == r {
            model.credential_ref = to.clone();
            workspace_set(&tx, rev, &model)?;
            reassigned.push("workspace".into());
        }
        for p in &mut profiles {
            let mut changed = false;
            if !p.model.inherit && p.model.choice.credential_ref == r {
                p.model.choice.credential_ref = to.clone();
                changed = true;
            }
            for c in p.connectors.iter_mut().filter(|c| c.secret_ref == r) {
                c.secret_ref = to.clone();
                changed = true;
            }
            if changed {
                write_revision(&tx, p)?;
                reassigned.push(p.id.clone());
            }
        }
    } else if uses["uses"].as_array().is_some_and(|v| !v.is_empty())
        && query.get("force").map(String::as_str) != Some("1")
    {
        return Err(ApiError {
            status: StatusCode::CONFLICT,
            body: json!({"error":"This credential is still in use.","usage":uses}),
        });
    }
    // Commit every reference update before erasing the source value. This tombstone keeps
    // an interrupted cleanup from re-adopting the old value on a later startup.
    tx.execute(
        "INSERT OR IGNORE INTO native_credential_deletions VALUES(?)",
        [&r],
    )?;
    tx.execute("DELETE FROM credentials WHERE ref=?", [&r])?;
    tx.commit()?;
    vault.values.remove(&r);
    vault.save()?;
    db.execute("DELETE FROM native_credential_deletions WHERE ref=?", [&r])?;
    Ok(Json(json!({"ok":true,"reassigned":reassigned})))
}
pub(super) async fn slack_check(token: &str) -> Value {
    let result=async {
        let token=checked_value("slack",token)?;
        if crate::mock_mode(){return Ok::<_,anyhow::Error>(json!({"ok":true,"message":"Mock Slack credential check passed."}))}
        let client=reqwest::Client::builder().timeout(std::time::Duration::from_secs(10)).redirect(reqwest::redirect::Policy::none()).build()?;
        let mut response=client.post("https://slack.com/api/auth.test").bearer_auth(token).send().await?;
        ensure!(response.status().is_success(),"Slack could not verify this token.");
        let mut bytes=vec![];
        while let Some(chunk)=response.chunk().await? {ensure!(chunk.len()<=65536-bytes.len(),"Slack returned an unexpected response.");bytes.extend_from_slice(&chunk);}
        let v:Value=serde_json::from_slice(&bytes)?;
        Ok(json!({"ok":v["ok"]==true,"message":if v["ok"]==true {"Slack bot token verified."}else{"Slack did not accept this token. Check the app’s installation and permissions."}}))
    }.await;
    result.unwrap_or_else(
        |_| json!({"ok":false,"message":"Could not verify this bot token with Slack."}),
    )
}
async fn check(State(app): State<App>, Path(r): Path<String>) -> Reply {
    let token = {
        let db = app.lock();
        let vault = Vault::load(&app.root)?;
        let m = record(&db, &vault, &r)?;
        if m["provider"] != "slack" {
            return Err(ApiError::bad(
                "Connection checks are available for Slack credentials.",
            ));
        }
        vault
            .values
            .get(&r)
            .cloned()
            .ok_or_else(|| ApiError::conflict("This credential’s value is missing."))?
    };
    Ok(Json(slack_check(&token).await))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::profiles::{self, vault};
    use std::sync::{Arc, Mutex};

    #[tokio::test]
    async fn rotation_delete_reassign_and_run_resolution_keep_values_scoped() -> Result<()> {
        let root = tempfile::tempdir()?;
        let path = root.path();
        vault::atomic(&path.join("secrets.backend"), b"file")?;
        vault::atomic(&path.join("secrets.json"),br#"{"controlToken":"old-control","EXISTING_KEY":"secret-one","BACKUP_KEY":"secret-two"}"#)?;
        let db = Connection::open_in_memory()?;
        db.execute_batch(include_str!("../schema.sql"))?;
        profiles::init(&db)?;
        profiles::recover_credentials(&db, path)?;
        let p = profiles::import(
            &db,
            &json!({"id":"worker","name":"Worker","harness":"hermes","model":{"provider":"openai","model":"mock","baseUrl":"","credentialRef":"EXISTING_KEY"}}),
        )?;
        let snap = profiles::snapshot(&db, &p.id)?;
        let app = App {
            root: Arc::new(path.to_owned()),
            db: Arc::new(Mutex::new(db)),
            token: Arc::new("old-control".into()),
            local_url: Arc::new("http://127.0.0.1:4317".into()),
            shutdown: tokio::sync::watch::channel(false).0,
        };
        let values = profiles::run_secrets(&app, &snap)?;
        assert_eq!(values.len(), 1);
        assert_eq!(values["EXISTING_KEY"], "secret-one");
        let rotated = rotate(
            State(app.clone()),
            Path("EXISTING_KEY".into()),
            Json(json!({"value":"rotated-secret"})),
        )
        .await?
        .0;
        assert_eq!(rotated["present"], true);
        assert!(!rotated.to_string().contains("rotated-secret"));
        assert_eq!(
            profiles::run_secrets(&app, &snap)?["EXISTING_KEY"],
            "rotated-secret"
        );
        let err = remove(
            State(app.clone()),
            Path("EXISTING_KEY".into()),
            Query(HashMap::new()),
        )
        .await
        .unwrap_err();
        assert_eq!(err.status, StatusCode::CONFLICT);
        assert_eq!(err.body["usage"]["agentCount"], 1);
        let moved = remove(
            State(app.clone()),
            Path("EXISTING_KEY".into()),
            Query(HashMap::from([("reassignTo".into(), "BACKUP_KEY".into())])),
        )
        .await?
        .0;
        assert_eq!(moved["reassigned"], json!(["worker"]));
        let snapshot = profiles::snapshot(&app.lock(), &p.id)?;
        assert_eq!(snapshot["revision"], 2);
        let values = profiles::run_secrets(&app, &snapshot)?;
        assert_eq!(values.len(), 1);
        assert_eq!(values["BACKUP_KEY"], "secret-two");
        assert_eq!(vault::control_token(path)?, "old-control");
        assert!(!std::fs::read_to_string(path.join("secrets.json"))?.contains("rotated-secret"));
        Ok(())
    }
}
