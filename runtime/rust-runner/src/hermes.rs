use anyhow::{Context, Result, anyhow, bail, ensure};
use serde_json::{Value, json};
use std::{collections::BTreeMap, path::Path, process::Stdio, time::Duration};
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Lines},
    process::{ChildStdin, ChildStdout, Command as Process},
    sync::{mpsc, oneshot, watch},
    time::{Instant, sleep_until, timeout},
};
use uuid::Uuid;

use crate::{
    engine::{self, Keys},
    outbox::Outbox,
    profile,
    protocol::{Command, Coordinator},
    required_str,
};

const GATEWAY: &str = "/opt/open-harness/managed_entry.py";
const START_TIMEOUT: Duration = Duration::from_secs(90);
const SESSION_TIMEOUT: Duration = Duration::from_secs(300);
const PROMPT_TIMEOUT: Duration = Duration::from_secs(24 * 60 * 60);

pub struct Control {
    pub command: Command,
    pub reply: oneshot::Sender<Result<Value>>,
}

pub async fn docker_ready() -> bool {
    if engine::mock() {
        return true;
    }
    docker(&["info", "--format", "{{.ServerVersion}}"], 10)
        .await
        .is_ok()
}

pub async fn image() -> Result<String> {
    let tag = engine::image_tag("hermes")?;
    let result = docker(
        &[
            "image",
            "inspect",
            "--format",
            "{{.Id}} {{index .Config.Labels \"dev.openharness.runtime\"}}",
            &tag,
        ],
        10,
    )
    .await
    .context("Install the pinned Open Harness Hermes image on this runner first")?;
    let (id, actual_contract) = result
        .trim()
        .split_once(' ')
        .context("Invalid Hermes image metadata")?;
    ensure!(
        actual_contract == "3",
        "The Hermes image has an outdated runtime contract. Rebuild it from this checkout."
    );
    engine::image_id(id)?;
    Ok(id.to_owned())
}

pub(crate) async fn docker(args: &[&str], seconds: u64) -> Result<String> {
    let output = timeout(
        Duration::from_secs(seconds),
        Process::new("docker")
            .args(args)
            .stdin(Stdio::null())
            .kill_on_drop(true)
            .output(),
    )
    .await
    .context("Docker did not respond in time")?
    .context("Could not run Docker")?;
    ensure!(output.status.success(), "Docker {} failed.", args[0]);
    Ok(String::from_utf8(output.stdout)?)
}

pub async fn reap(machine: &str) -> Result<()> {
    let filter = format!("label={}={machine}", engine::OWNER_LABEL);
    let containers = docker(&["ps", "--all", "--quiet", "--filter", &filter], 10).await?;
    for id in containers.split_whitespace() {
        ensure!(
            id.len() >= 12 && id.bytes().all(|byte| byte.is_ascii_hexdigit()),
            "Invalid container ID."
        );
        docker(&["rm", "--force", id], 60).await?;
    }
    Ok(())
}

pub fn validate_profile(snapshot: &Value) -> Result<()> {
    ensure!(
        engine::harness(snapshot)? == "hermes",
        "Choose the Hermes harness for this gateway."
    );
    Ok(())
}

pub async fn run(
    root: &Path,
    command: &Command,
    coordinator: &Coordinator,
    outbox: &Outbox,
    mut controls: mpsc::Receiver<Control>,
    mut shutdown: watch::Receiver<bool>,
    secrets: Keys,
) -> Result<Value> {
    let payload = &command.payload;
    let snapshot = &payload["snapshot"];
    validate_profile(snapshot)?;
    let agent = required_str(snapshot, "id")?;
    ensure!(
        command.agent_id.as_deref() == Some(agent),
        "Run profile does not match the assigned agent."
    );
    let agent_dir = crate::agent_dir(root, agent)?;
    let image = engine::prepare_image("hermes", &mut controls, &mut shutdown).await?;
    let run_id = required_str(payload, "runId")?;
    let prompt = required_str(payload, "prompt")?;
    let token = required_str(payload, "coordinationToken")?;

    profile::prepare(
        root,
        snapshot,
        &secrets,
        coordinator.url.as_str(),
        token,
        run_id,
    )?;
    let _relay = if profile::coordination_enabled(snapshot) {
        crate::relay::Relay::listen(
            &agent_dir.join("managed"),
            coordinator.url.clone(),
            agent,
            run_id,
            token,
        )
        .await?
    } else {
        None
    };

    let name = format!("open-harness-rust-{}", command.id);
    let mut stop_reply = None;
    let result = async {
        create_container(
            root,
            &agent_dir,
            &name,
            &coordinator.container_owner,
            &image,
            snapshot,
        )
        .await?;
        let mut child = Process::new("docker")
            .args([
                "exec",
                "-i",
                "-e",
                "HERMES_GATEWAY_SESSION=1",
                &name,
                "python",
                GATEWAY,
            ])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .spawn()
            .context("Could not start the Hermes gateway")?;
        let gateway = Gateway {
            input: child.stdin.take().context("Missing gateway input")?,
            output: BufReader::new(child.stdout.take().context("Missing gateway output")?).lines(),
            controls,
            shutdown,
            stop_reply: &mut stop_reply,
            command: command.id,
            run: run_id,
            outbox,
            secrets: &secrets,
        };
        gateway.run(prompt).await
    }
    .await;

    // Force-removing just this disposable container also reaps tools launched
    // by its gateway. Agent files and profile state live in per-agent mounts.
    let cleanup = remove_container(&name).await;
    if let Some(reply) = stop_reply {
        let outcome = cleanup
            .as_ref()
            .map(|_| json!({"ok": true}))
            .map_err(|_| anyhow!("Docker could not confirm the agent container stopped."));
        let _ = reply.send(outcome);
    }
    if let Err(error) = &cleanup {
        eprintln!("Could not confirm cleanup of {name}: {error}");
    }
    let mut result = result.map_err(|err| {
        let mut message = json!(format!("{err:#}"));
        engine::redact(&mut message, &secrets);
        anyhow!("{}", message.as_str().unwrap_or("Runtime error"))
    })?;
    engine::redact(&mut result, &secrets);
    cleanup.map(|_| result)
}

pub(crate) async fn create_container(
    root: &Path,
    agent: &Path,
    name: &str,
    machine: &str,
    image: &str,
    snapshot: &Value,
) -> Result<()> {
    let mut args = vec!["run".to_owned(), "--detach".to_owned()];
    args.extend(engine::container_flags(
        name,
        machine,
        &snapshot["computer"]["resources"],
    )?);
    args.extend(["--env".into(), "HOME=/workspace/private".into()]);
    for (source, target, readonly) in [
        (agent.join("managed"), "target=/run/open-harness", true),
        (agent.join("profile"), "target=/home/hermes/.hermes", false),
        (agent.join("private"), "target=/workspace/private", false),
        (root.join("shared"), "target=/workspace/shared", false),
    ] {
        args.extend(["--mount".into(), engine::bind(&source, target, readonly)?]);
    }
    for mount in engine::folder_mounts(root, snapshot).await? {
        args.extend(["--mount".into(), mount]);
    }
    args.push(image.to_owned());
    let args = args.iter().map(String::as_str).collect::<Vec<_>>();
    docker(&args, 90)
        .await
        .context("Could not start an isolated Hermes container")?;
    Ok(())
}

pub(crate) async fn remove_container(name: &str) -> Result<()> {
    let filter = format!("name=^/{name}$");
    for retry in [true, false] {
        match docker(&["rm", "--force", name], 60).await {
            Ok(_) => return Ok(()),
            Err(error) => {
                // A timed-out disconnect can still leave the daemon finishing the removal.
                let listed = docker(&["ps", "--all", "--quiet", "--filter", &filter], 30).await;
                if listed.as_deref().is_ok_and(|ids| ids.trim().is_empty()) {
                    return Ok(());
                }
                if !retry {
                    return Err(error.context("Could not confirm removal of the agent container"));
                }
            }
        }
    }
    Ok(())
}

struct Gateway<'a> {
    input: ChildStdin,
    output: Lines<BufReader<ChildStdout>>,
    controls: mpsc::Receiver<Control>,
    shutdown: watch::Receiver<bool>,
    stop_reply: &'a mut Option<oneshot::Sender<Result<Value>>>,
    command: Uuid,
    run: &'a str,
    outbox: &'a Outbox,
    secrets: &'a Keys,
}

impl Gateway<'_> {
    async fn send(input: &mut ChildStdin, id: &str, method: &str, params: Value) -> Result<()> {
        let mut request =
            serde_json::to_vec(&json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}))?;
        request.push(b'\n');
        timeout(Duration::from_secs(3), input.write_all(&request)).await??;
        Ok(())
    }

    async fn run(mut self, prompt: &str) -> Result<Value> {
        let mut deadline = Instant::now() + START_TIMEOUT;
        let mut session_requested = false;
        let mut prompt_sent = false;
        let mut session = String::new();
        let mut replies = BTreeMap::<String, oneshot::Sender<Result<Value>>>::new();
        loop {
            tokio::select! {
                _ = sleep_until(deadline) => bail!("Hermes did not confirm {} in time.", if prompt_sent { "prompt completion" } else if session_requested { "session creation" } else { "gateway startup" }),
                _ = async { let _ = self.shutdown.wait_for(|stop| *stop).await; } => bail!("The runner shut down during execution."),
                Some(control) = self.controls.recv() => {
                    let payload = &control.command.payload;
                    let id = control.command.id.to_string();
                    if control.command.kind == "stop" {
                        if !session.is_empty() {
                            let _ = Self::send(&mut self.input, &id, "session.interrupt", json!({"session_id":session})).await;
                        }
                        *self.stop_reply = Some(control.reply);
                        bail!("This run was stopped before execution completed.");
                    }
                    if session.is_empty() {
                        let _ = control.reply.send(Err(anyhow!("The run is still starting.")));
                        continue;
                    }
                    let (method, params) = if control.command.kind == "steer" {
                        ("session.steer", json!({"session_id": session, "text":payload["text"]}))
                    } else {
                        let choice = match payload["decision"].as_str() {
                            Some("approve" | "once") => "once",
                            Some("session") => "session",
                            Some("always") => "always",
                            _ => "deny",
                        };
                        ("approval.respond", json!({"session_id": session, "request_id": payload["requestId"], "choice": choice, "all": false}))
                    };
                    Self::send(&mut self.input, &id, method, params).await?;
                    replies.retain(|_, reply| !reply.is_closed());
                    replies.insert(id, control.reply);
                }
                line = self.output.next_line() => {
                    let line = line?.context("Hermes exited before confirming completion")?;
                    let Ok(value) = serde_json::from_str::<Value>(&line) else { continue; };
                    if let Some(id) = value["id"].as_str() {
                        let response = if value["error"].is_null() { Ok(value["result"].clone()) } else {
                            Err(anyhow!("{}", value["error"]["message"].as_str().unwrap_or("Hermes rejected the request.")))
                        };
                        match id {
                            "session" => {
                                let result = response?;
                                session = result["session_id"].as_str().or_else(|| result["id"].as_str())
                                    .filter(|id| !id.is_empty()).context("Hermes returned no session ID")?.to_owned();
                                Self::send(&mut self.input, "prompt", "prompt.submit", json!({"session_id": session, "text": prompt})).await?;
                                deadline = Instant::now() + PROMPT_TIMEOUT;
                                prompt_sent = true;
                            }
                            "prompt" => {
                                let result = response?;
                                if result["status"] != "streaming" {
                                    return Ok(result);
                                }
                            }
                            _ => if let Some(reply) = replies.remove(id) {
                                let _ = reply.send(response.map(|_| json!({"ok": true})));
                            }
                        }
                        continue;
                    }
                    let event = if value["method"] == "event" { &value["params"] } else {
                        value.pointer("/params/event").unwrap_or(&value)
                    };
                    let Some(kind) = event["type"].as_str() else { continue; };
                    let mut safe_event = event.clone(); engine::redact(&mut safe_event,self.secrets);
                    self.outbox.event(self.command, self.run, safe_event)?;
                    if kind == "gateway.ready" && !session_requested {
                        session_requested = true;
                        deadline = Instant::now() + SESSION_TIMEOUT;
                        Self::send(&mut self.input, "session", "session.create", json!({"cwd": "/workspace/shared", "profile": "default"})).await?;
                    }
                    if !prompt_sent || event["session_id"] != session {
                        continue;
                    }
                    let payload = &event["payload"];
                    if kind == "error" {
                        bail!("{}", payload["message"].as_str().unwrap_or("Hermes execution failed."));
                    }
                    if kind == "message.complete" {
                        if matches!(payload["status"].as_str(), Some("error" | "interrupted")) {
                            bail!("{}", payload["error"].as_str().or_else(|| payload["text"].as_str()).unwrap_or("Hermes execution was interrupted."));
                        }
                        return Ok(payload.clone());
                    }
                }
            }
        }
    }
}
