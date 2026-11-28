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

pub async fn view(
    app: &App,
    session: Session,
    notice: Option<(String, String)>,
    rotate: Option<&str>,
) -> Response {
    let data = api::call(app, Call::Credentials, None).await;
    let (rows, err) = match data {
        Ok(v) => (
            v["credentials"].as_array().cloned().unwrap_or_default(),
            None,
        ),
        Err(e) => (vec![], Some(e)),
    };
    let mut list = String::new();
    for row in &rows {
        let reference = row["ref"].as_str().unwrap_or("");
        let label = row["label"].as_str().unwrap_or(reference);
        let provider = row["provider"].as_str().unwrap_or("any");
        let present = if row["present"].as_bool().unwrap_or(false) {
            "present"
        } else {
            "missing"
        };
        let meta = format!("{reference} · {provider} · {present}");
        let actions = format!(
            "{}{}",
            html::post_button(
                "/ui/credentials/rotate-form",
                &session.csrf,
                "Replace",
                "subtle",
                &[("ref", reference)]
            ),
            html::post_button(
                "/ui/credentials/delete",
                &session.csrf,
                "Delete",
                "danger",
                &[("ref", reference)]
            )
        );
        list.push_str(&html::list_item(label, &meta, &actions));
    }
    if list.is_empty() {
        list.push_str(r#"<li><div class="muted">No credentials saved.</div></li>"#);
    }
    let rotate_box = rotate
        .filter(|s| api::valid_ref(s))
        .map(|r| {
            format!(
                r#"<form method="post" action="/ui/credentials/rotate" class="stack card">
        <h2>Replace value</h2>
        {csrf}
        <p class="muted">{ref}</p>
        <input type="hidden" name="ref" value="{ref_attr}" />
        <label>New value <input name="value" type="password" required autocomplete="off" /></label>
        <div class="row">
          <button type="submit" class="primary">Replace</button>
          <a class="subtle" href="/ui/credentials">Cancel</a>
        </div>
      </form>"#,
                csrf = html::csrf_field(&session),
                ref = html::esc(r),
                ref_attr = html::attr(r),
            )
        })
        .unwrap_or_default();

    let body = format!(
        r#"
    <section class="panel">
      <div class="row between">
        <h1>Credentials</h1>
        <a class="subtle" href="/ui/credentials">Refresh</a>
      </div>
      <p class="muted">Secret values are write-only. This page never displays them after save.</p>
      <form method="post" action="/ui/credentials/create" class="stack card">
        <h2>Add</h2>
        {csrf}
        <label>Label <input name="label" required /></label>
        <label>Provider
          <select name="provider">
            <option value="xai">xAI</option>
            <option value="openai">OpenAI</option>
            <option value="anthropic">Anthropic</option>
            <option value="openrouter">OpenRouter</option>
            <option value="slack">Slack</option>
          </select>
        </label>
        <label>Value <input name="value" type="password" required autocomplete="off" /></label>
        <button type="submit" class="primary">Save credential</button>
      </form>
      <ul class="list">{list}</ul>
      {rotate_box}
    </section>"#,
        csrf = html::csrf_field(&session),
        list = list,
        rotate_box = rotate_box,
    );
    html::page(Page {
        title: "Credentials",
        panel: "credentials",
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
    let rotate = q.get("rotate").map(String::as_str);
    view(&app, session, auth::notice_from_query(&q), rotate).await
}

#[derive(Deserialize)]
pub struct CreateForm {
    pub csrf: String,
    pub label: String,
    pub provider: String,
    pub value: String,
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
        return Redirect::to(&auth::flash_err("/ui/credentials", &msg)).into_response();
    }
    match api::call(
        &app,
        Call::CreateCredential,
        Some(json!({
            "label": form.label.trim(),
            "provider": form.provider.trim(),
            "value": form.value,
        })),
    )
    .await
    {
        Ok(_) => {
            Redirect::to(&auth::flash_ok("/ui/credentials", "Credential saved.")).into_response()
        }
        Err(e) => Redirect::to(&auth::flash_err("/ui/credentials", &e)).into_response(),
    }
}

#[derive(Deserialize)]
pub struct RefForm {
    pub csrf: String,
    #[serde(rename = "ref")]
    pub reference: String,
}

pub async fn rotate_form(
    State(app): State<App>,
    headers: HeaderMap,
    Form(form): Form<RefForm>,
) -> Response {
    let Some(session) = auth::session_from(&app, &headers) else {
        return Redirect::to("/").into_response();
    };
    if let Err((_, msg)) = auth::require_mutation(&headers, &session, &form.csrf) {
        return Redirect::to(&auth::flash_err("/ui/credentials", &msg)).into_response();
    }
    Redirect::to(&format!(
        "/ui/credentials?rotate={}",
        auth::enc_query(form.reference.trim())
    ))
    .into_response()
}

#[derive(Deserialize)]
pub struct RotateForm {
    pub csrf: String,
    #[serde(rename = "ref")]
    pub reference: String,
    pub value: String,
}

pub async fn rotate(
    State(app): State<App>,
    headers: HeaderMap,
    Form(form): Form<RotateForm>,
) -> Response {
    let Some(session) = auth::session_from(&app, &headers) else {
        return Redirect::to("/").into_response();
    };
    if let Err((_, msg)) = auth::require_mutation(&headers, &session, &form.csrf) {
        return Redirect::to(&auth::flash_err("/ui/credentials", &msg)).into_response();
    }
    match api::call(
        &app,
        Call::RotateCredential(form.reference.trim()),
        Some(json!({"value": form.value})),
    )
    .await
    {
        Ok(_) => {
            Redirect::to(&auth::flash_ok("/ui/credentials", "Credential replaced.")).into_response()
        }
        Err(e) => Redirect::to(&auth::flash_err("/ui/credentials", &e)).into_response(),
    }
}

pub async fn delete(
    State(app): State<App>,
    headers: HeaderMap,
    Form(form): Form<RefForm>,
) -> Response {
    let Some(session) = auth::session_from(&app, &headers) else {
        return Redirect::to("/").into_response();
    };
    if let Err((_, msg)) = auth::require_mutation(&headers, &session, &form.csrf) {
        return Redirect::to(&auth::flash_err("/ui/credentials", &msg)).into_response();
    }
    match api::call(&app, Call::DeleteCredential(form.reference.trim()), None).await {
        Ok(_) => {
            Redirect::to(&auth::flash_ok("/ui/credentials", "Credential removed.")).into_response()
        }
        Err(e) => Redirect::to(&auth::flash_err("/ui/credentials", &e)).into_response(),
    }
}
