use super::{
    api::{self, Call},
    auth::{self, Session},
    html::{self, Page},
};
use crate::App;
use axum::http::StatusCode;
use axum::{
    Form,
    extract::{Query, State},
    http::HeaderMap,
    response::{IntoResponse, Redirect, Response},
};
use serde::Deserialize;
use serde_json::json;
use std::collections::HashMap;

async fn view(
    app: &App,
    session: Session,
    notice: Option<(String, String)>,
    draft: Option<&CreateForm>,
) -> Response {
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
    let model_connections = html::model_connection_options(app).await;
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
          <label>Name <input name="name" maxlength="30" required autocomplete="off" value="{name}" /></label>
          <label>ID <input name="id" maxlength="80" placeholder="optional" autocomplete="off" value="{id}" /></label>
          <label>Harness <select name="harness" required>{harness}</select></label>
          <details{open}>
            <summary>Model connection</summary>
            <label>Provider <input name="provider" list="model-providers" placeholder="harness default" value="{provider}" /></label>
            <label>Model ID <input name="model" placeholder="harness default" autocomplete="off" value="{model}" /></label>
            <label>Credential ref <input name="credentialRef" list="model-credentials" autocomplete="off" value="{credential}" /></label>
            <label>Base URL <input name="baseUrl" autocomplete="off" value="{base_url}" /></label>
          </details>
          <button type="submit" class="primary">Create agent</button>
        </form>
        {model_connections}
      </div>
    </section>"#,
        csrf = html::csrf_field(&session),
        harness = html::harness_options(draft.map_or("hermes", |d| &d.harness)),
        name = html::attr(draft.map_or("", |d| &d.name)),
        id = html::attr(draft.map_or("", |d| &d.id)),
        provider = html::attr(draft.map_or("", |d| &d.provider)),
        model = html::attr(draft.map_or("", |d| &d.model)),
        credential = html::attr(draft.map_or("", |d| &d.credential_ref)),
        base_url = html::attr(draft.map_or("", |d| &d.base_url)),
        open = if draft.is_some() { " open" } else { "" },
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
    view(&app, session, auth::notice_from_query(&q), None).await
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
    #[serde(default)]
    pub provider: String,
    #[serde(default, rename = "credentialRef")]
    pub credential_ref: String,
    #[serde(default, rename = "baseUrl")]
    pub base_url: String,
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
    let mut model = serde_json::Map::new();
    for (key, value) in [
        ("model", form.model.trim()),
        ("provider", form.provider.trim()),
        ("credentialRef", form.credential_ref.trim()),
        ("baseUrl", form.base_url.trim()),
    ] {
        if !value.is_empty() {
            model.insert(key.to_owned(), json!(value));
        }
    }
    let message = if model.contains_key("provider") && !model.contains_key("model") {
        "Enter a model ID for the selected provider.".into()
    } else {
        if !model.is_empty() {
            payload["model"] = model.into();
        }
        match api::call(&app, Call::CreateAgent, Some(payload)).await {
            Ok(_) => {
                return Redirect::to(&auth::flash_ok("/ui/agents", "Agent created."))
                    .into_response();
            }
            Err(error) => error,
        }
    };
    let mut response = view(&app, session, Some((message, "error".into())), Some(&form)).await;
    *response.status_mut() = StatusCode::BAD_REQUEST;
    response
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
