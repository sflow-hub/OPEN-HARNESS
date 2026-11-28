use std::collections::{BTreeMap, BTreeSet};
use std::path::Path;

use anyhow::{Context, Result, anyhow, bail};
use serde_json::{Map, Value, json};
use url::{Host, Url};

use crate::{agent_dir, write_private};

pub(crate) const AGENT_TOOLS: &str = "/usr/local/bin/open-harness-agent-tools";
const COORDINATION_SERVER: &str = "open_harness";
const COORDINATION_TOOLS: [&str; 3] = [
    "mcp__open_harness__task",
    "mcp__open_harness__delegate_named_agent",
    "mcp__open_harness__create_open_harness_routine",
];
// Hermes will not hand a native provider's variable to a custom endpoint, so custom endpoints
// read the key from a name only Open Harness uses.
const CUSTOM_KEY_ENV: &str = "OPEN_HARNESS_MODEL_API_KEY";
const PROMPT_MAX: usize = 12_000;

struct Connector<'a> {
    name: &'a str,
    command: &'a str,
    args: Vec<&'a str>,
    secret_ref: &'a str,
    slack: bool,
}

pub fn prepare(
    root: &Path,
    snapshot: &Value,
    secrets: &BTreeMap<String, String>,
    coordinator: &str,
    token: &str,
    run_id: &str,
) -> Result<()> {
    // The ID becomes a path component; the pattern is validId's and rules out traversal.
    let id = snapshot
        .get("id")
        .and_then(Value::as_str)
        .filter(|id| is_name(id))
        .context("This run has an invalid agent ID.")?;
    let revision = snapshot
        .get("revision")
        .and_then(Value::as_u64)
        .context("This run has an invalid profile revision.")?;
    if run_id.is_empty() {
        bail!("This run has no run ID.");
    }
    crate::hermes::validate_profile(snapshot)?;

    let prompt = snapshot
        .get("prompt")
        .context("This run has no system prompt settings.")?;
    let prompt_on = prompt
        .get("enabled")
        .and_then(Value::as_bool)
        .context("This run has an invalid system prompt switch.")?;
    let prompt_text = text(prompt, "text", "System prompt", PROMPT_MAX, false)?;

    let model = snapshot
        .get("effectiveModel")
        .context("This run has no model choice.")?;
    let provider = text(model, "provider", "Provider", 100, true)?;
    let model_id = text(model, "model", "Model ID", 200, true)?;
    let credential_ref = text(model, "credentialRef", "Credential reference", 80, false)?;
    let base_url = text(model, "baseUrl", "Endpoint", 2000, false)?;
    if !credential_ref.is_empty() && !is_env_name(credential_ref) {
        bail!("Credential references must use uppercase letters, digits, and underscores.");
    }
    if !base_url.is_empty() {
        let url = Url::parse(base_url).map_err(|_| anyhow!("Enter a valid endpoint URL."))?;
        if !matches!(url.scheme(), "http" | "https")
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
        {
            bail!("Endpoint must be HTTP(S), without embedded credentials, query, or fragment.");
        }
    }

    // Connections fail closed: one that cannot be configured completely refuses the run instead
    // of starting a server with no credential or quietly dropping tools the operator granted.
    let mut names = BTreeSet::new();
    let mut connectors = Vec::new();
    for c in snapshot
        .get("connectors")
        .and_then(Value::as_array)
        .context("This run has invalid connections.")?
    {
        let name = c
            .get("name")
            .and_then(Value::as_str)
            .filter(|n| is_name(n) && *n != COORDINATION_SERVER && names.insert(*n))
            .context(
                "Connections need unique names using letters, numbers, dashes, or underscores.",
            )?;
        let enabled = c
            .get("enabled")
            .and_then(Value::as_bool)
            .with_context(|| format!("The {name} connection has an invalid on/off switch."))?;
        if !enabled {
            continue;
        }
        let slack = c["kind"] == "slack";
        if !c["kind"].is_null() && !slack {
            bail!("The {name} connection type is unavailable on this runner.");
        }
        let secret_ref = match c.get("secretRef") {
            None | Some(Value::Null) => "",
            Some(Value::String(s)) => s.as_str(),
            _ => bail!("The {name} connection has an invalid credential reference."),
        };
        if slack && secret_ref.is_empty() {
            bail!("Select a saved Slack bot token.");
        }
        if !secret_ref.is_empty() && !is_env_name(secret_ref) {
            bail!("The {name} connection has an invalid credential reference.");
        }
        let args = c
            .get("args")
            .and_then(Value::as_array)
            .filter(|a| a.len() <= 100)
            .with_context(|| format!("The {name} connection has invalid arguments."))?
            .iter()
            .map(|a| a.as_str().filter(|a| a.encode_utf16().count() <= 4000))
            .collect::<Option<Vec<_>>>()
            .with_context(|| format!("The {name} connection has invalid arguments."))?;
        let command = text(c, "command", "Executable", 300, true)?;
        if !secret_ref.is_empty() {
            // OPEN_HARNESS_* names are the control plane's; a connection must not be able to
            // overwrite the model key that the custom-endpoint route reads.
            if secret_ref.starts_with("OPEN_HARNESS_") {
                bail!(
                    "The {name} connection uses the reserved credential name {secret_ref}. Save its credential under another name."
                );
            }
            if secrets.get(secret_ref).is_none_or(String::is_empty) {
                bail!(
                    "The {name} connection needs the saved credential {secret_ref}, which this runner did not receive. Save the credential again or turn the connection off."
                );
            }
        }
        connectors.push(Connector {
            name,
            command,
            args,
            secret_ref,
            slack,
        });
    }

    // Explicit allowlist, re-derived the way runToolGrants does. The snapshot should already be
    // narrowed, but this only ever removes names, so applying it again cannot widen a grant.
    let tools = snapshot
        .get("allowedTools")
        .and_then(Value::as_array)
        .filter(|t| t.len() <= 3000)
        .context("Invalid tool selection.")?;
    let servers: BTreeSet<&str> = std::iter::once(COORDINATION_SERVER)
        .chain(connectors.iter().map(|c| c.name))
        .collect();
    let mut seen = BTreeSet::new();
    let mut allowed = Vec::new();
    for tool in tools {
        let tool = tool
            .as_str()
            .filter(|t| is_tool_id(t))
            .context("Invalid tool selection.")?;
        // A single-underscore mcp_ name never reaches here as a grant: guessing where the
        // server name ends could widen access, so it is dropped (matches runToolGrants).
        let keep = tool != "computer_use"
            && (!tool.starts_with("mcp_")
                || mcp_server_of(tool).is_some_and(|s| servers.contains(s)));
        if keep && seen.insert(tool) {
            allowed.push(tool);
        }
    }
    let coordination = allowed.iter().any(|t| COORDINATION_TOOLS.contains(t));

    let mut env = BTreeMap::new();
    // Any explicit endpoint is a custom endpoint: Hermes ignores base_url on its native
    // providers and only the custom path honours the URL and carries the key via key_env.
    let custom = !base_url.is_empty();
    // Hermes has no provider called "openai"; its API-key provider is "openai-api".
    let hermes_provider = if custom {
        "custom"
    } else {
        match provider {
            "local" => "custom",
            "openai" => "openai-api",
            other => other,
        }
    };
    if !credential_ref.is_empty() {
        let key = secrets.get(credential_ref).filter(|v| !v.is_empty())
            .with_context(|| format!("The model credential {credential_ref} was not sent to this runner. Save it in Credentials, or choose a model that needs no key."))?;
        put(&mut env, credential_ref, key)?;
        if custom {
            put(&mut env, CUSTOM_KEY_ENV, key)?;
        } else if let Some(native) = match provider {
            "xai" => Some("XAI_API_KEY"),
            "openrouter" => Some("OPENROUTER_API_KEY"),
            "anthropic" => Some("ANTHROPIC_API_KEY"),
            "openai" | "openai-api" => Some("OPENAI_API_KEY"),
            _ => None,
        } {
            put(&mut env, native, key)?;
        }
    }

    let mut mcp = Map::new();
    if coordination {
        if token.is_empty() {
            bail!(
                "This run has no coordination token, so its task and hand-off tools cannot start."
            );
        }
        mcp.insert(COORDINATION_SERVER.into(), json!({ "command": AGENT_TOOLS, "args": ["coordination"], "env": {
            "OPEN_HARNESS_AGENT_ID": id, "OPEN_HARNESS_AGENT_TOKEN": token, "OPEN_HARNESS_RUN_ID": run_id, "OPEN_HARNESS_CONTROL_URL": container_control_url(coordinator)?,
        } }));
    }
    for c in &connectors {
        if !c.secret_ref.is_empty() {
            put(&mut env, c.secret_ref, &secrets[c.secret_ref])?;
        }
        // Only the variable NAME goes into config.yaml; Hermes expands it from the profile .env.
        if c.slack {
            mcp.insert(c.name.into(), json!({"command":AGENT_TOOLS,"args":["slack"],"env":{"SLACK_BOT_TOKEN":format!("${{{}}}",c.secret_ref)}}));
            continue;
        }
        let mut server_env = Map::new();
        if !c.secret_ref.is_empty() {
            server_env.insert(c.secret_ref.into(), format!("${{{}}}", c.secret_ref).into());
        }
        mcp.insert(
            c.name.into(),
            json!({ "command": c.command, "args": c.args, "env": server_env }),
        );
    }

    let mut model_config = json!({ "default": model_id, "provider": hermes_provider });
    if custom {
        model_config["base_url"] = base_url.into();
    }
    let mut config = json!({
        "model": model_config,
        "terminal": { "backend": "local", "cwd": "/workspace/shared", "home_mode": "profile" },
        "approvals": { "mode": "smart", "unattended_mode": "deny", "cron_mode": "deny" },
        "computer_use": { "permission_mode": "standard", "no_overlay": false },
        "cron": { "enabled": false },
        "delegation": { "inherit_mcp_toolsets": false },
        // Tool Search would defer every MCP tool behind bridges the policy strips, leaving the
        // granted tools reachable by no route.
        "tools": { "tool_search": { "enabled": "off" } },
        // An allow-LIST of plugin keys; any other shape gates the policy extension off and
        // managed_entry.py aborts every run at startup.
        "plugins": { "enabled": ["open_harness_policy"] },
        "mcp_servers": mcp,
    });
    if custom {
        let mut entry =
            json!({ "name": "custom", "base_url": base_url, "default_model": model_id });
        if !credential_ref.is_empty() {
            entry["key_env"] = CUSTOM_KEY_ENV.into();
        }
        config["providers"] = json!({ "custom": entry });
    }

    // python-dotenv reads a double-quoted value with JSON's escapes, as the TS writer relies on.
    let mut dotenv = String::new();
    for (name, value) in &env {
        dotenv.push_str(name);
        dotenv.push('=');
        dotenv.push_str(&serde_json::to_string(value)?);
        dotenv.push('\n');
    }
    if env.is_empty() {
        dotenv.push('\n');
    }

    crate::directory(&root.join("agents"))?;
    let agent = agent_dir(root, id)?;
    let (home, managed) = (agent.join("profile"), agent.join("managed"));
    // JSON is a YAML subset; serializing prevents YAML injection from prompts, names, and endpoints.
    write_private(
        &home.join("config.yaml"),
        serde_json::to_string_pretty(&config)?.as_bytes(),
    )?;
    write_private(
        &home.join("SOUL.md"),
        if prompt_on {
            prompt_text.as_bytes()
        } else {
            &[]
        },
    )?;
    write_private(&home.join(".env"), dotenv.as_bytes())?;
    write_private(
        &managed.join("policy.json"),
        json!({ "runId": run_id, "revision": revision, "allowedTools": allowed })
            .to_string()
            .as_bytes(),
    )?;
    Ok(())
}

pub(crate) fn coordination_enabled(snapshot: &Value) -> bool {
    snapshot["allowedTools"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .any(|v| COORDINATION_TOOLS.contains(&v))
}

fn text<'a>(
    value: &'a Value,
    key: &str,
    label: &str,
    max: usize,
    required: bool,
) -> Result<&'a str> {
    // Length is counted in UTF-16 units so the caps match the JavaScript validator exactly.
    value
        .get(key)
        .and_then(Value::as_str)
        .filter(|s| s.encode_utf16().count() <= max && (!required || !s.trim().is_empty()))
        .with_context(|| {
            format!(
                "{label} {}must be at most {max} characters.",
                if required { "is required and " } else { "" }
            )
        })
}
fn is_name(s: &str) -> bool {
    let b = s.as_bytes();
    (1..=80).contains(&b.len())
        && b[0].is_ascii_alphanumeric()
        && b.iter()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'_' | b'-'))
}
pub(crate) fn is_env_name(s: &str) -> bool {
    let b = s.as_bytes();
    (2..=80).contains(&b.len())
        && b[0].is_ascii_uppercase()
        && b.iter()
            .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || *c == b'_')
}
fn is_tool_id(s: &str) -> bool {
    (1..=200).contains(&s.len())
        && s.bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'_' | b'.' | b':' | b'-'))
}
fn mcp_server_of(id: &str) -> Option<&str> {
    id.strip_prefix("mcp__")?
        .split("__")
        .next()
        .filter(|s| !s.is_empty())
}
fn put(env: &mut BTreeMap<String, String>, name: &str, value: &str) -> Result<()> {
    // Two sources writing different values under one name would let the later one silently
    // replace the model key; refuse rather than pick.
    match env.get(name) {
        Some(existing) if existing != value => bail!(
            "Two credentials are configured under the name {name}. Give one of them a different name."
        ),
        _ => {
            env.insert(name.into(), value.into());
            Ok(())
        }
    }
}
fn container_control_url(coordinator: &str) -> Result<String> {
    let mut url = Url::parse(coordinator)
        .map_err(|_| anyhow!("The coordinator address is not a valid URL."))?;
    if !matches!(url.scheme(), "http" | "https")
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        bail!(
            "The coordinator address must be HTTP(S), without embedded credentials, query, or fragment."
        );
    }
    // Inside the container, loopback is the container itself. The TS runner does a string
    // replace on "://localhost", which also rewrites hosts like localhost.example.com.
    let loopback = match url.host() {
        Some(Host::Domain(d)) => d.eq_ignore_ascii_case("localhost"),
        Some(Host::Ipv4(ip)) => ip.is_loopback(),
        Some(Host::Ipv6(ip)) => ip.is_loopback(),
        None => bail!("The coordinator address has no host."),
    };
    if loopback {
        url.set_host(Some("host.docker.internal")).map_err(|_| {
            anyhow!("The coordinator address could not be rewritten for the container.")
        })?;
    }
    Ok(url.as_str().trim_end_matches('/').to_string())
}
#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn snapshot() -> Value {
        json!({ "id": "atlas", "revision": 3, "harness": "hermes", "prompt": { "enabled": true, "text": "Keep context." },
            "effectiveModel": { "provider": "xai", "model": "grok-4.6", "credentialRef": "XAI_API_KEY", "baseUrl": "" },
            "allowedTools": ["mcp__open_harness__task", "terminal", "computer_use", "mcp_research_lookup", "mcp__research__lookup", "mcp__off__x"],
            "connectors": [
                { "id": "r", "name": "research", "command": "npx", "args": ["-y", "research"], "secretRef": "RESEARCH_KEY", "enabled": true },
                { "id": "o", "name": "off", "command": "npx", "args": [], "secretRef": "", "enabled": false } ],
            "computer": { "machineId": "local", "access": "private", "desktop": "none", "folders": [], "reserveMachine": false, "resources": { "cpu": 2, "memoryMb": 4096, "concurrency": 4 } } })
    }
    fn secrets() -> BTreeMap<String, String> {
        [
            ("XAI_API_KEY", "xai-secret"),
            ("RESEARCH_KEY", "r\"key\n"),
            ("UNUSED", "never"),
        ]
        .into_iter()
        .map(|(k, v)| (k.into(), v.into()))
        .collect()
    }
    fn read(root: &Path, rel: &str) -> String {
        fs::read_to_string(root.join("agents/atlas").join(rel)).unwrap()
    }

    #[test]
    fn compiles_a_private_headless_profile() {
        let dir = tempfile::tempdir().unwrap();
        prepare(
            dir.path(),
            &snapshot(),
            &secrets(),
            "http://127.0.0.1:4317/",
            "tok",
            "run-1",
        )
        .unwrap();
        let policy: Value = serde_json::from_str(&read(dir.path(), "managed/policy.json")).unwrap();
        assert_eq!(
            policy,
            json!({ "runId": "run-1", "revision": 3, "allowedTools": ["mcp__open_harness__task", "terminal", "mcp__research__lookup"] })
        );
        let config: Value = serde_json::from_str(&read(dir.path(), "profile/config.yaml")).unwrap();
        assert_eq!(config["plugins"]["enabled"], json!(["open_harness_policy"]));
        assert_eq!(
            config["model"],
            json!({ "default": "grok-4.6", "provider": "xai" })
        );
        assert_eq!(
            config["mcp_servers"]["open_harness"]["env"]["OPEN_HARNESS_CONTROL_URL"],
            "http://host.docker.internal:4317"
        );
        assert_eq!(
            config["mcp_servers"]["research"]["env"],
            json!({ "RESEARCH_KEY": "${RESEARCH_KEY}" })
        );
        assert!(config["mcp_servers"].get("off").is_none());
        assert_eq!(
            read(dir.path(), "profile/.env"),
            "RESEARCH_KEY=\"r\\\"key\\n\"\nXAI_API_KEY=\"xai-secret\"\n"
        );
        assert_eq!(read(dir.path(), "profile/SOUL.md"), "Keep context.");
        assert_eq!(
            config["mcp_servers"]["open_harness"]["command"],
            AGENT_TOOLS
        );
        assert_eq!(
            config["mcp_servers"]["open_harness"]["args"],
            json!(["coordination"])
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(dir.path().join("agents/atlas/profile/.env"))
                    .unwrap()
                    .permissions()
                    .mode()
                    & 0o777,
                0o600
            );
        }
    }

    #[test]
    fn custom_endpoint_reads_the_key_from_the_managed_name() {
        let dir = tempfile::tempdir().unwrap();
        let mut s = snapshot();
        s["effectiveModel"] = json!({ "provider": "xai", "model": "m", "credentialRef": "PROXY_KEY", "baseUrl": "https://proxy.example/v1" });
        s["prompt"]["enabled"] = json!(false);
        let mut keys = secrets();
        keys.insert("PROXY_KEY".into(), "p".into());
        prepare(
            dir.path(),
            &s,
            &keys,
            "http://localhost.example.com:4317",
            "tok",
            "run-2",
        )
        .unwrap();
        let config: Value = serde_json::from_str(&read(dir.path(), "profile/config.yaml")).unwrap();
        assert_eq!(config["model"]["provider"], "custom");
        assert_eq!(config["providers"]["custom"]["key_env"], CUSTOM_KEY_ENV);
        assert_eq!(
            config["mcp_servers"]["open_harness"]["env"]["OPEN_HARNESS_CONTROL_URL"],
            "http://localhost.example.com:4317"
        );
        let env = read(dir.path(), "profile/.env");
        assert!(env.contains("OPEN_HARNESS_MODEL_API_KEY=\"p\"") && !env.contains("XAI_API_KEY"));
        assert_eq!(read(dir.path(), "profile/SOUL.md"), "");
    }

    #[test]
    fn refuses_without_writing() {
        let cases = [
            ("/computer/access", json!("direct")),
            ("/computer/desktop", json!("virtual")),
            ("/harness", json!("codex")),
            ("/id", json!("../escape")),
            ("/allowedTools", json!(["bad tool"])),
            ("/connectors/0/command", json!("")),
            ("/connectors/0/secretRef", json!(CUSTOM_KEY_ENV)),
            ("/effectiveModel/credentialRef", json!("MISSING_KEY")),
            ("/effectiveModel/baseUrl", json!("https://u:p@example.test")),
            ("/prompt/text", json!("x".repeat(PROMPT_MAX + 1))),
        ];
        for (pointer, invalid) in cases {
            let dir = tempfile::tempdir().unwrap();
            let mut s = snapshot();
            *s.pointer_mut(pointer).unwrap() = invalid;
            assert!(
                prepare(
                    dir.path(),
                    &s,
                    &secrets(),
                    "http://127.0.0.1:4317",
                    "tok",
                    "run"
                )
                .is_err(),
                "{pointer}"
            );
            assert!(!dir.path().join("agents").exists());
        }
    }

    #[test]
    fn coordination_needs_a_token_only_when_granted() {
        let dir = tempfile::tempdir().unwrap();
        assert!(prepare(dir.path(), &snapshot(), &secrets(), "", "", "run").is_err());
        let mut s = snapshot();
        s["allowedTools"] = json!([]);
        prepare(dir.path(), &s, &secrets(), "", "", "catalog").unwrap();
        let config: Value = serde_json::from_str(&read(dir.path(), "profile/config.yaml")).unwrap();
        assert!(config["mcp_servers"].get("open_harness").is_none());
        assert_eq!(
            read(dir.path(), "managed/policy.json"),
            r#"{"allowedTools":[],"revision":3,"runId":"catalog"}"#
        );
    }
}
