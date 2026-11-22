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
use serde::Deserialize;
use serde_json::json;
use std::collections::HashMap;

pub struct Draft {
    pub memory: String,
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
    let agent = resolve_agent(agent_id, &session.agent, &agents);
    let mut memory = String::new();
    let mut load_err = None;
    if let Some(d) = draft {
        memory = d.memory;
    } else if !agent.is_empty() {
        match api::call(app, Call::AgentContext(&agent), None).await {
            Ok(v) => memory = v["memory"].as_str().unwrap_or("").to_owned(),
            Err(e) => load_err = Some(e),
        }
    }
    let body = format!(
        r#"
    <section class="panel">
      <div class="row between">
        <h1>Memory</h1>
        <a class="subtle" href="/ui/memory?agent={agent_q}">Refresh</a>
      </div>
      <form method="get" action="/ui/memory" class="stack card">
        <label>Agent <select name="agent">{agent_opts}</select></label>
        <button type="submit" class="subtle">Load agent</button>
      </form>
      <form method="post" action="/ui/memory/save" class="stack card">
        <h2>Durable memory</h2>
        <p class="muted">Saved as MEMORY.md for this agent. Limited to 50 KB.</p>
        {csrf}
        <input type="hidden" name="agentId" value="{agent}" />
        <label>Memory <textarea name="memory" rows="16" maxlength="50000">{memory}</textarea></label>
        <button type="submit" class="primary" {disabled}>Save memory</button>
      </form>
    </section>"#,
        agent_q = auth::enc_query(&agent),
        agent_opts = html::agent_options(&agents, &agent, None),
        csrf = html::csrf_field(&session),
        agent = html::attr(&agent),
        memory = html::esc(&memory),
        disabled = if agent.is_empty() { "disabled" } else { "" },
    );
    html::page(Page {
        title: "Memory",
        panel: "memory",
        status: auth::status_line(app),
        notice: load_err.map(|e| (e, "error".into())).or(notice),
        session,
        body,
        refresh: None,
    })
    .into_response()
}

fn resolve_agent(requested: &str, session_agent: &str, agents: &[serde_json::Value]) -> String {
    if api::valid_id(requested) {
        requested.to_owned()
    } else if api::valid_id(session_agent) {
        session_agent.to_owned()
    } else {
        agents
            .first()
            .and_then(|a| a["id"].as_str())
            .unwrap_or("")
            .to_owned()
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
    let mut res = view(
        &app,
        session.clone(),
        auth::notice_from_query(&q),
        &agent,
        None,
    )
    .await;
    if let Ok(cookie) = auth::set_cookie_header(&app, &session) {
        res.headers_mut()
            .insert(axum::http::header::SET_COOKIE, cookie);
    }
    res
}

#[derive(Deserialize)]
pub struct SaveForm {
    pub csrf: String,
    #[serde(rename = "agentId")]
    pub agent_id: String,
    #[serde(default)]
    pub memory: String,
}

pub async fn save(
    State(app): State<App>,
    headers: HeaderMap,
    Form(form): Form<SaveForm>,
) -> Response {
    let Some(mut session) = auth::session_from(&app, &headers) else {
        return Redirect::to("/").into_response();
    };
    if let Err((_, msg)) = auth::require_mutation(&headers, &session, &form.csrf) {
        return Redirect::to(&auth::flash_err("/ui/memory", &msg)).into_response();
    }
    let agent = form.agent_id.trim();
    if !api::valid_id(agent) {
        return Redirect::to(&auth::flash_err("/ui/memory", "Select an agent first."))
            .into_response();
    }
    session.agent = agent.to_owned();
    let dest = format!("/ui/memory?agent={}", auth::enc_query(agent));
    match api::call(
        &app,
        Call::SaveAgentMemory(agent),
        Some(json!({"memory": form.memory})),
    )
    .await
    {
        Ok(_) => {
            let dest = auth::flash_ok(&dest, "Memory saved.");
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
                Some(Draft {
                    memory: form.memory,
                }),
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
