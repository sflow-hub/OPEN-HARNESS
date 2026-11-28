use super::{
    api::{self, Call},
    auth::{self, Session},
    html::{self, Page},
};
use crate::App;
use axum::{
    extract::{Query, State},
    http::HeaderMap,
    response::{IntoResponse, Redirect, Response},
};
use serde_json::json;
use std::collections::HashMap;

pub async fn view(app: &App, session: Session, notice: Option<(String, String)>) -> Response {
    let agents = api::call(app, Call::Agents, None)
        .await
        .map(|v| api::agents_list(&v))
        .unwrap_or_default();
    let data = api::call(app, Call::Teams, None).await;
    let (teams, err) = match data {
        Ok(v) => (v["teams"].as_array().cloned().unwrap_or_default(), None),
        Err(e) => (vec![], Some(e)),
    };
    let mut list = String::new();
    for team in &teams {
        let id = team["id"].as_str().unwrap_or("");
        let name = team["name"].as_str().unwrap_or(id);
        let members = team["memberAgentIds"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|m| m.as_str())
            .map(|id| api::agent_name(&agents, id))
            .collect::<Vec<_>>()
            .join(", ");
        let retired = team["retiredAt"].as_str().is_some();
        let meta = format!(
            "{id}{} · {}",
            if retired { " · retired" } else { "" },
            if members.is_empty() {
                "no members"
            } else {
                &members
            }
        );
        let actions = if retired {
            String::new()
        } else {
            html::post_button(
                "/ui/teams/retire",
                &session.csrf,
                "Retire",
                "danger",
                &[("teamId", id)],
            )
        };
        list.push_str(&html::list_item(name, &meta, &actions));
    }
    if list.is_empty() {
        list.push_str(r#"<li><div class="muted">No teams yet.</div></li>"#);
    }
    let mut members = String::new();
    for agent in &agents {
        let id = agent["id"].as_str().unwrap_or("");
        let name = agent["name"].as_str().unwrap_or(id);
        members.push_str(&format!(
            r#"<label class="check"><input type="checkbox" name="member" value="{}" /> {}</label>"#,
            html::attr(id),
            html::esc(name)
        ));
    }
    let body = format!(
        r#"
    <section class="panel">
      <div class="row between">
        <h1>Teams</h1>
        <a class="subtle" href="/ui/teams">Refresh</a>
      </div>
      <form method="post" action="/ui/teams/create" class="stack card">
        <h2>Create</h2>
        {csrf}
        <label>Name <input name="name" maxlength="60" required /></label>
        <label>Description <input name="description" maxlength="240" /></label>
        <label>Color
          <select name="color">
            <option>sage</option><option>blue</option><option>amber</option>
            <option>violet</option><option>rose</option><option>teal</option>
          </select>
        </label>
        <label>Icon
          <select name="icon">
            <option>people</option><option>rocket</option><option>briefcase</option><option>flask</option>
            <option>writing</option><option>code</option><option>compass</option><option>shield</option>
          </select>
        </label>
        <fieldset class="stack"><legend>Members</legend>{members}</fieldset>
        <button type="submit" class="primary">Create team</button>
      </form>
      <ul class="list">{list}</ul>
    </section>"#,
        csrf = html::csrf_field(&session),
        members = if members.is_empty() {
            r#"<p class="muted">Create an agent first.</p>"#.into()
        } else {
            members
        },
        list = list,
    );
    html::page(Page {
        title: "Teams",
        panel: "teams",
        status: auth::status_line(app),
        notice: err.map(|e| (e, "error".into())).or(notice),
        session,
        body,
        refresh: None,
    })
    .into_response()
}

pub async fn get(
    State(app): State<App>,
    headers: HeaderMap,
    Query(q): Query<HashMap<String, String>>,
) -> Response {
    let Some(session) = auth::session_from(&app, &headers) else {
        return Redirect::to("/").into_response();
    };
    view(&app, session, auth::notice_from_query(&q)).await
}

pub async fn create(State(app): State<App>, headers: HeaderMap, body: String) -> Response {
    let Some(session) = auth::session_from(&app, &headers) else {
        return Redirect::to("/").into_response();
    };
    let pairs = parse(&body);
    let csrf = field(&pairs, "csrf");
    if let Err((_, msg)) = auth::require_mutation(&headers, &session, csrf) {
        return Redirect::to(&auth::flash_err("/ui/teams", &msg)).into_response();
    }
    let members: Vec<&str> = pairs
        .iter()
        .filter(|(k, _)| k == "member")
        .map(|(_, v)| v.as_str())
        .collect();
    match api::call(
        &app,
        Call::CreateTeam,
        Some(json!({
            "name": field(&pairs, "name").trim(),
            "description": field(&pairs, "description").trim(),
            "color": field(&pairs, "color"),
            "icon": field(&pairs, "icon"),
            "memberAgentIds": members,
        })),
    )
    .await
    {
        Ok(_) => Redirect::to(&auth::flash_ok("/ui/teams", "Team created.")).into_response(),
        Err(e) => Redirect::to(&auth::flash_err("/ui/teams", &e)).into_response(),
    }
}

pub async fn retire(
    State(app): State<App>,
    headers: HeaderMap,
    axum::Form(form): axum::Form<HashMap<String, String>>,
) -> Response {
    let Some(session) = auth::session_from(&app, &headers) else {
        return Redirect::to("/").into_response();
    };
    let csrf = form.get("csrf").map(String::as_str).unwrap_or("");
    if let Err((_, msg)) = auth::require_mutation(&headers, &session, csrf) {
        return Redirect::to(&auth::flash_err("/ui/teams", &msg)).into_response();
    }
    let id = form.get("teamId").map(|s| s.trim()).unwrap_or("");
    match api::call(&app, Call::RetireTeam(id), None).await {
        Ok(_) => Redirect::to(&auth::flash_ok("/ui/teams", "Team retired.")).into_response(),
        Err(e) => Redirect::to(&auth::flash_err("/ui/teams", &e)).into_response(),
    }
}

fn parse(body: &str) -> Vec<(String, String)> {
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
