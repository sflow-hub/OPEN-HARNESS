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
    let agents = api::call(app, Call::Agents, None)
        .await
        .map(|v| api::agents_list(&v))
        .unwrap_or_default();
    let data = api::call(app, Call::Routines, None).await;
    let (routines, err) = match data {
        Ok(v) => (v["routines"].as_array().cloned().unwrap_or_default(), None),
        Err(e) => (vec![], Some(e)),
    };
    let mut list = String::new();
    for routine in &routines {
        let id = routine["id"].as_str().unwrap_or("");
        let name = routine["name"].as_str().unwrap_or(id);
        let agent = routine["agent_id"]
            .as_str()
            .or_else(|| routine["agentId"].as_str())
            .unwrap_or("");
        let interval = routine["interval_minutes"]
            .as_u64()
            .or_else(|| routine["intervalMinutes"].as_u64())
            .unwrap_or(0);
        let enabled = routine["enabled"].as_bool().unwrap_or(false);
        let meta = format!(
            "{} · every {interval}m · {}",
            api::agent_name(&agents, agent),
            if enabled { "on" } else { "off" }
        );
        let actions = format!(
            "{}{}{}",
            html::post_button(
                "/ui/routines/run",
                &session.csrf,
                "Run now",
                "subtle",
                &[("routineId", id)]
            ),
            html::post_button(
                "/ui/routines/toggle",
                &session.csrf,
                "Toggle",
                "subtle",
                &[("routineId", id)]
            ),
            html::post_button(
                "/ui/routines/delete",
                &session.csrf,
                "Delete",
                "danger",
                &[("routineId", id)]
            )
        );
        list.push_str(&html::list_item(name, &meta, &actions));
    }
    if list.is_empty() {
        list.push_str(r#"<li><div class="muted">No routines yet.</div></li>"#);
    }
    let body = format!(
        r#"
    <section class="panel">
      <div class="row between">
        <h1>Routines</h1>
        <a class="subtle" href="/ui/routines">Refresh</a>
      </div>
      <form method="post" action="/ui/routines/create" class="stack card">
        <h2>Create</h2>
        {csrf}
        <label>Name <input name="name" required maxlength="200" /></label>
        <label>Agent <select name="agentId" required>{agents}</select></label>
        <label>Interval (minutes) <input name="intervalMinutes" type="number" min="1" value="60" required /></label>
        <label>Prompt <textarea name="prompt" rows="3" required maxlength="20000"></textarea></label>
        <button type="submit" class="primary">Create routine</button>
      </form>
      <ul class="list">{list}</ul>
    </section>"#,
        csrf = html::csrf_field(&session),
        agents = html::agent_options(&agents, &session.agent, None),
        list = list,
    );
    html::page(Page {
        title: "Routines",
        panel: "routines",
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

#[derive(Deserialize)]
pub struct CreateForm {
    pub csrf: String,
    pub name: String,
    #[serde(rename = "agentId")]
    pub agent_id: String,
    #[serde(rename = "intervalMinutes")]
    pub interval_minutes: u64,
    pub prompt: String,
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
        return Redirect::to(&auth::flash_err("/ui/routines", &msg)).into_response();
    }
    match api::call(
        &app,
        Call::CreateRoutine,
        Some(json!({
            "name": form.name.trim(),
            "agentId": form.agent_id.trim(),
            "intervalMinutes": form.interval_minutes.max(1),
            "prompt": form.prompt.trim(),
        })),
    )
    .await
    {
        Ok(_) => Redirect::to(&auth::flash_ok("/ui/routines", "Routine created.")).into_response(),
        Err(e) => Redirect::to(&auth::flash_err("/ui/routines", &e)).into_response(),
    }
}

#[derive(Deserialize)]
pub struct IdForm {
    pub csrf: String,
    #[serde(rename = "routineId")]
    pub routine_id: String,
}

pub async fn run_now(
    State(app): State<App>,
    headers: HeaderMap,
    Form(form): Form<IdForm>,
) -> Response {
    let Some(session) = auth::session_from(&app, &headers) else {
        return Redirect::to("/").into_response();
    };
    if let Err((_, msg)) = auth::require_mutation(&headers, &session, &form.csrf) {
        return Redirect::to(&auth::flash_err("/ui/routines", &msg)).into_response();
    }
    match api::call(&app, Call::RunRoutine(form.routine_id.trim()), None).await {
        Ok(run) => {
            if let Some(id) = run["id"].as_str() {
                Redirect::to(&auth::flash_ok(
                    &format!("/ui/jobs/{id}"),
                    "Routine started.",
                ))
                .into_response()
            } else {
                Redirect::to(&auth::flash_ok("/ui/routines", "Routine started.")).into_response()
            }
        }
        Err(e) => Redirect::to(&auth::flash_err("/ui/routines", &e)).into_response(),
    }
}

pub async fn toggle(
    State(app): State<App>,
    headers: HeaderMap,
    Form(form): Form<IdForm>,
) -> Response {
    let Some(session) = auth::session_from(&app, &headers) else {
        return Redirect::to("/").into_response();
    };
    if let Err((_, msg)) = auth::require_mutation(&headers, &session, &form.csrf) {
        return Redirect::to(&auth::flash_err("/ui/routines", &msg)).into_response();
    }
    match api::call(&app, Call::ToggleRoutine(form.routine_id.trim()), None).await {
        Ok(_) => Redirect::to("/ui/routines").into_response(),
        Err(e) => Redirect::to(&auth::flash_err("/ui/routines", &e)).into_response(),
    }
}

pub async fn delete(
    State(app): State<App>,
    headers: HeaderMap,
    Form(form): Form<IdForm>,
) -> Response {
    let Some(session) = auth::session_from(&app, &headers) else {
        return Redirect::to("/").into_response();
    };
    if let Err((_, msg)) = auth::require_mutation(&headers, &session, &form.csrf) {
        return Redirect::to(&auth::flash_err("/ui/routines", &msg)).into_response();
    }
    match api::call(&app, Call::DeleteRoutine(form.routine_id.trim()), None).await {
        Ok(_) => Redirect::to(&auth::flash_ok("/ui/routines", "Routine deleted.")).into_response(),
        Err(e) => Redirect::to(&auth::flash_err("/ui/routines", &e)).into_response(),
    }
}
