//! Launch validation and stdout protocols for the headless CLI harnesses.

use crate::additional_cli;

use anyhow::{Result, anyhow, bail};
use serde_json::{Map, Value, json};
use std::fmt;

const CORE_CODEX_TOOLS: [&str; 5] = [
    "terminal",
    "read_file",
    "write_file",
    "patch",
    "search_files",
];
const MAX_INSTRUCTIONS: usize = 12_000;
const MAX_MODEL: usize = 200;

fn claude_tools(tool: &str) -> &'static [&'static str] {
    match tool {
        "terminal" => &["Bash"],
        "read_file" => &["Read"],
        "write_file" => &["Write"],
        "patch" => &["Edit"],
        "search_files" => &["Glob", "Grep"],
        "web_search" => &["WebSearch"],
        "web_extract" => &["WebFetch"],
        _ => &[],
    }
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Harness {
    ClaudeCode,
    Codex,
    OpenCode,
    Pi,
    OpenHands,
}

impl Harness {
    fn parse(value: &str) -> Option<Self> {
        match value {
            "claude-code" => Some(Self::ClaudeCode),
            "codex" => Some(Self::Codex),
            "opencode" => Some(Self::OpenCode),
            "pi" => Some(Self::Pi),
            "openhands" => Some(Self::OpenHands),
            _ => None,
        }
    }
    fn name(self) -> &'static str {
        match self {
            Self::ClaudeCode => "Claude Code",
            Self::Codex => "Codex",
            Self::OpenCode => "OpenCode",
            Self::Pi => "Pi",
            Self::OpenHands => "OpenHands",
        }
    }
    fn provider(self) -> Option<(&'static str, &'static str)> {
        match self {
            Self::ClaudeCode => Some(("anthropic", "Anthropic")),
            Self::Codex => Some(("openai", "OpenAI")),
            _ => None,
        }
    }
}

/// The CLI ended without confirming completion. Callers downcast to this to keep the run
/// recoverable instead of failed, matching the `interrupted` flag on the TypeScript error.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Interrupted(pub String);
impl fmt::Display for Interrupted {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}
impl std::error::Error for Interrupted {}

fn text<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value.get(key).and_then(Value::as_str)
}

fn truthy(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(flag)) => *flag,
        Some(Value::Number(number)) => number.as_f64().is_some_and(|n| n != 0.0 && !n.is_nan()),
        Some(Value::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}

fn js_string(value: &Value) -> String {
    match value {
        Value::String(s) => s.clone(),
        Value::Array(items) => items
            .iter()
            .map(|item| {
                if item.is_null() {
                    String::new()
                } else {
                    js_string(item)
                }
            })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".into(),
        other => other.to_string(),
    }
}

// Equivalent of `String(a || b || fallback)`.
fn first_truthy(values: &[Option<&Value>], fallback: &str) -> String {
    values
        .iter()
        .copied()
        .find(|value| truthy(*value))
        .flatten()
        .map(js_string)
        .unwrap_or_else(|| fallback.into())
}

fn clip(value: &str, limit: usize) -> String {
    value.chars().take(limit).collect()
}

fn valid_id(id: &str) -> bool {
    let bytes = id.as_bytes();
    !bytes.is_empty()
        && bytes.len() <= 80
        && bytes[0].is_ascii_alphanumeric()
        && bytes
            .iter()
            .all(|c| c.is_ascii_alphanumeric() || *c == b'_' || *c == b'-')
}

// A leading dash would be parsed by the CLI as another flag.
fn valid_model(model: &str) -> bool {
    !model.is_empty()
        && model.chars().count() <= MAX_MODEL
        && !model.starts_with('-')
        && !model.chars().any(|c| c.is_whitespace() || c.is_control())
}

fn owned(items: &[&str]) -> Vec<String> {
    items.iter().map(|s| s.to_string()).collect()
}

pub struct ManagedConfig<'a> {
    pub model: additional_cli::Model<'a>,
    pub tools: Vec<&'a str>,
    pub instructions: &'a str,
}

pub struct Launch<'a> {
    pub harness: &'a str,
    pub args: Vec<String>,
    pub config: Option<ManagedConfig<'a>>,
}

pub fn arguments(snapshot: &Value) -> Result<Vec<String>> {
    Ok(launch(snapshot)?.args)
}

/// The worker accepts both a bare profile snapshot and one with a nested profile.
pub fn launch(snapshot: &Value) -> Result<Launch<'_>> {
    let profile = snapshot
        .get("profile")
        .filter(|p| p.is_object())
        .unwrap_or(snapshot);
    let model = snapshot
        .get("effectiveModel")
        .filter(|m| m.is_object())
        .ok_or_else(|| anyhow!("Choose a model for this agent before starting a task."))?;
    let invalid_harness = || anyhow!("Choose a supported CLI harness.");
    let harness_id = text(profile, "harness").ok_or_else(invalid_harness)?;
    let harness = Harness::parse(harness_id).ok_or_else(invalid_harness)?;
    let name = harness.name();
    if !text(profile, "id").is_some_and(valid_id) {
        bail!("Invalid agent ID.");
    }

    let computer = profile.get("computer");
    let access = computer.and_then(|c| text(c, "access")).unwrap_or("");
    let desktop = computer.and_then(|c| text(c, "desktop")).unwrap_or("");
    if !matches!(access, "private" | "folders") || desktop != "none" {
        bail!("{name} requires an isolated workspace without desktop access.");
    }
    let folders = if access == "folders" {
        computer.and_then(|c| c.get("folders")).and_then(Value::as_array).map(Vec::len)
            .ok_or_else(|| anyhow!("The shared folders for this agent could not be read. Review them in Agent settings."))?
    } else {
        0
    };

    match profile.get("connectors") {
        None | Some(Value::Null) => {}
        Some(Value::Array(list)) => {
            if list.iter().any(|c| truthy(c.get("enabled"))) {
                bail!(
                    "{name} does not support MCP connections in Open Harness yet. Disable them or choose Hermes."
                );
            }
        }
        Some(_) => bail!(
            "The connections for this agent could not be read. Review them in Agent settings."
        ),
    }

    let unreadable_tools = || {
        anyhow!("The tool choices for this agent could not be read. Review them in Agent settings.")
    };
    let allowed = match profile.get("allowedTools") {
        Some(Value::Array(list)) => list
            .iter()
            .map(|tool| tool.as_str().ok_or_else(unreadable_tools))
            .collect::<Result<Vec<_>>>()?,
        _ => return Err(unreadable_tools()),
    };

    let prompt = profile.get("prompt");
    let instructions = if prompt.is_some_and(|p| truthy(p.get("enabled"))) {
        prompt.and_then(|p| text(p, "text")).unwrap_or("")
    } else {
        ""
    };
    if instructions.chars().count() > MAX_INSTRUCTIONS {
        bail!("Instructions are limited to 12,000 characters.");
    }
    if instructions.contains('\0') {
        bail!("Instructions contain an unsupported character.");
    }

    let plan = match snapshot.get("modelAuth") {
        None => false,
        Some(mode) if mode == "configured" => false,
        Some(mode) if mode == "chatgpt-plan" => true,
        _ => bail!("Choose a supported billing method before starting this run."),
    };
    if harness.provider().is_none() {
        if plan {
            bail!("Choose a saved model credential for {name}.");
        }
        let model = additional_cli::Model::from_snapshot(model)?;
        let tools = additional_cli::tool_grants(harness_id, &allowed)?;
        let args = additional_cli::arguments(harness_id, &model, &tools, instructions);
        return Ok(Launch {
            harness: harness_id,
            args,
            config: Some(ManagedConfig {
                model,
                tools,
                instructions,
            }),
        });
    }

    let (provider, label) = harness
        .provider()
        .expect("a legacy harness has a fixed provider");
    if text(model, "provider") != Some(provider) {
        bail!("{name} requires an {label} model and saved credential.");
    }
    let model_id = text(model, "model").unwrap_or("");
    if !valid_model(model_id) {
        bail!("Choose a valid {label} model for this agent.");
    }
    let base_url = text(model, "baseUrl").unwrap_or("");
    if plan
        && (harness != Harness::Codex
            || !base_url.is_empty()
            || text(model, "credentialRef").is_some_and(|s| !s.is_empty()))
    {
        bail!("Choose Codex with the OpenAI endpoint and ChatGPT plan billing for this agent.");
    }
    if base_url.chars().any(char::is_control) {
        bail!("The selected endpoint contains an unsupported line break.");
    }
    if !base_url.is_empty()
        && !url::Url::parse(base_url).is_ok_and(|url| {
            matches!(url.scheme(), "http" | "https")
                && url.has_host()
                && url.username().is_empty()
                && url.password().is_none()
                && url.query().is_none()
                && url.fragment().is_none()
        })
    {
        bail!(
            "The selected endpoint must start with http:// or https:// and contain no credentials, query or fragment."
        );
    }

    if harness == Harness::ClaudeCode {
        let mut tools: Vec<&str> = Vec::new();
        for tool in &allowed {
            for mapped in claude_tools(tool) {
                if !tools.contains(mapped) {
                    tools.push(*mapped);
                }
            }
        }
        let tools = tools.join(",");
        let mut args = owned(&[
            "claude",
            "--print",
            "--output-format",
            "stream-json",
            "--verbose",
            "--model",
            model_id,
            "--restricted",
            "--safe-mode",
            "--setting-sources",
            "",
            "--permission-mode",
            "dontAsk",
            "--permission-prompts",
            "none",
            "--add-dir",
            "/workspace/private",
        ]);
        args.extend((1..=folders).map(|index| format!("/workspace/mounts/folder-{index}")));
        args.extend(owned(&[
            "--strict-mcp-config",
            "--mcp-config",
            "{\"mcpServers\":{}}",
            "--disallowedTools",
            "mcp__*",
            "--tools",
            tools.as_str(),
            "--allowedTools",
            tools.as_str(),
        ]));
        if !instructions.is_empty() {
            args.extend(owned(&["--append-system-prompt", instructions]));
        }
        return Ok(Launch {
            harness: harness_id,
            args,
            config: None,
        });
    }

    if CORE_CODEX_TOOLS.iter().any(|tool| !allowed.contains(tool)) {
        bail!(
            "Codex requires Terminal, Read files, Write files, Edit files, and Search files together. Enable these tools or choose another harness."
        );
    }
    // Untrusted project layers and disabled integrations prevent a shared workspace from
    // installing its own tools, hooks, or connections outside the saved agent profile.
    let mut config = owned(&[
        "approval_policy=\"never\"",
        "projects.\"/workspace/shared\".trust_level=\"untrusted\"",
        "mcp_servers={}",
        "features.apps=false",
        "features.plugins=false",
        "features.remote_plugin=false",
        "features.hooks=false",
        "features.multi_agent=false",
        "agents.enabled=false",
        "features.computer_use=false",
        "features.browser_use=false",
        "features.image_generation=false",
        "features.skill_mcp_dependency_install=false",
        "features.tool_suggest=false",
        "features.goals=false",
        "skills.bundled.enabled=false",
        "skills.include_instructions=false",
    ]);
    config.push(format!(
        "web_search=\"{}\"",
        if allowed.contains(&"web_search") {
            "live"
        } else {
            "disabled"
        }
    ));
    if !base_url.is_empty() {
        config.push(format!("openai_base_url={}", Value::from(base_url)));
    }
    if !instructions.is_empty() {
        config.push(format!(
            "developer_instructions={}",
            Value::from(instructions)
        ));
    }
    let mut args = if plan {
        config.extend(owned(&[
            "model_provider=\"openai_chatgpt_plan\"",
            "model_providers.openai_chatgpt_plan.name=\"ChatGPT plan\"",
            "model_providers.openai_chatgpt_plan.base_url=\"https://api.openai.com/v1\"",
            "model_providers.openai_chatgpt_plan.wire_api=\"responses\"",
            "model_providers.openai_chatgpt_plan.requires_openai_auth=false",
            "model_providers.openai_chatgpt_plan.supports_websockets=false",
            "model_providers.openai_chatgpt_plan.request_max_retries=0",
            "model_providers.openai_chatgpt_plan.stream_max_retries=0",
            "features.tool_search=false",
            "features.code_mode_tool_search=false",
            "shell_environment_policy.inherit=\"core\"",
            "analytics.enabled=false",
            "feedback.enabled=false",
        ]));
        owned(&["codex", "app-server", "--listen", "stdio://"])
    } else {
        owned(&[
            "codex",
            "exec",
            "--json",
            "--skip-git-repo-check",
            "--ignore-user-config",
            "--ignore-rules",
            "--sandbox",
            "danger-full-access",
            "--model",
            model_id,
        ])
    };
    for value in config {
        args.push("-c".into());
        args.push(value);
    }
    if !plan {
        args.push("-".into());
    }
    Ok(Launch {
        harness: harness_id,
        args,
        config: None,
    })
}

fn event(kind: &str, payload: Value) -> Value {
    json!({ "type": kind, "payload": payload })
}

/// Completion is confirmed by both the CLI protocol and the process exit. A truncated
/// stream or a successful process with no result must never complete the coordinator run.
#[derive(Debug)]
pub struct Output {
    harness: Option<Harness>,
    text: String,
    completed: bool,
    failure: String,
    transient_error: String,
    pi_stopped: bool,
}

impl Output {
    pub fn new(harness: &str) -> Self {
        Self {
            harness: Harness::parse(harness),
            text: String::new(),
            completed: false,
            failure: String::new(),
            transient_error: String::new(),
            pi_stopped: false,
        }
    }

    pub fn accept(&mut self, value: &Value) -> Vec<Value> {
        let mut events = Vec::new();
        if !value.is_object() {
            return events;
        }
        let kind = text(value, "type").unwrap_or("");
        match self.harness {
            None => {}
            Some(Harness::Codex) => self.accept_codex(value, kind, &mut events),
            Some(Harness::ClaudeCode) => self.accept_claude(value, kind, &mut events),
            Some(Harness::OpenCode) => self.accept_opencode(value, kind, &mut events),
            Some(Harness::Pi) => self.accept_pi(value, kind, &mut events),
            Some(Harness::OpenHands) => self.accept_openhands(value, kind, &mut events),
        }
        events
    }

    fn accept_codex(&mut self, value: &Value, kind: &str, events: &mut Vec<Value>) {
        match kind {
            "turn.completed" => self.completed = true,
            "turn.failed" => {
                self.failure = first_truthy(
                    &[
                        value.get("error").and_then(|e| e.get("message")),
                        value.get("message"),
                    ],
                    "Codex could not complete this task.",
                )
            }
            "error" => {
                self.transient_error = first_truthy(
                    &[value.get("message")],
                    "Codex could not complete this task.",
                )
            }
            _ => {}
        }
        let Some(item) = value.get("item").filter(|item| truthy(Some(*item))) else {
            return;
        };
        let item_type = text(item, "type").unwrap_or("");
        if kind == "item.completed"
            && item_type == "agent_message"
            && let Some(message) = text(item, "text")
        {
            self.text = message.into();
            events.push(event("message.delta", json!({ "text": message })));
            return;
        }
        if !matches!(
            item_type,
            "command_execution" | "file_change" | "web_search"
        ) {
            return;
        }
        let phase = match kind {
            "item.started" => "tool.start",
            "item.completed" => "tool.complete",
            _ => return,
        };
        let mut payload = Map::new();
        if let Some(id) = item.get("id") {
            payload.insert("id".into(), id.clone());
        }
        payload.insert(
            "name".into(),
            item.get("type").cloned().unwrap_or(Value::Null),
        );
        payload.insert(
            "preview".into(),
            first_truthy(&[item.get("command"), item.get("query")], "").into(),
        );
        payload.insert(
            "result".into(),
            first_truthy(&[item.get("aggregated_output"), item.get("status")], "").into(),
        );
        events.push(event(phase, Value::Object(payload)));
    }

    fn accept_claude(&mut self, value: &Value, kind: &str, events: &mut Vec<Value>) {
        let blocks = || {
            value
                .get("message")
                .and_then(|m| m.get("content"))
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
        };
        // Subagent turns carry a parent tool ID; only the top-level reply is the result.
        if kind == "assistant" && !truthy(value.get("parent_tool_use_id")) {
            for block in blocks() {
                match text(block, "type") {
                    Some("text") => {
                        if let Some(message) = text(block, "text") {
                            self.text = message.into();
                            events.push(event("message.delta", json!({ "text": message })));
                        }
                    }
                    Some("tool_use") => {
                        let input = block
                            .get("input")
                            .filter(|i| truthy(Some(*i)))
                            .cloned()
                            .unwrap_or_else(|| json!({}));
                        let mut payload = Map::new();
                        if let Some(id) = block.get("id") {
                            payload.insert("id".into(), id.clone());
                        }
                        if let Some(name) = block.get("name") {
                            payload.insert("name".into(), name.clone());
                        }
                        payload.insert("preview".into(), clip(&input.to_string(), 1000).into());
                        events.push(event("tool.start", Value::Object(payload)));
                    }
                    _ => {}
                }
            }
        }
        if kind == "user" {
            for block in blocks().filter(|b| text(b, "type") == Some("tool_result")) {
                let mut payload = Map::new();
                if let Some(id) = block.get("tool_use_id") {
                    payload.insert("id".into(), id.clone());
                }
                payload.insert("name".into(), "tool".into());
                payload.insert(
                    "result".into(),
                    text(block, "content")
                        .map(|c| clip(c, 4000))
                        .unwrap_or_default()
                        .into(),
                );
                payload.insert("error".into(), truthy(block.get("is_error")).into());
                events.push(event("tool.complete", Value::Object(payload)));
            }
        }
        if kind == "result" {
            if truthy(value.get("is_error")) || text(value, "subtype") != Some("success") {
                let joined = value
                    .get("errors")
                    .and_then(Value::as_array)
                    .map(|errors| {
                        errors
                            .iter()
                            .map(|e| {
                                if e.is_null() {
                                    String::new()
                                } else {
                                    js_string(e)
                                }
                            })
                            .collect::<Vec<_>>()
                            .join(" ")
                    })
                    .filter(|joined| !joined.is_empty());
                self.failure = joined.unwrap_or_else(|| {
                    first_truthy(
                        &[value.get("result")],
                        "Claude Code could not complete this task.",
                    )
                });
            } else {
                self.completed = true;
                if let Some(result) = text(value, "result") {
                    self.text = result.into();
                }
            }
        }
    }

    fn accept_opencode(&mut self, value: &Value, kind: &str, events: &mut Vec<Value>) {
        let part = &value["part"];
        match kind {
            "step_start" => self.completed = false,
            "step_finish" => {
                self.completed = part["reason"] == "stop";
                if part["reason"] == "length" {
                    self.failure = "OpenCode reached the model’s output limit.".into();
                }
            }
            "text" => {
                if let Some(message) = text(part, "text") {
                    self.text.push_str(message);
                    events.push(event("message.delta", json!({"text": message})));
                }
            }
            "tool_use" => {
                let state = &part["state"];
                let is_error = state["status"] == "error";
                if (state["status"] == "completed" || is_error)
                    && let (Some(id), Some(name)) = (text(part, "callID"), text(part, "tool"))
                {
                    events.push(event("tool.start", json!({
                        "id": id, "name": name, "preview": clip(&state["input"].to_string(), 1000)
                    })));
                    events.push(event("tool.complete", json!({
                        "id": id, "name": name, "error": is_error,
                        "result": clip(text(state, if is_error { "error" } else { "output" }).unwrap_or(""), 4000)
                    })));
                }
            }
            "error" => {
                self.failure = clip(
                    &first_truthy(
                        &[
                            value["error"]["data"].get("message"),
                            value["error"].get("message"),
                            value.get("message"),
                        ],
                        "OpenCode could not complete this task.",
                    ),
                    4000,
                );
            }
            _ => {}
        }
    }

    fn accept_pi(&mut self, value: &Value, kind: &str, events: &mut Vec<Value>) {
        match kind {
            "agent_start" => {
                self.completed = false;
                self.pi_stopped = false;
            }
            "message_end" if value["message"]["role"] == "assistant" => {
                let message = &value["message"];
                let stop = text(message, "stopReason");
                self.pi_stopped = stop == Some("stop");
                self.transient_error = match stop {
                    Some("error") => clip(
                        text(message, "errorMessage").unwrap_or("Pi could not complete this task."),
                        4000,
                    ),
                    Some("length") => "Pi reached the model’s output limit.".into(),
                    Some("aborted") => "Pi stopped before completing the task.".into(),
                    _ => String::new(),
                };
                let reply = message["content"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter(|block| block["type"] == "text")
                    .filter_map(|block| text(block, "text"))
                    .collect::<String>();
                if !reply.is_empty() {
                    events.push(event("message.delta", json!({"text": reply})));
                    self.text = reply;
                } else if self.pi_stopped {
                    self.text.clear();
                }
            }
            "agent_settled" => {
                self.completed = self.pi_stopped && value["aborted"] == false;
                if !self.completed && !self.transient_error.is_empty() {
                    self.failure = std::mem::take(&mut self.transient_error);
                }
            }
            "tool_execution_start" | "tool_execution_end" => {
                let (Some(id), Some(name)) = (text(value, "toolCallId"), text(value, "toolName"))
                else {
                    return;
                };
                if kind == "tool_execution_start" {
                    events.push(event("tool.start", json!({
                        "id": id, "name": name, "preview": clip(&value["args"].to_string(), 1000)
                    })));
                } else {
                    events.push(event(
                        "tool.complete",
                        json!({
                            "id": id, "name": name, "error": value["isError"] == true,
                            "result": clip(&value["result"].to_string(), 4000)
                        }),
                    ));
                }
            }
            _ => {}
        }
    }

    fn accept_openhands(&mut self, value: &Value, kind: &str, events: &mut Vec<Value>) {
        match kind {
            "message" => {
                if let Some(message) = text(value, "text") {
                    self.text = message.into();
                    events.push(event("message.delta", json!({"text": message})));
                }
            }
            "tool.start" | "tool.complete" => {
                if let (Some(id), Some(name)) = (text(value, "id"), text(value, "name")) {
                    let payload = if kind == "tool.start" {
                        json!({"id": id, "name": name, "preview": clip(text(value, "preview").unwrap_or(""), 1000)})
                    } else {
                        json!({"id": id, "name": name, "error": value["error"] == true,
                            "result": clip(text(value, "result").unwrap_or(""), 4000)})
                    };
                    events.push(event(kind, payload));
                }
            }
            "result" => {
                if let Some(result) = text(value, "text") {
                    self.completed = true;
                    self.text = result.into();
                }
            }
            "error" => {
                self.failure = clip(
                    text(value, "message")
                        .filter(|s| !s.is_empty())
                        .unwrap_or("OpenHands could not complete this task."),
                    4000,
                );
            }
            _ => {}
        }
    }

    pub fn finish(self, code: Option<i32>) -> Result<Value> {
        let Some(harness) = self.harness else {
            bail!("Choose a supported CLI harness.")
        };
        if !self.failure.is_empty() {
            bail!(self.failure);
        }
        if code != Some(0) {
            bail!(
                "{} exited with code {}.",
                harness.name(),
                code.map_or_else(|| "unknown".to_string(), |c| c.to_string())
            );
        }
        if !self.completed {
            let message = if self.transient_error.is_empty() {
                format!(
                    "{} ended before confirming completion. Inspect its saved work before retrying.",
                    harness.name()
                )
            } else {
                self.transient_error
            };
            return Err(Interrupted(message).into());
        }
        Ok(json!({ "text": self.text }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn snapshot(harness: &str, provider: &str) -> Value {
        json!({
            "profile": {
                "id": "agent-1", "harness": harness,
                "computer": { "access": "private", "desktop": "none", "folders": [] },
                "connectors": [{ "id": "c1", "enabled": false }],
                "allowedTools": ["terminal", "read_file", "write_file", "patch", "search_files"],
                "prompt": { "enabled": true, "text": "Be brief." }
            },
            "effectiveModel": { "provider": provider, "model": "model-1", "baseUrl": "", "credentialRef": "KEY" }
        })
    }
    fn set(value: &mut Value, pointer: &str, next: Value) {
        *value.pointer_mut(pointer).unwrap() = next;
    }
    fn rejection(value: &Value) -> String {
        arguments(value).unwrap_err().to_string()
    }
    fn after<'a>(args: &'a [String], flag: &str) -> &'a str {
        &args[args.iter().position(|a| a == flag).unwrap() + 1]
    }

    #[test]
    fn claude_arguments_restrict_settings_and_map_tools() {
        let mut s = snapshot("claude-code", "anthropic");
        set(&mut s, "/profile/computer/access", json!("folders"));
        set(
            &mut s,
            "/profile/computer/folders",
            json!([{ "path": "/a", "mode": "read" }, { "path": "/b", "mode": "write" }]),
        );
        set(
            &mut s,
            "/profile/allowedTools",
            json!([
                "search_files",
                "terminal",
                "search_files",
                "web_extract",
                "unknown_tool"
            ]),
        );
        let args = arguments(&s).unwrap();
        assert_eq!(
            &args[..7],
            [
                "claude",
                "--print",
                "--output-format",
                "stream-json",
                "--verbose",
                "--model",
                "model-1"
            ]
        );
        assert_eq!(after(&args, "--setting-sources"), "");
        assert_eq!(after(&args, "--permission-mode"), "dontAsk");
        assert_eq!(after(&args, "--permission-prompts"), "none");
        for flag in ["--restricted", "--safe-mode", "--strict-mcp-config"] {
            assert!(args.iter().any(|a| a == flag), "{flag}");
        }
        let dirs = args.iter().position(|a| a == "--add-dir").unwrap();
        assert_eq!(
            &args[dirs + 1..dirs + 4],
            [
                "/workspace/private",
                "/workspace/mounts/folder-1",
                "/workspace/mounts/folder-2"
            ]
        );
        assert_eq!(after(&args, "--mcp-config"), "{\"mcpServers\":{}}");
        assert_eq!(after(&args, "--disallowedTools"), "mcp__*");
        assert_eq!(after(&args, "--tools"), "Glob,Grep,Bash,WebFetch");
        assert_eq!(after(&args, "--allowedTools"), "Glob,Grep,Bash,WebFetch");
        assert_eq!(
            &args[args.len() - 2..],
            ["--append-system-prompt", "Be brief."]
        );
    }

    #[test]
    fn claude_disabled_tools_and_instructions_compile_to_empty() {
        let mut s = snapshot("claude-code", "anthropic");
        set(&mut s, "/profile/allowedTools", json!([]));
        set(&mut s, "/profile/prompt/enabled", json!(false));
        let args = arguments(&s).unwrap();
        assert_eq!(after(&args, "--tools"), "");
        assert_eq!(after(&args, "--allowedTools"), "");
        assert!(!args.iter().any(|a| a == "--append-system-prompt"));
        assert!(!args.iter().any(|a| a.starts_with("/workspace/mounts/")));
    }

    #[test]
    fn chatgpt_plan_uses_only_the_fixed_responses_provider_and_existing_tool_grants() {
        let mut profile = snapshot("codex", "openai");
        profile["modelAuth"] = json!("chatgpt-plan");
        assert!(arguments(&profile).is_err());
        profile["effectiveModel"]["credentialRef"] = json!("");
        let argv = arguments(&profile).unwrap();
        assert_eq!(argv[..4], ["codex", "app-server", "--listen", "stdio://"]);
        for setting in [
            "model_providers.openai_chatgpt_plan.base_url=\"https://api.openai.com/v1\"",
            "model_providers.openai_chatgpt_plan.supports_websockets=false",
            "mcp_servers={}",
            "features.apps=false",
            "approval_policy=\"never\"",
        ] {
            assert!(argv.iter().any(|v| v == setting), "{setting}");
        }
        profile["effectiveModel"]["baseUrl"] = json!("http://localhost");
        assert!(arguments(&profile).is_err());
        profile["effectiveModel"]["baseUrl"] = json!("");
        profile["modelAuth"] = json!("unknown");
        assert!(arguments(&profile).is_err());
        profile["modelAuth"] = json!("chatgpt-plan");
        set(&mut profile, "/profile/allowedTools", json!([]));
        assert!(arguments(&profile).is_err());
    }

    #[test]
    fn codex_arguments_lock_down_config_and_use_endpoint() {
        let mut s = snapshot("codex", "openai");
        set(
            &mut s,
            "/effectiveModel/baseUrl",
            json!("https://llm.example/v1"),
        );
        set(
            &mut s,
            "/profile/prompt/text",
            json!("Say \"hi\"\nthen stop."),
        );
        let args = arguments(&s).unwrap();
        assert_eq!(
            &args[..10],
            [
                "codex",
                "exec",
                "--json",
                "--skip-git-repo-check",
                "--ignore-user-config",
                "--ignore-rules",
                "--sandbox",
                "danger-full-access",
                "--model",
                "model-1"
            ]
        );
        assert_eq!(args.last().unwrap(), "-");
        let config: Vec<&str> = args
            .windows(2)
            .filter(|w| w[0] == "-c")
            .map(|w| w[1].as_str())
            .collect();
        for expected in [
            "approval_policy=\"never\"",
            "projects.\"/workspace/shared\".trust_level=\"untrusted\"",
            "mcp_servers={}",
            "features.hooks=false",
            "features.plugins=false",
            "agents.enabled=false",
            "skills.bundled.enabled=false",
            "web_search=\"disabled\"",
            "openai_base_url=\"https://llm.example/v1\"",
            "developer_instructions=\"Say \\\"hi\\\"\\nthen stop.\"",
        ] {
            assert!(config.contains(&expected), "missing {expected}");
        }
        set(
            &mut s,
            "/profile/allowedTools",
            json!([
                "terminal",
                "read_file",
                "write_file",
                "patch",
                "search_files",
                "web_search"
            ]),
        );
        set(&mut s, "/effectiveModel/baseUrl", json!(""));
        set(&mut s, "/profile/prompt/enabled", json!(false));
        let args = arguments(&s).unwrap();
        assert!(args.iter().any(|a| a == "web_search=\"live\""));
        assert!(
            !args
                .iter()
                .any(|a| a.starts_with("openai_base_url=")
                    || a.starts_with("developer_instructions="))
        );
    }

    #[test]
    fn codex_requires_core_tools_together() {
        let mut s = snapshot("codex", "openai");
        set(
            &mut s,
            "/profile/allowedTools",
            json!(["terminal", "read_file"]),
        );
        assert!(rejection(&s).starts_with("Codex requires Terminal, Read files"));
    }

    #[test]
    fn arguments_reject_unsafe_profiles_and_models() {
        let cases: Vec<(&str, &str, Value, &str)> = vec![
            (
                "claude-code",
                "/profile/computer/access",
                json!("direct"),
                "Claude Code requires an isolated workspace without desktop access.",
            ),
            (
                "codex",
                "/profile/computer/desktop",
                json!("virtual"),
                "Codex requires an isolated workspace without desktop access.",
            ),
            (
                "claude-code",
                "/profile/connectors/0/enabled",
                json!(true),
                "Claude Code does not support MCP connections in Open Harness yet. Disable them or choose Hermes.",
            ),
            (
                "claude-code",
                "/effectiveModel/provider",
                json!("openai"),
                "Claude Code requires an Anthropic model and saved credential.",
            ),
            (
                "codex",
                "/effectiveModel/provider",
                json!("anthropic"),
                "Codex requires an OpenAI model and saved credential.",
            ),
            (
                "codex",
                "/profile/id",
                json!("../escape"),
                "Invalid agent ID.",
            ),
            (
                "codex",
                "/profile/harness",
                json!("hermes"),
                "Choose a supported CLI harness.",
            ),
            (
                "claude-code",
                "/effectiveModel/model",
                json!("--dangerously-skip-permissions"),
                "Choose a valid Anthropic model for this agent.",
            ),
            (
                "codex",
                "/effectiveModel/model",
                json!(""),
                "Choose a valid OpenAI model for this agent.",
            ),
            (
                "codex",
                "/effectiveModel/baseUrl",
                json!("https://x\n-c x=1"),
                "The selected endpoint contains an unsupported line break.",
            ),
            (
                "codex",
                "/effectiveModel/baseUrl",
                json!("file:///etc"),
                "The selected endpoint must start with http:// or https:// and contain no credentials, query or fragment.",
            ),
            (
                "claude-code",
                "/profile/allowedTools",
                json!("terminal"),
                "The tool choices for this agent could not be read. Review them in Agent settings.",
            ),
            (
                "claude-code",
                "/profile/prompt/text",
                json!("x".repeat(12_001)),
                "Instructions are limited to 12,000 characters.",
            ),
        ];
        for (harness, pointer, value, message) in cases {
            let mut s = snapshot(
                harness,
                if harness == "codex" {
                    "openai"
                } else {
                    "anthropic"
                },
            );
            set(&mut s, pointer, value);
            assert_eq!(rejection(&s), message, "{harness} {pointer}");
        }
        let mut s = snapshot("codex", "openai");
        s.as_object_mut().unwrap().remove("effectiveModel");
        assert_eq!(
            rejection(&s),
            "Choose a model for this agent before starting a task."
        );
    }

    #[test]
    fn claude_output_streams_top_level_events_and_confirms_result() {
        let mut out = Output::new("claude-code");
        assert!(out.accept(&json!("not an object")).is_empty());
        let long = "y".repeat(5000);
        let events = out.accept(&json!({ "type": "assistant", "message": { "content": [
            { "type": "text", "text": "Working" },
            { "type": "tool_use", "id": "t1", "name": "Bash", "input": { "command": long } }
        ] } }));
        assert_eq!(
            events[0],
            json!({ "type": "message.delta", "payload": { "text": "Working" } })
        );
        assert_eq!(events[1]["type"], "tool.start");
        assert_eq!(events[1]["payload"]["name"], "Bash");
        assert_eq!(
            events[1]["payload"]["preview"]
                .as_str()
                .unwrap()
                .chars()
                .count(),
            1000
        );
        assert!(out.accept(&json!({ "type": "assistant", "parent_tool_use_id": "t1", "message": { "content": [{ "type": "text", "text": "sub" }] } })).is_empty());
        let done = out.accept(&json!({ "type": "user", "message": { "content": [{ "type": "tool_result", "tool_use_id": "t1", "content": long, "is_error": true }] } }));
        assert_eq!(done[0]["payload"]["id"], "t1");
        assert_eq!(done[0]["payload"]["error"], true);
        assert_eq!(done[0]["payload"]["result"].as_str().unwrap().len(), 4000);
        out.accept(&json!({ "type": "result", "subtype": "success", "result": "Final answer" }));
        assert_eq!(
            out.finish(Some(0)).unwrap(),
            json!({ "text": "Final answer" })
        );
    }

    #[test]
    fn claude_output_reports_failures_exit_codes_and_truncation() {
        let mut out = Output::new("claude-code");
        out.accept(&json!({ "type": "result", "subtype": "error_max_turns", "errors": ["Too many", "turns"] }));
        assert_eq!(
            out.finish(Some(0)).unwrap_err().to_string(),
            "Too many turns"
        );

        let mut out = Output::new("claude-code");
        out.accept(&json!({ "type": "result", "subtype": "success", "is_error": true, "errors": [], "result": "Auth failed" }));
        assert_eq!(out.finish(Some(1)).unwrap_err().to_string(), "Auth failed");

        let mut out = Output::new("claude-code");
        out.accept(&json!({ "type": "result", "subtype": "success", "result": "ok" }));
        assert_eq!(
            out.finish(Some(137)).unwrap_err().to_string(),
            "Claude Code exited with code 137."
        );
        assert_eq!(
            Output::new("claude-code")
                .finish(None)
                .unwrap_err()
                .to_string(),
            "Claude Code exited with code unknown."
        );

        let mut out = Output::new("claude-code");
        out.accept(&json!({ "type": "assistant", "message": { "content": [{ "type": "text", "text": "partial" }] } }));
        let failure = out.finish(Some(0)).unwrap_err();
        assert_eq!(
            failure.downcast_ref::<Interrupted>().unwrap().0,
            "Claude Code ended before confirming completion. Inspect its saved work before retrying."
        );
    }

    #[test]
    fn codex_output_normalizes_items_and_requires_turn_completion() {
        let mut out = Output::new("codex");
        let start = out.accept(&json!({ "type": "item.started", "item": { "id": "i1", "type": "command_execution", "command": "ls" } }));
        assert_eq!(
            start,
            vec![
                json!({ "type": "tool.start", "payload": { "id": "i1", "name": "command_execution", "preview": "ls", "result": "" } })
            ]
        );
        let end = out.accept(&json!({ "type": "item.completed", "item": { "id": "i1", "type": "command_execution", "command": "ls", "aggregated_output": "a.txt", "status": "completed" } }));
        assert_eq!(end[0]["type"], "tool.complete");
        assert_eq!(end[0]["payload"]["result"], "a.txt");
        assert!(out.accept(&json!({ "type": "item.updated", "item": { "id": "i2", "type": "web_search", "query": "q" } })).is_empty());
        assert!(out.accept(&json!({ "type": "item.completed", "item": { "type": "reasoning", "text": "hidden" } })).is_empty());
        let message = out.accept(&json!({ "type": "item.completed", "item": { "type": "agent_message", "text": "Done." } }));
        assert_eq!(
            message,
            vec![json!({ "type": "message.delta", "payload": { "text": "Done." } })]
        );
        out.accept(&json!({ "type": "turn.completed" }));
        assert_eq!(out.finish(Some(0)).unwrap(), json!({ "text": "Done." }));
    }

    #[test]
    fn codex_output_failures_and_transient_errors() {
        let mut out = Output::new("codex");
        out.accept(&json!({ "type": "turn.failed", "error": { "message": "Quota exceeded" } }));
        out.accept(&json!({ "type": "turn.completed" }));
        assert_eq!(
            out.finish(Some(0)).unwrap_err().to_string(),
            "Quota exceeded"
        );

        let mut out = Output::new("codex");
        out.accept(&json!({ "type": "error", "message": "Reconnecting... 2/5" }));
        let failure = out.finish(Some(0)).unwrap_err();
        assert_eq!(
            failure.downcast_ref::<Interrupted>().unwrap().0,
            "Reconnecting... 2/5"
        );

        let mut out = Output::new("codex");
        out.accept(&json!({ "type": "turn.failed" }));
        assert_eq!(
            out.finish(Some(1)).unwrap_err().to_string(),
            "Codex could not complete this task."
        );

        let mut out = Output::new("hermes");
        assert!(out.accept(&json!({ "type": "turn.completed" })).is_empty());
        assert_eq!(
            out.finish(Some(0)).unwrap_err().to_string(),
            "Choose a supported CLI harness."
        );
    }
}
