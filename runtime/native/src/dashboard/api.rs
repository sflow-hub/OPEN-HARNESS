//! Authenticated same-origin API client: fixed local_url, path whitelist, server token only.
use crate::App;
use reqwest::Method;
use serde_json::{Value, json};
use std::time::Duration;

pub fn valid_id(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 80
        && s.as_bytes()[0].is_ascii_alphanumeric()
        && s.bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_'))
}

pub fn valid_ref(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 80
        && s.bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_'))
}

pub fn valid_file_name(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 200
        && s != "."
        && s != ".."
        && !s.contains('/')
        && !s.contains('\\')
        && !s.contains('\0')
}

/// Matches coordinator skill directory names (`profiles/files.rs` valid_skill).
pub fn valid_skill_name(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 80
        && s.as_bytes()[0].is_ascii_alphanumeric()
        && !s.contains("..")
        && !s.contains(' ')
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
}

pub fn valid_scope(s: &str) -> bool {
    matches!(s, "shared" | "private")
}

/// Whitelisted coordinator calls. Path IDs are validated before formatting.
pub enum Call<'a> {
    Agents,
    CreateAgent,
    AgentProfile(&'a str),
    SaveAgentProfile(&'a str),
    AgentTools(&'a str),
    AgentHarness(&'a str),
    InstallHarness(&'a str),
    AgentContext(&'a str),
    SaveAgentMemory(&'a str),
    AgentSkill(&'a str, &'a str),
    SaveAgentSkill(&'a str, &'a str),
    DeleteAgentSkill(&'a str, &'a str),
    TransferAgent(&'a str),
    WorkspaceModel,
    SaveWorkspaceModel,
    Runs,
    CreateRun,
    RunEvents(&'a str, u64),
    StopRun(&'a str),
    StopAllRuns,
    Approval(&'a str),
    Credentials,
    CreateCredential,
    RotateCredential(&'a str),
    DeleteCredential(&'a str),
    Teams,
    CreateTeam,
    RetireTeam(&'a str),
    Tasks,
    CreateTask,
    CreateBoard,
    StartTask(&'a str),
    StopTask(&'a str),
    ApproveTask(&'a str),
    Routines,
    CreateRoutine,
    RunRoutine(&'a str),
    ToggleRoutine(&'a str),
    DeleteRoutine(&'a str),
    Files {
        scope: &'a str,
        agent: Option<&'a str>,
    },
    File {
        scope: &'a str,
        agent: Option<&'a str>,
        name: &'a str,
    },
    SaveFile {
        scope: &'a str,
        agent: Option<&'a str>,
    },
    DeleteFile {
        scope: &'a str,
        agent: Option<&'a str>,
        name: &'a str,
    },
    Machines,
    PairMachine,
    TestMachine(&'a str),
    ReconnectMachine(&'a str),
    RevokeMachine(&'a str),
}

fn route(call: &Call<'_>) -> Result<(Method, String), String> {
    fn id(s: &str) -> Result<&str, String> {
        if valid_id(s) {
            Ok(s)
        } else {
            Err("Invalid identifier.".into())
        }
    }
    fn reference(s: &str) -> Result<&str, String> {
        if valid_ref(s) {
            Ok(s)
        } else {
            Err("Invalid credential reference.".into())
        }
    }
    fn file(s: &str) -> Result<&str, String> {
        if valid_file_name(s) {
            Ok(s)
        } else {
            Err("Invalid file name.".into())
        }
    }
    fn skill(s: &str) -> Result<&str, String> {
        if valid_skill_name(s) {
            Ok(s)
        } else {
            Err("Invalid skill name.".into())
        }
    }
    fn files_path(scope: &str, agent: Option<&str>, name: Option<&str>) -> Result<String, String> {
        if !valid_scope(scope) {
            return Err("Invalid workspace scope.".into());
        }
        let mut q = format!("scope={scope}");
        if scope == "private" {
            let agent = agent.ok_or_else(|| "Choose an agent.".to_string())?;
            q.push_str(&format!("&agentId={}", id(agent)?));
        }
        if let Some(name) = name {
            q.push_str(&format!("&name={}", urlencoding_file(file(name)?)));
        }
        Ok(format!("/v1/files?{q}"))
    }
    Ok(match call {
        Call::Agents => (Method::GET, "/v1/agents".into()),
        Call::CreateAgent => (Method::POST, "/v1/agents".into()),
        Call::AgentProfile(a) => (Method::GET, format!("/v1/agents/{}/profile", id(a)?)),
        Call::SaveAgentProfile(a) => (Method::PUT, format!("/v1/agents/{}/profile", id(a)?)),
        Call::AgentTools(a) => (Method::GET, format!("/v1/agents/{}/tools", id(a)?)),
        Call::AgentHarness(a) => (Method::GET, format!("/v1/agents/{}/harness", id(a)?)),
        Call::InstallHarness(a) => (Method::POST, format!("/v1/agents/{}/harness", id(a)?)),
        Call::AgentContext(a) => (Method::GET, format!("/v1/agents/{}/context", id(a)?)),
        Call::SaveAgentMemory(a) => (Method::PUT, format!("/v1/agents/{}/context", id(a)?)),
        Call::AgentSkill(a, s) => (
            Method::GET,
            format!(
                "/v1/agents/{}/context/skills/{}",
                id(a)?,
                urlencoding_file(skill(s)?)
            ),
        ),
        Call::SaveAgentSkill(a, s) => (
            Method::PUT,
            format!(
                "/v1/agents/{}/context/skills/{}",
                id(a)?,
                urlencoding_file(skill(s)?)
            ),
        ),
        Call::DeleteAgentSkill(a, s) => (
            Method::DELETE,
            format!(
                "/v1/agents/{}/context/skills/{}",
                id(a)?,
                urlencoding_file(skill(s)?)
            ),
        ),
        Call::TransferAgent(a) => (Method::POST, format!("/v1/agents/{}/transfer", id(a)?)),
        Call::WorkspaceModel => (Method::GET, "/v1/workspace/model".into()),
        Call::SaveWorkspaceModel => (Method::PUT, "/v1/workspace/model".into()),
        Call::Runs => (Method::GET, "/v1/runs".into()),
        Call::CreateRun => (Method::POST, "/v1/runs".into()),
        Call::RunEvents(a, after) => (
            Method::GET,
            format!("/v1/runs/{}/events?after={}", id(a)?, after),
        ),
        Call::StopRun(a) => (Method::POST, format!("/v1/runs/{}/stop", id(a)?)),
        Call::StopAllRuns => (Method::POST, "/v1/runs/stop-all".into()),
        Call::Approval(a) => (Method::POST, format!("/v1/runs/{}/approval", id(a)?)),
        Call::Credentials => (Method::GET, "/v1/credentials".into()),
        Call::CreateCredential => (Method::POST, "/v1/credentials".into()),
        Call::RotateCredential(r) => (
            Method::POST,
            format!("/v1/credentials/{}/value", reference(r)?),
        ),
        Call::DeleteCredential(r) => (
            Method::DELETE,
            format!("/v1/credentials/{}?force=1", reference(r)?),
        ),
        Call::Teams => (Method::GET, "/v1/teams?includeRetired=1".into()),
        Call::CreateTeam => (Method::POST, "/v1/teams".into()),
        Call::RetireTeam(a) => (Method::DELETE, format!("/v1/teams/{}", id(a)?)),
        Call::Tasks => (Method::GET, "/v1/tasks".into()),
        Call::CreateTask => (Method::POST, "/v1/tasks".into()),
        Call::CreateBoard => (Method::POST, "/v1/boards".into()),
        Call::StartTask(a) => (Method::POST, format!("/v1/tasks/{}/start", id(a)?)),
        Call::StopTask(a) => (Method::POST, format!("/v1/tasks/{}/stop", id(a)?)),
        Call::ApproveTask(a) => (Method::POST, format!("/v1/tasks/{}/approve", id(a)?)),
        Call::Routines => (Method::GET, "/v1/routines".into()),
        Call::CreateRoutine => (Method::POST, "/v1/routines".into()),
        Call::RunRoutine(a) => (Method::POST, format!("/v1/routines/{}/run", id(a)?)),
        Call::ToggleRoutine(a) => (Method::POST, format!("/v1/routines/{}/toggle", id(a)?)),
        Call::DeleteRoutine(a) => (Method::DELETE, format!("/v1/routines/{}", id(a)?)),
        Call::Files { scope, agent } => (Method::GET, files_path(scope, *agent, None)?),
        Call::File { scope, agent, name } => (Method::GET, files_path(scope, *agent, Some(name))?),
        Call::SaveFile { scope, agent } => (Method::POST, files_path(scope, *agent, None)?),
        Call::DeleteFile { scope, agent, name } => {
            (Method::DELETE, files_path(scope, *agent, Some(name))?)
        }
        Call::Machines => (Method::GET, "/v1/machines".into()),
        Call::PairMachine => (Method::POST, "/v1/machines".into()),
        Call::TestMachine(a) => (Method::POST, format!("/v1/machines/{}/test", id(a)?)),
        Call::ReconnectMachine(a) => (Method::POST, format!("/v1/machines/{}/reconnect", id(a)?)),
        Call::RevokeMachine(a) => (Method::POST, format!("/v1/machines/{}/revoke", id(a)?)),
    })
}

fn urlencoding_file(name: &str) -> String {
    let mut out = String::with_capacity(name.len() * 3);
    for b in name.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

fn assert_whitelisted(method: &Method, path_and_query: &str) -> Result<(), String> {
    let path = path_and_query.split('?').next().unwrap_or(path_and_query);
    if !path.starts_with("/v1/") || path.contains("://") || path.contains("..") {
        return Err("Blocked API path.".into());
    }
    // Defense in depth: only the Call enum can build these; reject anything odd.
    let ok = match (method.as_str(), path) {
        ("GET", "/v1/agents")
        | ("POST", "/v1/agents")
        | ("GET", "/v1/workspace/model")
        | ("PUT", "/v1/workspace/model")
        | ("GET", "/v1/harnesses")
        | ("GET", "/v1/runs")
        | ("POST", "/v1/runs")
        | ("POST", "/v1/runs/stop-all")
        | ("GET", "/v1/credentials")
        | ("POST", "/v1/credentials")
        | ("GET", "/v1/teams")
        | ("POST", "/v1/teams")
        | ("GET", "/v1/tasks")
        | ("POST", "/v1/tasks")
        | ("POST", "/v1/boards")
        | ("GET", "/v1/routines")
        | ("POST", "/v1/routines")
        | ("GET", "/v1/files")
        | ("POST", "/v1/files")
        | ("DELETE", "/v1/files")
        | ("GET", "/v1/machines")
        | ("POST", "/v1/machines") => true,
        ("GET" | "PUT", p) if segs(p, &["v1", "agents", "*", "profile"]) => true,
        ("GET" | "POST", p) if segs(p, &["v1", "agents", "*", "harness"]) => true,
        ("GET", p) if segs(p, &["v1", "agents", "*", "tools"]) => true,
        ("GET" | "PUT", p) if segs(p, &["v1", "agents", "*", "context"]) => true,
        ("GET" | "PUT" | "DELETE", p) if agent_skill_path(p) => true,
        ("POST", p) if segs(p, &["v1", "agents", "*", "transfer"]) => true,
        ("GET", p) if segs(p, &["v1", "runs", "*", "events"]) => true,
        ("POST", p) if segs(p, &["v1", "runs", "*", "stop"]) => true,
        ("POST", p) if segs(p, &["v1", "runs", "*", "approval"]) => true,
        ("POST", p) if segs(p, &["v1", "credentials", "*", "value"]) => true,
        ("DELETE", p) if segs(p, &["v1", "credentials", "*"]) => true,
        ("DELETE", p) if segs(p, &["v1", "teams", "*"]) => true,
        ("POST", p)
            if segs(p, &["v1", "tasks", "*", "start"])
                || segs(p, &["v1", "tasks", "*", "stop"])
                || segs(p, &["v1", "tasks", "*", "approve"]) =>
        {
            true
        }
        ("POST", p)
            if segs(p, &["v1", "routines", "*", "run"])
                || segs(p, &["v1", "routines", "*", "toggle"]) =>
        {
            true
        }
        ("DELETE", p) if segs(p, &["v1", "routines", "*"]) => true,
        ("POST", p)
            if segs(p, &["v1", "machines", "*", "test"])
                || segs(p, &["v1", "machines", "*", "reconnect"])
                || segs(p, &["v1", "machines", "*", "revoke"]) =>
        {
            true
        }
        _ => false,
    };
    if ok {
        Ok(())
    } else {
        Err("API endpoint is not available to the dashboard.".into())
    }
}

fn segs(path: &str, pattern: &[&str]) -> bool {
    let parts: Vec<_> = path.trim_start_matches('/').split('/').collect();
    if parts.len() != pattern.len() {
        return false;
    }
    parts.iter().zip(pattern).all(|(p, pat)| {
        if *pat == "*" {
            valid_id(p) || valid_ref(p)
        } else {
            p == pat
        }
    })
}

fn agent_skill_path(path: &str) -> bool {
    let parts: Vec<_> = path.trim_start_matches('/').split('/').collect();
    parts.len() == 6
        && parts[0] == "v1"
        && parts[1] == "agents"
        && valid_id(parts[2])
        && parts[3] == "context"
        && parts[4] == "skills"
        && valid_skill_name(parts[5])
}

pub async fn call(app: &App, call: Call<'_>, body: Option<Value>) -> Result<Value, String> {
    let (method, path) = route(&call)?;
    assert_whitelisted(&method, &path)?;
    let base = app.local_url.trim_end_matches('/');
    if !(base.starts_with("http://") || base.starts_with("https://")) {
        return Err("Coordinator URL is not configured.".into());
    }
    let url = format!("{base}{path}");
    // Token is attached only here, after the caller already authenticated the browser session.
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(30))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| e.to_string())?;
    let mut req = client
        .request(method, &url)
        .header("Authorization", format!("Bearer {}", app.token.as_str()))
        .header("Accept", "application/json");
    if let Some(body) = body {
        req = req
            .header("Content-Type", "application/json")
            .body(body.to_string());
    } else if matches!(
        call,
        Call::StopRun(_)
            | Call::StopAllRuns
            | Call::InstallHarness(_)
            | Call::RunRoutine(_)
            | Call::ToggleRoutine(_)
            | Call::StopTask(_)
            | Call::ReconnectMachine(_)
            | Call::RevokeMachine(_)
    ) {
        req = req.header("Content-Type", "application/json").body("{}");
    }
    let response = req.send().await.map_err(|e| e.to_string())?;
    let status = response.status();
    let text = response.text().await.map_err(|e| e.to_string())?;
    let value: Value = if text.trim().is_empty() {
        json!({})
    } else {
        serde_json::from_str(&text).unwrap_or_else(
            |_| json!({"error": format!("The coordinator returned HTTP {}.", status.as_u16())}),
        )
    };
    if !status.is_success() {
        let message = value["error"]
            .as_str()
            .unwrap_or("The coordinator rejected the request.")
            .to_owned();
        // Surface stale-editor conflicts distinctly while keeping the coordinator text.
        if status.as_u16() == 409 && !message.to_ascii_lowercase().contains("conflict") {
            return Err(format!("Conflict: {message}"));
        }
        return Err(message);
    }
    Ok(value)
}

pub fn harness_label(id: &str) -> &'static str {
    open_harness_runner::harnesses::find(id).map_or("Hermes", |harness| harness.name)
}

pub fn agent_name(agents: &[Value], id: &str) -> String {
    agents
        .iter()
        .find(|a| a["id"].as_str() == Some(id))
        .and_then(|a| a["name"].as_str())
        .unwrap_or(id)
        .to_owned()
}

pub fn agents_list(data: &Value) -> Vec<Value> {
    data["agents"].as_array().cloned().unwrap_or_default()
}

pub fn machines_list(data: &Value) -> Vec<Value> {
    data["machines"].as_array().cloned().unwrap_or_default()
}

pub const PAGE_SIZE: usize = 40;

#[cfg(test)]
mod tests {
    use super::*;
    use reqwest::Method;

    #[test]
    fn rejects_open_proxy_paths() {
        assert!(assert_whitelisted(&Method::GET, "/v1/../etc/passwd").is_err());
        assert!(assert_whitelisted(&Method::GET, "https://evil.example/v1/agents").is_err());
        assert!(assert_whitelisted(&Method::POST, "/v1/bootstrap").is_err());
        assert!(assert_whitelisted(&Method::GET, "/v1/agents").is_ok());
    }

    #[test]
    fn validates_ids() {
        assert!(valid_id("agent-1"));
        assert!(!valid_id("../x"));
        assert!(!valid_file_name("a/b"));
        assert!(valid_ref("XAI_API_KEY"));
        assert!(valid_skill_name("note-taker"));
        assert!(valid_skill_name("v1.summary"));
        assert!(!valid_skill_name("has space"));
        assert!(!valid_skill_name("../x"));
    }

    #[test]
    fn routes_encode_ids() {
        let (m, p) = route(&Call::StopRun("run-1")).unwrap();
        assert_eq!(m, Method::POST);
        assert_eq!(p, "/v1/runs/run-1/stop");
        assert!(route(&Call::StopRun("../no")).is_err());
    }

    #[test]
    fn routes_context_skills_and_private_files() {
        let (m, p) = route(&Call::AgentContext("atlas")).unwrap();
        assert_eq!(m, Method::GET);
        assert_eq!(p, "/v1/agents/atlas/context");
        assert!(assert_whitelisted(&m, &p).is_ok());

        let (m, p) = route(&Call::SaveAgentSkill("atlas", "note-taker")).unwrap();
        assert_eq!(m, Method::PUT);
        assert_eq!(p, "/v1/agents/atlas/context/skills/note-taker");
        assert!(assert_whitelisted(&m, &p).is_ok());

        let (m, p) = route(&Call::Files {
            scope: "private",
            agent: Some("atlas"),
        })
        .unwrap();
        assert_eq!(m, Method::GET);
        assert_eq!(p, "/v1/files?scope=private&agentId=atlas");
        assert!(assert_whitelisted(&m, &p).is_ok());

        let (m, p) = route(&Call::TransferAgent("atlas")).unwrap();
        assert_eq!(m, Method::POST);
        assert_eq!(p, "/v1/agents/atlas/transfer");
        assert!(assert_whitelisted(&m, &p).is_ok());

        assert!(route(&Call::AgentSkill("atlas", "bad name")).is_err());
        assert!(
            route(&Call::Files {
                scope: "private",
                agent: None
            })
            .is_err()
        );
    }
}
