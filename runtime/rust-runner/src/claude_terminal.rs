//! Interactive Claude Code terminal for a named agent. Docker owns the TTY of a detached
//! container; the worker only supervises its lifecycle and never reads terminal bytes, so
//! nothing typed or shown reaches durable logs, the outbox, or the coordinator. A local
//! `attach` connects the operator's own terminal straight to that container.

use anyhow::{Context, Result, anyhow, bail, ensure};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs,
    io::Read,
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};
use tokio::{
    process::Command as Process,
    sync::{mpsc, watch},
    time::{Instant, sleep},
};
use uuid::Uuid;

use crate::{
    agent_dir, cli_protocol, directory, engine,
    hermes::{Control, docker, remove_container},
    outbox::Outbox,
    protocol::Command,
    required_str, write_private,
};

const AGENT_LABEL: &str = "dev.openharness.claude-terminal.agent";
const RUN_LABEL: &str = "dev.openharness.claude-terminal.run";
const COMMAND_LABEL: &str = "dev.openharness.claude-terminal.command";
// Kept apart from the headless `harnesses/claude-code` home so an official sign-in made
// in the terminal never changes how API-key runs authenticate, and vice versa.
const HOME_DIR: &str = "claude-terminal";
const RECORDS: &str = "claude-terminal";
const RECORDS_LOCK: &str = "records.lock";
const ACTIVE_LOCK: &str = "active.lock";
const MAX_RECORD: u64 = 16 * 1024;
const STARTUP: Duration = Duration::from_secs(90);
const POLL: Duration = Duration::from_millis(250);
const HEADLESS: [&str; 5] = [
    "claude",
    "--print",
    "--output-format",
    "stream-json",
    "--verbose",
];
const IDENTITY: &str =
    "{{.Id}} {{.State.Running}} {{.Config.Tty}} {{.Config.OpenStdin}} {{json .Config.Labels}}";

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
enum State {
    Starting,
    Ready,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Session {
    agent: String,
    run_id: String,
    command_id: Uuid,
    owner: String,
    container: Option<String>,
    state: State,
}

struct Identity {
    id: String,
    running: bool,
    tty: bool,
    stdin: bool,
    labels: BTreeMap<String, String>,
}

impl Session {
    fn owns(&self, found: &Identity) -> bool {
        let label = |key: &str| found.labels.get(key).map(String::as_str);
        self.container.as_deref() == Some(found.id.as_str())
            && found.tty
            && found.stdin
            && label(engine::OWNER_LABEL) == Some(self.owner.as_str())
            && label(AGENT_LABEL) == Some(self.agent.as_str())
            && label(RUN_LABEL) == Some(self.run_id.as_str())
            && label(COMMAND_LABEL) == Some(self.command_id.to_string().as_str())
    }
}

pub(crate) async fn run(
    root: &Path,
    command: &Command,
    machine: &str,
    outbox: &Outbox,
    mut controls: mpsc::Receiver<Control>,
    mut shutdown: watch::Receiver<bool>,
    grant: &str,
) -> Result<Value> {
    let snapshot = &command.payload["snapshot"];
    let agent = required_str(snapshot, "id")?;
    ensure!(
        command.agent_id.as_deref() == Some(agent),
        "Run profile belongs to a different agent."
    );
    let run_id = required_str(&command.payload, "runId")?;
    ensure!(valid_id(run_id), "Invalid run ID.");
    interactive_arguments(snapshot)?;
    let agent_root = agent_dir(root, agent)?;
    directory(&agent_root.join("harnesses"))?;
    let home = terminal_home(&agent_root, grant);
    directory(&home)?;
    let records = agent_root.join(RECORDS);
    directory(&records)?;
    // The coordinator already grants one run per agent. This only stops a second
    // supervisor from rewriting the record a live terminal is using.
    let slot = lock_file(&records.join(ACTIVE_LOCK))?;
    slot.try_lock()
        .map_err(|_| anyhow!("This agent already has a Claude terminal open on this computer."))?;
    let mut session = Session {
        agent: agent.to_owned(),
        run_id: run_id.to_owned(),
        command_id: command.id,
        owner: machine.to_owned(),
        container: None,
        state: State::Starting,
    };
    save(&records, &session, true)?;
    let name = container_name(command.id);
    let mut stop_reply = None;
    let result: Result<Value> = async {
        let folders = engine::folder_mounts(root, snapshot).await?;
        let image = engine::prepare_image("claude-code", &mut controls, &mut shutdown).await?;
        let args = create_arguments(&session, &agent_root, root, &home, snapshot, folders, &image)?;
        let args = args.iter().map(String::as_str).collect::<Vec<_>>();
        let created = docker(&args, 30)
            .await
            .context("Create the Claude terminal container")?;
        let id = container_id(created.trim())?.to_owned();
        session.container = Some(id.clone());
        docker(&["start", id.as_str()], 30)
            .await
            .context("Start the Claude terminal")?;
        ensure!(
            session.owns(&inspect(&id).await?),
            "The Claude terminal container does not match this run."
        );
        session.state = State::Ready;
        save(&records, &session, false)?;
        outbox.event(
            command.id,
            run_id,
            json!({"type":"gateway.ready","session_id":command.id.to_string(),
                "payload":{"harness":"claude-code","mode":"terminal"}}),
        )?;
        let waiting = Process::new("docker")
            .args(["wait", id.as_str()])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .context("Could not monitor the Claude terminal")?
            .wait_with_output();
        tokio::pin!(waiting);
        loop {
            tokio::select! {
                // Restart reaps the container by owner label. A conversation is never
                // resumed, so the coordinator sees an interruption, not a failure.
                _ = shutdown.wait_for(|v| *v) => return Err(cli_protocol::Interrupted(
                    "The runner stopped while the Claude terminal was open. Inspect its saved work before starting another.".into()).into()),
                Some(control) = controls.recv() => {
                    if control.command.kind == "stop" {
                        stop_reply = Some(control.reply);
                        bail!("This run was stopped before execution completed.");
                    }
                    let _ = control.reply.send(Err(anyhow!(
                        "Type into the Claude terminal on this computer to talk to this agent.")));
                }
                waited = &mut waiting => return finish(waited),
            }
        }
    }
    .await;
    let cleanup = remove_container(&name).await;
    if let Err(error) = forget(&records, run_id, command.id) {
        eprintln!("Could not clear the Claude terminal record for {run_id}: {error}");
    }
    drop(slot);
    if let Some(reply) = stop_reply {
        let _ = reply.send(
            cleanup
                .as_ref()
                .map(|_| json!({"ok":true}))
                .map_err(|_| anyhow!("Docker could not confirm the agent stopped.")),
        );
    }
    cleanup?;
    result
}

/// Connect this process's own terminal to a running Claude terminal. Docker carries the
/// bytes directly; closing this window or losing the connection only detaches.
pub(crate) async fn attach(root: &Path, agent: &str, run_id: &str) -> Result<()> {
    ensure!(
        valid_id(agent) && valid_id(run_id),
        "Invalid agent or run ID."
    );
    ensure!(
        unsafe { libc::isatty(0) == 1 && libc::isatty(1) == 1 },
        "Open the Claude terminal from an interactive terminal window."
    );
    let meta = root
        .symlink_metadata()
        .context("The worker state directory is unavailable")?;
    ensure!(
        meta.is_dir() && meta.uid() == unsafe { libc::geteuid() } && meta.mode() & 0o077 == 0,
        "The runner state directory must be owned by this user and private (chmod 700)."
    );
    let root = root.canonicalize()?;
    let deadline = Instant::now() + STARTUP;
    let mut guard = None;
    let container = loop {
        if guard.is_none()
            && let Some(records) = existing_records(&root, agent)?
        {
            let file = lock_file(&records.join(format!("{run_id}.attach")))?;
            file.try_lock()
                .map_err(|_| anyhow!("This Claude terminal is already open in another window."))?;
            guard = Some((records, file));
        }
        if let Some((records, _)) = &guard
            && let Some(session) = load(records, run_id)?
            && session.state == State::Ready
            && let Some(id) = session.container.clone()
        {
            ensure!(
                session.agent == agent && session.run_id == run_id,
                "The Claude terminal record does not match this run."
            );
            let found = inspect(&id)
                .await
                .context("The Claude terminal is no longer running on this computer.")?;
            ensure!(
                session.owns(&found),
                "The Claude terminal container does not match this run."
            );
            ensure!(found.running, "The Claude terminal for this run has ended.");
            break id;
        }
        ensure!(
            Instant::now() < deadline,
            "The Claude terminal did not start in time. Check the run in the dashboard, then try again."
        );
        sleep(POLL).await;
    };
    let status = Process::new("docker")
        .args(["attach", "--sig-proxy=false", container.as_str()])
        .stdin(Stdio::inherit())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit())
        .kill_on_drop(true)
        .status()
        .await
        .context("Could not attach to the Claude terminal")?;
    drop(guard);
    if inspect(&container).await.is_ok_and(|found| found.running) {
        eprintln!("Detached. The Claude terminal keeps running; attach again to continue.");
    } else if status.success() {
        eprintln!("The Claude terminal session ended.");
    } else {
        eprintln!("The Claude terminal is no longer running.");
    }
    Ok(())
}

/// The headless argv minus its print-mode prefix, so tool, MCP, folder, and instruction
/// limits stay exactly those the profile compiles for headless runs.
fn interactive_arguments(snapshot: &Value) -> Result<Vec<String>> {
    ensure!(
        engine::harness(snapshot)? == "claude-code",
        "Choose the Claude Code harness to open a Claude terminal."
    );
    ensure!(
        snapshot["effectiveModel"]["baseUrl"]
            .as_str()
            .is_none_or(str::is_empty),
        "The Claude terminal signs in with Anthropic directly. Clear the custom endpoint for this agent, or start a regular task."
    );
    let mut argv = cli_protocol::arguments(snapshot)?;
    // Strip by position only: a flag-like value later in argv, such as instructions, stays intact.
    ensure!(
        argv.get(..HEADLESS.len())
            .is_some_and(|head| head.iter().zip(HEADLESS).all(|(a, b)| a == b)),
        "The Claude Code arguments changed. Update the terminal launcher."
    );
    argv.drain(1..HEADLESS.len());
    Ok(argv)
}

// A fresh grant gets a fresh Claude login even if an agent returns to a previous machine.
fn terminal_home(agent: &Path, grant: &str) -> PathBuf {
    agent
        .join("harnesses")
        .join(format!("{HOME_DIR}-{:x}", Sha256::digest(grant.as_bytes())))
}

fn create_arguments(
    session: &Session,
    agent_root: &Path,
    root: &Path,
    home: &Path,
    snapshot: &Value,
    folders: Vec<String>,
    image: &str,
) -> Result<Vec<String>> {
    let mut args = Vec::from(
        [
            "create",
            "--init",
            "--interactive",
            "--tty",
            "--log-driver",
            "none",
        ]
        .map(String::from),
    );
    args.extend(engine::container_flags(
        &container_name(session.command_id),
        &session.owner,
        &snapshot["computer"]["resources"],
    )?);
    let command = session.command_id.to_string();
    for (label, value) in [
        (AGENT_LABEL, session.agent.as_str()),
        (RUN_LABEL, session.run_id.as_str()),
        (COMMAND_LABEL, command.as_str()),
    ] {
        args.extend(["--label".into(), format!("{label}={value}")]);
    }
    for env in [
        "HOME=/home/agent",
        "CLAUDE_CONFIG_DIR=/home/agent/.claude",
        "DISABLE_AUTOUPDATER=1",
        "TERM=xterm-256color",
    ] {
        args.extend(["--env".into(), env.into()]);
    }
    for (source, target) in [
        (home.to_owned(), "target=/home/agent"),
        (agent_root.join("private"), "target=/workspace/private"),
        (root.join("shared"), "target=/workspace/shared"),
    ] {
        args.extend(["--mount".into(), engine::bind(&source, target, false)?]);
    }
    for mount in folders {
        args.extend(["--mount".into(), mount]);
    }
    args.extend(["--workdir".into(), "/workspace/shared".into(), image.into()]);
    args.extend(interactive_arguments(snapshot)?);
    Ok(args)
}

fn finish(waited: std::io::Result<std::process::Output>) -> Result<Value> {
    let output = waited.context("Could not monitor the Claude terminal")?;
    let code = String::from_utf8_lossy(&output.stdout)
        .trim()
        .parse::<i64>()
        .ok()
        .filter(|_| output.status.success());
    match code {
        Some(0) => Ok(json!({"text":"The Claude terminal session ended."})),
        Some(code) => bail!("Claude Code exited with code {code}."),
        None => Err(cli_protocol::Interrupted(
            "The Claude terminal ended before confirming it finished. Inspect its saved work before starting another.".into(),
        )
        .into()),
    }
}

async fn inspect(id: &str) -> Result<Identity> {
    container_id(id)?;
    parse_identity(
        &docker(
            &["inspect", "--type", "container", "--format", IDENTITY, id],
            10,
        )
        .await?,
    )
}

fn parse_identity(text: &str) -> Result<Identity> {
    let mut parts = text.trim().splitn(5, ' ');
    let mut next = || {
        parts
            .next()
            .context("Docker returned incomplete container details.")
    };
    let id = next()?.to_owned();
    let running = next()? == "true";
    let tty = next()? == "true";
    let stdin = next()? == "true";
    let labels = serde_json::from_str::<Option<BTreeMap<String, String>>>(next()?)
        .context("Docker returned unreadable container labels.")?
        .unwrap_or_default();
    Ok(Identity {
        id,
        running,
        tty,
        stdin,
        labels,
    })
}

fn container_name(command: Uuid) -> String {
    format!("open-harness-rust-{command}")
}

fn container_id(id: &str) -> Result<&str> {
    ensure!(
        id.len() == 64 && id.bytes().all(|b| b.is_ascii_hexdigit()),
        "Invalid container ID."
    );
    Ok(id)
}

fn valid_id(id: &str) -> bool {
    id.len() <= 80
        && id.starts_with(|c: char| c.is_ascii_alphanumeric())
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
}

fn record_name(run: &str) -> String {
    format!("{run}.json")
}

fn lock_file(path: &Path) -> Result<fs::File> {
    fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)
        .with_context(|| format!("Could not open {}", path.display()))
}

// Attach must not create agent state, and must refuse a directory replaced by a link.
fn existing_records(root: &Path, agent: &str) -> Result<Option<PathBuf>> {
    let records = root.join("agents").join(agent).join(RECORDS);
    for path in [
        root.join("agents"),
        root.join("agents").join(agent),
        records.clone(),
    ] {
        match path.symlink_metadata() {
            Ok(meta) => {
                ensure!(
                    meta.is_dir() && meta.uid() == unsafe { libc::geteuid() },
                    "Open Harness state for this agent must be a private directory."
                );
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error.into()),
        }
    }
    Ok(Some(records))
}

fn read_record(path: &Path) -> Result<Option<Session>> {
    let file = match fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)
    {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(error).context("The Claude terminal record is not a private file.");
        }
    };
    let meta = file.metadata()?;
    ensure!(
        meta.is_file()
            && meta.uid() == unsafe { libc::geteuid() }
            && meta.mode() & 0o077 == 0
            && meta.len() <= MAX_RECORD,
        "The Claude terminal record is not a private file."
    );
    let mut data = Vec::new();
    file.take(MAX_RECORD + 1).read_to_end(&mut data)?;
    ensure!(
        data.len() as u64 <= MAX_RECORD,
        "The Claude terminal record is too large."
    );
    Ok(Some(
        serde_json::from_slice(&data).context("The Claude terminal record is invalid.")?,
    ))
}

fn load(records: &Path, run: &str) -> Result<Option<Session>> {
    let lock = lock_file(&records.join(RECORDS_LOCK))?;
    lock.lock_shared()?;
    read_record(&records.join(record_name(run)))
}

fn save(records: &Path, session: &Session, prune: bool) -> Result<()> {
    let lock = lock_file(&records.join(RECORDS_LOCK))?;
    lock.lock()?;
    let own = record_name(&session.run_id);
    if prune {
        // One run per agent: anything else here is left over from a crash or restart.
        for entry in fs::read_dir(records)? {
            let entry = entry?;
            let name = entry.file_name();
            if name
                .to_str()
                .is_some_and(|n| n.ends_with(".json") && n != own)
                && !entry.file_type()?.is_dir()
            {
                fs::remove_file(entry.path())?;
            }
        }
    }
    write_private(&records.join(own), &serde_json::to_vec(session)?)
}

fn forget(records: &Path, run: &str, command: Uuid) -> Result<()> {
    let lock = lock_file(&records.join(RECORDS_LOCK))?;
    lock.lock()?;
    let path = records.join(record_name(run));
    if read_record(&path)?.is_some_and(|s| s.command_id == command) {
        fs::remove_file(&path)?;
        if let Err(error) = fs::remove_file(records.join(format!("{run}.attach")))
            && error.kind() != std::io::ErrorKind::NotFound
        {
            return Err(error.into());
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::{fs::PermissionsExt, process::ExitStatusExt};

    fn snapshot() -> Value {
        json!({
            "id": "agent-1", "harness": "claude-code",
            "computer": { "access": "folders", "desktop": "none",
                "folders": [{ "path": "/a", "mode": "read" }],
                "resources": { "memoryMb": 2048, "cpu": 2.0 } },
            "connectors": [],
            "allowedTools": ["terminal", "read_file"],
            "prompt": { "enabled": true, "text": "--print stays an instruction." },
            "effectiveModel": { "provider": "anthropic", "model": "model-1", "baseUrl": "", "credentialRef": "KEY" }
        })
    }

    fn session(container: Option<&str>) -> Session {
        Session {
            agent: "agent-1".into(),
            run_id: "run-1".into(),
            command_id: Uuid::nil(),
            owner: "machine-1".into(),
            container: container.map(str::to_owned),
            state: State::Ready,
        }
    }

    fn records() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        fs::set_permissions(dir.path(), fs::Permissions::from_mode(0o700)).unwrap();
        dir
    }

    #[test]
    fn interactive_arguments_drop_print_mode_and_keep_profile_limits() {
        let argv = interactive_arguments(&snapshot()).unwrap();
        assert_eq!(&argv[..3], ["claude", "--model", "model-1"]);
        for flag in ["--output-format", "stream-json", "--verbose"] {
            assert!(!argv.iter().any(|a| a == flag), "{flag}");
        }
        let after = |flag: &str| &argv[argv.iter().position(|a| a == flag).unwrap() + 1];
        assert_eq!(after("--tools"), "Bash,Read");
        assert_eq!(after("--allowedTools"), "Bash,Read");
        assert_eq!(after("--disallowedTools"), "mcp__*");
        assert_eq!(after("--permission-mode"), "dontAsk");
        assert!(argv.iter().any(|a| a == "--strict-mcp-config"));
        assert!(argv.iter().any(|a| a == "/workspace/mounts/folder-1"));
        assert_eq!(
            &argv[argv.len() - 2..],
            ["--append-system-prompt", "--print stays an instruction."]
        );

        let mut endpoint = snapshot();
        endpoint["effectiveModel"]["baseUrl"] = json!("https://llm.example");
        assert!(
            interactive_arguments(&endpoint)
                .unwrap_err()
                .to_string()
                .contains("signs in with Anthropic directly")
        );
        let mut codex = snapshot();
        codex["harness"] = json!("codex");
        assert!(interactive_arguments(&codex).is_err());
        let mut long = snapshot();
        long["prompt"]["text"] = json!("x".repeat(12_001));
        assert!(interactive_arguments(&long).is_err());
    }

    #[test]
    fn container_owns_its_tty_and_receives_no_credentials_or_logs() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        let agent = root.join("agents/agent-1");
        let home = terminal_home(&agent, "first-launch-grant");
        assert_ne!(home, terminal_home(&agent, "replacement-launch-grant"));
        let args = create_arguments(
            &session(None),
            &agent,
            root,
            &home,
            &snapshot(),
            vec!["type=bind,source=/a,target=/workspace/mounts/folder-1,readonly".into()],
            "sha256:image",
        )
        .unwrap();
        assert_eq!(
            &args[..6],
            [
                "create",
                "--init",
                "--interactive",
                "--tty",
                "--log-driver",
                "none"
            ]
        );
        for label in [
            format!("{}=machine-1", engine::OWNER_LABEL),
            format!("{AGENT_LABEL}=agent-1"),
            format!("{RUN_LABEL}=run-1"),
            format!("{COMMAND_LABEL}={}", Uuid::nil()),
        ] {
            assert!(args.contains(&label), "{label}");
        }
        assert!(
            !args
                .iter()
                .any(|a| a == "--env-file" || a.contains("API_KEY") || a.contains("BASE_URL"))
        );
        assert!(
            args.iter()
                .any(|a| a == "CLAUDE_CONFIG_DIR=/home/agent/.claude")
        );
        let mounts: Vec<&String> = args
            .windows(2)
            .filter(|w| w[0] == "--mount")
            .map(|w| &w[1])
            .collect();
        assert!(!args.iter().any(|arg| arg.contains("first-launch-grant")));
        assert_eq!(
            mounts[0],
            &format!("type=bind,source={},target=/home/agent", home.display())
        );
        assert!(mounts[1].ends_with("target=/workspace/private"));
        assert!(mounts[2].ends_with("target=/workspace/shared"));
        assert!(mounts[3].ends_with(",readonly"));
        let image = args.iter().position(|a| a == "sha256:image").unwrap();
        assert_eq!(
            args[image + 1..],
            interactive_arguments(&snapshot()).unwrap()
        );
    }

    #[test]
    fn identity_requires_matching_labels_and_an_interactive_tty() {
        let id = "a".repeat(64);
        let labels = serde_json::to_string(&BTreeMap::from([
            (engine::OWNER_LABEL, "machine-1".to_owned()),
            (AGENT_LABEL, "agent-1".to_owned()),
            (RUN_LABEL, "run-1".to_owned()),
            (COMMAND_LABEL, Uuid::nil().to_string()),
        ]))
        .unwrap();
        let found = parse_identity(&format!("{id} true true true {labels}\n")).unwrap();
        assert!(found.running && session(Some(id.as_str())).owns(&found));
        assert!(!session(Some("b".repeat(64).as_str())).owns(&found));
        let mut other = session(Some(id.as_str()));
        other.run_id = "run-2".into();
        assert!(!other.owns(&found));
        let detached = parse_identity(&format!("{id} true false true {labels}")).unwrap();
        assert!(!session(Some(id.as_str())).owns(&detached));
        let unlabeled = parse_identity(&format!("{id} false true true null")).unwrap();
        assert!(!unlabeled.running && !session(Some(id.as_str())).owns(&unlabeled));
        assert!(parse_identity("abc true").is_err());
        assert!(container_id(&id).is_ok() && container_id("../x").is_err());
    }

    #[test]
    fn records_are_private_scoped_to_their_run_and_never_follow_links() {
        let dir = records();
        let path = dir.path();
        let stale = Session {
            run_id: "old-run".into(),
            ..session(None)
        };
        save(path, &stale, false).unwrap();
        let current = session(Some("c".repeat(64).as_str()));
        save(path, &current, true).unwrap();
        assert_eq!(load(path, "old-run").unwrap(), None);
        assert_eq!(load(path, "run-1").unwrap(), Some(current.clone()));
        let file = path.join("run-1.json");
        assert_eq!(fs::metadata(&file).unwrap().mode() & 0o777, 0o600);

        forget(path, "run-1", Uuid::new_v4()).unwrap();
        assert!(file.exists(), "another command must not clear this run");
        forget(path, "run-1", Uuid::nil()).unwrap();
        assert!(!file.exists());

        let target = path.join("elsewhere");
        fs::write(&target, serde_json::to_vec(&current).unwrap()).unwrap();
        fs::set_permissions(&target, fs::Permissions::from_mode(0o600)).unwrap();
        std::os::unix::fs::symlink(&target, &file).unwrap();
        assert!(load(path, "run-1").is_err());
        fs::remove_file(&file).unwrap();
        fs::copy(&target, &file).unwrap();
        fs::set_permissions(&file, fs::Permissions::from_mode(0o644)).unwrap();
        assert!(load(path, "run-1").is_err());
        let secret = serde_json::to_string(&current).unwrap();
        assert!(!secret.contains("KEY") && !secret.contains("prompt"));
    }

    #[test]
    fn attach_refuses_missing_or_linked_state_and_a_second_writer() {
        let temp = records();
        let root = temp.path();
        assert!(existing_records(root, "agent-1").unwrap().is_none());
        fs::create_dir_all(root.join("agents/agent-1/claude-terminal")).unwrap();
        let records = existing_records(root, "agent-1").unwrap().unwrap();
        let first = lock_file(&records.join("run-1.attach")).unwrap();
        first.try_lock().unwrap();
        let second = lock_file(&records.join("run-1.attach")).unwrap();
        assert!(second.try_lock().is_err());
        drop(first);
        assert!(second.try_lock().is_ok());

        fs::create_dir(root.join("real")).unwrap();
        std::os::unix::fs::symlink(root.join("real"), root.join("agents/agent-2")).unwrap();
        assert!(existing_records(root, "agent-2").is_err());
        std::os::unix::fs::symlink(root.join("real"), records.join("linked.attach")).unwrap();
        assert!(lock_file(&records.join("linked.attach")).is_err());
        assert!(!valid_id("../agent") && !valid_id("-run") && valid_id("run_1-a"));
    }

    #[test]
    fn exit_codes_complete_fail_or_interrupt() {
        let output = |raw: i32, out: &str| {
            Ok(std::process::Output {
                status: std::process::ExitStatus::from_raw(raw),
                stdout: out.as_bytes().to_vec(),
                stderr: Vec::new(),
            })
        };
        assert_eq!(
            finish(output(0, "0\n")).unwrap(),
            json!({"text":"The Claude terminal session ended."})
        );
        assert_eq!(
            finish(output(0, "137\n")).unwrap_err().to_string(),
            "Claude Code exited with code 137."
        );
        assert!(
            finish(output(256, ""))
                .unwrap_err()
                .downcast_ref::<cli_protocol::Interrupted>()
                .is_some()
        );
    }
}
