//! Server-rendered operator dashboard: session auth, POST forms, PRG, no required JS.
mod agents;
mod api;
mod auth;
mod boards;
mod credentials;
mod files;
mod html;
mod jobs;
mod machines;
mod memory;
mod profile;
mod routines;
mod skills;
mod teams;

use crate::App;
use axum::{
    Form, Router,
    extract::{ConnectInfo, DefaultBodyLimit, State},
    http::HeaderMap,
    response::{IntoResponse, Redirect, Response},
    routing::{get, post},
};
use serde::Deserialize;
use std::net::SocketAddr;

pub fn router() -> Router<App> {
    Router::new()
        .route("/", get(entry).post(sign_in))
        .route("/assets/dashboard.css", get(css))
        .route("/ui/signout", post(sign_out))
        .route("/ui/agents", get(agents::get))
        .route("/ui/agents/create", post(agents::create))
        .route("/ui/agents/select", post(agents::select))
        .route("/ui/jobs", get(jobs::get))
        .route("/ui/jobs/{id}", get(jobs::watch))
        .route("/ui/jobs/submit", post(jobs::submit))
        .route("/ui/jobs/stop", post(jobs::stop))
        .route("/ui/jobs/stop-all", post(jobs::stop_all))
        .route("/ui/jobs/approval", post(jobs::approval))
        .route("/ui/profile", get(profile::get))
        .route("/ui/profile/workspace", post(profile::save_workspace))
        .route("/ui/profile/agent", post(profile::save_agent_raw))
        .route(
            "/ui/profile/install-harness",
            post(profile::install_harness),
        )
        .route("/ui/memory", get(memory::get))
        .route("/ui/memory/save", post(memory::save))
        .route("/ui/skills", get(skills::get))
        .route("/ui/skills/save", post(skills::save))
        .route("/ui/skills/delete", post(skills::delete))
        .route("/ui/credentials", get(credentials::get))
        .route("/ui/credentials/create", post(credentials::create))
        .route(
            "/ui/credentials/rotate-form",
            post(credentials::rotate_form),
        )
        .route("/ui/credentials/rotate", post(credentials::rotate))
        .route("/ui/credentials/delete", post(credentials::delete))
        .route("/ui/teams", get(teams::get))
        .route("/ui/teams/create", post(teams::create))
        .route("/ui/teams/retire", post(teams::retire))
        .route("/ui/boards", get(boards::get))
        .route("/ui/boards/create", post(boards::create_board))
        .route("/ui/boards/task", post(boards::create_task))
        .route("/ui/boards/task/start", post(boards::start_task))
        .route("/ui/boards/task/stop", post(boards::stop_task))
        .route("/ui/boards/task/approve", post(boards::approve_task))
        .route("/ui/routines", get(routines::get))
        .route("/ui/routines/create", post(routines::create))
        .route("/ui/routines/run", post(routines::run_now))
        .route("/ui/routines/toggle", post(routines::toggle))
        .route("/ui/routines/delete", post(routines::delete))
        .route("/ui/files", get(files::get))
        .route(
            "/ui/files/upload",
            post(files::upload).layer(DefaultBodyLimit::max(files::MAX_UPLOAD_BODY)),
        )
        .route("/ui/files/download", get(files::download))
        .route("/ui/files/save", post(files::save))
        .route("/ui/files/delete", post(files::delete))
        .route("/ui/machines", get(machines::get))
        .route("/ui/machines/pair", post(machines::pair))
        .route("/ui/machines/test", post(machines::test))
        .route("/ui/machines/reconnect", post(machines::reconnect))
        .route("/ui/machines/revoke", post(machines::revoke))
        .route("/ui/machines/transfer", post(machines::transfer))
}

async fn css() -> impl IntoResponse {
    html::asset(
        "text/css; charset=utf-8",
        include_str!("dashboard/dashboard.css"),
    )
}

async fn entry(
    State(app): State<App>,
    headers: HeaderMap,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
) -> Response {
    if auth::session_from(&app, &headers).is_some() {
        return Redirect::to("/ui/agents").into_response();
    }
    let can_auto = auth::loopback_peer(Some(addr)) && auth::loopback_host(&headers);
    if can_auto {
        let session = auth::new_session("");
        match auth::set_cookie_header(&app, &session) {
            Ok(cookie) => return html::redirect_with_cookie("/ui/agents", cookie),
            Err(e) => {
                return html::sign_in(Some((e, "error".into())), true).into_response();
            }
        }
    }
    html::sign_in(None, false).into_response()
}

#[derive(Deserialize)]
struct SignInForm {
    #[serde(default)]
    token: String,
}

async fn sign_in(
    State(app): State<App>,
    headers: HeaderMap,
    ConnectInfo(addr): ConnectInfo<SocketAddr>,
    Form(form): Form<SignInForm>,
) -> Response {
    if !auth::origin_matches_host(&headers) && headers.contains_key(axum::http::header::ORIGIN) {
        return html::forbidden("Cross-origin sign-in is not allowed.").into_response();
    }
    let loopback = auth::loopback_peer(Some(addr)) && auth::loopback_host(&headers);
    let token = form.token.trim();
    let ok = if token.is_empty() {
        // Empty password: auto local entry only on loopback peer+host.
        loopback
    } else {
        auth::token_matches(&app, token)
    };
    if !ok {
        return html::sign_in(
            Some((
                "That token did not match. Paste the CLI control token.".into(),
                "error".into(),
            )),
            loopback,
        )
        .into_response();
    }
    // Never send the controller credential to the browser; session is a separate keyed cookie.
    let session = auth::new_session("");
    match auth::set_cookie_header(&app, &session) {
        Ok(cookie) => html::redirect_with_cookie("/ui/agents", cookie),
        Err(e) => html::sign_in(Some((e, "error".into())), loopback).into_response(),
    }
}

async fn sign_out(
    State(app): State<App>,
    headers: HeaderMap,
    Form(form): Form<std::collections::HashMap<String, String>>,
) -> Response {
    if let Some(session) = auth::session_from(&app, &headers) {
        let csrf = form.get("csrf").map(String::as_str).unwrap_or("");
        if let Err(error) = auth::require_mutation(&headers, &session, csrf) {
            return html::forbidden(&error.1).into_response();
        }
    }
    let mut res = Redirect::to("/").into_response();
    res.headers_mut()
        .insert(axum::http::header::SET_COOKIE, auth::clear_cookie_header());
    res
}
