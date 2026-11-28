use anyhow::{Context, Result, ensure};
use axum::{
    Json, Router,
    body::Bytes,
    extract::{DefaultBodyLimit, OriginalUri, State},
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::post,
};
use serde_json::json;
use std::{
    fs,
    os::unix::fs::{FileTypeExt, PermissionsExt, symlink},
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};
use tokio::{net::UnixListener, sync::watch};
use url::Url;

pub struct Relay {
    path: PathBuf,
    done: watch::Sender<bool>,
    _alias: Option<tempfile::TempDir>,
}

#[derive(Clone)]
struct Scope {
    coordinator: Url,
    client: reqwest::Client,
    agent: String,
    run: String,
    token: String,
    done: watch::Receiver<bool>,
}

impl Relay {
    pub async fn listen(
        dir: &Path,
        coordinator: Url,
        agent: &str,
        run: &str,
        token: &str,
    ) -> Result<Option<Self>> {
        let path = dir.join("coord.sock");
        match path.symlink_metadata() {
            Ok(meta) => {
                ensure!(
                    meta.file_type().is_socket(),
                    "Unexpected file at the agent coordination socket path."
                );
                fs::remove_file(&path)?;
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
            Err(e) => return Err(e.into()),
        }
        // sockaddr_un has a short pathname field even when the mounted workspace path is long.
        let alias = if path.as_os_str().as_encoded_bytes().len() > 95 {
            let temp = tempfile::Builder::new()
                .prefix("oh-sock-")
                .permissions(fs::Permissions::from_mode(0o700))
                .tempdir_in("/tmp")?;
            symlink(dir, temp.path().join("m"))?;
            Some(temp)
        } else {
            None
        };
        let bind = alias
            .as_ref()
            .map_or_else(|| path.clone(), |t| t.path().join("m/coord.sock"));
        let listener = match UnixListener::bind(bind) {
            Ok(listener) => listener,
            // The managed coordination tool already has an authenticated HTTP fallback.
            Err(error) if crate::socket_unsupported(&error) => return Ok(None),
            Err(error) => return Err(error).context("Bind the agent coordination socket"),
        };
        fs::set_permissions(&path, fs::Permissions::from_mode(0o600))?;
        let (done, mut stop) = watch::channel(false);
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .no_proxy()
            .timeout(Duration::from_secs(24 * 60 * 60))
            .build()?;
        let state = Arc::new(Scope {
            coordinator,
            client,
            agent: agent.into(),
            run: run.into(),
            token: token.into(),
            done: stop.clone(),
        });
        let app = Router::new()
            .route("/internal/handoff", post(forward))
            .route("/internal/task", post(forward))
            .route("/internal/schedule", post(forward))
            .layer(DefaultBodyLimit::max(256_000))
            .with_state(state);
        tokio::spawn(async move {
            let _ = axum::serve(listener, app)
                .with_graceful_shutdown(async move {
                    let _ = stop.changed().await;
                })
                .await;
        });
        Ok(Some(Self {
            path,
            done,
            _alias: alias,
        }))
    }
}

impl Drop for Relay {
    fn drop(&mut self) {
        let _ = self.done.send(true);
        let _ = fs::remove_file(&self.path);
    }
}

async fn forward(
    State(scope): State<Arc<Scope>>,
    OriginalUri(uri): OriginalUri,
    headers: HeaderMap,
    body: Bytes,
) -> Response {
    let header = |name: &str| {
        headers
            .get(name)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("")
    };
    let presented = header("authorization")
        .strip_prefix("Bearer ")
        .unwrap_or("");
    if presented.len() != scope.token.len()
        || !openssl::memcmp::eq(presented.as_bytes(), scope.token.as_bytes())
        || header("x-open-harness-agent") != scope.agent
        || header("x-open-harness-run") != scope.run
    {
        return (
            StatusCode::FORBIDDEN,
            Json(json!({"error":"Invalid agent or run credential."})),
        )
            .into_response();
    }
    let target = crate::protocol::endpoint(&scope.coordinator, uri.path());
    let mut done = scope.done.clone();
    let response = async {
        let mut response = scope
            .client
            .post(target)
            .bearer_auth(&scope.token)
            .header("x-open-harness-agent", &scope.agent)
            .header("x-open-harness-run", &scope.run)
            .header("content-type", "application/json")
            .body(body)
            .send()
            .await?;
        let status = response.status();
        let mut data = Vec::new();
        while let Some(chunk) = response.chunk().await? {
            ensure!(
                data.len() + chunk.len() <= 4_900_000,
                "Coordinator response too large."
            );
            data.extend_from_slice(&chunk);
        }
        Ok::<_, anyhow::Error>(
            (status, [("content-type", "application/json")], data).into_response(),
        )
    };
    tokio::select! {
        _=done.wait_for(|stop| *stop) => (StatusCode::GONE,Json(json!({"error":"This run has ended."}))).into_response(),
        result=response=> result.unwrap_or_else(|_| (StatusCode::BAD_GATEWAY,Json(json!({"error":"Coordinator unavailable."}))).into_response())
    }
}
