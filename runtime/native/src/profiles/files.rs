use super::model::valid_id;
use crate::{ApiError, App, Reply};
use anyhow::{Context, Result, ensure};
use axum::{
    Json, Router,
    extract::{Path, Query, State},
    routing::{get, post},
};
use base64::{Engine, engine::general_purpose::STANDARD};
use rusqlite::params;
use rustix::{
    fs::{self, AtFlags, Dir, FileType, Mode, OFlags},
    io::Errno,
};
use serde_json::{Value, json};
use std::os::unix::fs::MetadataExt;
use std::{
    collections::HashMap,
    fs::File,
    io::{Read, Write},
    path::Path as FsPath,
};
type Params = HashMap<String, String>;
const DIR: OFlags = OFlags::RDONLY
    .union(OFlags::DIRECTORY)
    .union(OFlags::CLOEXEC)
    .union(OFlags::NOFOLLOW);

fn directory(parent: &File, name: &str, create: bool) -> Result<File> {
    ensure!(
        name != "."
            && name != ".."
            && !name.contains('/')
            && !name.contains('\0')
            && !name.is_empty(),
        "Invalid directory name."
    );
    if create
        && let Err(e) = fs::mkdirat(parent, name, Mode::from_bits_truncate(0o700))
        && e != Errno::EXIST
    {
        return Err(e.into());
    }
    Ok(File::from(fs::openat(parent, name, DIR, Mode::empty())?))
}
fn root_dir(root: &FsPath) -> Result<File> {
    Ok(File::from(fs::open(root, DIR, Mode::empty())?))
}
pub(super) fn agent_dir(root: &FsPath, id: &str) -> Result<File> {
    ensure!(valid_id(id), "Invalid agent ID.");
    let root = root_dir(root)?;
    let agents = directory(&root, "agents", true)?;
    let agent = directory(&agents, id, true)?;
    for sub in ["profile", "managed", "private"] {
        directory(&agent, sub, true)?;
    }
    Ok(agent)
}
fn entries(parent: &File) -> Result<Vec<(String, FileType)>> {
    let mut result = Vec::new();
    for entry in Dir::read_from(parent)? {
        let entry = entry?;
        let Some(name) = entry.file_name().to_str().ok() else {
            continue;
        };
        if name != "." && name != ".." {
            result.push((name.to_owned(), entry.file_type()));
        }
    }
    result.sort_by(|a, b| a.0.cmp(&b.0));
    Ok(result)
}
fn file(parent: &File, name: &str) -> Result<File> {
    let handle = File::from(fs::openat(
        parent,
        name,
        OFlags::RDONLY | OFlags::NOFOLLOW | OFlags::NONBLOCK | OFlags::CLOEXEC,
        Mode::empty(),
    )?);
    let meta = handle.metadata()?;
    ensure!(
        meta.is_file() && meta.nlink() == 1,
        "Expected an ordinary workspace file."
    );
    Ok(handle)
}
fn bytes(parent: &File, name: &str, max: u64) -> Result<Vec<u8>> {
    let handle = file(parent, name)?;
    ensure!(
        handle.metadata()?.len() <= max,
        "File exceeds the size limit."
    );
    let mut out = Vec::new();
    handle.take(max + 1).read_to_end(&mut out)?;
    ensure!(out.len() as u64 <= max, "File exceeds the size limit.");
    Ok(out)
}
fn optional_text(parent: &File, name: &str) -> Result<String> {
    match bytes(parent, name, 5_000_000) {
        Ok(bytes) => Ok(String::from_utf8_lossy(&bytes).into_owned()),
        Err(err) if err.downcast_ref::<Errno>() == Some(&Errno::NOENT) => Ok(String::new()),
        Err(err) => Err(err),
    }
}
fn write(parent: &File, name: &str, data: &[u8], exclusive: bool) -> Result<()> {
    let tmp = format!(".write-{}", crate::id());
    let mut f = File::from(fs::openat(
        parent,
        tmp.as_str(),
        OFlags::CREATE | OFlags::EXCL | OFlags::WRONLY | OFlags::CLOEXEC,
        Mode::from_bits_truncate(0o600),
    )?);
    let result = (|| -> Result<()> {
        f.write_all(data)?;
        open_harness_runner::sync_state_file(&f)?;
        if exclusive {
            fs::linkat(parent, tmp.as_str(), parent, name, AtFlags::empty())?;
        } else {
            fs::renameat(parent, tmp.as_str(), parent, name)?;
        }
        Ok(())
    })();
    // Exclusive creation links the complete temporary file. Unlinking the staging name
    // also prevents partial files or a symlink swap from reaching a different directory.
    match fs::unlinkat(parent, tmp.as_str(), AtFlags::empty()) {
        Ok(()) | Err(Errno::NOENT) => {}
        Err(e) if result.is_ok() => return Err(e.into()),
        _ => {}
    }
    result?;
    open_harness_runner::sync_state_file(parent)?;
    Ok(())
}
fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 160
        && name.as_bytes()[0].is_ascii_alphanumeric()
        && !name.contains("..")
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-' | b' '))
}
fn valid_skill(s: &str) -> bool {
    valid_name(s) && s.len() <= 80 && !s.contains(' ')
}
fn file_type(name: &str) -> (&'static str, &'static str) {
    let ext = name
        .rsplit_once('.')
        .map(|(_, s)| s.to_ascii_lowercase())
        .unwrap_or_default();
    match ext.as_str() {
        "md" => ("utf8", "text/markdown"),
        "html" => ("utf8", "text/html"),
        "csv" => ("utf8", "text/csv"),
        "json" => ("utf8", "application/json"),
        "svg" => ("utf8", "image/svg+xml"),
        "txt" | "css" | "js" | "mjs" | "cjs" | "ts" | "tsx" | "py" | "yaml" | "yml" | "xml"
        | "log" => ("utf8", "text/plain"),
        "jpg" | "jpeg" => ("base64", "image/jpeg"),
        "png" => ("base64", "image/png"),
        "webp" => ("base64", "image/webp"),
        "gif" => ("base64", "image/gif"),
        "pdf" => ("base64", "application/pdf"),
        _ => ("base64", "application/octet-stream"),
    }
}
fn scope(app: &App, params: &Params) -> Result<(String, File), ApiError> {
    match params.get("scope").map(String::as_str).unwrap_or("shared") {
        "shared" => Ok((
            "shared".into(),
            directory(&root_dir(&app.root)?, "shared", true)?,
        )),
        "private" => {
            let id = params
                .get("agentId")
                .ok_or_else(|| ApiError::bad("Choose an agent."))?;
            super::profile(&app.lock(), id)?;
            Ok((
                "private".into(),
                directory(&agent_dir(&app.root, id)?, "private", true)?,
            ))
        }
        _ => Err(ApiError::bad("Invalid workspace scope.")),
    }
}
pub(super) fn router() -> Router<App> {
    Router::new()
        .route(
            "/v1/files",
            get(list_files).post(upload).delete(remove_file),
        )
        .route("/v1/agents/{id}/context", get(context).put(memory))
        .route(
            "/v1/agents/{id}/context/skills/{skill}",
            get(skill).put(save_skill).delete(remove_skill),
        )
        .route("/v1/migrate", post(migrate))
}
fn require_name(name: &str) -> Result<(), ApiError> {
    if !valid_name(name) {
        Err(ApiError::bad("Invalid filename."))
    } else {
        Ok(())
    }
}
async fn list_files(State(app): State<App>, Query(params): Query<Params>) -> Reply {
    let (scope, dir) = scope(&app, &params)?;
    if let Some(name) = params.get("name").filter(|v| !v.is_empty()) {
        require_name(name)?;
        let data = bytes(&dir, name, 20_000_000).map_err(|e| {
            if e.downcast_ref::<Errno>() == Some(&Errno::NOENT) {
                ApiError::missing("File not found.")
            } else {
                ApiError::bad(e.to_string())
            }
        })?;
        let (encoding, mime) = file_type(name);
        let (encoding, mime, content) = if encoding == "utf8" {
            match String::from_utf8(data) {
                Ok(text) => (encoding, mime, text),
                Err(e) => (
                    "base64",
                    "application/octet-stream",
                    STANDARD.encode(e.as_bytes()),
                ),
            }
        } else {
            (encoding, mime, STANDARD.encode(data))
        };
        return Ok(Json(
            json!({"name":name,"encoding":encoding,"mimeType":mime,"scope":scope,"content":content}),
        ));
    }
    let mut items = Vec::new();
    for (name, kind) in entries(&dir)? {
        if kind != FileType::RegularFile || !valid_name(&name) {
            continue;
        }
        let Ok(f) = file(&dir, &name) else { continue };
        let m = f.metadata()?;
        let time: chrono::DateTime<chrono::Utc> = m.modified()?.into();
        let (encoding, mime) = file_type(&name);
        items.push(json!({"name":name,"size":m.len(),"updatedAt":time.to_rfc3339_opts(chrono::SecondsFormat::Millis,true),"encoding":encoding,"mimeType":mime}));
        if items.len() >= 200 {
            break;
        }
    }
    Ok(Json(json!({"files":items,"scope":scope})))
}
async fn upload(
    State(app): State<App>,
    Query(params): Query<Params>,
    Json(input): Json<Value>,
) -> Result<(axum::http::StatusCode, Json<Value>), ApiError> {
    let (scope, dir) = scope(&app, &params)?;
    let name = input["name"].as_str().unwrap_or("");
    require_name(name)?;
    let content = input["content"]
        .as_str()
        .ok_or_else(|| ApiError::bad("File content is required."))?;
    let data = if input["encoding"] == "base64" {
        STANDARD
            .decode(content)
            .map_err(|_| ApiError::bad("Invalid base64 file."))?
    } else {
        content.as_bytes().to_vec()
    };
    if data.len() > 1_000_000 {
        return Err(ApiError {
            status: axum::http::StatusCode::PAYLOAD_TOO_LARGE,
            body: json!({"error":"Files are limited to 1 MB."}),
        });
    }
    let exclusive = input["createOnly"] == true;
    let _guard = app.lock();
    if exclusive
        && entries(&dir)?
            .iter()
            .filter(|(_, k)| *k == FileType::RegularFile)
            .count()
            >= 40
    {
        return Err(ApiError::conflict("The workspace already has 40 files."));
    }
    write(&dir, name, &data, exclusive).map_err(|e| {
        if e.downcast_ref::<Errno>() == Some(&Errno::EXIST) {
            ApiError::conflict("A file with this name already exists.")
        } else {
            e.into()
        }
    })?;
    Ok((
        axum::http::StatusCode::CREATED,
        Json(json!({"name":name,"scope":scope})),
    ))
}
async fn remove_file(State(app): State<App>, Query(params): Query<Params>) -> Reply {
    let (_, dir) = scope(&app, &params)?;
    let name = params.get("name").map(String::as_str).unwrap_or("");
    require_name(name)?;
    match fs::unlinkat(&dir, name, AtFlags::empty()) {
        Ok(()) | Err(Errno::NOENT) => {}
        Err(e) => return Err(anyhow::Error::from(e).into()),
    }
    Ok(Json(json!({"ok":true})))
}
fn profile_dir(app: &App, id: &str) -> Result<(File, super::Profile), ApiError> {
    let p = super::profile(&app.lock(), id)?;
    Ok((directory(&agent_dir(&app.root, id)?, "profile", true)?, p))
}
async fn context(State(app): State<App>, Path(id): Path<String>) -> Reply {
    let (dir, p) = profile_dir(&app, &id)?;
    let skills = entries(&directory(&dir, "skills", true)?)?
        .into_iter()
        .filter(|(n, k)| valid_skill(n) && *k == FileType::Directory)
        .map(|(n, _)| n)
        .take(200)
        .collect::<Vec<_>>();
    let permitted = |tools: &[&str]| p.allowed_tools.iter().any(|s| tools.contains(&s.as_str()));
    Ok(Json(
        json!({"memory":optional_text(&dir,"MEMORY.md")?,"user":optional_text(&dir,"USER.md")?,"skills":skills,"capabilities":{"terminal":permitted(&["terminal"]),"process":permitted(&["process_manage"]),"code":permitted(&["execute_code"]),"files":permitted(&["read_file","write_file"]),"web":permitted(&["web_search","web_extract"]),"browser":permitted(&["browser_navigate"]),"memory":permitted(&["memory"]),"skills":permitted(&["skills_list"]),"mcp":p.connectors.iter().any(|c|c.enabled),"delegation":permitted(&["mcp__open_harness__delegate_named_agent"]),"schedules":true}}),
    ))
}
async fn memory(State(app): State<App>, Path(id): Path<String>, Json(v): Json<Value>) -> Reply {
    let (dir, _) = profile_dir(&app, &id)?;
    let text = v["memory"].as_str().unwrap_or("");
    if text.len() > 50_000 {
        return Err(ApiError {
            status: axum::http::StatusCode::PAYLOAD_TOO_LARGE,
            body: json!({"error":"Memory is limited to 50 KB."}),
        });
    }
    write(&dir, "MEMORY.md", text.as_bytes(), false)?;
    Ok(Json(json!({"ok":true})))
}
fn skills(app: &App, id: &str, name: &str) -> Result<File, ApiError> {
    if !valid_skill(name) {
        return Err(ApiError::bad("Invalid skill name."));
    }
    let (dir, _) = profile_dir(app, id)?;
    Ok(directory(&dir, "skills", true)?)
}
async fn skill(State(app): State<App>, Path((id, name)): Path<(String, String)>) -> Reply {
    let skills = skills(&app, &id, &name)?;
    let dir =
        directory(&skills, &name, false).map_err(|_| ApiError::missing("Skill not found."))?;
    let text =
        bytes(&dir, "SKILL.md", 5_000_000).map_err(|_| ApiError::missing("Skill not found."))?;
    Ok(Json(
        json!({"name":name,"content":String::from_utf8_lossy(&text)}),
    ))
}
async fn save_skill(
    State(app): State<App>,
    Path((id, name)): Path<(String, String)>,
    Json(v): Json<Value>,
) -> Reply {
    let skills = skills(&app, &id, &name)?;
    let dir = directory(&skills, &name, true)?;
    let text = v["content"]
        .as_str()
        .ok_or_else(|| ApiError::bad("Skill content is required."))?;
    write(&dir, "SKILL.md", text.as_bytes(), false)?;
    Ok(Json(json!({"ok":true})))
}
fn remove_tree(parent: &File, name: &str, depth: usize) -> Result<()> {
    ensure!(depth < 64, "Skill folder is too deeply nested.");
    let dir = directory(parent, name, false)?;
    for (name, kind) in entries(&dir)? {
        if kind == FileType::Directory {
            remove_tree(&dir, &name, depth + 1)?;
        } else {
            fs::unlinkat(&dir, name.as_str(), AtFlags::empty())?;
        }
    }
    fs::unlinkat(parent, name, AtFlags::REMOVEDIR)?;
    Ok(())
}
async fn remove_skill(State(app): State<App>, Path((id, name)): Path<(String, String)>) -> Reply {
    let skills = skills(&app, &id, &name)?;
    if let Err(e) = remove_tree(&skills, &name, 0)
        && e.downcast_ref::<Errno>() != Some(&Errno::NOENT)
    {
        return Err(e.into());
    }
    Ok(Json(json!({"ok":true})))
}
async fn migrate(State(app): State<App>, Json(v): Json<Value>) -> Reply {
    let db = app.lock();
    let tx = db.unchecked_transaction()?;
    let seen: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM migrations WHERE key='browser-v1')",
        [],
        |r| r.get(0),
    )?;
    if seen {
        return Ok(Json(json!({"migrated":false,"reason":"already_migrated"})));
    }
    let root = root_dir(&app.root)?;
    let shared = directory(&root, "shared", true)?;
    for agent in v["agents"].as_array().into_iter().flatten() {
        let p = super::import(&tx, agent).map_err(|e| ApiError::bad(e.to_string()))?;
        let dir = directory(&agent_dir(&app.root, &p.id)?, "profile", true)?;
        if let Some(lines) = agent["memory"].as_array().filter(|v| !v.is_empty()) {
            let content = lines
                .iter()
                .filter_map(Value::as_str)
                .map(|l| format!("- {l}\n"))
                .collect::<String>();
            if let Err(e) = write(&dir, "MEMORY.md", content.as_bytes(), true)
                && e.downcast_ref::<Errno>() != Some(&Errno::EXIST)
            {
                return Err(e.into());
            }
        }
    }
    for c in v["conversations"].as_array().into_iter().flatten() {
        let stamp = c["updatedAt"]
            .as_str()
            .map(str::to_owned)
            .unwrap_or_else(crate::now);
        tx.execute("INSERT OR IGNORE INTO conversations(id,agent_id,title,legacy_json,created_at,updated_at) VALUES(?1,?2,?3,?4,?5,?5)",params![c["id"].as_str(),c["agentId"].as_str(),c["title"].as_str(),c.to_string(),stamp])?;
    }
    for f in v["files"].as_array().into_iter().flatten() {
        let name = f["name"]
            .as_str()
            .context("Missing filename.")?
            .chars()
            .map(|c| {
                if c.is_ascii_alphanumeric() || "._ -".contains(c) {
                    c
                } else {
                    '_'
                }
            })
            .collect::<String>();
        require_name(&name)?;
        let data = f["content"].as_str().unwrap_or("").as_bytes();
        if let Err(e) = write(&shared, &name, &data[..data.len().min(1_000_000)], true)
            && e.downcast_ref::<Errno>() != Some(&Errno::EXIST)
        {
            return Err(e.into());
        }
    }
    let raw = serde_json::to_vec(&v)?;
    tx.execute(
        "INSERT INTO migrations VALUES('browser-v1',?1,?2)",
        params![
            std::str::from_utf8(&raw).expect("JSON is UTF-8"),
            crate::now()
        ],
    )?;
    super::vault::atomic(&app.root.join("browser-v1-backup.json"), &raw)?;
    tx.commit()?;
    Ok(Json(json!({"migrated":true})))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::symlink;
    #[test]
    fn agent_links_cannot_read_or_overwrite_other_paths() -> Result<()> {
        let tmp = tempfile::tempdir()?;
        let root = tmp.path();
        let outside = root.join("outside");
        std::fs::write(&outside, "private bytes")?;
        let agent = agent_dir(root, "atlas")?;
        let private = directory(&agent, "private", false)?;
        let dir = root.join("agents/atlas/private");
        symlink(&outside, dir.join("secret.txt"))?;
        assert!(bytes(&private, "secret.txt", 1000).is_err());
        write(&private, "secret.txt", b"workspace bytes", false)?;
        assert_eq!(std::fs::read_to_string(&outside)?, "private bytes");
        assert_eq!(bytes(&private, "secret.txt", 1000)?, b"workspace bytes");
        assert!(write(&private, "secret.txt", b"collision", true).is_err());
        std::fs::hard_link(&outside, dir.join("hard.txt"))?;
        assert!(bytes(&private, "hard.txt", 1000).is_err());
        symlink(root, dir.join("redirect"))?;
        assert!(directory(&private, "redirect", false).is_err());
        Ok(())
    }
}
