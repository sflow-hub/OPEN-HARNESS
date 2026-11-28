mod additional_cli;
mod claude_terminal;
mod cli;
mod cli_protocol;
mod engine;
pub mod harnesses;
mod hermes;
mod inspect;
mod legacy;
mod outbox;
mod plan_auth;
mod plan_run;
mod profile;
mod protocol;
mod relay;
mod simulation;
mod transfer;
pub mod worker_local;

use anyhow::{Context, Result, bail, ensure};
use hermes::Control;
use outbox::Outbox;
use protocol::{Command, Commands, Coordinator};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    io::{self, Write},
    os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt},
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};
use tokio::{
    signal::unix::{SignalKind, signal},
    sync::{mpsc, oneshot, watch},
    task::JoinSet,
    time::{Instant, MissedTickBehavior, interval, timeout},
};
use uuid::Uuid;

/// Allows both Docker removal attempts and their confirmation checks to finish.
pub const STOP_TIMEOUT: Duration = Duration::from_secs(210);

struct Runner {
    root: PathBuf,
    coordinator: Arc<Coordinator>,
    outbox: Arc<Outbox>,
    secrets: engine::Secrets,
}

struct ActiveRun {
    command: Uuid,
    controls: mpsc::Sender<Control>,
}

/// Run the same durable worker for a paired remote machine or the local coordinator.
pub async fn start(root: PathBuf, pairing: Option<(String, String)>, once: bool) -> Result<()> {
    start_with(root, pairing, once, None).await
}

pub async fn start_local(root: PathBuf, url: String, pairing_code: Option<String>) -> Result<()> {
    let pairing = pairing_code.map(|code| (url.clone(), code));
    start_with(root, pairing, false, Some(url)).await
}

pub use engine::install;

pub(crate) fn socket_unsupported(error: &io::Error) -> bool {
    error.kind() == io::ErrorKind::Unsupported || error.raw_os_error() == Some(libc::ENOTSUP)
}

async fn start_with(
    root: PathBuf,
    pairing: Option<(String, String)>,
    once: bool,
    local_url: Option<String>,
) -> Result<()> {
    ensure!(
        unsafe { libc::geteuid() } != 0,
        "Start the runner as a non-root user with access to Docker."
    );
    fs::DirBuilder::new()
        .mode(0o700)
        .recursive(true)
        .create(&root)?;
    let mut metadata = root.symlink_metadata()?;
    if local_url.is_none()
        && pairing.is_none()
        && root.join("connection.json").is_file()
        && !root.join("rust-connection.json").exists()
        && metadata.is_dir()
        && metadata.uid() == unsafe { libc::geteuid() }
        && metadata.mode() & 0o022 == 0
        && metadata.mode() & 0o077 != 0
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700))?;
        metadata = root.symlink_metadata()?;
    }
    ensure!(
        metadata.is_dir()
            && metadata.uid() == unsafe { libc::geteuid() }
            && metadata.mode() & 0o077 == 0,
        "The runner state directory must be owned by this user and private (chmod 700)."
    );
    // The previous vault lookup hashes the lexical absolute path used at pairing time.
    let legacy_root = if root.is_absolute() {
        root.clone()
    } else {
        std::env::current_dir()?.join(&root)
    };
    let root = root.canonicalize()?;
    let lock = fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(root.join("rust-runner.lock"))?;
    lock.try_lock()
        .context("Another runner is using this state directory")?;
    directory(&root.join("agents"))?;
    directory(&root.join("shared"))?;
    directory(&root.join("rust-outbox"))?;
    engine::recover_inputs(&root)?;

    // Pairing marks a worker online. Its advertised command socket must already accept connections.
    let socket = if once {
        None
    } else {
        Some(worker_local::Socket::bind(&root)?)
    };
    let docker_ready = hermes::docker_ready().await;
    let coordinator = Arc::new(
        Coordinator::connect(
            &root,
            pairing
                .as_ref()
                .map(|(url, code)| (url.as_str(), code.as_str())),
            capabilities(docker_ready),
            local_url.as_deref(),
        )
        .await?,
    );
    let adopt = local_url.is_none()
        && legacy::matching_identity(&root, &coordinator.machine_id, &coordinator.public_key)?;
    let outbox = Arc::new(Outbox::open(root.join("rust-outbox"))?);
    if adopt {
        outbox.adopt(&root)?;
    }
    let Some(socket) = socket else {
        println!("Paired {}.", coordinator.machine_id);
        return Ok(());
    };
    println!(
        "Open Harness Rust runner {} connected to {}",
        coordinator.machine_id, coordinator.url
    );
    Runner {
        secrets: engine::Secrets::load(
            &root,
            if adopt {
                legacy::secrets(&legacy_root).await?
            } else {
                BTreeMap::new()
            },
        )?,
        root,
        coordinator,
        outbox,
    }
    .serve(socket)
    .await
}

impl Runner {
    async fn serve(self, socket: worker_local::Socket) -> Result<()> {
        let this = Arc::new(self);
        let requests = socket.serve(this.root.clone(), this.coordinator.clone());
        tokio::pin!(requests);
        let mut delivery = tokio::spawn(this.outbox.clone().delivery(this.coordinator.clone()));
        let mut termination = signal(SignalKind::terminate())?;
        let mut tick = interval(Duration::from_secs(1));
        tick.set_missed_tick_behavior(MissedTickBehavior::Skip);
        let (shutdown, _) = watch::channel(false);
        let mut workers = JoinSet::new();
        let mut admitted = BTreeSet::new();
        let mut runs = BTreeMap::<String, ActiveRun>::new();
        let mut busy_agents = BTreeSet::<String>::new();
        let mut last_heartbeat = None;
        let mut reaped = false;
        loop {
            tokio::select! {
                _ = tokio::signal::ctrl_c() => break,
                _ = termination.recv() => break,
                result = &mut requests => return result,
                result = &mut delivery => {
                    result??;
                    bail!("Runner delivery stopped unexpectedly.");
                }
                Some(result) = workers.join_next() => {
                    let (id, agent, run, outcome, transfer) = result?;
                    this.outbox.complete(id, outcome, transfer)?;
                    admitted.remove(&id);
                    if let Some(agent) = agent { busy_agents.remove(&agent); }
                    if let Some(run) = run { runs.remove(&run); }
                }
                _ = tick.tick() => {
                    if last_heartbeat.is_none_or(|time: Instant| time.elapsed() >= Duration::from_secs(15)) {
                        let available = hermes::docker_ready().await;
                        if engine::mock() {reaped = true;}
                        if available && !reaped {
                            match hermes::reap(&this.coordinator.container_owner).await {
                                Ok(()) => reaped = true,
                                Err(error) => eprintln!("Runner container recovery paused: {error}"),
                            }
                        }
                        let pending = this.outbox.pending_commands();
                        let heartbeat = json!({
                            "capabilities": capabilities(available && reaped),
                            "encryptionPublicKey": this.coordinator.public_key,
                            "activeCommandIds": admitted.union(&pending).collect::<Vec<_>>(),
                        });
                        if let Err(error) = this.coordinator.post("/v1/runner/heartbeat", &heartbeat).await {
                            eprintln!("Runner heartbeat paused: {error}");
                            continue;
                        }
                        last_heartbeat = Some(Instant::now());
                    }
                    // Wait for startup cleanup before leasing work. The coordinator can
                    // queue jobs while Docker is coming back, and those leases must stay queued.
                    if !reaped {
                        continue;
                    }
                    let incoming = this.coordinator.get::<Commands>("/v1/runner/commands").await;
                    let commands = match incoming {
                        Ok(incoming) => incoming.commands,
                        Err(error) => { eprintln!("Runner polling paused: {error}"); continue; }
                    };
                    let pending = this.outbox.pending_commands();
                    for command in commands {
                        let id = command.id;
                        if pending.contains(&id) || !admitted.insert(id) { continue; }

                        if matches!(command.kind.as_str(), "stop" | "steer" | "approval") {
                            let target = command.payload["runId"].as_str().and_then(|run| runs.get(run))
                                .filter(|run| command.payload["commandId"].as_str().is_none_or(|id| id == run.command.to_string()))
                                .map(|run| run.controls.clone());
                            workers.spawn(async move { (id, None, None, control(target, command).await, false) });
                            continue;
                        }

                        let agent = command.agent_id.clone().filter(|_| matches!(command.kind.as_str(), "run" | "import-agent" | "export-agent" | "probe-runtime" | "probe-models" | "probe-tools"));
                        if let Some(agent) = &agent
                            && !busy_agents.insert(agent.clone()) {
                            this.outbox.complete(id, Err(anyhow::anyhow!("This agent already has work on this runner.")), false)?;
                            admitted.remove(&id);
                            continue;
                        }
                        let mut run = None;
                        let mut controls = None;
                        if command.kind == "run"
                            && let Some(run_id) = command.payload["runId"].as_str() {
                            let (sender, receiver) = mpsc::channel(8);
                            run = Some(run_id.to_owned());
                            controls = Some(receiver);
                            runs.insert(run_id.to_owned(), ActiveRun { command: id, controls: sender });
                        }
                        let task = this.clone();
                        let stop = shutdown.subscribe();
                        workers.spawn(async move {
                            let result = task.execute(&command, controls, stop).await;
                            (id, agent, run, result, command.kind == "export-agent")
                        });
                    }
                }
            }
        }

        let _ = shutdown.send(true);
        while let Some(result) = workers.join_next().await {
            let (id, _, _, outcome, transfer) = result?;
            this.outbox.complete(id, outcome, transfer)?;
        }
        delivery.abort();
        Ok(())
    }

    async fn execute(
        &self,
        command: &Command,
        controls: Option<mpsc::Receiver<Control>>,
        mut shutdown: watch::Receiver<bool>,
    ) -> Result<Value> {
        let payload = &command.payload;
        match command.kind.as_str() {
            "run" => {
                let snapshot = &payload["snapshot"];
                let harness = engine::harness(snapshot)?;
                let mut controls = controls.context("Missing run ID")?;
                if payload["mode"] == "terminal" {
                    ensure!(
                        !engine::mock(),
                        "An interactive Claude Code terminal needs a worker running with OPEN_HARNESS_MOCK=0."
                    );
                    ensure!(
                        harness == "claude-code",
                        "Choose a Claude Code agent to open a terminal."
                    );
                    let agent = required_str(snapshot, "id")?;
                    let run = required_str(payload, "runId")?;
                    let preflight = worker_local::terminal_grant(&self.coordinator, agent, run);
                    tokio::pin!(preflight);
                    let grant = loop {
                        tokio::select! {
                            result = &mut preflight => break result?,
                            _ = shutdown.wait_for(|stop| *stop) => bail!("The worker stopped before the terminal opened."),
                            Some(control) = controls.recv() => {
                                if control.command.kind == "stop" {
                                    let _ = control.reply.send(Ok(json!({"ok":true})));
                                    bail!("The terminal was stopped before it opened.");
                                }
                                let _ = control.reply.send(Err(anyhow::anyhow!("The terminal is waiting for launch authorization.")));
                            }
                        }
                    };
                    let (stop, signal) = watch::channel(false);
                    let session = claude_terminal::run(
                        &self.root,
                        command,
                        &self.coordinator.container_owner,
                        &self.outbox,
                        controls,
                        signal,
                        &grant,
                    );
                    tokio::pin!(session);
                    let end = tokio::select! {
                        outcome = &mut session => return outcome,
                        result = worker_local::watch_terminal(&self.coordinator, agent, &grant, run) => result,
                        _ = shutdown.wait_for(|stop| *stop) => Ok(()),
                    };
                    let _ = stop.send(true);
                    let outcome = session.await;
                    end?;
                    return outcome;
                }
                let keys = if snapshot["modelAuth"] == "chatgpt-plan" {
                    BTreeMap::new()
                } else {
                    self.secrets.for_profile(
                        snapshot,
                        self.coordinator.secrets(payload.get("encryptedSecrets"))?,
                    )
                };
                if engine::mock() {
                    return simulation::run(command, &self.outbox, controls, shutdown).await;
                }
                if harness == "hermes" {
                    hermes::run(
                        &self.root,
                        command,
                        &self.coordinator,
                        &self.outbox,
                        controls,
                        shutdown,
                        keys,
                    )
                    .await
                } else {
                    let outcome = cli::run(
                        &self.root,
                        command,
                        &self.coordinator.container_owner,
                        &self.outbox,
                        controls,
                        shutdown,
                        keys,
                    )
                    .await;
                    if snapshot["modelAuth"] == "chatgpt-plan"
                        && let Ok(status) = plan_auth::status(
                            &self.root,
                            required_str(snapshot, "id")?,
                            required_str(snapshot, "planBinding")?,
                        )
                        && matches!(
                            status["state"].as_str(),
                            Some("connected" | "signedOut" | "signInRequired")
                        )
                    {
                        self.outbox.event(
                            command.id,
                            required_str(payload, "runId")?,
                            json!({"type":"provider.auth","payload":{"state":status["state"]}}),
                        )?;
                    }
                    outcome
                }
            }
            "store-secret" => {
                let name = required_str(payload, "name")?;
                let encrypted = json!({name: &payload["encrypted"]});
                let mut values = self.coordinator.secrets(Some(&encrypted))?;
                self.secrets.store(
                    name,
                    values.remove(name).context("Missing credential value")?,
                )?;
                Ok(json!({"stored":true, "name":name, "backend":"restricted local file"}))
            }
            "install-harness" => {
                let harness = required_str(payload, "harness")?;
                engine::install(harness).await?;
                Ok(json!({"harness":harness, "state":"ready"}))
            }
            "import-agent" => {
                if !payload["profile"].is_null() {
                    let snapshot = &payload["profile"];
                    let harness = engine::harness(snapshot)?;
                    engine::folder_mounts(&self.root, snapshot).await?;
                    engine::install(harness).await?;
                }
                if let Some(names) = payload["requiredSecrets"].as_array() {
                    for name in names {
                        let name = name.as_str().context("Invalid required credential")?;
                        ensure!(
                            self.secrets.has(name),
                            "Credential {name} is missing on this computer."
                        );
                    }
                }
                let root = agent_dir(
                    &self.root,
                    command
                        .agent_id
                        .as_deref()
                        .context("Missing transfer agent ID")?,
                )?;
                transfer::import(&root, &payload["bundle"])
            }
            "export-agent" => {
                let root = agent_dir(
                    &self.root,
                    command
                        .agent_id
                        .as_deref()
                        .context("Missing transfer agent ID")?,
                )?;
                transfer::export(&root)
            }
            "probe-runtime" | "probe-tools" | "probe-models" => {
                let snapshot = &payload["profile"];
                let keys = self.secrets.for_profile(
                    snapshot,
                    self.coordinator.secrets(payload.get("encryptedSecrets"))?,
                );
                inspect::probe(&self.root, command, &self.coordinator, keys).await
            }
            _ => bail!("Unknown runner command."),
        }
    }
}

async fn control(target: Option<mpsc::Sender<Control>>, command: Command) -> Result<Value> {
    let target = target.context("The requested run is no longer active on this runner")?;
    let (reply, result) = oneshot::channel();
    let wait = if command.kind == "stop" {
        STOP_TIMEOUT
    } else {
        Duration::from_secs(50)
    };
    target
        .try_send(Control { command, reply })
        .map_err(|_| anyhow::anyhow!("The run is busy or has already stopped."))?;
    timeout(wait, result)
        .await
        .context("The harness did not answer the run control in time")?
        .context("The run stopped before responding")?
}

fn capabilities(container: bool) -> Value {
    json!({"container":container, "workerLaunch":true, "direct":false, "desktop":false, "virtualDesktop":false,
        "harnesses":harnesses::HARNESSES.map(|harness| harness.id),
        "detail":"Headless Docker worker."})
}

fn required_str<'a>(value: &'a Value, key: &str) -> Result<&'a str> {
    value[key]
        .as_str()
        .with_context(|| format!("Missing or invalid {key}"))
}

fn directory(path: &Path) -> Result<()> {
    match fs::DirBuilder::new().mode(0o700).create(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            ensure!(
                path.symlink_metadata()?.is_dir(),
                "Expected a directory at {}.",
                path.display()
            );
            Ok(())
        }
        Err(error) => Err(error.into()),
    }
}

fn agent_dir(root: &Path, id: &str) -> Result<PathBuf> {
    ensure!(
        id.len() <= 80
            && id.starts_with(|character: char| character.is_ascii_alphanumeric())
            && id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_')),
        "Invalid agent ID."
    );
    let agent = root.join("agents").join(id);
    directory(&agent)?;
    for name in ["profile", "managed", "private"] {
        directory(&agent.join(name))?;
    }
    Ok(agent)
}

/// Flush a state file or its parent directory before acknowledging a durable write.
pub fn sync_state_file(file: &fs::File) -> io::Result<()> {
    let result = file.sync_all();
    #[cfg(target_os = "macos")]
    if result.as_ref().is_err_and(|err| {
        matches!(
            err.raw_os_error(),
            Some(libc::ENOTTY | libc::ENOTSUP | libc::EINVAL)
        )
    }) {
        use std::os::fd::AsRawFd;
        // VirtioFS supports POSIX fsync but rejects macOS's stronger F_FULLFSYNC ioctl.
        loop {
            if unsafe { libc::fsync(file.as_raw_fd()) } == 0 {
                return Ok(());
            }
            let error = io::Error::last_os_error();
            if error.kind() != io::ErrorKind::Interrupted {
                return Err(error);
            }
        }
    }
    result
}

fn write_private(path: &Path, data: &[u8]) -> Result<()> {
    let parent = path.parent().context("Missing state file directory")?;
    let mut temp = tempfile::NamedTempFile::new_in(parent)?;
    temp.write_all(data)?;
    sync_state_file(temp.as_file())?;
    temp.persist(path)?;
    sync_state_file(&fs::File::open(parent)?)?;
    Ok(())
}
