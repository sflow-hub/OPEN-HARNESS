//! Operator commands on the machine that owns a worker. The local CLI never receives
//! the pairing identity or launch grant. The coordinator authorizes each operation.
use crate::{
    claude_terminal, plan_auth,
    protocol::{Coordinator, CoordinatorStatus},
    required_str,
};
use anyhow::{Context, Result, bail, ensure};
use clap::Subcommand;
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{ErrorKind, IsTerminal},
    os::unix::fs::{FileTypeExt, MetadataExt, PermissionsExt, symlink},
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};
use tokio::{
    io::{AsyncBufRead, AsyncBufReadExt, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader},
    net::{UnixListener, UnixStream},
    sync::mpsc,
    task::JoinSet,
    time::{sleep, timeout},
};
use uuid::Uuid;

const SOCKET: &str = "worker.sock";
const REQUEST_LIMIT: u64 = 6_100_000;
const REPLY_LIMIT: u64 = 24_000_000;

#[derive(Subcommand, Serialize, Deserialize)]
#[serde(tag = "action", rename_all = "camelCase", deny_unknown_fields)]
pub enum Action {
    /// Connect a ChatGPT plan for this agent. Schedules and handoffs may use its allowance.
    Login {
        #[arg(long)]
        agent: String,
    },
    /// Show this agent's worker, billing method and sign-in status.
    Status {
        #[arg(long)]
        agent: String,
    },
    /// Disconnect this agent's ChatGPT plan on this worker.
    Logout {
        #[arg(long)]
        agent: String,
    },
    /// Submit work to the assigned Codex agent.
    Run {
        #[arg(long)]
        agent: String,
        prompt: String,
        #[arg(long)]
        wait: bool,
        /// Reuse this UUID to retry a submission after an uncertain response.
        #[arg(long)]
        request_id: Option<Uuid>,
    },
    /// Open or reattach to this agent's Claude Code terminal.
    Terminal {
        #[arg(long)]
        agent: String,
        #[arg(skip)]
        request_id: Option<Uuid>,
    },
}
impl Action {
    fn agent(&self) -> &str {
        match self {
            Self::Login { agent }
            | Self::Status { agent }
            | Self::Logout { agent }
            | Self::Run { agent, .. }
            | Self::Terminal { agent, .. } => agent,
        }
    }
}

#[derive(Serialize, Deserialize)]
#[serde(tag = "type", content = "value", rename_all = "camelCase")]
enum Reply {
    Progress(String),
    Result(Value),
    Error(String),
}

pub fn client_root(explicit: Option<&Path>, local: Option<&Path>) -> Result<PathBuf> {
    if let Some(path) = explicit {
        return Ok(path.to_owned());
    }
    if let Some(path) = std::env::var_os("OPEN_HARNESS_RUNNER_STATE_DIR").filter(|s| !s.is_empty())
    {
        return Ok(path.into());
    }
    let paired = PathBuf::from(std::env::var_os("HOME").context("Set HOME or pass --state-dir.")?)
        .join(".open-harness-rust-runner");
    if let Some(local) = local
        && active_socket(local)?.is_some()
    {
        ensure!(
            active_socket(&paired)?.is_none() || paired.canonicalize()? == local.canonicalize()?,
            "Two workers are available. Pass --state-dir to choose the agent's assigned worker."
        );
        return Ok(local.to_owned());
    }
    Ok(paired)
}

fn check_root(root: &Path) -> Result<()> {
    let metadata = root.symlink_metadata().context(
        "Worker state was not found. Start the assigned worker or pass its --state-dir.",
    )?;
    ensure!(
        metadata.is_dir()
            && metadata.uid() == unsafe { libc::geteuid() }
            && metadata.mode() & 0o077 == 0,
        "The worker state directory must be private and owned by this user."
    );
    Ok(())
}

fn check_id(agent: &str) -> Result<()> {
    ensure!(
        agent.len() <= 80
            && agent.starts_with(|c: char| c.is_ascii_alphanumeric())
            && agent
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_')),
        "Invalid agent ID."
    );
    Ok(())
}

fn owned_socket(path: &Path) -> Result<bool> {
    match path.symlink_metadata() {
        Ok(meta) => {
            ensure!(
                meta.file_type().is_socket() && meta.uid() == unsafe { libc::geteuid() },
                "Unexpected file at the worker socket path."
            );
            Ok(true)
        }
        Err(err) if err.kind() == ErrorKind::NotFound => Ok(false),
        Err(err) => Err(err.into()),
    }
}

fn local_socket_dir() -> PathBuf {
    Path::new("/tmp").join(format!("oh-worker-{}", unsafe { libc::geteuid() }))
}

fn local_socket(root: &Path, dir: &Path) -> Result<PathBuf> {
    let root = root.canonicalize()?;
    Ok(dir.join(format!(
        "{:x}",
        Sha256::digest(root.as_os_str().as_encoded_bytes())
    )))
}

fn active_socket(root: &Path) -> Result<Option<PathBuf>> {
    let path = root.join(SOCKET);
    if owned_socket(&path)? {
        return Ok(Some(path));
    }
    let dir = local_socket_dir();
    if !root.try_exists()? || !dir.try_exists()? {
        return Ok(None);
    }
    check_root(&dir)?;
    let path = local_socket(root, &dir)?;
    Ok(owned_socket(&path)?.then_some(path))
}

// Long state paths need a short alias to fit in sockaddr_un on Linux and macOS.
fn short_socket(path: &Path) -> Result<(PathBuf, Option<tempfile::TempDir>)> {
    if path.as_os_str().as_encoded_bytes().len() <= 95 {
        return Ok((path.to_owned(), None));
    }
    let alias = tempfile::Builder::new()
        .prefix("oh-w-")
        .permissions(fs::Permissions::from_mode(0o700))
        .tempdir_in("/tmp")?;
    let root = path.parent().context("Missing worker socket directory")?;
    let name = path.file_name().context("Missing worker socket name")?;
    symlink(root.canonicalize()?, alias.path().join("r"))?;
    Ok((alias.path().join("r").join(name), Some(alias)))
}
pub(crate) struct Socket {
    path: PathBuf,
    listener: UnixListener,
}
impl Socket {
    pub fn bind(root: &Path) -> Result<Self> {
        Self::bind_with(root, |path| UnixListener::bind(path))
    }
    fn bind_with(
        root: &Path,
        bind: impl FnOnce(&Path) -> std::io::Result<UnixListener>,
    ) -> Result<Self> {
        check_root(root)?;
        let mut path = root.join(SOCKET);
        // The runner holds the state's exclusive process lock before binding.
        if owned_socket(&path)? {
            fs::remove_file(&path)?;
        }
        let (address, _alias) = short_socket(&path)?;
        let listener = match bind(&address) {
            Err(err) if crate::socket_unsupported(&err) => {
                // Shared filesystems can store the durable worker state but refuse Unix sockets.
                let dir = local_socket_dir();
                crate::directory(&dir)?;
                check_root(&dir)?;
                path = local_socket(root, &dir)?;
                if owned_socket(&path)? {
                    fs::remove_file(&path)?;
                }
                UnixListener::bind(&path)
            }
            result => result,
        }
        .context("Bind worker command socket")?;
        let socket = Self { path, listener };
        fs::set_permissions(&socket.path, fs::Permissions::from_mode(0o600))?;
        Ok(socket)
    }
    pub async fn serve(&self, root: PathBuf, coordinator: Arc<Coordinator>) -> Result<()> {
        let mut clients = JoinSet::new();
        loop {
            tokio::select! {
                Some(_) = clients.join_next() => {},
                accepted = self.listener.accept(), if clients.len()<32 => {
                    let (client,_) = accepted?;
                    if !client.peer_cred().is_ok_and(|cred| cred.uid() == unsafe { libc::geteuid() }) { continue; }
                    let coordinator = coordinator.clone();
                    let root = root.clone();
                    clients.spawn(async move { let _ = connection(client, &root, &coordinator).await; });
                }
            }
        }
    }
}
impl Drop for Socket {
    fn drop(&mut self) {
        if owned_socket(&self.path).unwrap_or(false) {
            let _ = fs::remove_file(&self.path);
        }
    }
}

async fn receive<T: DeserializeOwned>(
    reader: &mut (impl AsyncBufRead + Unpin),
    limit: u64,
) -> Result<T> {
    let mut line = Vec::new();
    let n = reader.take(limit + 1).read_until(b'\n', &mut line).await?;
    ensure!(
        n > 0 && n as u64 <= limit && line.last() == Some(&b'\n'),
        "Incomplete or oversized worker message."
    );
    Ok(serde_json::from_slice(&line)?)
}
async fn send<T: Serialize>(writer: &mut (impl AsyncWrite + Unpin), value: &T) -> Result<()> {
    let mut frame = serde_json::to_vec(value)?;
    frame.push(b'\n');
    writer.write_all(&frame).await?;
    Ok(())
}

async fn connection(socket: UnixStream, root: &Path, coordinator: &Coordinator) -> Result<()> {
    let (reader, mut writer) = socket.into_split();
    let mut reader = BufReader::new(reader);
    let action = timeout(
        Duration::from_secs(10),
        receive::<Action>(&mut reader, REQUEST_LIMIT),
    )
    .await??;
    let result = tokio::select! {
        result = handle(root, coordinator, action, &mut writer) => result,
        // Browser login and follow requests end when their private client goes away.
        // A run already admitted to the coordinator continues under its durable lease.
        _ = reader.read_u8() => return Ok(()),
    };
    let frame = match result {
        Ok(value) => Reply::Result(value),
        Err(err) => Reply::Error(format!("{err:#}")),
    };
    send(&mut writer, &frame).await
}

fn launch_path(agent: &str) -> Result<String> {
    check_id(agent)?;
    Ok(format!("/v1/runner/launch/{agent}"))
}

async fn authorization(coordinator: &Coordinator, path: &str) -> Result<Value> {
    coordinator.post_json(path, &json!({"action":"authorize"})).await.context(
        "This worker could not confirm launch access. Check the coordinator connection, agent assignment, and worker launch setting")
}
async fn scoped(
    coordinator: &Coordinator,
    path: &str,
    grant: &str,
    mut payload: Value,
) -> Result<Value> {
    payload["grant"] = json!(grant);
    coordinator.post_json(path, &payload).await.map_err(|error| {
        match error.downcast_ref::<CoordinatorStatus>().map(|s| s.0.as_u16()) {
            Some(401 | 403) => error.context("Worker access has ended. Check the agent assignment and worker launch setting."),
            Some(409) => error.context("The launch conflicts with an existing request. Use the same request ID only with its original prompt."),
            _ => error,
        }
    })
}
async fn publish_state(
    coordinator: &Coordinator,
    path: &str,
    grant: &str,
    value: &Value,
) -> Result<()> {
    let state = required_str(value, "state")?;
    ensure!(
        matches!(state, "connected" | "signInRequired" | "signedOut"),
        "Unrecognized provider sign-in status."
    );
    scoped(
        coordinator,
        path,
        grant,
        json!({"action":"status","state":state}),
    )
    .await?;
    Ok(())
}

async fn handle(
    root: &Path,
    coordinator: &Coordinator,
    action: Action,
    output: &mut (impl AsyncWrite + Unpin),
) -> Result<Value> {
    let agent = action.agent().to_owned();
    let path = launch_path(&agent)?;
    // Local removal stays available even after the operator revokes the machine grant.
    if matches!(action, Action::Logout { .. }) {
        let auth = authorization(coordinator, &path).await.ok();
        let mut state = plan_auth::logout(root, &agent).await?;
        if auth.as_ref().is_some_and(|a| a["harness"] == "claude-code") {
            return Ok(
                json!({"chatgptPlan":state,"claudeCode":format!("Open the Claude Code terminal with open-harness worker terminal --agent {agent} and enter /logout.")}),
            );
        }
        state["activeRuns"] = json!(
            "A request already sent may finish. Stop an active run in Open Harness to end the job."
        );
        if let Some(auth) = auth
            && auth["modelAuth"] == "chatgpt-plan"
            && let Some(grant) = auth["grant"].as_str()
            && publish_state(coordinator, &path, grant, &state)
                .await
                .is_err()
        {
            state["workerStatusReported"] = json!(false);
        }
        return Ok(state);
    }
    let auth = authorization(coordinator, &path).await?;
    let grant = required_str(&auth, "grant")?;
    let harness = required_str(&auth, "harness")?;
    let plan = harness == "codex" && auth["modelAuth"] == "chatgpt-plan";
    match action {
        Action::Login { .. } => {
            if harness == "claude-code" {
                bail!(
                    "Open the official Claude Code sign-in using open-harness worker terminal --agent {agent}."
                );
            }
            ensure!(
                plan,
                "Select ChatGPT plan for this Codex agent in Agent settings first."
            );
            let (progress, mut messages) = mpsc::channel(4);
            let login =
                plan_auth::login(root, &agent, required_str(&auth, "planBinding")?, progress);
            tokio::pin!(login);
            let state = loop {
                tokio::select! {
                    biased;
                    Some(message)=messages.recv()=>send(output,&Reply::Progress(message)).await?,
                    result=&mut login=>break result?,
                }
            };
            publish_state(coordinator,&path,grant,&state).await.context("Sign-in finished on this worker. Run worker status to refresh the coordinator.")?;
            Ok(state)
        }
        Action::Status { .. } => {
            let mut result = json!({"agentId":agent,"machineId":auth["machineId"],"harness":harness,"modelAuth":auth["modelAuth"],"workerLaunch":true});
            if plan {
                let status = plan_auth::status(root, &agent, required_str(&auth, "planBinding")?)?;
                publish_state(coordinator, &path, grant, &status).await?;
                result["signIn"] = status;
            } else if harness == "claude-code" {
                result["terminal"] = json!(format!("open-harness worker terminal --agent {agent}"));
            }
            Ok(result)
        }
        Action::Run {
            prompt,
            wait,
            request_id,
            ..
        } => {
            ensure!(
                plan,
                "Choose a Codex agent configured to use a ChatGPT plan."
            );
            ensure!(
                !prompt.trim().is_empty() && prompt.len() <= 1_000_000,
                "Enter a prompt up to one million bytes."
            );
            let request_id = request_id.context("Missing launch request ID")?;
            let result = scoped(
                coordinator,
                &path,
                grant,
                json!({"action":"run","requestId":request_id,"prompt":prompt}),
            )
            .await?;
            if wait {
                follow(coordinator, &path, grant, result, false).await
            } else {
                Ok(result)
            }
        }
        Action::Terminal { request_id, .. } => {
            ensure!(
                harness == "claude-code",
                "Choose a Claude Code agent to open a terminal."
            );
            let request_id = request_id.context("Missing launch request ID")?;
            let result = scoped(
                coordinator,
                &path,
                grant,
                json!({"action":"terminal","requestId":request_id}),
            )
            .await?;
            follow(coordinator, &path, grant, result, true).await
        }
        Action::Logout { .. } => unreachable!(),
    }
}

async fn follow(
    coordinator: &Coordinator,
    path: &str,
    grant: &str,
    mut run: Value,
    terminal: bool,
) -> Result<Value> {
    let id = Uuid::parse_str(required_str(&run, "id")?).context("Invalid run ID")?;
    loop {
        match required_str(&run, "state")? {
            "running" if terminal => return Ok(json!({"id":id,"state":"running"})),
            "queued" | "running" | "waiting_approval" | "waiting_input" => {}
            _ => return Ok(run),
        }
        sleep(Duration::from_millis(400)).await;
        run = scoped(
            coordinator,
            path,
            grant,
            json!({"action":"read","runId":id}),
        )
        .await?;
    }
}

fn temporary(err: &anyhow::Error) -> bool {
    if let Some(status) = err.downcast_ref::<CoordinatorStatus>() {
        return status.0.is_server_error() || status.0.as_u16() == 429;
    }
    err.downcast_ref::<reqwest::Error>()
        .is_some_and(|e| e.is_connect() || e.is_timeout() || e.is_request() || e.is_body())
}

async fn validate_terminal(
    coordinator: &Coordinator,
    path: &str,
    grant: &str,
    run: &str,
) -> Result<()> {
    let value = scoped(
        coordinator,
        path,
        grant,
        json!({"action":"read","runId":run}),
    )
    .await?;
    ensure!(
        value["id"] == run
            && matches!(
                value["state"].as_str(),
                Some("running" | "waiting_approval" | "waiting_input")
            ),
        "The coordinator ended this terminal run."
    );
    Ok(())
}

/// Establish the original grant and confirm admission before creating a TTY.
pub(crate) async fn terminal_grant(
    coordinator: &Coordinator,
    agent: &str,
    run: &str,
) -> Result<String> {
    let path = launch_path(agent)?;
    loop {
        let result = async {
            let auth = authorization(coordinator, &path).await?;
            let grant = required_str(&auth, "grant")?;
            validate_terminal(coordinator, &path, grant, run).await?;
            Ok(grant.to_owned())
        }
        .await;
        match result {
            Err(err) if temporary(&err) => sleep(Duration::from_secs(2)).await,
            result => return result,
        }
    }
}

/// An attached or detached terminal ends on definitive rejection or a closed run.
/// A temporary coordinator outage leaves its existing lease to normal recovery.
pub(crate) async fn watch_terminal(
    coordinator: &Coordinator,
    agent: &str,
    grant: &str,
    run: &str,
) -> Result<()> {
    let path = launch_path(agent)?;
    loop {
        sleep(Duration::from_secs(10)).await;
        if let Err(err) = validate_terminal(coordinator, &path, grant, run).await
            && !temporary(&err)
        {
            return Err(err);
        }
    }
}

pub async fn command(root: &Path, mut action: Action) -> Result<()> {
    check_id(action.agent())?;
    check_root(root)?;
    let agent = action.agent().to_owned();
    let terminal = matches!(action, Action::Terminal { .. });
    let wait = matches!(action, Action::Run { wait: true, .. });
    if terminal {
        ensure!(
            std::io::stdin().is_terminal() && std::io::stdout().is_terminal(),
            "Run the terminal command from an interactive shell. Use ssh -t on a remote machine."
        );
    }
    let mut retry = None;
    match &mut action {
        Action::Run { request_id, .. } => {
            retry = Some(*request_id.get_or_insert_with(Uuid::new_v4));
        }
        Action::Terminal { request_id, .. } => {
            request_id.replace(Uuid::new_v4());
        }
        _ => {}
    }
    let unavailable = "Could not reach the worker command socket. Start or upgrade the assigned worker and check --state-dir.";
    let path = active_socket(root)?.context(unavailable)?;
    let (path, _alias) = short_socket(&path)?;
    let socket = UnixStream::connect(path).await.context(unavailable)?;
    ensure!(
        socket.peer_cred()?.uid() == unsafe { libc::geteuid() },
        "The worker is owned by a different user."
    );
    let (reader, mut writer) = socket.into_split();
    let mut reader = BufReader::new(reader);
    send(&mut writer, &action).await?;
    let result = async {
        loop {
            match receive(&mut reader, REPLY_LIMIT).await? {
                Reply::Progress(text) => eprintln!("{text}"),
                Reply::Result(value) => return Ok(value),
                Reply::Error(message) => bail!("{message}"),
            }
        }
    }
    .await;
    let value = match retry {
        Some(id) => result.with_context(|| {
            format!("Worker run request {id}. To retry this submission, reuse --request-id {id}.")
        })?,
        None => result?,
    };
    if terminal && value["state"] == "running" {
        return claude_terminal::attach(root, &agent, required_str(&value, "id")?).await;
    }
    println!("{}", serde_json::to_string_pretty(&value)?);
    ensure!(
        !terminal && (!wait || value["state"] == "completed"),
        "The run ended with state {}.",
        value["state"]
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn worker_commands_reject_foreign_paths_and_refuse_to_replace_regular_files() -> Result<()> {
        assert!(launch_path("other/agent").is_err());
        assert!(launch_path("..").is_err());
        let dir = tempfile::tempdir()?;
        fs::set_permissions(dir.path(), fs::Permissions::from_mode(0o700))?;
        fs::write(dir.path().join(SOCKET), "keep")?;
        assert!(Socket::bind(dir.path()).is_err());
        assert_eq!(fs::read(dir.path().join(SOCKET))?, b"keep");
        fs::remove_file(dir.path().join(SOCKET))?;
        symlink("missing", dir.path().join(SOCKET))?;
        assert!(Socket::bind(dir.path()).is_err());
        assert!(active_socket(dir.path()).is_err());
        assert_eq!(
            fs::read_link(dir.path().join(SOCKET))?,
            Path::new("missing")
        );
        Ok(())
    }
    #[tokio::test]
    async fn long_state_path_supports_private_worker_socket() -> Result<()> {
        let parent = tempfile::tempdir()?;
        let root = parent.path().join("w".repeat(110));
        fs::create_dir(&root)?;
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700))?;
        let socket = Socket::bind(&root)?;
        assert_eq!(fs::metadata(root.join(SOCKET))?.mode() & 0o777, 0o600);
        let (name, alias) = short_socket(&active_socket(&root)?.unwrap())?;
        check_root(alias.as_ref().unwrap().path())?;
        let client = UnixStream::connect(name).await?;
        let (server, _) = socket.listener.accept().await?;
        assert_eq!(client.peer_cred()?.uid(), server.peer_cred()?.uid());
        drop(socket);
        assert!(!root.join(SOCKET).exists());
        Ok(())
    }

    #[tokio::test]
    async fn unsupported_volume_uses_a_private_state_specific_local_socket() -> Result<()> {
        let state = tempfile::tempdir()?;
        let other = tempfile::tempdir()?;
        fs::set_permissions(state.path(), fs::Permissions::from_mode(0o700))?;
        fs::set_permissions(other.path(), fs::Permissions::from_mode(0o700))?;
        let unsupported = |_: &Path| Err(std::io::Error::from_raw_os_error(libc::EOPNOTSUPP));
        let socket = Socket::bind_with(state.path(), unsupported)?;
        let remote_alias = state.path().join(".");
        assert_eq!(active_socket(&remote_alias)?, Some(socket.path.clone()));
        assert!(active_socket(other.path())?.is_none());
        assert!(!state.path().join(SOCKET).exists());
        assert_eq!(fs::metadata(&socket.path)?.mode() & 0o777, 0o600);
        check_root(socket.path.parent().unwrap())?;
        let client = UnixStream::connect(&socket.path).await?;
        let (server, _) = socket.listener.accept().await?;
        assert_eq!(client.peer_cred()?.uid(), server.peer_cred()?.uid());
        let path = socket.path.clone();
        drop(socket);
        assert!(active_socket(state.path())?.is_none());
        symlink("missing", &path)?;
        let rejected = Socket::bind_with(state.path(), unsupported);
        let retained = fs::read_link(&path);
        fs::remove_file(&path)?;
        assert!(rejected.is_err());
        assert_eq!(retained?, Path::new("missing"));
        Ok(())
    }

    #[tokio::test]
    async fn daemon_keeps_the_grant_private_and_stops_following_after_revocation() -> Result<()> {
        use axum::{Json, Router, http::StatusCode, routing::post};
        use std::sync::atomic::{AtomicUsize, Ordering};
        let grant = "private-fixture-grant";
        let run = Uuid::new_v4();
        let attempts = Arc::new(AtomicUsize::new(0));
        let terminal_calls = attempts.clone();
        let router = Router::new()
            .route("/v1/runner/pair", post(|| async { Json(json!({"machineId":"machine-fixture","token":"pair-fixture"})) }))
            .route("/v1/runner/launch/ada", post(move |Json(v): Json<Value>| async move {
                if v["action"] == "authorize" {
                    return (StatusCode::OK, Json(json!({"agentId":"ada","harness":"codex","machineId":"machine-fixture","modelAuth":"chatgpt-plan","planBinding":Uuid::nil(),"grant":grant})));
                }
                if v["grant"] != grant { return (StatusCode::UNAUTHORIZED,Json(Value::Null)); }
                match v["action"].as_str() {
                    Some("status") => (StatusCode::OK, Json(json!({"state":v["state"]}))),
                    Some("run") => (StatusCode::OK, Json(json!({"id":run,"state":"queued"}))),
                    Some("read") => (StatusCode::FORBIDDEN, Json(Value::Null)),
                    _ => (StatusCode::BAD_REQUEST,Json(Value::Null)),
                }
            }))
            .route("/v1/runner/launch/editor",post(move |Json(v):Json<Value>| {
                let n=terminal_calls.fetch_add(1,Ordering::SeqCst);
                async move {
                    match (n,v["action"].as_str()) {
                        (0,Some("authorize")) => (StatusCode::SERVICE_UNAVAILABLE,Json(Value::Null)),
                        (1,Some("authorize")) => (StatusCode::OK,Json(json!({"grant":grant}))),
                        (2,Some("read")) => (StatusCode::OK,Json(json!({"id":run,"state":"running"}))),
                        (_,Some("read")) => (StatusCode::OK,Json(json!({"id":run,"state":"interrupted"}))),
                        _ => (StatusCode::BAD_REQUEST,Json(Value::Null)),
                    }
                }
            }));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await?;
        let url = format!("http://{}", listener.local_addr()?);
        let server = tokio::spawn(async move { axum::serve(listener, router).await });
        let dir = tempfile::tempdir()?;
        fs::set_permissions(dir.path(), fs::Permissions::from_mode(0o700))?;
        let coordinator =
            Coordinator::connect(dir.path(), Some((&url, "code")), json!({}), None).await?;
        let mut output = Vec::new();
        let state = handle(
            dir.path(),
            &coordinator,
            Action::Status {
                agent: "ada".into(),
            },
            &mut output,
        )
        .await?;
        assert_eq!(state["signIn"]["state"], "signedOut");
        assert!(!state.to_string().contains(grant));
        let err = handle(
            dir.path(),
            &coordinator,
            Action::Run {
                agent: "ada".into(),
                wait: true,
                request_id: Some(Uuid::new_v4()),
                prompt: "work".into(),
            },
            &mut output,
        )
        .await
        .unwrap_err();
        assert_eq!(
            err.downcast_ref::<CoordinatorStatus>().unwrap().0,
            StatusCode::FORBIDDEN
        );
        assert!(output.is_empty());
        assert_eq!(
            terminal_grant(&coordinator, "editor", &run.to_string()).await?,
            grant
        );
        assert_eq!(attempts.load(Ordering::SeqCst), 3);
        let closed = validate_terminal(
            &coordinator,
            "/v1/runner/launch/editor",
            grant,
            &run.to_string(),
        )
        .await
        .unwrap_err();
        assert!(!temporary(&closed));
        assert!(closed.to_string().contains("ended"));
        server.abort();
        Ok(())
    }
}
