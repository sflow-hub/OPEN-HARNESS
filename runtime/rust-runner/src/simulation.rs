use crate::{engine::harness, hermes::Control, outbox::Outbox, protocol::Command, required_str};
use anyhow::{Context, Result, anyhow, bail, ensure};
use serde_json::{Value, json};
use std::time::Duration;
use tokio::{
    sync::{mpsc, watch},
    time::sleep,
};

pub async fn run(
    command: &Command,
    outbox: &Outbox,
    mut controls: mpsc::Receiver<Control>,
    mut shutdown: watch::Receiver<bool>,
) -> Result<Value> {
    let p = &command.payload;
    let snapshot = &p["snapshot"];
    let selected = harness(snapshot)?;
    ensure!(
        command.agent_id.as_deref() == snapshot["id"].as_str(),
        "Run profile belongs to a different agent."
    );
    if selected != "hermes" {
        crate::cli_protocol::arguments(snapshot)?;
    }
    let id = required_str(p, "runId")?;
    let prompt = required_str(p, "prompt")?;
    let emit = |kind: &str, payload: Value| {
        outbox.event(
            command.id,
            id,
            json!({"type":kind,"session_id":command.id,"payload":payload}),
        )
    };
    emit("gateway.ready", json!({"harness":selected,"mock":true}))?;
    let tools = snapshot["allowedTools"]
        .as_array()
        .context("Invalid tool selection")?;
    let terminal = selected == "hermes" && tools.iter().any(|v| v == "terminal");
    if selected == "hermes"
        && let Some(request) = prompt
            .split_once("MOCK_TOOL:")
            .and_then(|(_, r)| r.split_whitespace().next())
    {
        ensure!(
            tools.iter().any(|v| v == request),
            "Tool {request} is disabled in this agent profile."
        );
    }
    if terminal {
        emit(
            "tool.start",
            json!({"id":"mock-tool","name":"terminal","preview":"python task.py"}),
        )?;
    }
    let approval = selected == "hermes" && prompt.contains("MOCK_APPROVAL");
    let mut approved = !approval;
    if approval {
        emit(
            "approval.request",
            json!({"request_id":"mock-approval","command":"publish mock result"}),
        )?;
    }
    // Leave time for a command to travel through the headless worker poll.
    let delay = sleep(Duration::from_millis(if prompt.contains("MOCK_SLOW") {
        1800
    } else {
        10
    }));
    tokio::pin!(delay);
    let mut elapsed = false;
    while !elapsed || !approved {
        tokio::select! {
            _=shutdown.wait_for(|v|*v)=> bail!("The runner stopped during execution."),
            _=&mut delay, if !elapsed => elapsed=true,
            Some(control)=controls.recv()=>{
                let p=&control.command.payload;
                let result=match control.command.kind.as_str() {
                    "stop"=>{let _=control.reply.send(Ok(json!({"ok":true}))); bail!("This run was stopped before execution completed.");}
                    "steer" if selected=="hermes" =>Ok(json!({"ok":true})),
                    "approval" if !approved && p["requestId"]=="mock-approval" =>{
                        let decision=p["decision"].as_str();
                        let _=control.reply.send(Ok(json!({"ok":true})));
                        ensure!(matches!(decision,Some("approve"|"once"|"session"|"always")),"Mock action was denied.");
                        approved=true;
                        continue;
                    }
                    _=>Err(anyhow!("This harness cannot apply that control to the active run.")),
                };
                let _=control.reply.send(result);
            }
        }
    }
    if terminal {
        emit(
            "tool.complete",
            json!({"id":"mock-tool","name":"terminal","result":"Created and executed task.py"}),
        )?;
    }
    let name = match selected {
        "hermes" => "Hermes",
        "claude-code" => "Claude Code",
        _ => "Codex",
    };
    let text = format!("{name} mock completed the task.");
    emit("message.delta", json!({"text":text}))?;
    emit("message.complete", json!({"text":text,"status":"complete"}))?;
    Ok(json!({"text":text}))
}
