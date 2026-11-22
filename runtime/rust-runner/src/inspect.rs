use crate::{
    agent_dir,
    engine::{self, Keys},
    hermes, profile,
    protocol::{Command, Coordinator},
    required_str,
};
use anyhow::{Context, Result, bail, ensure};
use serde_json::{Value, json};
use std::{collections::BTreeMap, path::Path, process::Stdio, time::Duration};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    process::Command as Process,
    time::timeout,
};

fn tool(id: &str, name: &str, group: &str, description: &str) -> Value {
    json!({"id":id,"name":name,"group":group,"description":description,"available":true})
}

fn agent_tools(harness: &str) -> Value {
    let mut tools = vec![
        tool(
            "terminal",
            "Terminal",
            "terminal",
            "Run commands inside the container.",
        ),
        tool("read_file", "Read files", "files", "Read workspace files."),
        tool(
            "write_file",
            "Write files",
            "files",
            "Create workspace files.",
        ),
        tool("patch", "Edit files", "files", "Change workspace files."),
        tool(
            "search_files",
            "Search files",
            "files",
            "Find files and search their contents.",
        ),
        tool("web_search", "Web search", "web", "Search the web."),
    ];
    if harness != "codex" {
        tools.push(tool(
            "web_extract",
            "Read web pages",
            "web",
            "Retrieve a web page.",
        ));
    }
    if harness == "hermes" {
        tools.extend(coordination_tools());
    }
    json!({"source":if engine::mock() {"mock"} else {"runtime"}, "tools":tools})
}

fn coordination_tools() -> [Value; 3] {
    [
        tool(
            "mcp__open_harness__task",
            "Task board",
            "other",
            "Read and update assigned board tasks.",
        ),
        tool(
            "mcp__open_harness__delegate_named_agent",
            "Hand off to another agent",
            "delegation",
            "Assign task context to another agent on a shared team.",
        ),
        tool(
            "mcp__open_harness__create_open_harness_routine",
            "Create a routine",
            "scheduling",
            "Schedule work through Open Harness.",
        ),
    ]
}

pub async fn probe(
    root: &Path,
    command: &Command,
    coordinator: &Coordinator,
    keys: Keys,
) -> Result<Value> {
    let snapshot = &command.payload["profile"];
    let agent = required_str(snapshot, "id")?;
    ensure!(
        command.agent_id.as_deref() == Some(agent),
        "Probe profile belongs to a different agent."
    );
    let harness = engine::harness(snapshot)?;
    engine::folder_mounts(root, snapshot).await?;
    let kind = command.kind.as_str();
    let action = command.payload["input"]["action"].as_str();
    if harness != "hermes" {
        return match kind {
            "probe-tools" => Ok(agent_tools(harness)),
            "probe-models" => {
                Ok(json!({"models":[],"error":"Enter a model ID supported by this harness."}))
            }
            "probe-runtime" if action == Some("computer") => {
                engine::install(harness).await?;
                Ok(
                    json!({"ok":true,"message":"The selected headless harness is ready on this computer."}),
                )
            }
            _ => Ok(
                json!({"ok":false,"message":"This harness checks its model credentials when a task starts."}),
            ),
        };
    }
    if engine::mock() {
        return Ok(match kind {
            "probe-tools" => agent_tools("hermes"),
            "probe-models" => {
                json!({"models":[{"id":"mock-atlas","provider":"mock","label":"Mock Atlas"},{"id":"mock-scout","provider":"mock","label":"Mock Scout"}]})
            }
            _ if action == Some("mcp") => json!({"status":"connected","tools":[]}),
            _ => json!({"ok":true,"message":"The deterministic headless runtime is ready."}),
        });
    }
    engine::install("hermes").await?;
    let image = engine::image("hermes").await?;
    let dir = agent_dir(root, agent)?;
    let run = format!("probe-{}", command.id);
    let name = format!("open-harness-rust-{}", command.id);
    // A read-only probe never needs agent coordination privileges, and may have no run token.
    let mut probe = snapshot.clone();
    if let Some(tools) = probe["allowedTools"].as_array_mut() {
        tools.retain(|t| {
            !t.as_str()
                .is_some_and(|s| s.starts_with("mcp__open_harness__"))
        });
    }
    profile::prepare(root, &probe, &keys, coordinator.url.as_str(), "", &run)?;
    let inspected = async {
        hermes::create_container(
            root,
            &dir,
            &name,
            &coordinator.container_owner,
            &image,
            snapshot,
        )
        .await?;
        if kind == "probe-models" {
            return model_options(&name).await;
        }
        let mut input = if kind == "probe-tools" {
            json!({"action":"catalog"})
        } else {
            command.payload["input"].clone()
        };
        match input["action"].as_str() {
            Some("computer") => {
                input["desktop"] = "none".into();
            }
            Some("connection") => {
                if let Some(key) = input["credentialRef"]
                    .as_str()
                    .or_else(|| snapshot["effectiveModel"]["credentialRef"].as_str())
                    .and_then(|r| keys.get(r))
                {
                    input["apiKey"] = key.as_str().into();
                }
            }
            Some("mcp") => {
                if input["kind"] == "slack" {
                    input["command"] = profile::AGENT_TOOLS.into();
                    input["args"] = json!(["slack"]);
                }
                if let Some(name) = input["secretRef"].as_str().filter(|s| !s.is_empty()) {
                    let key = keys
                        .get(name)
                        .context("Select a saved connector credential.")?;
                    let name = if input["kind"] == "slack" {
                        "SLACK_BOT_TOKEN"
                    } else {
                        name
                    }
                    .to_owned();
                    if input["env"].is_null() {
                        input["env"] = json!({});
                    }
                    input["env"][name] = key.as_str().into();
                }
                if let Some(env) = input["env"].as_object_mut() {
                    for (k, v) in env {
                        if v.as_str().is_none_or(str::is_empty)
                            && let Some(key) = keys.get(k)
                        {
                            *v = key.as_str().into();
                        }
                    }
                }
            }
            Some("catalog") if kind == "probe-tools" => {}
            _ => bail!("Unsupported headless runtime probe."),
        }
        let mut result = run_probe(&name, &input).await?;
        if kind == "probe-tools" {
            let tools = result["tools"]
                .as_array_mut()
                .context("Invalid Hermes tool catalog")?;
            tools.retain(|t| {
                t["id"] != "computer_use" && t["group"] != "computer_use" && t["group"] != "cronjob"
            });
            tools.extend(coordination_tools());
            result["source"] = "runtime".into();
        }
        engine::redact(&mut result, &keys);
        Ok(result)
    }
    .await;
    hermes::remove_container(&name).await?;
    inspected
}

async fn run_probe(name: &str, input: &Value) -> Result<Value> {
    let mut cmd = Process::new("docker");
    cmd.args(["exec", "-i", name]);
    if input["action"] == "connection" {
        cmd.args([profile::AGENT_TOOLS, "check-model"]);
    } else {
        cmd.args(["python", "/opt/open-harness/inspect_runtime.py"]);
    }
    let mut child = cmd
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()?;
    timeout(Duration::from_secs(35), async {
        let mut stdin = child.stdin.take().context("Missing probe input")?;
        stdin.write_all(&serde_json::to_vec(input)?).await?;
        stdin.write_all(b"\n").await?;
        drop(stdin);
        let mut data = Vec::new();
        child
            .stdout
            .take()
            .context("Missing probe output")?
            .take(4_900_001)
            .read_to_end(&mut data)
            .await?;
        ensure!(
            data.len() <= 4_900_000 && child.wait().await?.success(),
            "Hermes runtime check failed. Check the endpoint, executable and selected credentials."
        );
        let result: Value = serde_json::from_slice(&data)?;
        ensure!(
            result["error"].is_null(),
            "The Hermes runtime check failed."
        );
        Ok(result)
    })
    .await?
}

async fn model_options(name: &str) -> Result<Value> {
    let mut child = Process::new("docker")
        .args([
            "exec",
            "-i",
            "-e",
            "HERMES_GATEWAY_SESSION=1",
            name,
            "python",
            "/opt/open-harness/managed_entry.py",
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()?;
    let mut input = child.stdin.take().context("Missing model probe input")?;
    let mut lines = BufReader::new(
        child
            .stdout
            .take()
            .context("Missing model probe output")?
            .take(4_900_001),
    )
    .lines();
    timeout(Duration::from_secs(90),async {
        while let Some(line)=lines.next_line().await? {
            let Ok(v)=serde_json::from_str::<Value>(&line) else {continue;};
            if v["id"]=="models" {
                ensure!(v["error"].is_null(),"Hermes rejected the model catalog request.");
                let mut catalog=BTreeMap::new();
                collect_models(&v["result"],"",&mut catalog);
                let models=catalog.into_values().collect::<Vec<_>>();
                return Ok(if models.is_empty() {json!({"models":[],"error":"The runtime returned no model choices. Enter a custom model ID."})} else {json!({"models":models})});
            }
            if v.pointer("/params/type").or_else(||v.pointer("/type")).is_some_and(|v|v=="gateway.ready"){
                input.write_all(b"{\"jsonrpc\":\"2.0\",\"id\":\"models\",\"method\":\"model.options\",\"params\":{\"refresh\":true}}\n").await?;
            }
        }
        bail!("Hermes closed the model catalog stream.")
    }).await?
}

fn collect_models(v: &Value, provider: &str, out: &mut BTreeMap<(String, String), Value>) {
    let insert = |out: &mut BTreeMap<_, _>, id: &str, p: &str, label: &str| {
        if !id.is_empty() && !p.is_empty() {
            out.insert(
                (p.to_owned(), id.to_owned()),
                json!({"id":id,"provider":p,"label":label}),
            );
        }
    };
    if let Some(v) = v.as_str() {
        insert(out, v, provider, v);
        return;
    }
    if let Some(v) = v.as_array() {
        for item in v {
            collect_models(item, provider, out);
        }
        return;
    }
    let p = ["slug", "provider_id", "provider"]
        .into_iter()
        .find_map(|k| v[k].as_str())
        .unwrap_or(provider);
    let id = v["model_id"]
        .as_str()
        .or(v["model"].as_str())
        .or_else(|| v["models"].is_null().then(|| v["id"].as_str()).flatten());
    if let Some(id) = id {
        insert(
            out,
            id,
            p,
            v["name"].as_str().or(v["label"].as_str()).unwrap_or(id),
        );
    }
    for key in ["providers", "models", "options", "items"] {
        if let Some(child) = v.get(key) {
            let p = if key == "models" && p.is_empty() {
                v["id"].as_str().unwrap_or(p)
            } else {
                p
            };
            collect_models(child, p, out);
        }
    }
}
