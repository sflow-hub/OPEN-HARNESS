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
    board_q: Option<&str>,
) -> Response {
    let agents = api::call(app, Call::Agents, None)
        .await
        .map(|v| api::agents_list(&v))
        .unwrap_or_default();
    let data = api::call(app, Call::Tasks, None).await;
    let (boards, tasks, err) = match data {
        Ok(v) => (
            v["boards"].as_array().cloned().unwrap_or_default(),
            v["tasks"].as_array().cloned().unwrap_or_default(),
            None,
        ),
        Err(e) => (vec![], vec![], Some(e)),
    };
    let active_boards: Vec<_> = boards
        .iter()
        .filter(|b| !b["archived"].as_bool().unwrap_or(false))
        .cloned()
        .collect();
    let selected = board_q
        .filter(|s| api::valid_id(s))
        .or_else(|| active_boards.first().and_then(|b| b["id"].as_str()))
        .unwrap_or("");
    let selected_board = active_boards
        .iter()
        .find(|b| b["id"].as_str() == Some(selected));

    let mut board_opts = String::new();
    for board in &active_boards {
        let id = board["id"].as_str().unwrap_or("");
        board_opts.push_str(&html::option(
            id,
            board["name"].as_str().unwrap_or(id),
            id == selected,
        ));
    }
    let mut stage_opts = String::new();
    if let Some(board) = selected_board {
        for stage in board["stages"].as_array().into_iter().flatten() {
            let id = stage["id"].as_str().unwrap_or("");
            let label = format!(
                "{} ({})",
                stage["name"].as_str().unwrap_or(id),
                stage["category"].as_str().unwrap_or("")
            );
            stage_opts.push_str(&html::option(id, &label, false));
        }
    }

    let mut board_list = String::new();
    for board in &boards {
        let id = board["id"].as_str().unwrap_or("");
        let name = board["name"].as_str().unwrap_or(id);
        let stages = board["stages"].as_array().map(|s| s.len()).unwrap_or(0);
        let meta = format!(
            "{id} · {stages} stages{}",
            if board["archived"].as_bool().unwrap_or(false) {
                " · archived"
            } else {
                ""
            }
        );
        board_list.push_str(&html::list_item(name, &meta, ""));
    }
    if board_list.is_empty() {
        board_list.push_str(r#"<li><div class="muted">No boards yet.</div></li>"#);
    }

    let mut task_list = String::new();
    for task in &tasks {
        let id = task["id"].as_str().unwrap_or("");
        let title = task["title"].as_str().unwrap_or(id);
        let owner = task["ownerAgentId"].as_str().unwrap_or("");
        let run = task["activeRunId"].as_str().unwrap_or("");
        let rev = task["revision"].as_u64().unwrap_or(0).to_string();
        let meta = format!(
            "{id} · owner {}{}",
            if owner.is_empty() {
                "none".into()
            } else {
                api::agent_name(&agents, owner)
            },
            if run.is_empty() {
                String::new()
            } else {
                format!(" · run {run}")
            }
        );
        let mut actions = String::new();
        if run.is_empty() && !owner.is_empty() {
            actions.push_str(&html::post_button(
                "/ui/boards/task/start",
                &session.csrf,
                "Start",
                "primary",
                &[("taskId", id), ("revision", &rev)],
            ));
        }
        if !run.is_empty() {
            actions.push_str(&html::post_button(
                "/ui/boards/task/stop",
                &session.csrf,
                "Stop",
                "danger",
                &[("taskId", id)],
            ));
            actions.push_str(&format!(
                r#"<a class="subtle" href="/ui/jobs/{}">Watch</a>"#,
                html::attr(run)
            ));
        }
        actions.push_str(&html::post_button(
            "/ui/boards/task/approve",
            &session.csrf,
            "Approve",
            "subtle",
            &[("taskId", id), ("revision", &rev)],
        ));
        task_list.push_str(&html::list_item(title, &meta, &actions));
    }
    if task_list.is_empty() {
        task_list.push_str(r#"<li><div class="muted">No tasks yet.</div></li>"#);
    }

    let body = format!(
        r#"
    <section class="panel">
      <div class="row between">
        <h1>Boards &amp; tasks</h1>
        <a class="subtle" href="/ui/boards">Refresh</a>
      </div>
      <div class="split">
        <form method="post" action="/ui/boards/create" class="stack card">
          <h2>New board</h2>
          {csrf}
          <label>Name <input name="name" required /></label>
          <label>Description <input name="description" /></label>
          <label>Color
            <select name="color">
              <option>sage</option><option>blue</option><option>amber</option>
              <option>violet</option><option>rose</option><option>teal</option>
            </select>
          </label>
          <button type="submit" class="primary">Create board</button>
        </form>
        <form method="get" action="/ui/boards" class="stack card">
          <h2>Board for new task</h2>
          <label>Board <select name="board">{board_opts}</select></label>
          <button type="submit" class="subtle">Load stages</button>
        </form>
        <form method="post" action="/ui/boards/task" class="stack card">
          <h2>New task</h2>
          {csrf}
          <input type="hidden" name="boardId" value="{selected}" />
          <p class="muted">Board: {selected_name}</p>
          <label>Stage <select name="stageId" required>{stage_opts}</select></label>
          <label>Title <input name="title" required /></label>
          <label>Owner <select name="ownerAgentId">{owners}</select></label>
          <button type="submit" class="primary">Create task</button>
        </form>
      </div>
      <ul class="list">{board_list}</ul>
      <ul class="list">{task_list}</ul>
    </section>"#,
        csrf = html::csrf_field(&session),
        board_opts = board_opts,
        selected = html::attr(selected),
        selected_name = html::esc(selected_board.and_then(|b| b["name"].as_str()).unwrap_or(
            if selected.is_empty() {
                "(none)"
            } else {
                selected
            }
        ),),
        stage_opts = if stage_opts.is_empty() {
            r#"<option value="">No stages</option>"#.into()
        } else {
            stage_opts
        },
        owners = html::agent_options(&agents, &session.agent, Some("Unassigned")),
        board_list = board_list,
        task_list = task_list,
    );
    html::page(Page {
        title: "Boards",
        panel: "boards",
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
    view(
        &app,
        session,
        auth::notice_from_query(&q),
        q.get("board").map(String::as_str),
    )
    .await
}

#[derive(Deserialize)]
pub struct BoardForm {
    pub csrf: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    pub color: String,
}

pub async fn create_board(
    State(app): State<App>,
    headers: HeaderMap,
    Form(form): Form<BoardForm>,
) -> Response {
    let Some(session) = auth::session_from(&app, &headers) else {
        return Redirect::to("/").into_response();
    };
    if let Err((_, msg)) = auth::require_mutation(&headers, &session, &form.csrf) {
        return Redirect::to(&auth::flash_err("/ui/boards", &msg)).into_response();
    }
    match api::call(
        &app,
        Call::CreateBoard,
        Some(json!({
            "name": form.name.trim(),
            "description": form.description.trim(),
            "color": form.color,
        })),
    )
    .await
    {
        Ok(_) => Redirect::to(&auth::flash_ok("/ui/boards", "Board created.")).into_response(),
        Err(e) => Redirect::to(&auth::flash_err("/ui/boards", &e)).into_response(),
    }
}

#[derive(Deserialize)]
pub struct TaskForm {
    pub csrf: String,
    #[serde(rename = "boardId")]
    pub board_id: String,
    #[serde(rename = "stageId")]
    pub stage_id: String,
    pub title: String,
    #[serde(rename = "ownerAgentId", default)]
    pub owner_agent_id: String,
}

pub async fn create_task(
    State(app): State<App>,
    headers: HeaderMap,
    Form(form): Form<TaskForm>,
) -> Response {
    let Some(session) = auth::session_from(&app, &headers) else {
        return Redirect::to("/").into_response();
    };
    if let Err((_, msg)) = auth::require_mutation(&headers, &session, &form.csrf) {
        return Redirect::to(&auth::flash_err("/ui/boards", &msg)).into_response();
    }
    let owner = form.owner_agent_id.trim();
    let payload = json!({
        "boardId": form.board_id.trim(),
        "stageId": form.stage_id.trim(),
        "title": form.title.trim(),
        "ownerAgentId": if owner.is_empty() { serde_json::Value::Null } else { json!(owner) },
    });
    match api::call(&app, Call::CreateTask, Some(payload)).await {
        Ok(_) => Redirect::to(&auth::flash_ok("/ui/boards", "Task created.")).into_response(),
        Err(e) => Redirect::to(&auth::flash_err("/ui/boards", &e)).into_response(),
    }
}

#[derive(Deserialize)]
pub struct TaskAction {
    pub csrf: String,
    #[serde(rename = "taskId")]
    pub task_id: String,
    #[serde(default)]
    pub revision: String,
}

pub async fn start_task(
    State(app): State<App>,
    headers: HeaderMap,
    Form(form): Form<TaskAction>,
) -> Response {
    let Some(session) = auth::session_from(&app, &headers) else {
        return Redirect::to("/").into_response();
    };
    if let Err((_, msg)) = auth::require_mutation(&headers, &session, &form.csrf) {
        return Redirect::to(&auth::flash_err("/ui/boards", &msg)).into_response();
    }
    let rev: u64 = form.revision.parse().unwrap_or(0);
    match api::call(
        &app,
        Call::StartTask(form.task_id.trim()),
        Some(json!({"revision": rev})),
    )
    .await
    {
        Ok(started) => {
            if let Some(id) = started["run"]["id"].as_str() {
                Redirect::to(&auth::flash_ok(&format!("/ui/jobs/{id}"), "Task started."))
                    .into_response()
            } else {
                Redirect::to(&auth::flash_ok("/ui/boards", "Task started.")).into_response()
            }
        }
        Err(e) => Redirect::to(&auth::flash_err("/ui/boards", &e)).into_response(),
    }
}

pub async fn stop_task(
    State(app): State<App>,
    headers: HeaderMap,
    Form(form): Form<TaskAction>,
) -> Response {
    let Some(session) = auth::session_from(&app, &headers) else {
        return Redirect::to("/").into_response();
    };
    if let Err((_, msg)) = auth::require_mutation(&headers, &session, &form.csrf) {
        return Redirect::to(&auth::flash_err("/ui/boards", &msg)).into_response();
    }
    match api::call(&app, Call::StopTask(form.task_id.trim()), None).await {
        Ok(_) => {
            Redirect::to(&auth::flash_ok("/ui/boards", "Task stop requested.")).into_response()
        }
        Err(e) => Redirect::to(&auth::flash_err("/ui/boards", &e)).into_response(),
    }
}

pub async fn approve_task(
    State(app): State<App>,
    headers: HeaderMap,
    Form(form): Form<TaskAction>,
) -> Response {
    let Some(session) = auth::session_from(&app, &headers) else {
        return Redirect::to("/").into_response();
    };
    if let Err((_, msg)) = auth::require_mutation(&headers, &session, &form.csrf) {
        return Redirect::to(&auth::flash_err("/ui/boards", &msg)).into_response();
    }
    let rev: u64 = form.revision.parse().unwrap_or(0);
    match api::call(
        &app,
        Call::ApproveTask(form.task_id.trim()),
        Some(json!({"revision": rev})),
    )
    .await
    {
        Ok(_) => Redirect::to(&auth::flash_ok("/ui/boards", "Task approved.")).into_response(),
        Err(e) => Redirect::to(&auth::flash_err("/ui/boards", &e)).into_response(),
    }
}
