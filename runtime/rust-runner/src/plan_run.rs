//! One worker lease drives exactly one Codex app-server turn over private stdio.
use crate::{
    agent_dir,
    cli_protocol::Interrupted,
    engine,
    hermes::{Control, docker, remove_container},
    outbox::Outbox,
    protocol::Command,
    required_str,
};
use anyhow::{Context, Result, ensure};
use serde_json::{Value, json};
use std::{path::Path, process::Stdio, time::Duration};
use tokio::io::{AsyncBufReadExt, AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::{
    process::Command as Process,
    sync::{mpsc, watch},
    time::{sleep, timeout},
};

const MAX_RECORD: usize = 4_900_000;

pub(crate) async fn run(
    root: &Path,
    command: &Command,
    machine: &str,
    outbox: &Outbox,
    mut controls: mpsc::Receiver<Control>,
    mut shutdown: watch::Receiver<bool>,
    argv: Vec<String>,
) -> Result<Value> {
    let snapshot = &command.payload["snapshot"];
    let agent = required_str(snapshot, "id")?;
    let model = required_str(&snapshot["effectiveModel"], "model")?;
    let run_id = required_str(&command.payload, "runId")?;
    let prompt = required_str(&command.payload, "prompt")?;
    let name = format!("open-harness-rust-{}", command.id);
    let area = agent_dir(root, agent)?;
    let image = engine::prepare_image("codex", &mut controls, &mut shutdown).await?;
    let mut create = vec![
        "create".to_string(),
        "--init".into(),
        "--log-driver".into(),
        "none".into(),
    ];
    create.extend(engine::container_flags(
        &name,
        machine,
        &snapshot["computer"]["resources"],
    )?);
    // app-server has no --ignore-user-config. Its home lives only for this run,
    // separately from both the agent's work and the worker's OAuth store.
    create.extend([
        "--tmpfs".into(),
        format!(
            "/home/agent:rw,nosuid,nodev,mode=0700,uid={},gid={}",
            unsafe { libc::geteuid() },
            unsafe { libc::getegid() }
        ),
        "-e".into(),
        "HOME=/home/agent".into(),
        "-e".into(),
        "CODEX_HOME=/home/agent".into(),
        "-e".into(),
        "RUST_LOG=off".into(),
    ]);
    for (source, mount) in [
        (area.join("private"), "target=/workspace/private"),
        (root.join("shared"), "target=/workspace/shared"),
    ] {
        create.extend(["--mount".into(), engine::bind(&source, mount, false)?]);
    }
    for mount in engine::folder_mounts(root, snapshot).await? {
        create.extend(["--mount".into(), mount]);
    }
    create.extend([
        "--workdir".into(),
        "/".into(),
        "--entrypoint".into(),
        "/bin/sleep".into(),
        image,
        "infinity".into(),
    ]);
    let mut stop_reply = None;
    let mut container_requested = false;
    let result = {
        let operation = async {
            let binding = required_str(snapshot, "planBinding")?;
            let token = crate::plan_auth::access_token(root, agent, binding).await?;
            let secrets = engine::Keys::from([("plan".into(), token.clone())]);
            container_requested = true;
            docker(&create.iter().map(String::as_str).collect::<Vec<_>>(), 30)
                .await
                .context("Create isolated Codex container")?;
            docker(&["start", &name], 30)
                .await
                .context("Start isolated Codex container")?;
            let mut child = Process::new("docker")
                .args(["exec", "-i", &name])
                .args(argv)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .kill_on_drop(true)
                .spawn()
                .context("Start Codex app-server")?;
            let input = child.stdin.take().context("Missing Codex input")?;
            let output = child.stdout.take().context("Missing Codex output")?;
            let emit = |mut event: Value| {
                event["session_id"] = command.id.to_string().into();
                engine::redact(&mut event, &secrets);
                outbox.event(command.id, run_id, event)
            };
            let mut pending = String::new();
            let result = conversation(input, output, model, prompt, &token, |mut event| {
                if event["type"] == "message.delta" {
                    let safe = stream_text(
                        &mut pending,
                        event["payload"]["text"].as_str().unwrap_or_default(),
                        &token,
                    );
                    if safe.is_empty() {
                        return Ok(());
                    }
                    event["payload"]["text"] = safe.into();
                }
                emit(event)
            })
            .await;
            if result.as_ref().is_err_and(|e| e.is::<SignInRequired>()) {
                crate::plan_auth::mark_rejected(root, agent, binding, &token).await?;
            }
            let mut result = result?;
            if !pending.is_empty() {
                emit(json!({"type":"message.delta","payload":{"text":pending}}))?;
            }
            let status = timeout(Duration::from_secs(15), child.wait())
                .await
                .map_err(|_| interrupted())??;
            if !status.success() {
                return Err(interrupted());
            }
            engine::redact(&mut result, &secrets);
            Ok(result)
        };
        tokio::pin!(operation);
        let deadline = sleep(Duration::from_secs(24 * 60 * 60));
        tokio::pin!(deadline);
        loop {
            tokio::select! {
                result=&mut operation=>break result,
                _=shutdown.wait_for(|v|*v)=>break Err(interrupted()),
                _=&mut deadline=>break Err(interrupted()),
                Some(control)=controls.recv()=>{
                    if control.command.kind=="stop"{stop_reply=Some(control.reply);break Err(anyhow::anyhow!("This run was stopped."));}
                    let _=control.reply.send(Err(anyhow::anyhow!("Submit another message after the current Codex turn ends.")));
                }
            }
        }
    };
    let cleanup = if container_requested {
        remove_container(&name).await
    } else {
        Ok(())
    };
    if let Some(reply) = stop_reply {
        let _ = reply.send(
            cleanup
                .as_ref()
                .map(|_| json!({"ok":true}))
                .map_err(|_| anyhow::anyhow!("Docker could not confirm the agent stopped.")),
        );
    }
    cleanup?;
    result
}

async fn send(input: &mut (impl AsyncWrite + Unpin), request: Value) -> Result<()> {
    let mut data = serde_json::to_vec(&request)?;
    data.push(b'\n');
    input.write_all(&data).await?;
    input.flush().await?;
    Ok(())
}

/// A provider may divide an echoed credential between arbitrary message deltas.
/// Hold only a trailing partial match so ordinary text still streams immediately.
fn stream_text(pending: &mut String, delta: &str, token: &str) -> String {
    pending.push_str(delta);
    let Some(first) = token.chars().next() else {
        return std::mem::take(pending);
    };
    let mut safe = pending.replace(token, "[redacted]");
    pending.clear();
    let mut start = safe.len().saturating_sub(token.len() - 1);
    while !safe.is_char_boundary(start) {
        start += 1;
    }
    if let Some((at, _)) = safe[start..]
        .match_indices(first)
        .find(|(offset, _)| token.starts_with(&safe[start + offset..]))
    {
        *pending = safe.split_off(start + at);
    }
    safe
}

#[derive(Debug)]
pub(crate) struct SignInRequired;
impl std::fmt::Display for SignInRequired {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(
            "ChatGPT declined the worker's access token. Sign in again on the assigned worker.",
        )
    }
}
impl std::error::Error for SignInRequired {}

fn provider_error(error: &Value) -> anyhow::Error {
    let info = &error["codexErrorInfo"];
    let status = info
        .as_object()
        .and_then(|o| o.values().find_map(|v| v["httpStatusCode"].as_u64()));
    let message = error["message"]
        .as_str()
        .unwrap_or_default()
        .to_ascii_lowercase();
    if info == "usageLimitExceeded"
        || info == "rateLimitExceeded"
        || status == Some(429)
        || message.contains("usage limit")
        || message.contains("quota")
    {
        anyhow::anyhow!(
            "ChatGPT plan usage limit reached. Review your allowance at https://chatgpt.com/settings/usage."
        )
    } else if status == Some(403) || message.contains("403 forbidden") {
        anyhow::anyhow!(
            "The ChatGPT workspace declined access to this model. Check your workspace permissions."
        )
    } else if info == "unauthorized" || status == Some(401) {
        SignInRequired.into()
    } else {
        // The server can echo request configuration in an error. Provider data never goes into the outbox.
        anyhow::anyhow!(
            "Codex could not complete the ChatGPT plan request. Check model access and the connection on the worker."
        )
    }
}

fn interrupted() -> anyhow::Error {
    Interrupted("Codex stopped before confirming the turn. Inspect the agent workspace before submitting another run.".into()).into()
}

async fn conversation(
    mut input: impl AsyncWrite + Unpin,
    stdout: impl AsyncRead + Unpin,
    model: &str,
    prompt: &str,
    token: &str,
    mut emit: impl FnMut(Value) -> Result<()>,
) -> Result<Value> {
    let mut output = BufReader::new(stdout);
    send(&mut input,json!({"id":1,"method":"initialize","params":{"clientInfo":{"name":"open_harness","title":"Open Harness","version":env!("CARGO_PKG_VERSION")}}})).await?;
    let mut expected = 1;
    let mut thread = String::new();
    let mut turn = String::new();
    let mut text = String::new();
    let mut item_id = String::new();
    let mut streamed = false;
    let mut buffer = Vec::new();
    loop {
        let n = (&mut output)
            .take((MAX_RECORD + 1) as u64)
            .read_until(b'\n', &mut buffer)
            .await
            .map_err(|_| interrupted())?;
        if n == 0 || buffer.len() > MAX_RECORD || !buffer.ends_with(b"\n") {
            return Err(interrupted());
        }
        let msg: Value = serde_json::from_slice(&buffer).map_err(|_| interrupted())?;
        buffer.clear();
        let method = msg["method"].as_str().unwrap_or_default();
        if !method.is_empty() && !msg["id"].is_null() {
            // No client tools, approvals or credential requests are enabled for this adapter.
            send(&mut input,json!({"id":msg["id"],"error":{"code":-32601,"message":"Request unavailable on this worker."}})).await?;
            continue;
        }
        if method.is_empty() {
            ensure!(
                msg["id"].as_i64() == Some(expected) && expected <= 3,
                "Unexpected Codex response."
            );
            if let Some(error) = msg.get("error") {
                return Err(provider_error(error));
            }
            let result = msg
                .get("result")
                .context("Missing Codex response result.")?;
            match expected {
                1 => {
                    send(&mut input, json!({"method":"initialized","params":{}})).await?;
                    // The pinned provider supports an in-memory bearer override. Deliver it only
                    // over this pipe, outside argv, process environments, and the persistent workspace.
                    send(&mut input,json!({"id":2,"method":"thread/start","params":{
                        "model":model,"modelProvider":"openai_chatgpt_plan","cwd":"/workspace/shared",
                        "approvalPolicy":"never","sandbox":"danger-full-access","ephemeral":true,
                        "config":{"model_providers.openai_chatgpt_plan.experimental_bearer_token":token}
                    }})).await?;
                }
                2 => {
                    thread = result
                        .pointer("/thread/id")
                        .and_then(Value::as_str)
                        .filter(|s| !s.is_empty())
                        .context("Missing Codex thread ID.")?
                        .to_owned();
                    emit(
                        json!({"type":"gateway.ready","payload":{"harness":"codex","threadId":thread}}),
                    )?;
                    send(&mut input,json!({"id":3,"method":"turn/start","params":{"threadId":thread,"input":[{"type":"text","text":prompt}]}})).await.map_err(|_|interrupted())?;
                }
                3 => {
                    let id = result
                        .pointer("/turn/id")
                        .and_then(Value::as_str)
                        .filter(|s| !s.is_empty())
                        .context("Missing Codex turn ID.")?;
                    ensure!(turn.is_empty() || turn == id, "Unexpected Codex turn.");
                    turn = id.to_owned();
                }
                _ => unreachable!(),
            }
            expected += 1;
            continue;
        }
        if thread.is_empty() || msg["params"]["threadId"] != thread {
            continue;
        }
        let params = &msg["params"];
        if method == "turn/started" && turn.is_empty() {
            if let Some(id) = params.pointer("/turn/id").and_then(Value::as_str) {
                turn = id.to_string();
            }
            continue;
        }
        if turn.is_empty() {
            continue;
        }
        if method == "turn/completed" && params["turn"]["id"] == turn {
            return match params["turn"]["status"].as_str() {
                Some("completed") => Ok(json!({"text":text,"threadId":thread,"turnId":turn})),
                Some("failed") => Err(provider_error(&params["turn"]["error"])),
                _ => Err(interrupted()),
            };
        }
        if params["turnId"] != turn {
            continue;
        }
        let event = match method {
            "item/agentMessage/delta" => {
                let id = params["itemId"].as_str().unwrap_or_default();
                if item_id != id {
                    text.clear();
                    item_id = id.to_string();
                }
                let delta = params["delta"].as_str().unwrap_or_default();
                ensure!(
                    text.len().saturating_add(delta.len()) <= MAX_RECORD,
                    "Codex reply is too large."
                );
                text.push_str(delta);
                streamed = true;
                json!({"type":"message.delta","payload":{"text":delta}})
            }
            "item/started" | "item/completed" => {
                let item = &params["item"];
                let kind = item["type"].as_str().unwrap_or_default();
                if kind == "agentMessage" {
                    if method == "item/started" {
                        streamed = false;
                        continue;
                    }
                    if let Some(final_text) = item["text"].as_str() {
                        text = final_text.to_owned();
                    }
                    if streamed {
                        continue;
                    }
                    json!({"type":"message.delta","payload":{"text":text}})
                } else if matches!(kind, "commandExecution" | "fileChange" | "webSearch") {
                    json!({"type":if method=="item/started"{"tool.start"}else{"tool.complete"},"payload":{
                        "id":item["id"],"name":kind,"preview":item["command"].as_str().or(item["query"].as_str()).unwrap_or_default().chars().take(1000).collect::<String>(),
                        "result":item["aggregatedOutput"].as_str().or(item["status"].as_str()).unwrap_or_default().chars().take(4000).collect::<String>()
                    }})
                } else {
                    continue;
                }
            }
            _ => continue,
        };
        emit(event)?;
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{duplex, split};
    #[tokio::test]
    async fn one_turn_streams_and_consumes_only_its_own_completion() {
        let (client, server) = duplex(32768);
        let (read, write) = split(client);
        let (r, mut w) = split(server);
        let driver = async {
            let mut requests = BufReader::new(r).lines();
            let init: Value = serde_json::from_str(&requests.next_line().await?.unwrap())?;
            assert_eq!(init["method"], "initialize");
            send(&mut w, json!({"id":1,"result":{}})).await?;
            assert!(requests.next_line().await?.unwrap().contains("initialized"));
            let cfg: Value = serde_json::from_str(&requests.next_line().await?.unwrap())?;
            assert_eq!(
                cfg["params"]["config"]["model_providers.openai_chatgpt_plan.experimental_bearer_token"],
                "test-sentinel"
            );
            send(&mut w, json!({"id":2,"result":{"thread":{"id":"t"}}})).await?;
            assert!(requests.next_line().await?.unwrap().contains("turn/start"));
            send(&mut w, json!({"id":3,"result":{"turn":{"id":"v"}}})).await?;
            send(&mut w,json!({"method":"turn/completed","params":{"threadId":"other","turn":{"id":"v","status":"completed"}}})).await?;
            send(&mut w,json!({"method":"item/agentMessage/delta","params":{"threadId":"t","turnId":"v","itemId":"i","delta":"Hello"}})).await?;
            send(&mut w,json!({"method":"item/completed","params":{"threadId":"t","turnId":"v","item":{"id":"i","type":"agentMessage","text":"Hello"}}})).await?;
            send(&mut w,json!({"method":"turn/completed","params":{"threadId":"t","turn":{"id":"v","status":"completed"}}})).await?;
            anyhow::Ok(())
        };
        let mut events = Vec::new();
        let (driven, reply) = tokio::join!(
            driver,
            conversation(write, read, "model", "question", "test-sentinel", |event| {
                events.push(event);
                Ok(())
            })
        );
        driven.unwrap();
        assert_eq!(reply.unwrap()["text"], "Hello");
        assert_eq!(events.len(), 2);
        assert!(!json!(events).to_string().contains("test-sentinel"));
    }
    #[test]
    fn provider_errors_do_not_include_raw_credentials() {
        let reason = provider_error(
            &json!({"message":"sensitive credential","codexErrorInfo":"usageLimitExceeded"}),
        )
        .to_string();
        assert!(reason.contains("usage limit"));
        assert!(!reason.contains("sensitive"));
        assert!(
            provider_error(
                &json!({"codexErrorInfo":{"httpConnectionFailed":{"httpStatusCode":401}}})
            )
            .is::<SignInRequired>()
        );
        assert!(!provider_error(&json!({"message":"401 unauthorized", "codexErrorInfo":{"httpConnectionFailed":{"httpStatusCode":403}}})).is::<SignInRequired>());
    }

    #[test]
    fn credential_fragments_never_reach_concatenated_run_events() {
        let token = "testsecret";
        let mut pending = String::new();
        let mut out = String::new();
        for chunk in ["😀 reply tes", "tse", "cret and t", "wo"] {
            out.push_str(&stream_text(&mut pending, chunk, token));
        }
        out.push_str(&pending);
        assert_eq!(out, "😀 reply [redacted] and two");
    }

    #[tokio::test]
    async fn unconfirmed_turn_is_interrupted_without_replaying_the_prompt() {
        let responses=b"{\"id\":1,\"result\":{}}\n{\"id\":2,\"result\":{\"thread\":{\"id\":\"t\"}}}\n{\"id\":3,\"result\":{\"turn\":{\"id\":\"v\"}}}\n";
        let mut requests = Vec::new();
        let error = conversation(
            &mut requests,
            &responses[..],
            "model",
            "only-once",
            "test-token",
            |_| Ok(()),
        )
        .await
        .unwrap_err();
        assert!(error.is::<Interrupted>());
        assert_eq!(
            String::from_utf8(requests)
                .unwrap()
                .matches("only-once")
                .count(),
            1
        );
    }
}
