use crate::{ApiError, App, Reply, id, now};
use axum::{Json, Router, body::Bytes, extract::Query, http::StatusCode};
use rusqlite::{Connection, Params, params, types::ValueRef};
use serde_json::{Value, json};
use std::collections::HashMap;

mod boards;
mod routines;
mod tasks;
mod teams;

pub use routines::{agent_schedule, tick};
pub use tasks::{agent_task, run_changed};
pub use teams::shares_team;

type Data<T = Value> = Result<T, ApiError>;
type Http = Result<(StatusCode, Json<Value>), ApiError>;
type Options = Query<HashMap<String, String>>;
const COLORS: [&str; 6] = ["sage", "blue", "amber", "violet", "rose", "teal"];
const CATEGORIES: [&str; 5] = ["backlog", "ready", "in_progress", "review", "done"];

pub fn router() -> Router<App> {
    teams::router()
        .merge(boards::router())
        .merge(tasks::router())
        .merge(routines::router())
}

pub fn init(db: &Connection) -> anyhow::Result<()> {
    db.execute_batch(include_str!("workspace/schema.sql"))?;
    for (table, column, definition) in [
        ("task_boards", "settings_json", "TEXT NOT NULL DEFAULT '{}'"),
        ("task_comments", "author", "TEXT NOT NULL DEFAULT 'you'"),
        ("task_runs", "output", "TEXT NOT NULL DEFAULT ''"),
        ("task_runs", "stop_reason", "TEXT"),
        ("task_boards", "description", "TEXT NOT NULL DEFAULT ''"),
        ("task_boards", "color", "TEXT NOT NULL DEFAULT 'sage'"),
        ("task_boards", "position", "REAL NOT NULL DEFAULT 0"),
        ("task_boards", "default_owner_agent_id", "TEXT"),
        ("tasks", "team_id", "TEXT"),
    ] {
        if !exists(
            db,
            "SELECT 1 FROM pragma_table_info(?) WHERE name=?",
            params![table, column],
        )? {
            db.execute_batch(&format!(
                "ALTER TABLE {table} ADD COLUMN {column} {definition}"
            ))?;
        }
    }
    db.execute_batch(
        "CREATE INDEX IF NOT EXISTS idx_tasks_team_archived ON tasks(team_id,archived);
         UPDATE task_boards SET position=((SELECT count(*) FROM task_boards other WHERE
         other.created_at<task_boards.created_at OR (other.created_at=task_boards.created_at AND other.id<task_boards.id))+1)*1000 WHERE position=0;",
    )?;
    if !exists(db, "SELECT 1 FROM task_boards LIMIT 1", [])? {
        boards::create(db, &json!({"name":"Product launch"}))?;
    }
    db.execute("UPDATE runs SET state='interrupted',error=?,updated_at=? WHERE state='queued' AND id IN (SELECT run_id FROM task_runs)",
        params!["The local runtime restarted. This board task was not replayed; retry it when ready.",now()])?;
    let linked = strings(
        db,
        "SELECT runs.id FROM tasks JOIN runs ON runs.id=tasks.active_run_id WHERE runs.state IN ('completed','failed','cancelled','interrupted')",
        [],
    )?;
    for run in linked {
        run_changed(db, &run)?;
    }
    Ok(())
}

fn rows(db: &Connection, sql: &str, p: impl Params) -> rusqlite::Result<Vec<Value>> {
    let mut statement = db.prepare(sql)?;
    let keys: Vec<String> = statement.column_names().map(str::to_owned).collect();
    statement
        .query_map(p, |row| {
            let mut object = serde_json::Map::new();
            for (i, key) in keys.iter().enumerate() {
                let value = match row.get_ref(i)? {
                    ValueRef::Null => Value::Null,
                    ValueRef::Integer(n) => json!(n),
                    ValueRef::Real(n) => json!(n),
                    ValueRef::Text(s) => json!(String::from_utf8_lossy(s)),
                    ValueRef::Blob(_) => {
                        return Err(rusqlite::Error::InvalidColumnType(
                            i,
                            key.clone(),
                            rusqlite::types::Type::Blob,
                        ));
                    }
                };
                object.insert(key.clone(), value);
            }
            Ok(Value::Object(object))
        })?
        .collect()
}
fn one(db: &Connection, sql: &str, p: impl Params, missing: &str) -> Data {
    rows(db, sql, p)?
        .into_iter()
        .next()
        .ok_or_else(|| ApiError::missing(missing))
}
fn strings(db: &Connection, sql: &str, p: impl Params) -> rusqlite::Result<Vec<String>> {
    db.prepare(sql)?.query_map(p, |row| row.get(0))?.collect()
}
fn exists(db: &Connection, sql: &str, p: impl Params) -> rusqlite::Result<bool> {
    db.prepare(sql)?.exists(p)
}
fn count(db: &Connection, sql: &str, p: impl Params) -> rusqlite::Result<i64> {
    db.query_row(sql, p, |r| r.get(0))
}
fn transaction<T>(db: &Connection, work: impl FnOnce() -> Data<T>) -> Data<T> {
    // Savepoints nest when a task attempt creates a run or a project copies its tasks.
    db.execute_batch("SAVEPOINT workspace_edit")?;
    match work() {
        Ok(value) => {
            if let Err(error) = db.execute_batch("RELEASE workspace_edit") {
                db.execute_batch("ROLLBACK TO workspace_edit; RELEASE workspace_edit")?;
                return Err(error.into());
            }
            Ok(value)
        }
        Err(error) => {
            db.execute_batch("ROLLBACK TO workspace_edit; RELEASE workspace_edit")?;
            Err(error)
        }
    }
}
fn text(v: &Value) -> &str {
    v.as_str().unwrap_or("")
}
fn optional(v: &Value) -> Option<&str> {
    v.as_str().filter(|s| !s.is_empty())
}
fn list(v: &Value) -> &[Value] {
    v.as_array().map(Vec::as_slice).unwrap_or_default()
}
fn take(s: &str, n: usize) -> String {
    s.chars().take(n).collect()
}
fn tail(s: &str, n: usize) -> String {
    let start = s
        .char_indices()
        .rev()
        .nth(n.saturating_sub(1))
        .map_or(0, |(i, _)| i);
    s[start..].to_string()
}
fn array_strings(v: &Value) -> Vec<String> {
    let mut out = vec![];
    for v in list(v) {
        if let Some(s) = v.as_str()
            && !out.iter().any(|old| old == s)
        {
            out.push(s.to_string());
        }
    }
    out
}
fn required(v: &Value, name: &str, max: usize) -> Data<String> {
    let value = text(v).trim();
    if value.is_empty() {
        return Err(ApiError::bad(format!("{name} is required.")));
    }
    if value.chars().count() > max {
        return Err(ApiError::bad(format!("{name} is too long.")));
    }
    Ok(value.to_owned())
}
fn revision(input: &Value, current: &Value, entity: &str, optional: bool) -> Data<()> {
    if (input.get("revision").is_some() || !optional)
        && input["revision"].as_i64() != current["revision"].as_i64()
    {
        return Err(ApiError::conflict(format!(
            "This {entity} changed elsewhere. Refresh and try again."
        )));
    }
    Ok(())
}
fn json_body(bytes: Bytes) -> Data {
    if bytes.is_empty() {
        return Ok(json!({}));
    }
    let v: Value = serde_json::from_slice(&bytes).map_err(|_| ApiError::bad("Invalid JSON."))?;
    if !v.is_object() {
        return Err(ApiError::bad("Send an object."));
    }
    Ok(v)
}
fn response(code: StatusCode, v: Value) -> Http {
    Ok((code, Json(v)))
}

#[cfg(test)]
fn test_db() -> anyhow::Result<Connection> {
    let db = Connection::open_in_memory()?;
    db.execute_batch("PRAGMA foreign_keys=ON")?;
    db.execute_batch(include_str!("schema.sql"))?;
    db.execute_batch("CREATE TABLE agent_profiles(id TEXT PRIMARY KEY); INSERT INTO agent_profiles VALUES('atlas'),('scout'),('solo');")?;
    init(&db)?;
    Ok(db)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn imports_old_board_schema_before_building_team_index() -> anyhow::Result<()> {
        let db = Connection::open_in_memory()?;
        db.execute_batch(include_str!("schema.sql"))?;
        db.execute_batch("CREATE TABLE task_boards(id TEXT PRIMARY KEY,name TEXT,archived INTEGER DEFAULT 0,revision INTEGER DEFAULT 1,created_at TEXT,updated_at TEXT);
          CREATE TABLE tasks(id TEXT PRIMARY KEY,board_id TEXT,stage_id TEXT,title TEXT,description TEXT,owner_agent_id TEXT,priority TEXT,due_at TEXT,position REAL,archived INTEGER,revision INTEGER,active_run_id TEXT,created_at TEXT,updated_at TEXT);
          INSERT INTO task_boards(id,name,created_at,updated_at) VALUES('old','Existing project','2020','2020');")?;
        init(&db)?;
        assert!(exists(
            &db,
            "SELECT 1 FROM pragma_index_list('tasks') WHERE name='idx_tasks_team_archived'",
            []
        )?);
        assert_eq!(boards::board(&db, "old")?["position"], 1000.0);
        init(&db)?;
        assert_eq!(count(&db, "SELECT count(*) FROM task_boards", [])?, 1);
        Ok(())
    }
}
