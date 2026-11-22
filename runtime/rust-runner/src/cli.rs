use anyhow::{Context, Result, anyhow, bail, ensure};
use serde_json::{Value, json};
use std::{path::Path, process::Stdio, time::Duration};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, BufReader},
    process::Command as Process,
    sync::{mpsc, watch},
    time::sleep,
};

use crate::{
    additional_cli, agent_dir, cli_protocol, directory,
    engine::{self, Keys},
    hermes::{Control, docker, remove_container},
    outbox::Outbox,
    protocol::Command,
    required_str,
};

pub async fn run(
    root: &Path,
    command: &Command,
    machine: &str,
    outbox: &Outbox,
    mut controls: mpsc::Receiver<Control>,
    mut shutdown: watch::Receiver<bool>,
    secrets: Keys,
) -> Result<Value> {
    let snapshot = &command.payload["snapshot"];
    let agent = required_str(snapshot, "id")?;
    ensure!(
        command.agent_id.as_deref() == Some(agent),
        "Run profile belongs to a different agent."
    );
    let harness = engine::harness(snapshot)?;
    let launch = cli_protocol::launch(snapshot)?;
    ensure!(
        launch.harness == harness,
        "Run profile uses a different harness."
    );
    if snapshot["modelAuth"] == "chatgpt-plan" {
        return crate::plan_run::run(
            root,
            command,
            machine,
            outbox,
            controls,
            shutdown,
            launch.args,
        )
        .await;
    }
    let run_id = required_str(&command.payload, "runId")?;
    let prompt = required_str(&command.payload, "prompt")?;
    let model = &snapshot["effectiveModel"];
    let reference = match &launch.config {
        Some(config) => config.model.credential_ref,
        None => required_str(model, "credentialRef")?,
    };
    let credential = secrets
        .get(reference)
        .map(String::as_str)
        .filter(|key| !key.is_empty());
    ensure!(
        credential.is_some() || (launch.config.is_some() && reference.is_empty()),
        "Save a model credential for this agent before starting work."
    );
    let stream_key = launch.config.as_ref().and(credential).unwrap_or_default();
    let mut vars = match harness {
        "codex" => vec![("CODEX_API_KEY", credential.unwrap_or_default())],
        "claude-code" => vec![
            ("ANTHROPIC_API_KEY", credential.unwrap_or_default()),
            ("DISABLE_AUTOUPDATER", "1"),
        ],
        _ => credential
            .into_iter()
            .map(|key| (additional_cli::MODEL_KEY, key))
            .collect(),
    };
    if harness == "claude-code"
        && let Some(url) = model["baseUrl"].as_str().filter(|s| !s.is_empty())
    {
        vars.push(("ANTHROPIC_BASE_URL", url));
    }
    let agent_root = agent_dir(root, agent)?;
    let config_dir = if let Some(config) = &launch.config {
        let directory = engine::config_directory(root)?;
        additional_cli::write_config(
            harness,
            directory.path(),
            &config.model,
            &config.tools,
            config.instructions,
        )?;
        Some(directory)
    } else {
        None
    };
    let name = format!("open-harness-rust-{}", command.id);
    let session = command.id.to_string();
    let image = engine::prepare_image(harness, &mut controls, &mut shutdown).await?;
    let env = engine::environment_file(root, &vars)?;
    let input = engine::prompt_file(root, prompt)?;
    let mut args = vec![
        "create".into(),
        "--init".into(),
        "--log-driver".into(),
        "none".into(),
    ];
    args.extend(engine::container_flags(
        &name,
        machine,
        &snapshot["computer"]["resources"],
    )?);
    args.extend([
        "--env-file".into(),
        env.path()
            .to_str()
            .context("Invalid environment path")?
            .into(),
        "-e".into(),
        "HOME=/home/agent".into(),
    ]);
    if let Some(config_dir) = &config_dir {
        let uid = unsafe { libc::geteuid() };
        let gid = unsafe { libc::getegid() };
        args.extend([
            "--mount".into(),
            engine::bind(config_dir.path(), "target=/run/open-harness", true)?,
            "--tmpfs".into(),
            format!("/home/agent:rw,nosuid,nodev,mode=0700,uid={uid},gid={gid}"),
        ]);
        if harness == "opencode" {
            for assignment in [
                "OPENCODE_CONFIG=/run/open-harness/opencode.json",
                "OPENCODE_DISABLE_PROJECT_CONFIG=1",
                "OPENCODE_DISABLE_EXTERNAL_SKILLS=1",
                "OPENCODE_DISABLE_MODELS_FETCH=1",
                "OPENCODE_DISABLE_AUTOUPDATE=1",
                "OPENCODE_DISABLE_LSP_DOWNLOAD=1",
            ] {
                args.extend(["-e".into(), assignment.into()]);
            }
        }
    } else {
        directory(&agent_root.join("harnesses"))?;
        let home = agent_root.join("harnesses").join(harness);
        directory(&home)?;
        directory(&home.join(if harness == "codex" {
            ".codex"
        } else {
            ".claude"
        }))?;
        args.extend([
            "-e".into(),
            "CODEX_HOME=/home/agent/.codex".into(),
            "-e".into(),
            "CLAUDE_CONFIG_DIR=/home/agent/.claude".into(),
            "--mount".into(),
            engine::bind(&home, "target=/home/agent", false)?,
        ]);
    }
    for (src, target) in [
        (agent_root.join("private"), "target=/workspace/private"),
        (root.join("shared"), "target=/workspace/shared"),
    ] {
        args.extend(["--mount".into(), engine::bind(&src, target, false)?]);
    }
    for mount in engine::folder_mounts(root, snapshot).await? {
        args.extend(["--mount".into(), mount]);
    }
    let workdir = if matches!(harness, "opencode" | "openhands") {
        "/workspace"
    } else {
        "/workspace/shared"
    };
    // Both Docker and containerd can open this file as stdin, regardless of attach/EOF behavior.
    args.extend([
        "--mount".into(),
        engine::bind(input.path(), "target=/run/open-harness-prompt", true)?,
        "--workdir".into(),
        workdir.into(),
        "--entrypoint".into(),
        "/bin/sh".into(),
        image,
        "-c".into(),
        r#"exec "$@" < /run/open-harness-prompt"#.into(),
        "open-harness-input".into(),
    ]);
    args.extend(launch.args);
    let mut stop_reply = None;
    let result=async {
        let args=args.iter().map(String::as_str).collect::<Vec<_>>();
        docker(&args,90).await.context("Create isolated agent container")?;
        // Docker has copied the file into the container configuration. Its plaintext copy can go now.
        drop(env);
        let mut child=Process::new("docker").args(["start","--attach",&name])
            .stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null()).kill_on_drop(true).spawn().context("Attach to headless agent container")?;
        let stdout=child.stdout.take().context("Missing agent output")?;
        let mut lines=BufReader::new(stdout);
        let deadline=sleep(Duration::from_secs(24*60*60));
        tokio::pin!(deadline);
        let mut output=cli_protocol::Output::new(harness);
        let mut pending_text=String::new();
        outbox.event(command.id,run_id,json!({"type":"gateway.ready","session_id":session,"payload":{"harness":harness}}))?;
        let mut done=false;
        let mut buffer=Vec::new();
        loop {
            tokio::select! {
                _=shutdown.wait_for(|v|*v)=>bail!("The runner stopped during execution."),
                _=&mut deadline=>bail!("The harness timed out before confirming completion."),
                Some(control)=controls.recv()=>{
                    if control.command.kind=="stop" {stop_reply=Some(control.reply); bail!("This run was stopped before execution completed.");}
                    let _=control.reply.send(Err(anyhow!("This harness supports stopping an active task. Submit another message after it finishes.")));
                }
                result=async { (&mut lines).take((4_900_001-buffer.len()) as u64).read_until(b'\n', &mut buffer).await }, if !done=>{
                    let count=result?;
                    ensure!(buffer.len()<=4_900_000,"Harness stream record is too large.");
                    if count==0 {done=true;continue;}
                    if let Ok(mut value)=serde_json::from_slice::<Value>(&buffer) {
                        engine::redact(&mut value,&secrets);
                        for mut event in output.accept(&value) {
                            if event["type"] == "message.delta"
                                && !stream_key.is_empty()
                                && let Some(text) = event["payload"]["text"].as_str()
                            {
                                let safe = crate::plan_run::stream_text(&mut pending_text, text, stream_key);
                                if safe.is_empty() { continue; }
                                event["payload"]["text"] = safe.into();
                            }
                            engine::redact(&mut event["payload"], &secrets);
                            event["session_id"]=session.as_str().into();
                            outbox.event(command.id,run_id,event)?;
                        }
                    }
                    buffer.clear();
                }
                status=child.wait(), if done=>{
                    let mut result = output.finish(status?.code())?;
                    engine::redact(&mut result, &secrets);
                    if !pending_text.is_empty() {
                        outbox.event(command.id, run_id, json!({
                            "type":"message.delta","session_id":session,"payload":{"text":pending_text}
                        }))?;
                    }
                    return Ok(result);
                },
            }
        }
    }.await;
    let cleanup = remove_container(&name).await;
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
