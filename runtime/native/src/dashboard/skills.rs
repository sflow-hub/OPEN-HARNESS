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
    pub name: String,
    pub content: String,
}

pub async fn view(
    app: &App,
    session: Session,
    notice: Option<(String, String)>,
    agent_id: &str,
    open: Option<&str>,
    draft: Option<Draft>,
) -> Response {
    let agents = api::call(app, Call::Agents, None)
        .await
        .map(|v| api::agents_list(&v))
        .unwrap_or_default();
    let agent = resolve_agent(agent_id, &session.agent, &agents);
    let mut skills = Vec::new();
    let mut load_err = None;
    if !agent.is_empty() {
        match api::call(app, Call::AgentContext(&agent), None).await {
            Ok(v) => {
                skills = v["skills"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|s| s.as_str().map(str::to_owned))
                    .collect();
            }
            Err(e) => load_err = Some(e),
        }
    }

    let mut list = String::new();
    for name in &skills {
        let actions = format!(
            r#"<a class="subtle" href="/ui/skills?agent={}&amp;open={}">Open</a>{}"#,
            auth::enc_query(&agent),
            auth::enc_query(name),
            html::post_button(
                "/ui/skills/delete",
                &session.csrf,
                "Delete",
                "danger",
                &[("agentId", &agent), ("name", name)]
            )
        );
        list.push_str(&html::list_item(name, "SKILL.md", &actions));
    }
    if list.is_empty() {
        list.push_str(r#"<li><div class="muted">No skills yet.</div></li>"#);
    }

    let mut edit_name = draft.as_ref().map(|d| d.name.clone()).unwrap_or_default();
    let mut edit_content = draft
        .as_ref()
        .map(|d| d.content.clone())
        .unwrap_or_default();
    let mut open_err = None;
    if draft.is_none()
        && let Some(name) = open.filter(|s| api::valid_skill_name(s))
        && !agent.is_empty()
    {
        match api::call(app, Call::AgentSkill(&agent, name), None).await {
            Ok(body) => {
                edit_name = body["name"].as_str().unwrap_or(name).to_owned();
                edit_content = body["content"].as_str().unwrap_or("").to_owned();
            }
            Err(e) => open_err = Some(e),
        }
    }

    let body = format!(
        r#"
    <section class="panel">
      <div class="row between">
        <h1>Skills</h1>
        <a class="subtle" href="/ui/skills?agent={agent_q}">Refresh</a>
      </div>
      <form method="get" action="/ui/skills" class="stack card">
        <label>Agent <select name="agent">{agent_opts}</select></label>
        <button type="submit" class="subtle">Load agent</button>
      </form>
      <form method="post" action="/ui/skills/save" class="stack card">
        <h2>Write skill</h2>
        <p class="muted">Each skill is a folder with SKILL.md under the agent profile.</p>
        {csrf}
        <input type="hidden" name="agentId" value="{agent}" />
        <label>Name <input name="name" required maxlength="80" pattern="[A-Za-z0-9][A-Za-z0-9._-]{{0,79}}" value="{name}" autocomplete="off" /></label>
        <label>Content <textarea name="content" rows="14" maxlength="5000000">{content}</textarea></label>
        <button type="submit" class="primary" {disabled}>Save skill</button>
      </form>
      <ul class="list">{list}</ul>
    </section>"#,
        agent_q = auth::enc_query(&agent),
        agent_opts = html::agent_options(&agents, &agent, None),
        csrf = html::csrf_field(&session),
        agent = html::attr(&agent),
        name = html::attr(&edit_name),
        content = html::esc(&edit_content),
        disabled = if agent.is_empty() { "disabled" } else { "" },
        list = list,
    );
    html::page(Page {
        title: "Skills",
        panel: "skills",
        status: auth::status_line(app),
        notice: load_err
            .or(open_err)
            .map(|e| (e, "error".into()))
            .or(notice),
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
        q.get("open").map(String::as_str),
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
    pub name: String,
    #[serde(default)]
    pub content: String,
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
        return Redirect::to(&auth::flash_err("/ui/skills", &msg)).into_response();
    }
    let agent = form.agent_id.trim();
    let name = form.name.trim();
    if !api::valid_id(agent) {
        return Redirect::to(&auth::flash_err("/ui/skills", "Select an agent first."))
            .into_response();
    }
    session.agent = agent.to_owned();
    if !api::valid_skill_name(name) {
        let mut res = view(
            &app,
            session.clone(),
            Some(("Invalid skill name.".into(), "error".into())),
            agent,
            None,
            Some(Draft {
                name: name.to_owned(),
                content: form.content.clone(),
            }),
        )
        .await;
        if let Ok(cookie) = auth::set_cookie_header(&app, &session) {
            res.headers_mut()
                .insert(axum::http::header::SET_COOKIE, cookie);
        }
        return res;
    }
    let dest = format!(
        "/ui/skills?agent={}&open={}",
        auth::enc_query(agent),
        auth::enc_query(name)
    );
    match api::call(
        &app,
        Call::SaveAgentSkill(agent, name),
        Some(json!({"content": form.content})),
    )
    .await
    {
        Ok(_) => {
            let dest = auth::flash_ok(&dest, "Skill saved.");
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
                Some(name),
                Some(Draft {
                    name: name.to_owned(),
                    content: form.content,
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

#[derive(Deserialize)]
pub struct NameForm {
    pub csrf: String,
    #[serde(rename = "agentId")]
    pub agent_id: String,
    pub name: String,
}

pub async fn delete(
    State(app): State<App>,
    headers: HeaderMap,
    Form(form): Form<NameForm>,
) -> Response {
    let Some(mut session) = auth::session_from(&app, &headers) else {
        return Redirect::to("/").into_response();
    };
    if let Err((_, msg)) = auth::require_mutation(&headers, &session, &form.csrf) {
        return Redirect::to(&auth::flash_err("/ui/skills", &msg)).into_response();
    }
    let agent = form.agent_id.trim();
    let name = form.name.trim();
    if api::valid_id(agent) {
        session.agent = agent.to_owned();
    }
    let dest = format!("/ui/skills?agent={}", auth::enc_query(agent));
    match api::call(&app, Call::DeleteAgentSkill(agent, name), None).await {
        Ok(_) => {
            let dest = auth::flash_ok(&dest, "Skill deleted.");
            match auth::set_cookie_header(&app, &session) {
                Ok(c) => html::redirect_with_cookie(&dest, c),
                Err(_) => Redirect::to(&dest).into_response(),
            }
        }
        Err(e) => Redirect::to(&auth::flash_err(&dest, &e)).into_response(),
    }
}
