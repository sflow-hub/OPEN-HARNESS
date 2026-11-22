use super::{
    api::{self, Call},
    auth::{self, Session},
    html::{self, Page},
};
use crate::App;
use axum::{
    Form,
    extract::{Query, State},
    http::HeaderMap,
    response::{IntoResponse, Redirect, Response},
};
use open_harness_runner::harnesses;
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};

#[derive(Clone, Default)]
pub struct Draft {
    pub name: String,
    pub role: String,
    pub harness: String,
    pub prompt_text: String,
    pub prompt_enabled: bool,
    pub inherit: bool,
    pub provider: String,
    pub model: String,
    pub credential_ref: String,
    pub base_url: String,
    pub model_auth: String,
    pub worker_launch: bool,
    pub machine_id: String,
    pub access: String,
    pub reserve_machine: bool,
    pub folders: Vec<(String, String, String)>,
    pub folder_slots: usize,
    pub tools: Option<Vec<String>>,
    pub revision: u64,
}

pub async fn view(
    app: &App,
    session: Session,
    notice: Option<(String, String)>,
    agent_id: &str,
    draft: Option<Draft>,
) -> Response {
    let agents = api::call(app, Call::Agents, None)
        .await
        .map(|v| api::agents_list(&v))
        .unwrap_or_default();
    let agent = if api::valid_id(agent_id) {
        agent_id
    } else if api::valid_id(&session.agent) {
        session.agent.as_str()
    } else {
        agents.first().and_then(|a| a["id"].as_str()).unwrap_or("")
    };

    let workspace = api::call(app, Call::WorkspaceModel, None).await;
    let (ws_rev, ws_model) = match &workspace {
        Ok(v) => (
            v["revision"].as_i64().unwrap_or(0),
            v.get("model").cloned().unwrap_or(json!({})),
        ),
        Err(_) => (0, json!({})),
    };

    let machines = api::call(app, Call::Machines, None)
        .await
        .map(|v| api::machines_list(&v))
        .unwrap_or_default();

    let mut profile = json!({});
    let mut transfer = Value::Null;
    let mut worker_access = Value::Null;
    let mut tools_html = String::new();
    let mut harness_status = String::new();
    let model_connections = html::model_connection_options(app).await;
    let mut load_err = workspace.as_ref().err().cloned();
    if !agent.is_empty() {
        match api::call(app, Call::AgentProfile(agent), None).await {
            Ok(v) => {
                transfer = v.get("transfer").cloned().unwrap_or(Value::Null);
                worker_access = v.get("workerAccess").cloned().unwrap_or(Value::Null);
                profile = v.get("profile").cloned().unwrap_or(v);
            }
            Err(e) => load_err = Some(e),
        }
        if let Ok(tools) = api::call(app, Call::AgentTools(agent), None).await {
            let selected_harness = profile["harness"].as_str().unwrap_or("hermes");
            let group = grouped_tools(selected_harness);
            let allowed: Vec<String> = draft
                .as_ref()
                .and_then(|d| d.tools.clone())
                .or_else(|| {
                    profile["allowedTools"].as_array().map(|items| {
                        items
                            .iter()
                            .filter_map(|t| t.as_str().map(str::to_owned))
                            .collect()
                    })
                })
                .unwrap_or_default();
            for tool in tools["tools"].as_array().into_iter().flatten() {
                let id = tool["id"].as_str().unwrap_or("");
                if id.is_empty() {
                    continue;
                }
                let grouped = group.contains(&id);
                if grouped && group.first() != Some(&id) {
                    continue;
                }
                let name = if grouped {
                    if group.contains(&"read_file") {
                        "Read, write and edit files"
                    } else {
                        "Write and edit files"
                    }
                } else {
                    tool["name"].as_str().unwrap_or(id)
                };
                let shown = if grouped {
                    group
                } else {
                    std::slice::from_ref(&id)
                };
                let checked = if shown.iter().all(|id| allowed.iter().any(|t| t == id)) {
                    " checked"
                } else {
                    ""
                };
                for shown_id in shown {
                    tools_html.push_str(&format!(
                        r#"<input type="hidden" name="toolShown" value="{}" />"#,
                        html::attr(shown_id),
                    ));
                }
                tools_html.push_str(&format!(
                    r#"<label class="check"><input type="checkbox" name="tool" value="{id}"{checked} /> {label}</label>"#,
                    id = html::attr(id),
                    checked = checked,
                    label = html::esc(name)
                ));
            }
        }
        if let Ok(h) = api::call(app, Call::AgentHarness(agent), None).await {
            let install = &h["harnessInstallation"];
            let state = install["state"].as_str().unwrap_or("");
            let detail = install["detail"].as_str().unwrap_or("");
            harness_status = format!(
                r#"<p class="muted" role="status">Harness installation {}. {}</p>{}"#,
                html::esc(state),
                html::esc(detail),
                html::post_button(
                    "/ui/profile/install-harness",
                    &session.csrf,
                    "Install / retry harness",
                    "subtle",
                    &[("agentId", agent)]
                )
            );
        }
    }

    let mut d = draft.unwrap_or_else(|| draft_from_profile(&profile));
    normalize_draft_for_auth(&mut d, None);
    let prompt_enabled = d.prompt_enabled;
    let inherit = d.inherit;
    let model_auth = d.model_auth.as_str();
    let worker_launch = d.worker_launch;
    let access = if d.access == "folders" {
        "folders"
    } else {
        "private"
    };
    let transfer_note = transfer
        .as_object()
        .map(|t| {
            format!(
                r#"<p class="notice" role="status">Transfer {}: {}</p>"#,
                html::esc(t.get("state").and_then(|v| v.as_str()).unwrap_or("")),
                html::esc(t.get("detail").and_then(|v| v.as_str()).unwrap_or(""))
            )
        })
        .unwrap_or_default();
    let billing_html = billing_fields(&d.harness, model_auth);
    let worker_grant_html = worker_grant_fields(&d.harness, worker_launch);
    let plan_disclosure = if model_auth == "chatgpt-plan" {
        r#"<p class="notice" role="status">ChatGPT plan usage applies to this agent's manual runs, schedules, and handoffs. Sign in on the assigned computer so those triggers can use the plan allowance. <a class="subtle" href="https://chatgpt.com/settings/usage" target="_blank" rel="noopener">Manage ChatGPT usage</a></p>"#.into()
    } else {
        String::new()
    };
    let worker_status_html = if worker_launch || model_auth == "chatgpt-plan" {
        worker_access_status(&worker_access, model_auth)
    } else {
        String::new()
    };
    let worker_commands_html = if worker_launch && !agent.is_empty() {
        worker_commands(agent, &d.harness, model_auth)
    } else {
        String::new()
    };

    let folder_slots = d.folder_slots.max(d.folders.len().saturating_add(1)).max(1);
    let mut folders_html = String::new();
    for i in 0..folder_slots {
        let (id, path, mode) = d
            .folders
            .get(i)
            .cloned()
            .unwrap_or_else(|| (String::new(), String::new(), "read".into()));
        let read_sel = if mode != "write" { " selected" } else { "" };
        let write_sel = if mode == "write" { " selected" } else { "" };
        folders_html.push_str(&format!(
            r#"<div class="folder-row">
          <input type="hidden" name="folderId" value="{id}" />
          <label>Host path <input name="folderPath" value="{path}" placeholder="/home/me/project" autocomplete="off" /></label>
          <label>Access
            <select name="folderMode">
              <option value="read"{read}>Read only</option>
              <option value="write"{write}>Read and write</option>
            </select>
          </label>
          <label class="check"><input type="checkbox" name="folderRemove" value="{i}" /> Remove</label>
        </div>"#,
            id = html::attr(&id),
            path = html::attr(&path),
            read = read_sel,
            write = write_sel,
            i = i,
        ));
    }

    let body = format!(
        r#"
    <section class="panel">
      <div class="row between">
        <h1>Profile &amp; model</h1>
        <a class="subtle" href="/ui/profile?agent={agent_q}">Refresh</a>
      </div>
      <form method="post" action="/ui/profile/workspace" class="stack card">
        <h2>Workspace default model</h2>
        {csrf}
        <label>Provider <input name="provider" required value="{ws_provider}" /></label>
        <label>Model <input name="model" required value="{ws_model}" /></label>
        <label>Credential ref <input name="credentialRef" placeholder="XAI_API_KEY" autocomplete="off" value="{ws_ref}" /></label>
        <label>Base URL <input name="baseUrl" placeholder="optional" autocomplete="off" value="{ws_base}" /></label>
        <input type="hidden" name="revision" value="{ws_rev}" />
        <button type="submit" class="primary">Save defaults</button>
      </form>
      <form method="get" action="/ui/profile" class="stack card">
        <label>Agent <select name="agent">{agent_opts}</select></label>
        <button type="submit" class="subtle">Load agent</button>
      </form>
      {transfer_note}
      <form method="post" action="/ui/profile/agent" class="stack card">
        <h2>Selected agent profile</h2>
        {csrf}
        <input type="hidden" name="agentId" value="{agent}" />
        {tools_touched}
        <label>Name <input name="name" maxlength="30" required value="{name}" /></label>
        <label>Role <input name="role" maxlength="60" required value="{role}" /></label>
        <label>Harness <select name="harness">{harness}</select></label>
        <label>System prompt <textarea name="promptText" rows="5" maxlength="12000">{prompt}</textarea></label>
        <label class="check"><input type="checkbox" name="promptEnabled" value="1"{prompt_on} /> Prompt enabled</label>
        {billing}
        {plan_disclosure}
        <label class="check"><input type="checkbox" name="inherit" value="1"{inherit_on} /> Inherit workspace model</label>
        <label>Provider <input name="provider" list="model-providers" value="{provider}" /></label>
        <label>Model <input name="model" value="{model}" /></label>
        <label>Credential ref <input name="credentialRef" list="model-credentials" autocomplete="off" value="{cred}" /></label>
        <label>Base URL <input name="baseUrl" autocomplete="off" value="{base}" /></label>
        {worker_grant}
        {worker_status}
        {worker_commands}
        <fieldset class="stack">
          <legend>Computer</legend>
          <p class="muted">Every harness runs headless. Changing the computer transfers private files when needed.</p>
          <label>Connected computer <select name="machineId">{machines}</select></label>
          <label class="check"><input type="checkbox" name="reserveMachine" value="1"{reserve_on} /> Reserve this computer for this agent</label>
          <label>Workspace access
            <select name="access">
              <option value="private"{access_private}>Private workspace</option>
              <option value="folders"{access_folders}>Selected host folders</option>
            </select>
          </label>
          <input type="hidden" name="folderSlots" value="{folder_slots}" />
          <div class="stack">{folders}</div>
          <a class="subtle" href="/ui/profile?agent={agent_q}&amp;slots={more_slots}">Add folder slot</a>
        </fieldset>
        <fieldset class="stack"><legend>Tools</legend>{tools}</fieldset>
        <input type="hidden" name="revision" value="{rev}" />
        <button type="submit" class="primary">Save profile</button>
      </form>
      {harness_status}
      {model_connections}
    </section>"#,
        agent_q = auth::enc_query(agent),
        csrf = html::csrf_field(&session),
        ws_provider = html::attr(ws_model["provider"].as_str().unwrap_or("")),
        ws_model = html::attr(ws_model["model"].as_str().unwrap_or("")),
        ws_ref = html::attr(ws_model["credentialRef"].as_str().unwrap_or("")),
        ws_base = html::attr(ws_model["baseUrl"].as_str().unwrap_or("")),
        ws_rev = ws_rev,
        agent_opts = html::agent_options(&agents, agent, None),
        transfer_note = transfer_note,
        agent = html::attr(agent),
        name = html::attr(&d.name),
        role = html::attr(&d.role),
        harness = html::harness_options(&d.harness),
        harness_status = harness_status,
        model_connections = model_connections,
        prompt = html::esc(&d.prompt_text),
        prompt_on = if prompt_enabled { " checked" } else { "" },
        billing = billing_html,
        plan_disclosure = plan_disclosure,
        inherit_on = if inherit { " checked" } else { "" },
        provider = html::attr(&d.provider),
        model = html::attr(&d.model),
        cred = html::attr(&d.credential_ref),
        base = html::attr(&d.base_url),
        worker_grant = worker_grant_html,
        worker_status = worker_status_html,
        worker_commands = worker_commands_html,
        machines = html::machine_options(&machines, &d.machine_id),
        reserve_on = if d.reserve_machine { " checked" } else { "" },
        access_private = if access == "private" { " selected" } else { "" },
        access_folders = if access == "folders" { " selected" } else { "" },
        folder_slots = folder_slots,
        folders = folders_html,
        more_slots = folder_slots + 1,
        tools_touched = if tools_html.is_empty() {
            ""
        } else {
            r#"<input type="hidden" name="tools_touched" value="1" />"#
        },
        tools = if tools_html.is_empty() {
            r#"<p class="muted">No tool catalog for this agent yet.</p>"#.into()
        } else {
            tools_html
        },
        rev = d.revision,
    );

    html::page(Page {
        title: "Profile",
        panel: "profile",
        status: auth::status_line(app),
        notice: load_err.map(|e| (e, "error".into())).or(notice),
        session,
        body,
        refresh: None,
    })
    .into_response()
}

fn draft_from_profile(profile: &Value) -> Draft {
    let folders = profile["computer"]["folders"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|f| {
            (
                f["id"].as_str().unwrap_or("").to_owned(),
                f["path"].as_str().unwrap_or("").to_owned(),
                f["mode"].as_str().unwrap_or("read").to_owned(),
            )
        })
        .collect::<Vec<_>>();
    let slots = folders.len().saturating_add(1).max(1);
    Draft {
        name: profile["name"].as_str().unwrap_or("").to_owned(),
        role: profile["role"].as_str().unwrap_or("").to_owned(),
        harness: profile["harness"].as_str().unwrap_or("hermes").to_owned(),
        prompt_text: profile["prompt"]["text"].as_str().unwrap_or("").to_owned(),
        prompt_enabled: profile["prompt"]["enabled"].as_bool().unwrap_or(true),
        inherit: profile["model"]["inherit"].as_bool().unwrap_or(false),
        provider: profile["model"]["provider"]
            .as_str()
            .unwrap_or("")
            .to_owned(),
        model: profile["model"]["model"].as_str().unwrap_or("").to_owned(),
        credential_ref: profile["model"]["credentialRef"]
            .as_str()
            .unwrap_or("")
            .to_owned(),
        base_url: profile["model"]["baseUrl"]
            .as_str()
            .unwrap_or("")
            .to_owned(),
        model_auth: profile["modelAuth"]
            .as_str()
            .unwrap_or("configured")
            .to_owned(),
        worker_launch: profile["workerLaunch"].as_bool().unwrap_or(false),
        machine_id: profile["computer"]["machineId"]
            .as_str()
            .unwrap_or("local")
            .to_owned(),
        access: profile["computer"]["access"]
            .as_str()
            .unwrap_or("private")
            .to_owned(),
        reserve_machine: profile["computer"]["reserveMachine"]
            .as_bool()
            .unwrap_or(false),
        folders,
        folder_slots: slots,
        tools: None,
        revision: profile["revision"].as_u64().unwrap_or(0),
    }
}

pub async fn get(
    State(app): State<App>,
    headers: HeaderMap,
    Query(q): Query<HashMap<String, String>>,
) -> Response {
    let Some(mut session) = auth::session_from(&app, &headers) else {
        return Redirect::to("/").into_response();
    };
    if let Some(id) = q
        .get("agent")
        .map(|s| s.as_str())
        .filter(|s| api::valid_id(s))
    {
        session.agent = id.to_owned();
    }
    let agent = session.agent.clone();
    let slots = q
        .get("slots")
        .and_then(|s| s.parse::<usize>().ok())
        .filter(|n| (1..=51).contains(n));
    let draft = if let Some(slots) = slots {
        let mut d = Draft::default();
        // Load saved profile then expand empty slots for folder entry.
        if api::valid_id(&agent)
            && let Ok(v) = api::call(&app, Call::AgentProfile(&agent), None).await
        {
            d = draft_from_profile(v.get("profile").unwrap_or(&v));
        }
        d.folder_slots = slots;
        Some(d)
    } else {
        None
    };
    let mut res = view(
        &app,
        session.clone(),
        auth::notice_from_query(&q),
        &agent,
        draft,
    )
    .await;
    if let Ok(cookie) = auth::set_cookie_header(&app, &session) {
        res.headers_mut()
            .insert(axum::http::header::SET_COOKIE, cookie);
    }
    res
}

#[derive(Deserialize)]
pub struct WorkspaceForm {
    pub csrf: String,
    pub provider: String,
    pub model: String,
    #[serde(rename = "credentialRef")]
    pub credential_ref: String,
    #[serde(rename = "baseUrl")]
    pub base_url: String,
    pub revision: i64,
}

pub async fn save_workspace(
    State(app): State<App>,
    headers: HeaderMap,
    Form(form): Form<WorkspaceForm>,
) -> Response {
    let Some(session) = auth::session_from(&app, &headers) else {
        return Redirect::to("/").into_response();
    };
    if let Err((_, msg)) = auth::require_mutation(&headers, &session, &form.csrf) {
        return Redirect::to(&auth::flash_err("/ui/profile", &msg)).into_response();
    }
    let payload = json!({
        "revision": form.revision,
        "model": {
            "provider": form.provider.trim(),
            "model": form.model.trim(),
            "credentialRef": form.credential_ref.trim(),
            "baseUrl": form.base_url.trim(),
        }
    });
    match api::call(&app, Call::SaveWorkspaceModel, Some(payload)).await {
        Ok(_) => {
            Redirect::to(&auth::flash_ok("/ui/profile", "Workspace model saved.")).into_response()
        }
        Err(e) => Redirect::to(&auth::flash_err("/ui/profile", &e)).into_response(),
    }
}

pub async fn save_agent_raw(State(app): State<App>, headers: HeaderMap, body: String) -> Response {
    let Some(mut session) = auth::session_from(&app, &headers) else {
        return Redirect::to("/").into_response();
    };
    let pairs = parse_form(&body);
    let csrf = field(&pairs, "csrf");
    if let Err((_, msg)) = auth::require_mutation(&headers, &session, csrf) {
        return Redirect::to(&auth::flash_err("/ui/profile", &msg)).into_response();
    }
    let agent = field(&pairs, "agentId").trim();
    if !api::valid_id(agent) {
        return Redirect::to(&auth::flash_err("/ui/profile", "Select an agent first."))
            .into_response();
    }
    session.agent = agent.to_owned();

    let mut prior = match api::call(&app, Call::AgentProfile(agent), None).await {
        Ok(v) => v.get("profile").cloned().unwrap_or(v),
        Err(_) => {
            json!({"id": agent, "computer": {}, "connectors": [], "allowedTools": [], "board": {}})
        }
    };
    let mut tools: Vec<String> = pairs
        .iter()
        .filter(|(k, _)| k == "tool")
        .map(|(_, v)| v.clone())
        .collect();
    if pairs.iter().any(|(key, _)| key == "tools_touched") {
        tools = merge_tool_selection(&prior, &pairs, tools);
    }
    let mut draft = draft_from_pairs(&pairs, &tools);
    let prior_auth = prior["modelAuth"]
        .as_str()
        .unwrap_or("configured")
        .to_owned();
    normalize_draft_for_auth(&mut draft, Some(&prior_auth));
    if harnesses::is_additional(draft.harness.trim()) {
        draft.inherit = false;
        let prior_model = &prior["model"];
        // Keep the key scoped to the chosen provider when the old reference is still in the field.
        if prior_model["provider"] != draft.provider.trim()
            && prior_model["credentialRef"] == draft.credential_ref.trim()
        {
            draft.credential_ref.clear();
        }
    }
    prior["id"] = json!(agent);
    prior["revision"] = json!(draft.revision);
    prior["name"] = json!(draft.name.trim());
    prior["role"] = json!(draft.role.trim());
    prior["harness"] = json!(draft.harness.trim());
    prior["prompt"] = json!({
        "enabled": draft.prompt_enabled,
        "text": draft.prompt_text,
    });
    prior["modelAuth"] = json!(draft.model_auth);
    prior["workerLaunch"] = json!(draft.worker_launch);
    prior["model"] = json!({
        "inherit": draft.inherit,
        "provider": draft.provider.trim(),
        "model": draft.model.trim(),
        "credentialRef": draft.credential_ref.trim(),
        "baseUrl": draft.base_url.trim(),
    });
    if !prior["computer"].is_object() {
        prior["computer"] = json!({});
    }
    let machine = if draft.machine_id.trim().is_empty() {
        "local"
    } else {
        draft.machine_id.trim()
    };
    prior["computer"]["machineId"] = json!(machine);
    prior["computer"]["desktop"] = json!("none");
    prior["computer"]["access"] = json!(if draft.access == "folders" {
        "folders"
    } else {
        "private"
    });
    prior["computer"]["reserveMachine"] = json!(draft.reserve_machine);
    if draft.access == "folders" {
        let folders: Vec<Value> = draft
            .folders
            .iter()
            .filter(|(_, path, _)| !path.trim().is_empty())
            .map(|(id, path, mode)| {
                json!({
                    "id": if id.is_empty() { uuid::Uuid::new_v4().to_string() } else { id.clone() },
                    "path": path.trim(),
                    "mode": if mode == "write" { "write" } else { "read" },
                })
            })
            .collect();
        prior["computer"]["folders"] = json!(folders);
    } else {
        prior["computer"]["folders"] = json!([]);
    }
    if pairs.iter().any(|(k, _)| k == "tools_touched") {
        prior["allowedTools"] = json!(tools);
    }

    let dest = format!("/ui/profile?agent={}", auth::enc_query(agent));
    match api::call(&app, Call::SaveAgentProfile(agent), Some(prior)).await {
        Ok(_) => {
            let dest = auth::flash_ok(&dest, "Profile saved.");
            match auth::set_cookie_header(&app, &session) {
                Ok(c) => html::redirect_with_cookie(&dest, c),
                Err(_) => Redirect::to(&dest).into_response(),
            }
        }
        Err(e) => {
            let mut res = view(
                &app,
                session.clone(),
                Some((e, "error".into())),
                agent,
                Some(draft),
            )
            .await;
            if let Ok(cookie) = auth::set_cookie_header(&app, &session) {
                res.headers_mut()
                    .insert(axum::http::header::SET_COOKIE, cookie);
            }
            res
        }
    }
}

fn grouped_tools(harness: &str) -> &'static [&'static str] {
    harnesses::find(harness)
        .filter(|h| harnesses::is_additional(h.id))
        .map_or(&[][..], |h| h.tool_group)
}

fn merge_tool_selection(
    prior: &Value,
    pairs: &[(String, String)],
    mut selected: Vec<String>,
) -> Vec<String> {
    let old = prior["allowedTools"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str);
    let shown = |id: &str| {
        pairs
            .iter()
            .any(|(key, value)| key == "toolShown" && value == id)
    };
    let group = grouped_tools(prior["harness"].as_str().unwrap_or("hermes"));
    if let Some((&leader, other)) = group.split_first() {
        if selected.iter().any(|id| id == leader) {
            selected.extend(other.iter().map(|id| (*id).to_owned()));
        } else {
            // Switching from a harness with individual grants can leave an inactive partial group.
            let retained: Vec<_> = old.clone().filter(|id| group.contains(id)).collect();
            if retained.len() < group.len() {
                selected.extend(retained.into_iter().map(str::to_owned));
            }
        }
    }
    let group_shown = group.first().is_some_and(|leader| shown(leader));
    selected.extend(
        old.filter(|id| !(shown(id) || group_shown && group.contains(id)))
            .map(str::to_owned),
    );
    let mut seen = HashSet::new();
    selected.retain(|id| seen.insert(id.clone()));
    selected
}

fn draft_from_pairs(pairs: &[(String, String)], tools: &[String]) -> Draft {
    let ids = fields(pairs, "folderId");
    let paths = fields(pairs, "folderPath");
    let modes = fields(pairs, "folderMode");
    let remove: std::collections::HashSet<usize> = pairs
        .iter()
        .filter(|(k, _)| k == "folderRemove")
        .filter_map(|(_, v)| v.parse().ok())
        .collect();
    let mut folders = Vec::new();
    let n = ids.len().max(paths.len()).max(modes.len());
    for i in 0..n {
        if remove.contains(&i) {
            continue;
        }
        folders.push((
            ids.get(i).cloned().unwrap_or_default(),
            paths.get(i).cloned().unwrap_or_default(),
            modes.get(i).cloned().unwrap_or_else(|| "read".into()),
        ));
    }
    let slots = field(pairs, "folderSlots")
        .parse::<usize>()
        .unwrap_or(folders.len().saturating_add(1))
        .clamp(1, 51);
    Draft {
        name: field(pairs, "name").to_owned(),
        role: field(pairs, "role").to_owned(),
        harness: {
            let h = field(pairs, "harness").trim();
            if h.is_empty() {
                "hermes".into()
            } else {
                h.to_owned()
            }
        },
        prompt_text: field(pairs, "promptText").to_owned(),
        prompt_enabled: pairs.iter().any(|(k, _)| k == "promptEnabled"),
        inherit: pairs.iter().any(|(k, _)| k == "inherit"),
        provider: field(pairs, "provider").to_owned(),
        model: field(pairs, "model").to_owned(),
        credential_ref: field(pairs, "credentialRef").to_owned(),
        base_url: field(pairs, "baseUrl").to_owned(),
        model_auth: {
            let a = field(pairs, "modelAuth").trim();
            if a == "chatgpt-plan" {
                "chatgpt-plan".into()
            } else {
                "configured".into()
            }
        },
        worker_launch: pairs.iter().any(|(k, _)| k == "workerLaunch"),
        machine_id: {
            let m = field(pairs, "machineId").trim();
            if m.is_empty() {
                "local".into()
            } else {
                m.to_owned()
            }
        },
        access: {
            let a = field(pairs, "access").trim();
            if a == "folders" {
                "folders".into()
            } else {
                "private".into()
            }
        },
        reserve_machine: pairs.iter().any(|(k, _)| k == "reserveMachine"),
        folders,
        folder_slots: slots,
        tools: if pairs.iter().any(|(k, _)| k == "tools_touched") {
            Some(tools.to_vec())
        } else {
            None
        },
        revision: field(pairs, "revision").parse().unwrap_or(0),
    }
}

pub async fn install_harness(
    State(app): State<App>,
    headers: HeaderMap,
    Form(form): Form<HashMap<String, String>>,
) -> Response {
    let Some(session) = auth::session_from(&app, &headers) else {
        return Redirect::to("/").into_response();
    };
    let csrf = form.get("csrf").map(String::as_str).unwrap_or("");
    if let Err((_, msg)) = auth::require_mutation(&headers, &session, csrf) {
        return Redirect::to(&auth::flash_err("/ui/profile", &msg)).into_response();
    }
    let agent = form.get("agentId").map(|s| s.trim()).unwrap_or("");
    let dest = format!("/ui/profile?agent={}", auth::enc_query(agent));
    let location = match api::call(&app, Call::InstallHarness(agent), None).await {
        Ok(v) if v["harnessInstallation"]["workerUpgradeRequired"] == true => auth::flash_err(
            &dest,
            v["harnessInstallation"]["detail"]
                .as_str()
                .unwrap_or("Update the assigned worker."),
        ),
        Ok(_) => auth::flash_ok(&dest, "Harness install requested."),
        Err(e) => auth::flash_err(&dest, &e),
    };
    Redirect::to(&location).into_response()
}

fn parse_form(body: &str) -> Vec<(String, String)> {
    body.split('&')
        .filter(|p| !p.is_empty())
        .map(|pair| {
            let (k, v) = pair.split_once('=').unwrap_or((pair, ""));
            (auth::dec_query(k), auth::dec_query(v))
        })
        .collect()
}

fn field<'a>(pairs: &'a [(String, String)], name: &str) -> &'a str {
    pairs
        .iter()
        .find(|(k, _)| k == name)
        .map(|(_, v)| v.as_str())
        .unwrap_or("")
}

fn fields(pairs: &[(String, String)], name: &str) -> Vec<String> {
    pairs
        .iter()
        .filter(|(k, _)| k == name)
        .map(|(_, v)| v.clone())
        .collect()
}

fn normalize_model_auth(harness: &str, auth: &str) -> &'static str {
    if harness.trim() == "codex" && auth.trim() == "chatgpt-plan" {
        "chatgpt-plan"
    } else {
        "configured"
    }
}

fn normalize_draft_for_auth(draft: &mut Draft, prior_auth: Option<&str>) {
    let auth = normalize_model_auth(&draft.harness, &draft.model_auth).to_owned();
    draft.worker_launch =
        draft.worker_launch && matches!(draft.harness.as_str(), "codex" | "claude-code");
    if auth == "chatgpt-plan" {
        draft.inherit = false;
        draft.provider = "openai".into();
        draft.credential_ref.clear();
        draft.base_url.clear();
    } else if prior_auth == Some("chatgpt-plan")
        && draft.harness.trim() == "codex"
        && draft.credential_ref.trim().is_empty()
    {
        draft.credential_ref = "OPENAI_API_KEY".into();
    }
    draft.model_auth = auth;
}

fn billing_fields(harness: &str, model_auth: &str) -> String {
    if harness.trim() != "codex" {
        // Non-Codex agents keep configured billing; no ChatGPT-plan select.
        return r#"<input type="hidden" name="modelAuth" value="configured" />"#.into();
    }
    format!(
        r#"<label>Billing
            <select name="modelAuth">
              <option value="configured"{configured}>Configured API credential</option>
              <option value="chatgpt-plan"{plan}>ChatGPT plan</option>
            </select>
          </label>
          <p class="muted">ChatGPT plan uses an explicit OpenAI model on the official endpoint with an empty API credential.</p>"#,
        configured = if model_auth != "chatgpt-plan" {
            " selected"
        } else {
            ""
        },
        plan = if model_auth == "chatgpt-plan" {
            " selected"
        } else {
            ""
        },
    )
}

fn worker_grant_fields(harness: &str, worker_launch: bool) -> String {
    if !matches!(harness.trim(), "codex" | "claude-code") {
        return String::new();
    }
    format!(
        r#"<fieldset class="stack">
          <legend>Worker launch</legend>
          <label class="check"><input type="checkbox" name="workerLaunch" value="1"{on} /> Allow launches from the assigned worker</label>
          <p class="muted">The worker owner can start this agent from a local or SSH terminal.</p>
        </fieldset>"#,
        on = if worker_launch { " checked" } else { "" },
    )
}

fn worker_access_status(access: &Value, auth: &str) -> String {
    let Some(machine) = access["machineId"].as_str() else {
        return String::new();
    };
    let message = if access["online"] != true {
        "The worker is offline. Start it on the assigned computer."
    } else if access["capable"] != true {
        "Update the worker on this computer to enable terminal launches."
    } else if auth == "chatgpt-plan" {
        match access["state"].as_str() {
            Some("connected") => "The worker reported a connected ChatGPT plan.",
            Some("signedOut") => "Sign in to ChatGPT on the worker.",
            Some("signInRequired") => "Your ChatGPT session expired. Sign in again on the worker.",
            _ => "Run the worker status command to check ChatGPT sign-in.",
        }
    } else {
        "The worker is online."
    };
    format!(
        r#"<p class="muted" role="status">Assigned worker <strong>{}</strong>. {message}</p>"#,
        html::esc(machine)
    )
}

fn worker_commands(agent: &str, harness: &str, model_auth: &str) -> String {
    let mut lines = vec![format!("open-harness worker status --agent {agent}")];
    let help = if harness == "claude-code" {
        lines.push(format!("open-harness worker terminal --agent {agent}"));
        "Sign in inside Claude Code. Repeat the terminal command after an SSH disconnect to reattach. Use /logout inside Claude Code to sign out."
    } else if harness == "codex" && model_auth == "chatgpt-plan" {
        lines.push(format!("open-harness worker login --agent {agent}"));
        lines.push(format!(r#"open-harness worker run --agent {agent} --wait "Review the files in this workspace.""#));
        lines.push(format!("open-harness worker logout --agent {agent}"));
        "Open a terminal on the assigned computer or connect with SSH."
    } else {
        "Select ChatGPT plan to start Codex runs from the worker terminal."
    };
    format!(
        r#"<fieldset class="stack"><legend>Commands on the assigned computer</legend><p class="muted">{help}</p><pre class="log">{}</pre></fieldset>"#,
        html::esc(&lines.join("\n"))
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn grouped_selection_reconciles_existing_grants_once() {
        let prior =
            json!({"harness":"opencode","allowedTools":["write_file","patch","search_files"]});
        let fields = [("toolShown".into(), "write_file".into())];
        let submitted = vec!["write_file".into()];
        assert_eq!(
            merge_tool_selection(&prior, &fields, submitted),
            ["write_file", "patch", "search_files"]
        );
    }

    #[test]
    fn revoking_grouped_tools_stays_effective_across_profile_saves() {
        let mut prior = json!({"harness":"openhands",
            "allowedTools":["read_file","write_file","patch","terminal"]});
        let visible = [("toolShown".into(), "read_file".into())];
        for _ in 0..2 {
            let tools = merge_tool_selection(&prior, &visible, Vec::new());
            assert_eq!(tools, ["terminal"]);
            prior["allowedTools"] = json!(tools);
        }
    }
}
