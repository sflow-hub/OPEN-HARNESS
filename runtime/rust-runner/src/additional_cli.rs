use crate::harnesses::{default_credential_ref, find, validate_additional_model};
use anyhow::{Context, Result, ensure};
use serde_json::{Map, Value, json};
use std::{fs, path::Path};

pub const CONFIG_DIR: &str = "/run/open-harness";
pub const MODEL_KEY: &str = "OPEN_HARNESS_MODEL_API_KEY";
const MANAGED_PROVIDER: &str = "open-harness-model";
const SHARED_INSTRUCTIONS: &str =
    "Use /workspace/shared for shared work and /workspace/private for private agent files.";

pub struct Model<'a> {
    pub provider: &'a str,
    pub id: &'a str,
    pub base_url: &'a str,
    pub credential_ref: &'a str,
}

impl<'a> Model<'a> {
    pub fn from_snapshot(value: &'a Value) -> Result<Self> {
        let provider = crate::required_str(value, "provider")?;
        let id = crate::required_str(value, "model")?;
        let base_url = value["baseUrl"].as_str().unwrap_or("");
        let credential_ref = value["credentialRef"].as_str().unwrap_or("");
        validate_additional_model(provider, id, base_url)?;
        Ok(Self {
            provider,
            id,
            base_url: if base_url.is_empty() {
                match provider {
                    "openai" => "https://api.openai.com/v1",
                    "anthropic" => "https://api.anthropic.com/v1",
                    "xai" => "https://api.x.ai/v1",
                    "openrouter" => "https://openrouter.ai/api/v1",
                    _ => unreachable!("Local and Custom have an explicit endpoint"),
                }
            } else {
                base_url.trim_end_matches('/')
            },
            credential_ref: if credential_ref.is_empty() {
                default_credential_ref(provider)
            } else {
                credential_ref
            },
        })
    }
}

pub fn arguments(harness: &str, model: &Model, tools: &[&str], instructions: &str) -> Vec<String> {
    let owned = |args: &[&str]| args.iter().map(|arg| arg.to_string()).collect::<Vec<_>>();
    match harness {
        "opencode" => {
            let mut args = owned(&[
                "opencode", "run", "--pure", "--format", "json", "--agent", "build", "--model",
            ]);
            args.push(format!("{MANAGED_PROVIDER}/{}", model.id));
            args
        }
        "pi" => {
            let granted = [
                ("terminal", &["bash"][..]),
                ("read_file", &["read"][..]),
                ("write_file", &["write"][..]),
                ("patch", &["edit"][..]),
                ("search_files", &["grep", "find", "ls"][..]),
            ]
            .into_iter()
            .filter(|(id, _)| tools.contains(id))
            .flat_map(|(_, names)| names.iter().copied())
            .collect::<Vec<_>>();
            let mut args = owned(&[
                "/bin/sh",
                "/opt/open-harness/pi-entrypoint.sh",
                "pi",
                "--mode",
                "json",
                "--no-session",
                "--no-approve",
                "--no-extensions",
                "--no-skills",
                "--no-prompt-templates",
                "--no-themes",
                "--no-context-files",
                "--no-mcp",
                "--offline",
                "--provider",
                MANAGED_PROVIDER,
                "--model",
                model.id,
            ]);
            if granted.is_empty() {
                args.push("--no-tools".into());
            } else {
                args.extend(["--tools".into(), granted.join(",")]);
            }
            if !instructions.is_empty() {
                args.extend([
                    "--append-system-prompt".into(),
                    format!("{CONFIG_DIR}/instructions.md"),
                ]);
            }
            args
        }
        // The bridge filename also names the SDK namespace. Keep its directory off sys.path.
        "openhands" => owned(&["python3", "-P", "/opt/open-harness/openhands.py"]),
        _ => unreachable!("only additional headless harnesses use managed CLI configuration"),
    }
}

pub fn tool_grants<'a>(harness: &str, allowed: &[&'a str]) -> Result<Vec<&'a str>> {
    let spec = find(harness).context("Choose a supported harness.")?;
    let selected = spec
        .tool_group
        .iter()
        .filter(|tool| allowed.contains(tool))
        .count();
    ensure!(
        selected == 0 || selected == spec.tool_group.len(),
        "{} needs its combined file editor permissions selected together.",
        spec.name
    );
    Ok(allowed
        .iter()
        .copied()
        .filter(|id| spec.tool_ids.contains(id))
        .collect())
}

pub fn write_config(
    harness: &str,
    directory: &Path,
    model: &Model,
    tools: &[&str],
    instructions: &str,
) -> Result<()> {
    let (filename, config) = match harness {
        "opencode" => {
            let mut permission = Map::from_iter([("*".into(), json!("deny"))]);
            for (grant, permissions) in [
                ("terminal", &["bash"][..]),
                ("read_file", &["read"][..]),
                ("write_file", &["edit"][..]),
                ("search_files", &["glob", "grep"][..]),
            ] {
                if tools.contains(&grant) {
                    for name in permissions {
                        permission.insert((*name).into(), json!("allow"));
                    }
                }
            }
            let package = match model.provider {
                "openai" => "@ai-sdk/openai",
                "anthropic" => "@ai-sdk/anthropic",
                "xai" => "@ai-sdk/xai",
                "openrouter" => "@openrouter/ai-sdk-provider",
                _ => "@ai-sdk/openai-compatible",
            };
            let mut options = json!({ "baseURL": model.base_url });
            if !model.credential_ref.is_empty() {
                options["apiKey"] = json!(format!("{{env:{MODEL_KEY}}}"));
            }
            fs::write(
                directory.join("instructions.md"),
                format!("{SHARED_INSTRUCTIONS}\n\n{instructions}"),
            )?;
            (
                "opencode.json",
                json!({
                    "autoupdate": false,
                    "share": "disabled",
                    "formatter": false,
                    "lsp": false,
                    "mcp": {},
                    "permission": permission,
                    "instructions": [format!("{CONFIG_DIR}/instructions.md")],
                    "enabled_providers": [MANAGED_PROVIDER],
                    "provider": {
                        (MANAGED_PROVIDER): {
                            "name": "Open Harness",
                            "npm": package,
                            "options": options,
                            "models": {
                                (model.id): {
                                    "name": model.id,
                                    "tool_call": true,
                                    "limit": {"context": 32768, "output": 8192}
                                }
                            }
                        }
                    }
                }),
            )
        }
        "pi" => {
            if !instructions.is_empty() {
                fs::write(directory.join("instructions.md"), instructions)?;
            }
            let api = match model.provider {
                "openai" => "openai-responses",
                "anthropic" => "anthropic-messages",
                _ => "openai-completions",
            };
            // The Anthropic SDK appends /v1/messages to the origin.
            let base_url = if model.provider == "anthropic" {
                model.base_url.strip_suffix("/v1").unwrap_or(model.base_url)
            } else {
                model.base_url
            };
            // Pi expects a nonempty key in its model registry even for unauthenticated endpoints.
            let key = if model.credential_ref.is_empty() {
                "open-harness-local".into()
            } else {
                format!("${MODEL_KEY}")
            };
            (
                "models.json",
                json!({"providers": {
                    (MANAGED_PROVIDER): {
                        "baseUrl": base_url,
                        "api": api,
                        "apiKey": key,
                        "models": [{"id": model.id}]
                    }
                }}),
            )
        }
        "openhands" => (
            "config.json",
            json!({
                "provider": model.provider,
                "model": model.id,
                "baseUrl": model.base_url,
                "instructions": instructions,
                "tools": tools
            }),
        ),
        _ => unreachable!("only additional headless harnesses use managed CLI configuration"),
    };
    fs::write(directory.join(filename), serde_json::to_vec(&config)?)?;
    Ok(())
}
