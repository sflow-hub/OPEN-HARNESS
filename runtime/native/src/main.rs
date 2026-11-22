mod cli;
mod dashboard;
mod machines;
mod profiles;
mod runs;
mod server;
mod worker_launch;
mod workspace;

use axum::{
    Json,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use rusqlite::{Connection, ToSql, types::ValueRef};
use serde_json::{Value, json};
use std::{
    path::PathBuf,
    sync::{Arc, Mutex, MutexGuard},
};

#[derive(Clone)]
pub struct App {
    pub db: Arc<Mutex<Connection>>,
    pub root: Arc<PathBuf>,
    pub token: Arc<String>,
    pub local_url: Arc<String>,
    pub shutdown: tokio::sync::watch::Sender<bool>,
}

impl App {
    pub fn lock(&self) -> MutexGuard<'_, Connection> {
        self.db.lock().expect("workspace database lock poisoned")
    }
}

pub type Reply = Result<Json<Value>, ApiError>;

#[derive(Debug)]
pub struct ApiError {
    pub status: StatusCode,
    pub body: Value,
}
impl ApiError {
    pub fn new(status: StatusCode, message: impl Into<String>) -> Self {
        Self {
            status,
            body: json!({"error":message.into()}),
        }
    }
    pub fn bad(message: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_REQUEST, message)
    }
    pub fn conflict(message: impl Into<String>) -> Self {
        Self::new(StatusCode::CONFLICT, message)
    }
    pub fn missing(message: impl Into<String>) -> Self {
        Self::new(StatusCode::NOT_FOUND, message)
    }
}
impl std::fmt::Display for ApiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.body["error"].as_str().unwrap_or("Request failed."))
    }
}
impl std::error::Error for ApiError {}
impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (self.status, Json(self.body)).into_response()
    }
}
impl From<anyhow::Error> for ApiError {
    fn from(value: anyhow::Error) -> Self {
        Self::bad(value.to_string())
    }
}
macro_rules! internal_error {
    ($kind:ty) => {
        impl From<$kind> for ApiError {
            fn from(value: $kind) -> Self {
                Self::new(StatusCode::INTERNAL_SERVER_ERROR, value.to_string())
            }
        }
    };
}
internal_error!(rusqlite::Error);
internal_error!(std::io::Error);
internal_error!(serde_json::Error);

pub fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
pub fn id() -> String {
    uuid::Uuid::new_v4().to_string()
}
pub fn mock_mode() -> bool {
    std::env::var("OPEN_HARNESS_MOCK").as_deref() == Ok("1")
}
pub fn rows(db: &Connection, sql: &str, args: &[&dyn ToSql]) -> rusqlite::Result<Vec<Value>> {
    let mut stmt = db.prepare(sql)?;
    let names = stmt.column_names().map(str::to_owned).collect::<Vec<_>>();
    stmt.query_map(args, |row| {
        let mut object = serde_json::Map::new();
        for (index, name) in names.iter().enumerate() {
            let value = match row.get_ref(index)? {
                ValueRef::Null => Value::Null,
                ValueRef::Integer(n) => json!(n),
                ValueRef::Real(n) => json!(n),
                ValueRef::Text(s) => json!(String::from_utf8_lossy(s)),
                ValueRef::Blob(_) => Value::Null,
            };
            object.insert(name.clone(), value);
        }
        Ok(Value::Object(object))
    })?
    .collect()
}

fn main() -> anyhow::Result<()> {
    // Load project configuration before the async runtime starts other threads.
    if std::path::Path::new(".env").is_file() {
        dotenvy::from_path(".env")
            .map_err(|_| anyhow::anyhow!("Could not parse or read the workspace .env file."))?;
    }
    tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?
        .block_on(cli::main())
}
