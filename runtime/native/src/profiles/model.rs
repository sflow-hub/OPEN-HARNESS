use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::HashSet;

pub const TASK: &str = "mcp__open_harness__task";
pub const CORE: [&str; 5] = [
    "terminal",
    "read_file",
    "write_file",
    "patch",
    "search_files",
];
pub const DEFAULT_TOOLS: [&str; 16] = [
    TASK,
    "read_file",
    "write_file",
    "patch",
    "search_files",
    "terminal",
    "process_manage",
    "execute_code",
    "memory",
    "session_search",
    "skills_list",
    "skill_view",
    "skill_manage",
    "web_search",
    "web_extract",
    "clarify",
];

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Model {
    pub provider: String,
    pub model: String,
    pub credential_ref: String,
    pub base_url: String,
}
impl Default for Model {
    fn default() -> Self {
        Self {
            provider: "xai".into(),
            model: "grok-4.6".into(),
            credential_ref: "XAI_API_KEY".into(),
            base_url: String::new(),
        }
    }
}
impl Model {
    pub fn validate(&self) -> Result<()> {
        bounded(&self.provider, "Provider", 100, true)?;
        bounded(&self.model, "Model ID", 200, true)?;
        bounded(&self.base_url, "Endpoint", 2000, false)?;
        ensure!(
            self.credential_ref.is_empty() || valid_ref(&self.credential_ref, 80),
            "Invalid credential reference."
        );
        if !self.base_url.is_empty() {
            let url = reqwest::Url::parse(&self.base_url).context("Enter a valid endpoint URL.")?;
            ensure!(
                matches!(url.scheme(), "http" | "https")
                    && url.host().is_some()
                    && url.username().is_empty()
                    && url.password().is_none()
                    && url.query().is_none()
                    && url.fragment().is_none()
                    && !self.base_url.contains(['\0', '\n', '\r']),
                "Endpoint must be HTTP(S) without embedded credentials, query, or fragment."
            );
        }
        Ok(())
    }
}
#[derive(Clone, Serialize, Deserialize)]
pub struct Selection {
    pub inherit: bool,
    #[serde(flatten)]
    pub choice: Model,
}
#[derive(Clone, Serialize, Deserialize)]
pub struct Prompt {
    pub enabled: bool,
    pub text: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Connector {
    pub id: String,
    pub name: String,
    pub command: String,
    pub args: Vec<String>,
    #[serde(default)]
    pub secret_ref: String,
    pub enabled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kind: Option<String>,
}
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Board {
    pub assign_others: bool,
    pub dispatch: bool,
    pub manage_projects: bool,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Resources {
    pub cpu: f64,
    pub memory_mb: u64,
    pub concurrency: u8,
}
impl Default for Resources {
    fn default() -> Self {
        Self {
            cpu: 2.0,
            memory_mb: 4096,
            concurrency: 4,
        }
    }
}
#[derive(Clone, Serialize, Deserialize)]
pub struct Folder {
    #[serde(default = "crate::id")]
    pub id: String,
    pub path: String,
    pub mode: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct Computer {
    pub machine_id: String,
    pub access: String,
    pub desktop: String,
    pub folders: Vec<Folder>,
    pub reserve_machine: bool,
    pub resources: Resources,
}
impl Default for Computer {
    fn default() -> Self {
        Self {
            machine_id: "local".into(),
            access: "private".into(),
            desktop: "none".into(),
            folders: vec![],
            reserve_machine: false,
            resources: Resources::default(),
        }
    }
}
fn hermes() -> String {
    "hermes".into()
}
fn configured() -> String {
    "configured".into()
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    pub id: String,
    pub revision: u64,
    pub name: String,
    pub role: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub tone: u8,
    #[serde(default = "hermes")]
    pub harness: String,
    #[serde(default = "configured")]
    pub model_auth: String,
    #[serde(default)]
    pub worker_launch: bool,
    pub prompt: Prompt,
    pub model: Selection,
    pub allowed_tools: Vec<String>,
    #[serde(default)]
    pub board: Board,
    pub connectors: Vec<Connector>,
    #[serde(default)]
    pub computer: Computer,
}

pub fn valid_id(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 80
        && s.as_bytes()[0].is_ascii_alphanumeric()
        && s.bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_'))
}
pub fn valid_ref(s: &str, max: usize) -> bool {
    (2..=max).contains(&s.len())
        && s.as_bytes()[0].is_ascii_uppercase()
        && s.bytes()
            .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == b'_')
}
fn bounded(value: &str, name: &str, max: usize, required: bool) -> Result<()> {
    ensure!(
        (!required || !value.trim().is_empty()) && value.encode_utf16().count() <= max,
        "{name} must be at most {max} characters and have a valid value."
    );
    Ok(())
}
impl Profile {
    pub fn draft(agent: &Value) -> Result<Self> {
        if let Some(raw) = agent.get("profile").filter(|p| !p.is_null()) {
            let mut p: Self = serde_json::from_value(raw.clone())?;
            ensure!(
                agent.get("id").is_none_or(|id| id == &p.id),
                "Profile ID does not match this agent."
            );
            p.revision = 0;
            return p.validate(true);
        }
        let id = agent
            .get("id")
            .map(|s| s.as_str().context("Invalid agent ID.").map(str::to_string))
            .transpose()?
            .unwrap_or_else(crate::id);
        let name = agent["name"]
            .as_str()
            .context("An agent needs a name.")?
            .to_owned();
        let harness = agent
            .get("harness")
            .map(|h| h.as_str().context("Invalid harness."))
            .transpose()?
            .unwrap_or("hermes")
            .to_owned();
        let model = match harness.as_str() {
            "claude-code" => Model {
                provider: "anthropic".into(),
                model: "sonnet".into(),
                credential_ref: "ANTHROPIC_API_KEY".into(),
                base_url: String::new(),
            },
            "codex" => Model {
                provider: "openai".into(),
                model: "gpt-6.1-sol".into(),
                credential_ref: "OPENAI_API_KEY".into(),
                base_url: String::new(),
            },
            _ => Model::default(),
        };
        let explicit = agent.get("model").filter(|m| !m.is_null()).or_else(|| {
            agent.get("config").filter(|s| {
                s["model"]
                    .as_str()
                    .is_some_and(|m| !m.is_empty() && m != "hermes-agent")
            })
        });
        let mut inherit = harness == "hermes";
        let mut merged = serde_json::to_value(model)?;
        if let Some(selection) = explicit {
            inherit = selection["inherit"].as_bool().unwrap_or(false);
            for k in ["model", "provider", "credentialRef", "baseUrl"] {
                if let Some(v) = selection.get(k) {
                    merged[k] = v.clone();
                }
            }
            if selection.get("credentialRef").is_none() && merged["provider"] != "xai" {
                merged["credentialRef"] = json!(match merged["provider"].as_str() {
                    Some("openai") => "OPENAI_API_KEY",
                    Some("anthropic") => "ANTHROPIC_API_KEY",
                    Some("openrouter") => "OPENROUTER_API_KEY",
                    _ => "",
                });
            }
        }
        let model_auth = agent
            .get("modelAuth")
            .map(|v| v.as_str().context("Invalid billing method."))
            .transpose()?
            .unwrap_or("configured");
        if model_auth == "chatgpt-plan" && explicit.and_then(|s| s.get("credentialRef")).is_none() {
            merged["credentialRef"] = json!("");
        }
        let worker_launch = agent
            .get("workerLaunch")
            .map(|v| v.as_bool().context("Invalid worker launch setting."))
            .transpose()?
            .unwrap_or(false);
        let tone = agent
            .get("tone")
            .map(|v| {
                v.as_u64()
                    .and_then(|i| u8::try_from(i).ok())
                    .context("Choose an avatar color.")
            })
            .transpose()?
            .unwrap_or(0);
        Self {
            id,
            name,
            harness,
            model_auth: model_auth.into(),
            worker_launch,
            revision: 0,
            role: agent["role"].as_str().unwrap_or("Assistant").into(),
            description: agent["description"].as_str().unwrap_or("").into(),
            tone,
            prompt: Prompt {
                enabled: true,
                text: agent["instructions"].as_str().unwrap_or("").into(),
            },
            model: Selection {
                inherit,
                choice: serde_json::from_value(merged)?,
            },
            allowed_tools: DEFAULT_TOOLS.iter().map(|&s| s.into()).collect(),
            board: Board::default(),
            connectors: vec![],
            computer: Computer::default(),
        }
        .validate(false)
    }
    pub fn validate(mut self, legacy: bool) -> Result<Self> {
        ensure!(valid_id(&self.id), "Invalid agent ID.");
        ensure!(
            matches!(self.harness.as_str(), "hermes" | "claude-code" | "codex"),
            "Choose a supported agent harness."
        );
        bounded(&self.name, "Name", 30, true)?;
        self.name = self.name.trim().into();
        bounded(&self.role, "Role", 60, true)?;
        self.role = self.role.trim().into();
        bounded(&self.description, "Description", 180, false)?;
        bounded(&self.prompt.text, "System prompt", 12000, false)?;
        ensure!(self.tone <= 5, "Choose an avatar color.");
        if self.model.inherit && self.model.choice.model.is_empty() {
            self.model.choice.model = Model::default().model;
        }
        self.model.choice.validate()?;
        ensure!(
            matches!(self.model_auth.as_str(), "configured" | "chatgpt-plan"),
            "Choose a supported billing method."
        );
        ensure!(
            !self.worker_launch || matches!(self.harness.as_str(), "codex" | "claude-code"),
            "Worker launches require a Codex or Claude Code agent."
        );
        if self.model_auth == "chatgpt-plan" {
            ensure!(
                self.harness == "codex"
                    && self.model.choice.provider == "openai"
                    && !self.model.inherit
                    && self.model.choice.base_url.is_empty()
                    && self.model.choice.credential_ref.is_empty(),
                "ChatGPT plan usage requires a Codex agent with an explicit OpenAI model, the official endpoint, and an empty API credential."
            );
        }
        let c = &mut self.computer;
        // Convert only previously saved desktop/direct settings. New edits that request a GUI
        // are rejected, so an operator cannot mistake a headless job for a graphical one.
        if legacy && matches!(c.desktop.as_str(), "virtual" | "existing") {
            c.desktop = "none".into();
        }
        if legacy && c.access == "direct" {
            c.access = "private".into();
            c.folders.clear();
        }
        ensure!(
            matches!(c.access.as_str(), "private" | "folders") && c.desktop == "none",
            "Every harness runs headless. Choose an isolated workspace and turn off desktop access."
        );
        ensure!(valid_id(&c.machine_id), "Invalid machine ID.");
        ensure!(
            (0.25..=64.0).contains(&c.resources.cpu)
                && (256..=262144).contains(&c.resources.memory_mb)
                && (1..=32).contains(&c.resources.concurrency),
            "Computer resource limits are outside the supported range."
        );
        c.resources.cpu = (c.resources.cpu * 100.0).round() / 100.0;
        if c.access != "folders" {
            c.folders.clear();
        }
        ensure!(c.folders.len() <= 50, "Too many shared folders.");
        for folder in &c.folders {
            bounded(&folder.id, "Folder ID", 100, true)?;
            bounded(&folder.path, "Folder path", 4000, true)?;
            ensure!(
                matches!(folder.mode.as_str(), "read" | "write"),
                "Invalid folder permission."
            );
        }
        let mut names = HashSet::new();
        for conn in &mut self.connectors {
            bounded(&conn.id, "Connection ID", 100, true)?;
            ensure!(
                valid_id(&conn.name)
                    && conn.name != "open_harness"
                    && names.insert(conn.name.clone()),
                "Connections need unique names."
            );
            ensure!(
                conn.args.len() <= 100
                    && conn
                        .args
                        .iter()
                        .all(|a| a.encode_utf16().count() <= 4000 && !a.contains('\0')),
                "Invalid connection arguments."
            );
            ensure!(
                conn.secret_ref.is_empty() || valid_ref(&conn.secret_ref, 80),
                "Invalid connection secret reference."
            );
            if let Some(kind) = &conn.kind {
                ensure!(kind == "slack", "Unknown connection type.");
                ensure!(
                    !conn.enabled || !conn.secret_ref.is_empty(),
                    "Choose a saved Slack bot token."
                );
                conn.command = "node".into();
                conn.args = vec!["/run/open-harness/slack.mjs".into()];
            } else {
                bounded(&conn.command, "Connection executable", 300, true)?;
            }
        }
        if self.harness != "hermes" {
            let provider = if self.harness == "claude-code" {
                "anthropic"
            } else {
                "openai"
            };
            ensure!(
                !self.model.inherit && self.model.choice.provider == provider,
                "Choose an explicit {provider} model for this harness."
            );
            ensure!(
                !self.connectors.iter().any(|c| c.enabled),
                "Configured MCP connections require the Hermes harness."
            );
        }
        ensure!(
            self.allowed_tools.len() <= 3000
                && self.allowed_tools.iter().all(|s| !s.is_empty()
                    && s.len() <= 200
                    && s.bytes().all(
                        |c| c.is_ascii_alphanumeric() || matches!(c, b'.' | b'_' | b'-' | b':')
                    )),
            "Invalid tool selection."
        );
        let mut seen = HashSet::new();
        self.allowed_tools.push(TASK.into());
        for t in &mut self.allowed_tools {
            if t.starts_with("mcp_") && !t.starts_with("mcp__") {
                for server in std::iter::once("open_harness")
                    .chain(self.connectors.iter().map(|c| c.name.as_str()))
                {
                    if let Some(name) = t.strip_prefix(&format!("mcp_{server}_")) {
                        if server != "open_harness"
                            || matches!(
                                name,
                                "task" | "delegate_named_agent" | "create_open_harness_routine"
                            )
                        {
                            *t = format!("mcp__{server}__{name}");
                        }
                        break;
                    }
                }
            }
        }
        self.allowed_tools
            .retain(|t| t != "computer_use" && seen.insert(t.clone()));
        ensure!(
            self.harness != "codex"
                || CORE
                    .iter()
                    .all(|t| self.allowed_tools.iter().any(|s| s == t)),
            "Codex requires Terminal, Read files, Write files, Edit files, and Search files together."
        );
        Ok(self)
    }
    pub fn grants(&self) -> Vec<&str> {
        self.allowed_tools
            .iter()
            .filter(|t| {
                if !t.starts_with("mcp_") {
                    return true;
                }
                t.strip_prefix("mcp__")
                    .and_then(|s| s.split_once("__"))
                    .is_some_and(|(server, _)| {
                        server == "open_harness"
                            || self
                                .connectors
                                .iter()
                                .any(|c| c.enabled && c.name == server)
                    })
            })
            .map(String::as_str)
            .collect()
    }
    pub fn agent(&self) -> Value {
        json!({"id":self.id,"name":self.name,"role":self.role,"description":self.description,"tone":self.tone,"instructions":self.prompt.text,"memory":[],"profile":self})
    }
}
