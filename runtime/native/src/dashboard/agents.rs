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

pub async fn view(app: &App, session: Session, notice: Option<(String, String)>) -> Response {
    let agents = match api::call(app, Call::Agents, None).await {
        Ok(v) => api::agents_list(&v),
        Err(e) => {
            return html::page(Page {
                title: "Agents",
                panel: "agents",
                status: auth::status_line(app),
                notice: Some((e, "error".into())),
                session,
                body: String::new(),
                refresh: None,
            })
            .into_response();
        }
    };
    let mut list = String::new();
    for agent in &agents {
        let id = agent["id"].as_str().unwrap_or("");
        let name = agent["name"].as_str().unwrap_or(id);
        let harness = agent["profile"]["harness"]
            .as_str()
            .or_else(|| agent["harness"].as_str())
            .unwrap_or("hermes");
        let meta = format!("{} · {}", id, api::harness_label(harness));
        let select_label = if session.agent == id {
            "Selected"
        } else {
            "Select"
        };
        let actions = format!(
            "{}{}",
            html::post_button(
                "/ui/agents/select",
                &session.csrf,
                select_label,
                "subtle",
                &[("agentId", id)]
            ),
            html::post_button(
                "/ui/agents/select",
                &session.csrf,
                "Open jobs",
                "subtle",
                &[("agentId", id), ("next", "jobs")]
            )
        );
        list.push_str(&html::list_item(name, &meta, &actions));
    }
    if list.is_empty() {
        list.push_str(r#"<li><div class="muted">No agents yet.</div></li>"#);
    }
    let body = format!(
        r#"
    <section class="panel">
      <div class="row between">
        <h1>Agents</h1>
        <a class="subtle" href="/ui/agents">Refresh</a>
      </div>
      <div class="split">
        <div>
          <h2>Select</h2>
          <ul class="list">{list}</ul>
        </div>
        <form method="post" action="/ui/agents/create" class="stack card">
          <h2>Create</h2>
          {csrf}
          <label>Name <input name="name" maxlength="30" required autocomplete="off" /></label>
          <label>ID <input name="id" maxlength="80" placeholder="optional" autocomplete="off" /></label>
          <label>Harness <select name="harness" required>{harness}</select></label>
          <label>Model ID <input name="model" placeholder="optional override" autocomplete="off" /></label>
          <button type="submit" class="primary">Create agent</button>
        </form>
      </div>
    </section>"#,
        csrf = html::csrf_field(&session),
        harness = html::harness_options("hermes"),
        list = list,
    );
    html::page(Page {
        title: "Agents",
        panel: "agents",
        status: auth::status_line(app),
        notice,
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

#[derive(Deserialize)]
pub struct CreateForm {
    pub csrf: String,
    pub name: String,
    #[serde(default)]
    pub id: String,
    pub harness: String,
    #[serde(default)]
    pub model: String,
}

pub async fn create(
    State(app): State<App>,
    headers: HeaderMap,
    Form(form): Form<CreateForm>,
) -> Response {
    let Some(session) = auth::session_from(&app, &headers) else {
        return Redirect::to("/").into_response();
    };
    if let Err((_, msg)) = auth::require_mutation(&headers, &session, &form.csrf) {
        return Redirect::to(&auth::flash_err("/ui/agents", &msg)).into_response();
    }
    let mut payload = json!({
        "name": form.name.trim(),
        "harness": form.harness.trim(),
    });
    let id = form.id.trim();
    if !id.is_empty() {
        payload["id"] = json!(id);
    }
    let model = form.model.trim();
    if !model.is_empty() {
        payload["model"] = json!({"model": model});
    }
    match api::call(&app, Call::CreateAgent, Some(payload)).await {
        Ok(_) => Redirect::to(&auth::flash_ok("/ui/agents", "Agent created.")).into_response(),
        Err(e) => Redirect::to(&auth::flash_err("/ui/agents", &e)).into_response(),
    }
}

#[derive(Deserialize)]
pub struct SelectForm {
    pub csrf: String,
    #[serde(rename = "agentId")]
    pub agent_id: String,
    #[serde(default)]
    pub next: String,
}

pub async fn select(
    State(app): State<App>,
    headers: HeaderMap,
    Form(form): Form<SelectForm>,
) -> Response {
    let Some(mut session) = auth::session_from(&app, &headers) else {
        return Redirect::to("/").into_response();
    };
    if let Err((_, msg)) = auth::require_mutation(&headers, &session, &form.csrf) {
        return Redirect::to(&auth::flash_err("/ui/agents", &msg)).into_response();
    }
    if !api::valid_id(form.agent_id.trim()) {
        return Redirect::to(&auth::flash_err("/ui/agents", "Invalid agent.")).into_response();
    }
    session.agent = form.agent_id.trim().to_owned();
    let dest = if form.next == "jobs" {
        auth::flash_ok("/ui/jobs", "Agent selected.")
    } else {
        auth::flash_ok("/ui/agents", "Agent selected.")
    };
    match auth::set_cookie_header(&app, &session) {
        Ok(cookie) => html::redirect_with_cookie(&dest, cookie),
        Err(e) => Redirect::to(&auth::flash_err("/ui/agents", &e)).into_response(),
    }
}
