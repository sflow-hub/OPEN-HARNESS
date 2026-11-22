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
    pairing_out: Option<String>,
) -> Response {
    let data = api::call(app, Call::Machines, None).await;
    let (machines, err) = match data {
        Ok(v) => (v["machines"].as_array().cloned().unwrap_or_default(), None),
        Err(e) => (vec![], Some(e)),
    };
    let agents = api::call(app, Call::Agents, None)
        .await
        .map(|v| api::agents_list(&v))
        .unwrap_or_default();
    let mut list = String::new();
    for machine in &machines {
        let id = machine["id"].as_str().unwrap_or("");
        let name = machine["name"].as_str().unwrap_or(id);
        let status = machine["status"]
            .as_str()
            .or_else(|| machine["connection"].as_str())
            .unwrap_or("unknown");
        let platform = machine["platform"].as_str().unwrap_or("");
        let meta = format!("{id} · {status} · {platform}");
        let mut actions = String::new();
        if id != "local" && status != "revoked" {
            actions.push_str(&format!(
                r#"<form method="post" action="/ui/machines/test" class="inline">{}<input type="hidden" name="machineId" value="{}" /><input type="hidden" name="agentId" value="{}" /><button type="submit" class="subtle">Test</button></form>"#,
                html::csrf_field(&session),
                html::attr(id),
                html::attr(&session.agent),
            ));
            actions.push_str(&html::post_button(
                "/ui/machines/reconnect",
                &session.csrf,
                "Reconnect",
                "subtle",
                &[("machineId", id)],
            ));
            actions.push_str(&html::post_button(
                "/ui/machines/revoke",
                &session.csrf,
                "Revoke",
                "danger",
                &[("machineId", id)],
            ));
        }
        list.push_str(&html::list_item(name, &meta, &actions));
    }
    if list.is_empty() {
        list.push_str(r#"<li><div class="muted">No paired computers yet. Local is always available.</div></li>"#);
    }
    let pairing = pairing_out
        .map(|s| format!(r#"<pre class="log">{}</pre>"#, html::esc(&s)))
        .unwrap_or_default();
    let body = format!(
        r#"
    <section class="panel">
      <div class="row between">
        <h1>Machines</h1>
        <a class="subtle" href="/ui/machines">Refresh</a>
      </div>
      <form method="post" action="/ui/machines/pair" class="stack card">
        <h2>Pair computer</h2>
        {csrf}
        <label>Name <input name="name" required /></label>
        <label>Platform
          <select name="platform">
            <option value="linux">Linux</option>
            <option value="darwin">macOS</option>
            <option value="windows">Windows</option>
          </select>
        </label>
        <label>Coordinator URL <input name="coordinatorUrl" placeholder="https://… or leave blank" autocomplete="off" /></label>
        <button type="submit" class="primary">Create pairing</button>
      </form>
      {pairing}
      <form method="post" action="/ui/machines/transfer" class="stack card">
        <h2>Assign / transfer agent</h2>
        <p class="muted">Moves a named agent to a connected computer and transfers its private files.</p>
        {csrf}
        <label>Agent <select name="agentId" required>{agents}</select></label>
        <label>Destination <select name="machineId" required>{machines}</select></label>
        <button type="submit" class="primary">Transfer agent</button>
      </form>
      <ul class="list">{list}</ul>
    </section>"#,
        csrf = html::csrf_field(&session),
        pairing = pairing,
        agents = html::agent_options(&agents, &session.agent, None),
        machines = html::machine_options(&machines, ""),
        list = list,
    );
    html::page(Page {
        title: "Machines",
        panel: "machines",
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
    let pairing = q.get("pairing").cloned();
    view(&app, session, auth::notice_from_query(&q), pairing).await
}

#[derive(Deserialize)]
pub struct PairForm {
    pub csrf: String,
    pub name: String,
    pub platform: String,
    #[serde(rename = "coordinatorUrl", default)]
    pub coordinator_url: String,
}

pub async fn pair(
    State(app): State<App>,
    headers: HeaderMap,
    Form(form): Form<PairForm>,
) -> Response {
    let Some(session) = auth::session_from(&app, &headers) else {
        return Redirect::to("/").into_response();
    };
    if let Err((_, msg)) = auth::require_mutation(&headers, &session, &form.csrf) {
        return Redirect::to(&auth::flash_err("/ui/machines", &msg)).into_response();
    }
    let mut payload = json!({
        "name": form.name.trim(),
        "platform": form.platform.trim(),
    });
    let url = form.coordinator_url.trim();
    if !url.is_empty() {
        payload["coordinatorUrl"] = json!(url);
    }
    match api::call(&app, Call::PairMachine, Some(payload)).await {
        Ok(result) => {
            let out = result["command"]
                .as_str()
                .map(str::to_owned)
                .unwrap_or_else(|| {
                    format!(
                        "expiresAt: {}\nmachineId: {}",
                        result["expiresAt"].as_str().unwrap_or(""),
                        result["machineId"].as_str().unwrap_or("")
                    )
                });
            Redirect::to(&format!(
                "{}&pairing={}",
                auth::flash_ok(
                    "/ui/machines",
                    "Pairing created. Run the command on the other computer."
                ),
                auth::enc_query(&out)
            ))
            .into_response()
        }
        Err(e) => Redirect::to(&auth::flash_err("/ui/machines", &e)).into_response(),
    }
}

#[derive(Deserialize)]
pub struct MachineForm {
    pub csrf: String,
    #[serde(rename = "machineId")]
    pub machine_id: String,
    #[serde(rename = "agentId", default)]
    pub agent_id: String,
}

pub async fn test(
    State(app): State<App>,
    headers: HeaderMap,
    Form(form): Form<MachineForm>,
) -> Response {
    let Some(session) = auth::session_from(&app, &headers) else {
        return Redirect::to("/").into_response();
    };
    if let Err((_, msg)) = auth::require_mutation(&headers, &session, &form.csrf) {
        return Redirect::to(&auth::flash_err("/ui/machines", &msg)).into_response();
    }
    let mut body = json!({});
    let agent = form.agent_id.trim();
    if !agent.is_empty() {
        body["agentId"] = json!(agent);
    }
    match api::call(&app, Call::TestMachine(form.machine_id.trim()), Some(body)).await {
        Ok(result) => {
            let ok = result["ok"].as_bool().unwrap_or(false);
            let msg = result["message"].as_str().unwrap_or(if ok {
                "Machine ok."
            } else {
                "Machine check failed."
            });
            if ok {
                Redirect::to(&auth::flash_ok("/ui/machines", msg)).into_response()
            } else {
                Redirect::to(&auth::flash_err("/ui/machines", msg)).into_response()
            }
        }
        Err(e) => Redirect::to(&auth::flash_err("/ui/machines", &e)).into_response(),
    }
}

pub async fn reconnect(
    State(app): State<App>,
    headers: HeaderMap,
    Form(form): Form<MachineForm>,
) -> Response {
    let Some(session) = auth::session_from(&app, &headers) else {
        return Redirect::to("/").into_response();
    };
    if let Err((_, msg)) = auth::require_mutation(&headers, &session, &form.csrf) {
        return Redirect::to(&auth::flash_err("/ui/machines", &msg)).into_response();
    }
    match api::call(&app, Call::ReconnectMachine(form.machine_id.trim()), None).await {
        Ok(_) => Redirect::to("/ui/machines").into_response(),
        Err(e) => Redirect::to(&auth::flash_err("/ui/machines", &e)).into_response(),
    }
}

pub async fn revoke(
    State(app): State<App>,
    headers: HeaderMap,
    Form(form): Form<MachineForm>,
) -> Response {
    let Some(session) = auth::session_from(&app, &headers) else {
        return Redirect::to("/").into_response();
    };
    if let Err((_, msg)) = auth::require_mutation(&headers, &session, &form.csrf) {
        return Redirect::to(&auth::flash_err("/ui/machines", &msg)).into_response();
    }
    match api::call(&app, Call::RevokeMachine(form.machine_id.trim()), None).await {
        Ok(_) => Redirect::to(&auth::flash_ok("/ui/machines", "Machine revoked.")).into_response(),
        Err(e) => Redirect::to(&auth::flash_err("/ui/machines", &e)).into_response(),
    }
}

#[derive(Deserialize)]
pub struct TransferForm {
    pub csrf: String,
    #[serde(rename = "agentId")]
    pub agent_id: String,
    #[serde(rename = "machineId")]
    pub machine_id: String,
}

pub async fn transfer(
    State(app): State<App>,
    headers: HeaderMap,
    Form(form): Form<TransferForm>,
) -> Response {
    let Some(mut session) = auth::session_from(&app, &headers) else {
        return Redirect::to("/").into_response();
    };
    if let Err((_, msg)) = auth::require_mutation(&headers, &session, &form.csrf) {
        return Redirect::to(&auth::flash_err("/ui/machines", &msg)).into_response();
    }
    let agent = form.agent_id.trim();
    let machine = form.machine_id.trim();
    if !api::valid_id(agent) {
        return Redirect::to(&auth::flash_err("/ui/machines", "Select an agent.")).into_response();
    }
    if !api::valid_id(machine) {
        return Redirect::to(&auth::flash_err(
            "/ui/machines",
            "Choose a destination computer.",
        ))
        .into_response();
    }
    session.agent = agent.to_owned();
    match api::call(
        &app,
        Call::TransferAgent(agent),
        Some(json!({"destinationMachineId": machine})),
    )
    .await
    {
        Ok(_) => {
            let dest = auth::flash_ok(
                "/ui/machines",
                "Transfer queued. Private files move after the workers finish the export.",
            );
            match auth::set_cookie_header(&app, &session) {
                Ok(c) => html::redirect_with_cookie(&dest, c),
                Err(_) => Redirect::to(&dest).into_response(),
            }
        }
        Err(e) => Redirect::to(&auth::flash_err("/ui/machines", &e)).into_response(),
    }
}
