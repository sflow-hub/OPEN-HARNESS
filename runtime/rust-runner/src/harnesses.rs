use anyhow::{Result, ensure};

pub struct HarnessSpec {
    pub id: &'static str,
    pub name: &'static str,
    pub description: &'static str,
    pub tool_ids: &'static [&'static str],
    pub tool_group: &'static [&'static str],
}

pub const LEGACY_HARNESSES: [&str; 3] = ["hermes", "claude-code", "codex"];
pub const MODEL_PROVIDERS: [&str; 6] = [
    "openai",
    "anthropic",
    "xai",
    "openrouter",
    "local",
    "custom",
];

const CORE: &[&str] = &[
    "terminal",
    "read_file",
    "write_file",
    "patch",
    "search_files",
];

pub const HARNESSES: [HarnessSpec; 6] = [
    HarnessSpec {
        id: "hermes",
        name: "Hermes",
        description: "General-purpose agents with tools, memory and skills.",
        tool_ids: &[],
        tool_group: &[],
    },
    HarnessSpec {
        id: "claude-code",
        name: "Claude Code",
        description: "Anthropic’s coding harness in an isolated workspace.",
        tool_ids: &[
            "terminal",
            "read_file",
            "write_file",
            "patch",
            "search_files",
            "web_search",
            "web_extract",
        ],
        tool_group: &[],
    },
    HarnessSpec {
        id: "codex",
        name: "Codex",
        description: "OpenAI’s coding harness in an isolated workspace.",
        tool_ids: &[
            "terminal",
            "read_file",
            "write_file",
            "patch",
            "search_files",
            "web_search",
        ],
        tool_group: CORE,
    },
    HarnessSpec {
        id: "opencode",
        name: "OpenCode",
        description: "A headless coding harness with terminal and file tools.",
        tool_ids: CORE,
        tool_group: &["write_file", "patch"],
    },
    HarnessSpec {
        id: "pi",
        name: "Pi",
        description: "A coding harness with independently selectable terminal and file tools.",
        tool_ids: CORE,
        tool_group: &[],
    },
    HarnessSpec {
        id: "openhands",
        name: "OpenHands",
        description: "A software agent with terminal access and a file editor.",
        tool_ids: &["terminal", "read_file", "write_file", "patch"],
        tool_group: &["read_file", "write_file", "patch"],
    },
];

pub fn find(id: &str) -> Option<&'static HarnessSpec> {
    HARNESSES.iter().find(|harness| harness.id == id)
}

pub fn is_additional(id: &str) -> bool {
    find(id).is_some() && !LEGACY_HARNESSES.contains(&id)
}

pub fn default_credential_ref(provider: &str) -> &'static str {
    match provider {
        "openai" => "OPENAI_API_KEY",
        "anthropic" => "ANTHROPIC_API_KEY",
        "xai" => "XAI_API_KEY",
        "openrouter" => "OPENROUTER_API_KEY",
        _ => "",
    }
}

pub fn validate_additional_model(provider: &str, model: &str, base_url: &str) -> Result<()> {
    ensure!(
        MODEL_PROVIDERS.contains(&provider),
        "Choose OpenAI, Anthropic, xAI, OpenRouter, Local, or Custom for this harness."
    );
    ensure!(
        !model.is_empty()
            && model.chars().count() <= 200
            && !model.starts_with('-')
            && !model.chars().any(|c| c.is_whitespace() || c.is_control()),
        "Choose a valid model ID for this agent."
    );
    ensure!(
        !matches!(provider, "local" | "custom") || !base_url.is_empty(),
        "Enter an OpenAI-compatible endpoint for this model."
    );
    ensure!(
        base_url.is_empty()
            || (base_url.len() <= 2000
                && !base_url.chars().any(char::is_control)
                && url::Url::parse(base_url).is_ok_and(|url| {
                    matches!(url.scheme(), "http" | "https")
                        && url.has_host()
                        && url.username().is_empty()
                        && url.password().is_none()
                        && url.query().is_none()
                        && url.fragment().is_none()
                })),
        "Endpoint must be HTTP(S) without embedded credentials, query, or fragment."
    );
    Ok(())
}
