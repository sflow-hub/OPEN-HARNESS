use anyhow::{Context, Result, bail, ensure};
use reqwest::{Client, Url};
use serde_json::{Value, json};
use std::{env, time::Duration};

pub fn tools() -> Value {
    json!([
        {"name":"task","description":"Read and manage board tasks and projects. Team access and profile permissions apply.","inputSchema":{"type":"object","properties":{
            "action":{"type":"string","enum":["list","columns","get","create","update","move","comment","check","additem","claim","release","run","board_create","board_update"]},
            "taskId":{"type":"string","description":"Target task ID."},"boardId":{"type":"string","description":"Target board ID."},
            "input":{"type":"object","description":"Action fields. Move uses stageId and optional beforeId. Create takes title, description, teamId and ownerAgentId. Update includes revision. Comments use text, checklist updates use item and done."}},
            "required":["action"],"additionalProperties":false}},
        {"name":"delegate_named_agent","description":"Assign a bounded task to a named agent on a shared team.","inputSchema":{"type":"object","properties":{"agentId":{"type":"string"},"prompt":{"type":"string"}},"required":["agentId","prompt"],"additionalProperties":false}},
        {"name":"create_open_harness_routine","description":"Schedule recurring work for this agent.","inputSchema":{"type":"object","properties":{"name":{"type":"string"},"prompt":{"type":"string"},"intervalMinutes":{"type":"integer","minimum":1},"timezone":{"type":"string"}},"required":["name","prompt","intervalMinutes"],"additionalProperties":false}}
    ])
}

pub async fn call(name: &str, args: &Value) -> Result<Value> {
    let route = match name {
        "task" => "/internal/task",
        "delegate_named_agent" => "/internal/handoff",
        "create_open_harness_routine" => "/internal/schedule",
        _ => bail!("Unknown coordination tool."),
    };
    ensure!(args.is_object(), "Invalid coordination arguments.");
    let agent = env::var("OPEN_HARNESS_AGENT_ID").context("The agent ID is unavailable.")?;
    let run = env::var("OPEN_HARNESS_RUN_ID").context("The run ID is unavailable.")?;
    let token =
        env::var("OPEN_HARNESS_AGENT_TOKEN").context("The run credential is unavailable.")?;
    ensure!(
        !token.is_empty() && !agent.is_empty() && !run.is_empty(),
        "Missing agent run credential."
    );
    let socket = env::var_os("OPEN_HARNESS_CONTROL_SOCKET")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| "/run/open-harness/coord.sock".into());
    let client = || {
        Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .no_proxy()
            .timeout(Duration::from_secs(24 * 60 * 60))
    };
    let send = |c: &Client, url: Url| {
        c.post(url)
            .bearer_auth(&token)
            .header("x-open-harness-agent", &agent)
            .header("x-open-harness-run", &run)
            .json(args)
            .send()
    };
    let local = client().unix_socket(socket).build()?;
    let mut response = match send(&local, format!("http://localhost{route}").parse()?).await {
        Ok(response) => response,
        Err(error) if error.is_connect() => {
            // A Docker Desktop VM may not pass host Unix sockets through bind mounts.
            // Only retry an unsuccessful connect; a reset after dispatch could duplicate a handoff.
            let target = env::var("OPEN_HARNESS_CONTROL_URL")
                .context("The coordination socket is unavailable.")?;
            let mut url = Url::parse(&target).context("Invalid coordinator URL.")?;
            ensure!(
                matches!(url.scheme(), "https" | "http")
                    && url.has_host()
                    && url.username().is_empty()
                    && url.password().is_none()
                    && url.query().is_none()
                    && url.fragment().is_none(),
                "Invalid coordinator URL."
            );
            let path = format!("{}{route}", url.path().trim_end_matches('/'));
            url.set_path(&path);
            send(&client().build()?, url)
                .await
                .map_err(|_| anyhow::anyhow!("The coordinator could not confirm the request."))?
        }
        Err(_) => bail!("The coordinator could not confirm the request."),
    };
    let ok = response.status().is_success();
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| anyhow::anyhow!("Could not read the coordinator response."))?
    {
        ensure!(
            bytes.len() + chunk.len() <= 4_900_000,
            "Coordinator response too large."
        );
        bytes.extend_from_slice(&chunk);
    }
    let clean = String::from_utf8(bytes)
        .context("Invalid coordinator response.")?
        .replace(&token, "[redacted]");
    let value: Value = serde_json::from_str(&clean).context("Invalid coordinator response.")?;
    if !ok {
        bail!(
            "{}",
            value["error"]
                .as_str()
                .unwrap_or("Coordination request failed.")
        );
    }
    Ok(value)
}
