use super::{
    api::{self, Call},
    auth::{self, Session},
    html::{self, Page},
};
use crate::App;
use axum::{
    Form,
    extract::{Path, Query, State},
    http::HeaderMap,
    response::{IntoResponse, Redirect, Response},
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::collections::HashMap;

fn active(state: &str) -> bool {
    matches!(
        state,
        "queued" | "running" | "waiting_approval" | "waiting_input"
    )
}

fn format_event(item: &Value) -> String {
    let kind = item["type"].as_str().unwrap_or("event");
    let payload = &item["payload"];
    match kind {
        "message.delta" | "message.complete" => payload["text"]
            .as_str()
            .or_else(|| payload["delta"].as_str())
            .or_else(|| payload["content"].as_str())
            .unwrap_or("")
            .to_owned(),
        "tool.start" | "tool.progress" | "tool.generating" => format!(
            "→ {}: {}",
            payload["name"]
                .as_str()
                .or_else(|| payload["tool"].as_str())
                .unwrap_or("tool"),
            payload["preview"]
                .as_str()
                .or_else(|| payload["detail"].as_str())
                .unwrap_or("running")
        ),
        "tool.complete" => format!(
            "✓ {}: {}",
            payload["name"]
                .as_str()
                .or_else(|| payload["tool"].as_str())
                .unwrap_or("tool"),
            payload["result"]
                .as_str()
                .or_else(|| payload["preview"].as_str())
                .unwrap_or("done")
        ),
        "approval.request" => format!(
            "⚠ approval: {}",
            payload["command"]
                .as_str()
                .or_else(|| payload["description"].as_str())
                .unwrap_or("Hermes requests approval.")
        ),
        "approval.resolved" => format!(
            "approval {}",
            payload["decision"].as_str().unwrap_or("resolved")
        ),
        "run.completed" => {
            let mut s = String::new();
            if let Some(r) = payload["result"].as_str() {
                s.push_str(r);
                s.push('\n');
            }
            s.push_str("— completed —");
            s
        }
        "run.failed" | "run.interrupted" | "run.cancelled" => {
            format!("— {kind}: {} —", payload["error"].as_str().unwrap_or(""))
        }
        _ => kind.to_owned(),
    }
}

pub async fn view(
    app: &App,
    session: Session,
    notice: Option<(String, String)>,
    watch: Option<&str>,
    page_n: usize,
) -> Response {
    let agents = api::call(app, Call::Agents, None)
        .await
        .map(|v| api::agents_list(&v))
        .unwrap_or_default();
    let (runs, load_err) = match api::call(app, Call::Runs, None).await {
        Ok(v) => (v["runs"].as_array().cloned().unwrap_or_default(), None),
        Err(e) => (vec![], Some(e)),
    };
    let start = page_n.saturating_mul(api::PAGE_SIZE);
    let mut list = String::new();
    for run in runs.iter().skip(start).take(api::PAGE_SIZE) {
        let id = run["id"].as_str().unwrap_or("");
        let agent = run["agent_id"]
            .as_str()
            .or_else(|| run["agentId"].as_str())
            .unwrap_or("");
        let state = run["state"].as_str().unwrap_or("");
        let prompt = run["prompt"].as_str().unwrap_or("");
        let prompt = if prompt.chars().count() > 80 {
            format!("{}…", prompt.chars().take(80).collect::<String>())
        } else {
            prompt.to_owned()
        };
        let meta = format!(
            "{state} · {id}{}",
            if prompt.is_empty() {
                String::new()
            } else {
                format!(" · {prompt}")
            }
        );
        let mut actions = format!(
            r#"<a class="subtle" href="/ui/jobs/{}">Watch</a>"#,
            html::attr(id)
        );
        if active(state) {
            actions.push_str(&html::post_button(
                "/ui/jobs/stop",
                &session.csrf,
                "Stop",
                "danger",
                &[("runId", id)],
            ));
        }
        list.push_str(&html::list_item(
            &api::agent_name(&agents, agent),
            &meta,
            &actions,
        ));
    }
    if list.is_empty() {
        list.push_str(r#"<li><div class="muted">No jobs yet.</div></li>"#);
    }
    let mut pager = String::new();
    if page_n > 0 {
        pager.push_str(&format!(
            r#"<a class="subtle" href="/ui/jobs?page={}">Newer</a>"#,
            page_n - 1
        ));
    }
    if start + api::PAGE_SIZE < runs.len() {
        pager.push_str(&format!(
            r#"<a class="subtle" href="/ui/jobs?page={}">Older</a>"#,
            page_n + 1
        ));
    }

    let refresh_href = watch
        .filter(|s| api::valid_id(s))
        .map(|id| format!("/ui/jobs/{id}"))
        .unwrap_or_else(|| "/ui/jobs".into());
    let mut watch_meta = String::from("none");
    let mut log = String::new();
    let mut approval = String::new();
    let mut refresh = None;
    let mut stop_watch =
        r#"<button type="button" class="danger" disabled>Stop</button>"#.to_owned();

    if let Some(run_id) = watch.filter(|s| api::valid_id(s)) {
        stop_watch = html::post_button(
            "/ui/jobs/stop",
            &session.csrf,
            "Stop",
            "danger",
            &[("runId", run_id)],
        );
        match api::call(app, Call::RunEvents(run_id, 0), None).await {
            Ok(snapshot) => {
                let run = &snapshot["run"];
                let state = run["state"].as_str().unwrap_or("");
                watch_meta = format!("{} · {state}", run["id"].as_str().unwrap_or(run_id));
                if active(state) {
                    refresh = Some(2);
                }
                for item in snapshot["events"].as_array().into_iter().flatten() {
                    let line = format_event(item);
                    if !line.is_empty() {
                        log.push_str(&html::esc(&line));
                        log.push('\n');
                    }
                    if item["type"] == "approval.request" {
                        let approval_id = item["payload"]["approvalId"].as_str().unwrap_or("");
                        let detail = item["payload"]["command"]
                            .as_str()
                            .or_else(|| item["payload"]["description"].as_str())
                            .unwrap_or("Hermes requests approval.");
                        let agent = run["agent_id"]
                            .as_str()
                            .or_else(|| run["agentId"].as_str())
                            .unwrap_or("");
                        approval = format!(
                            r#"<div class="approval"><strong>{} needs approval</strong><p>{}</p><div class="row">{}{}</div></div>"#,
                            html::esc(&api::agent_name(&agents, agent)),
                            html::esc(detail),
                            html::post_button(
                                "/ui/jobs/approval",
                                &session.csrf,
                                "Deny",
                                "subtle",
                                &[
                                    ("runId", run_id),
                                    ("approvalId", approval_id),
                                    ("decision", "deny")
                                ]
                            ),
                            html::post_button(
                                "/ui/jobs/approval",
                                &session.csrf,
                                "Approve once",
                                "primary",
                                &[
                                    ("runId", run_id),
                                    ("approvalId", approval_id),
                                    ("decision", "approve")
                                ]
                            ),
                        );
                    }
                }
                if log.is_empty() {
                    log = html::esc(&format!("Watching {run_id}"));
                }
            }
            Err(e) => log = html::esc(&format!("watch error: {e}")),
        }
    }

    let body = format!(
        r#"
    <section class="panel">
      <div class="row between">
        <h1>Jobs</h1>
        <div class="row">
          <a class="subtle" href="{refresh_href}">Refresh</a>
          {stop_all}
        </div>
      </div>
      <form method="post" action="/ui/jobs/submit" class="stack card">
        <h2>Submit</h2>
        {csrf}
        <label>Agent <select name="agentId" required>{agents}</select></label>
        <label>Prompt <textarea name="prompt" rows="4" required maxlength="20000"></textarea></label>
        <div class="row">
          <button type="submit" class="primary">Run</button>
          <a class="subtle" href="/ui/files?scope=shared#upload" target="_blank" rel="noopener">Upload shared files</a>
          {stop_watch}
        </div>
      </form>
      {approval}
      <div class="split">
        <div>
          <h2>Recent</h2>
          <ul class="list">{list}</ul>
          <div class="row">{pager}</div>
        </div>
        <div>
          <h2>Watch <span class="muted">{watch_meta}</span></h2>
          <pre class="log" aria-live="polite">{log}</pre>
        </div>
      </div>
    </section>"#,
        refresh_href = html::attr(&refresh_href),
        stop_all = html::post_button(
            "/ui/jobs/stop-all",
            &session.csrf,
            "Stop all",
            "danger",
            &[]
        ),
        csrf = html::csrf_field(&session),
        agents = html::agent_options(&agents, &session.agent, None),
        stop_watch = stop_watch,
        approval = approval,
        list = list,
        pager = pager,
        watch_meta = html::esc(&watch_meta),
        log = log,
    );

    html::page(Page {
        title: "Jobs",
        panel: "jobs",
        status: auth::status_line(app),
        notice: load_err.map(|e| (e, "error".into())).or(notice),
        session,
        body,
        refresh,
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
    let page_n = q.get("page").and_then(|s| s.parse().ok()).unwrap_or(0usize);
    view(&app, session, auth::notice_from_query(&q), None, page_n).await
}

pub async fn watch(
    State(app): State<App>,
    headers: HeaderMap,
    Path(id): Path<String>,
    Query(q): Query<HashMap<String, String>>,
) -> Response {
    let Some(session) = auth::session_from(&app, &headers) else {
        return Redirect::to("/").into_response();
    };
    view(
        &app,
        session,
        auth::notice_from_query(&q),
        Some(id.as_str()),
        0,
    )
    .await
}

#[derive(Deserialize)]
pub struct SubmitForm {
    pub csrf: String,
    #[serde(rename = "agentId")]
    pub agent_id: String,
    pub prompt: String,
}

pub async fn submit(
    State(app): State<App>,
    headers: HeaderMap,
    Form(form): Form<SubmitForm>,
) -> Response {
    let Some(mut session) = auth::session_from(&app, &headers) else {
        return Redirect::to("/").into_response();
    };
    if let Err((_, msg)) = auth::require_mutation(&headers, &session, &form.csrf) {
        return Redirect::to(&auth::flash_err("/ui/jobs", &msg)).into_response();
    }
    let agent = form.agent_id.trim();
    if !api::valid_id(agent) {
        return Redirect::to(&auth::flash_err("/ui/jobs", "Select an agent.")).into_response();
    }
    session.agent = agent.to_owned();
    let result = api::call(
        &app,
        Call::CreateRun,
        Some(json!({"agentId": agent, "prompt": form.prompt.trim()})),
    )
    .await;
    match result {
        Ok(run) => {
            let id = run["id"].as_str().unwrap_or("");
            let dest = auth::flash_ok(&format!("/ui/jobs/{id}"), &format!("Job {id} queued."));
            match auth::set_cookie_header(&app, &session) {
                Ok(cookie) => html::redirect_with_cookie(&dest, cookie),
                Err(_) => Redirect::to(&dest).into_response(),
            }
        }
        Err(e) => Redirect::to(&auth::flash_err("/ui/jobs", &e)).into_response(),
    }
}

#[derive(Deserialize)]
pub struct StopForm {
    pub csrf: String,
    #[serde(rename = "runId")]
    pub run_id: String,
}

pub async fn stop(
    State(app): State<App>,
    headers: HeaderMap,
    Form(form): Form<StopForm>,
) -> Response {
    let Some(session) = auth::session_from(&app, &headers) else {
        return Redirect::to("/").into_response();
    };
    if let Err((_, msg)) = auth::require_mutation(&headers, &session, &form.csrf) {
        return Redirect::to(&auth::flash_err("/ui/jobs", &msg)).into_response();
    }
    let id = form.run_id.trim();
    match api::call(&app, Call::StopRun(id), None).await {
        Ok(_) => Redirect::to(&auth::flash_ok(
            &format!("/ui/jobs/{id}"),
            "Stop requested.",
        ))
        .into_response(),
        Err(e) => Redirect::to(&auth::flash_err("/ui/jobs", &e)).into_response(),
    }
}

pub async fn stop_all(
    State(app): State<App>,
    headers: HeaderMap,
    Form(form): Form<HashMap<String, String>>,
) -> Response {
    let Some(session) = auth::session_from(&app, &headers) else {
        return Redirect::to("/").into_response();
    };
    let csrf = form.get("csrf").map(String::as_str).unwrap_or("");
    if let Err((_, msg)) = auth::require_mutation(&headers, &session, csrf) {
        return Redirect::to(&auth::flash_err("/ui/jobs", &msg)).into_response();
    }
    match api::call(&app, Call::StopAllRuns, None).await {
        Ok(v) => {
            let n = v["stopped"].as_u64().unwrap_or(0);
            Redirect::to(&auth::flash_ok("/ui/jobs", &format!("Stopped {n} run(s).")))
                .into_response()
        }
        Err(e) => Redirect::to(&auth::flash_err("/ui/jobs", &e)).into_response(),
    }
}

#[derive(Deserialize)]
pub struct ApprovalForm {
    pub csrf: String,
    #[serde(rename = "runId")]
    pub run_id: String,
    #[serde(rename = "approvalId")]
    pub approval_id: String,
    pub decision: String,
}

pub async fn approval(
    State(app): State<App>,
    headers: HeaderMap,
    Form(form): Form<ApprovalForm>,
) -> Response {
    let Some(session) = auth::session_from(&app, &headers) else {
        return Redirect::to("/").into_response();
    };
    if let Err((_, msg)) = auth::require_mutation(&headers, &session, &form.csrf) {
        return Redirect::to(&auth::flash_err("/ui/jobs", &msg)).into_response();
    }
    let id = form.run_id.trim();
    let decision = if form.decision == "deny" {
        "deny"
    } else {
        "approve"
    };
    match api::call(
        &app,
        Call::Approval(id),
        Some(json!({"approvalId": form.approval_id.trim(), "decision": decision})),
    )
    .await
    {
        Ok(_) => {
            let msg = if decision == "deny" {
                "Denied."
            } else {
                "Approved."
            };
            Redirect::to(&auth::flash_ok(&format!("/ui/jobs/{id}"), msg)).into_response()
        }
        Err(e) => Redirect::to(&auth::flash_err(&format!("/ui/jobs/{id}"), &e)).into_response(),
    }
}
