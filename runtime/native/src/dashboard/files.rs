use super::{
    api::{self, Call},
    auth::{self, Session},
    html::{self, Page},
};
use crate::App;
use axum::{
    Form,
    extract::{Multipart, Query, State, multipart::Field},
    http::{HeaderMap, HeaderValue, StatusCode, header},
    response::{IntoResponse, Redirect, Response},
};
use base64::{Engine, engine::general_purpose::STANDARD};
use serde::Deserialize;
use serde_json::json;
use std::collections::HashMap;

const MAX_FILES: usize = 40;
const MAX_FILE_BYTES: usize = 1_000_000;
pub const MAX_UPLOAD_BODY: usize = MAX_FILES * MAX_FILE_BYTES + 100_000;

fn download_link(scope: &str, agent: &str, name: &str) -> String {
    let href = format!(
        "/ui/files/download?scope={}&agent={}&name={}",
        auth::enc_query(scope),
        auth::enc_query(agent),
        auth::enc_query(name)
    );
    format!(
        r#"<a class="subtle" href="{}" download="{}">Download</a>"#,
        html::attr(&href),
        html::attr(name)
    )
}

pub struct Draft {
    pub name: String,
    pub content: String,
}

pub async fn view(
    app: &App,
    session: Session,
    notice: Option<(String, String)>,
    scope: &str,
    agent_id: &str,
    open: Option<&str>,
    draft: Option<Draft>,
) -> Response {
    let scope = if api::valid_scope(scope) {
        scope
    } else {
        "shared"
    };
    let agents = api::call(app, Call::Agents, None)
        .await
        .map(|v| api::agents_list(&v))
        .unwrap_or_default();
    let agent = if api::valid_id(agent_id) {
        agent_id.to_owned()
    } else if api::valid_id(&session.agent) {
        session.agent.clone()
    } else {
        agents
            .first()
            .and_then(|a| a["id"].as_str())
            .unwrap_or("")
            .to_owned()
    };
    let agent_opt = if scope == "private" && !agent.is_empty() {
        Some(agent.as_str())
    } else {
        None
    };
    let data = if scope == "private" && agent_opt.is_none() {
        Err("Select an agent for private files.".into())
    } else {
        api::call(
            app,
            Call::Files {
                scope,
                agent: agent_opt,
            },
            None,
        )
        .await
    };
    let (files, err) = match data {
        Ok(v) => (v["files"].as_array().cloned().unwrap_or_default(), None),
        Err(e) => (vec![], Some(e)),
    };
    let mut list = String::new();
    for file in &files {
        let name = file["name"].as_str().unwrap_or("");
        let meta = format!(
            "{} bytes · {}",
            file["size"].as_u64().unwrap_or(0),
            file["updatedAt"].as_str().unwrap_or("")
        );
        let open_href = format!(
            "/ui/files?scope={}&agent={}&open={}",
            auth::enc_query(scope),
            auth::enc_query(&agent),
            auth::enc_query(name)
        );
        let mut actions = String::new();
        if file["encoding"] == "utf8" {
            actions.push_str(&format!(
                r#"<a class="subtle" href="{}">Open</a>"#,
                html::attr(&open_href)
            ));
        }
        actions.push_str(&download_link(scope, &agent, name));
        actions.push_str(&html::post_button(
            "/ui/files/delete",
            &session.csrf,
            "Delete",
            "danger",
            &[
                ("name", name),
                ("scope", scope),
                ("agentId", agent.as_str()),
            ],
        ));
        list.push_str(&html::list_item(name, &meta, &actions));
    }
    if list.is_empty() {
        let empty = if scope == "private" {
            "No private files for this agent."
        } else {
            "No shared files."
        };
        list.push_str(&format!(r#"<li><div class="muted">{empty}</div></li>"#));
    }

    let mut edit_name = draft.as_ref().map(|d| d.name.clone()).unwrap_or_default();
    let mut edit_content = draft
        .as_ref()
        .map(|d| d.content.clone())
        .unwrap_or_default();
    let mut view_block = String::new();
    let mut open_err = None;
    if draft.is_none()
        && let Some(name) = open.filter(|s| api::valid_file_name(s))
        && !(scope == "private" && agent_opt.is_none())
    {
        match api::call(
            app,
            Call::File {
                scope,
                agent: agent_opt,
                name,
            },
            None,
        )
        .await
        {
            Ok(body) => {
                if body["encoding"] == "base64" {
                    view_block = format!(
                        r#"<p>{} contains binary data. {}</p>"#,
                        html::esc(name),
                        download_link(scope, &agent, name)
                    );
                } else {
                    edit_name = name.to_owned();
                    edit_content = body["content"].as_str().unwrap_or("").to_owned();
                }
            }
            Err(e) => open_err = Some(e),
        }
    }

    let shared_selected = if scope == "shared" { " selected" } else { "" };
    let private_selected = if scope == "private" { " selected" } else { "" };
    let body = format!(
        r#"
    <section class="panel">
      <div class="row between">
        <h1>Files</h1>
        <a class="subtle" href="/ui/files?scope={scope_q}&amp;agent={agent_q}">Refresh</a>
      </div>
      <form method="get" action="/ui/files" class="stack card">
        <label>Scope
          <select name="scope">
            <option value="shared"{shared}>Shared workspace</option>
            <option value="private"{private}>Agent private</option>
          </select>
        </label>
        <label>Agent <select name="agent">{agent_opts}</select></label>
        <button type="submit" class="subtle">Browse</button>
      </form>
      <form id="upload" method="post" action="/ui/files/upload" enctype="multipart/form-data" class="stack card">
        <h2>Upload</h2>
        {csrf}
        <input type="hidden" name="scope" value="{scope}" />
        <input type="hidden" name="agentId" value="{agent}" />
        <label>Choose files (up to 1 MB each)
          <input type="file" name="file" multiple required {disabled} />
        </label>
        <button type="submit" class="primary" {disabled}>Upload files</button>
      </form>
      <form method="post" action="/ui/files/save" class="stack card">
        <h2>Write</h2>
        {csrf}
        <input type="hidden" name="scope" value="{scope}" />
        <input type="hidden" name="agentId" value="{agent}" />
        <label>Name <input name="name" required value="{name}" /></label>
        <label>Content <textarea name="content" rows="6" maxlength="1000000">{content}</textarea></label>
        <button type="submit" class="primary" {disabled}>Save file</button>
      </form>
      <ul class="list">{list}</ul>
      {view}
    </section>"#,
        scope_q = auth::enc_query(scope),
        agent_q = auth::enc_query(&agent),
        shared = shared_selected,
        private = private_selected,
        agent_opts = html::agent_options(&agents, &agent, None),
        csrf = html::csrf_field(&session),
        scope = html::attr(scope),
        agent = html::attr(&agent),
        name = html::attr(&edit_name),
        content = html::esc(&edit_content),
        disabled = if scope == "private" && agent.is_empty() {
            "disabled"
        } else {
            ""
        },
        list = list,
        view = view_block,
    );
    html::page(Page {
        title: "Files",
        panel: "files",
        status: auth::status_line(app),
        notice: err.or(open_err).map(|e| (e, "error".into())).or(notice),
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
    let scope = q.get("scope").map(String::as_str).unwrap_or("shared");
    let agent = session.agent.clone();
    let mut res = view(
        &app,
        session.clone(),
        auth::notice_from_query(&q),
        scope,
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

fn same_origin(headers: &HeaderMap) -> bool {
    !headers
        .get("sec-fetch-site")
        .is_some_and(|v| v == "cross-site" || v == "same-site")
        && (!headers.contains_key(header::ORIGIN) || auth::origin_matches_host(headers))
}

fn scoped_agent<'a>(scope: &str, agent: &'a str) -> Result<Option<&'a str>, &'static str> {
    match scope {
        "shared" => Ok(None),
        "private" if api::valid_id(agent) => Ok(Some(agent)),
        "private" => Err("Select an agent for private files."),
        _ => Err("Invalid workspace scope."),
    }
}

#[derive(Default)]
struct UploadForm {
    csrf: Option<String>,
    scope: Option<String>,
    agent: Option<String>,
    files: Vec<(String, Vec<u8>)>,
    skipped: Vec<String>,
}

async fn limited_part(mut field: Field<'_>, limit: usize) -> Result<Option<Vec<u8>>, String> {
    let mut data = Vec::new();
    while let Some(bytes) = field.chunk().await.map_err(|e| e.body_text())? {
        if bytes.len() > limit - data.len() {
            return Ok(None);
        }
        data.extend_from_slice(&bytes);
    }
    Ok(Some(data))
}

async fn upload_form(mut multipart: Multipart) -> Result<UploadForm, String> {
    let mut form = UploadForm::default();
    while let Some(field) = multipart.next_field().await.map_err(|e| e.body_text())? {
        let slot = match field.name() {
            Some("file") => {
                if form.files.len() + form.skipped.len() == MAX_FILES {
                    return Err(format!("Choose up to {MAX_FILES} files at a time."));
                }
                let Some(name) = field
                    .file_name()
                    .filter(|s| api::valid_file_name(s))
                    .map(str::to_owned)
                else {
                    form.skipped.push("Choose a file with a valid name.".into());
                    continue;
                };
                match limited_part(field, MAX_FILE_BYTES).await? {
                    Some(data) => form.files.push((name, data)),
                    None => form.skipped.push(format!("{name} exceeds the 1 MB limit.")),
                }
                continue;
            }
            Some("csrf") => &mut form.csrf,
            Some("scope") => &mut form.scope,
            Some("agentId") => &mut form.agent,
            _ => return Err("Unexpected upload field.".into()),
        };
        if slot.is_some() {
            return Err("Repeated upload form field.".into());
        }
        let bytes = limited_part(field, 256)
            .await?
            .ok_or("Upload form field is too long.")?;
        *slot = Some(String::from_utf8(bytes).map_err(|_| "Invalid upload form field.")?);
    }
    Ok(form)
}

pub async fn upload(State(app): State<App>, headers: HeaderMap, multipart: Multipart) -> Response {
    let Some(mut session) = auth::session_from(&app, &headers) else {
        return (StatusCode::UNAUTHORIZED, "Sign in to upload files.").into_response();
    };
    if !same_origin(&headers) {
        return html::forbidden("Open the dashboard to upload files.");
    }
    let mut form = match upload_form(multipart).await {
        Ok(form) => form,
        Err(e) => return Redirect::to(&auth::flash_err("/ui/files", &e)).into_response(),
    };
    if form.csrf.as_deref() != Some(&session.csrf) {
        return html::forbidden("This form could not be verified. Reload the page and try again.");
    }
    let scope = form.scope.as_deref().unwrap_or("");
    let agent = form.agent.as_deref().unwrap_or("");
    let agent_opt = match scoped_agent(scope, agent) {
        Ok(agent) => agent,
        Err(e) => return Redirect::to(&auth::flash_err("/ui/files", e)).into_response(),
    };
    if api::valid_id(agent) {
        session.agent = agent.to_owned();
    }
    let dest = format!("/ui/files?scope={scope}&agent={}", auth::enc_query(agent));
    let mut saved = Vec::new();
    for (name, bytes) in form.files {
        let input = json!({
            "name": name,
            "encoding": "base64",
            "content": STANDARD.encode(bytes),
            "createOnly": true,
        });
        match api::call(
            &app,
            Call::SaveFile {
                scope,
                agent: agent_opt,
            },
            Some(input),
        )
        .await
        {
            Ok(_) => saved.push(name),
            Err(e) => {
                let reason = e.strip_prefix("Conflict: ").unwrap_or(&e);
                form.skipped.push(format!("Skipped {name}. {reason}"));
            }
        }
    }
    let mut messages = Vec::new();
    match saved.as_slice() {
        [] => (),
        [name] => messages.push(format!("Uploaded {name}.")),
        files => messages.push(format!("Uploaded {} files.", files.len())),
    }
    let location = if let Some(first) = form.skipped.first() {
        if form.skipped.len() > 1 {
            messages.push(format!("{} files were skipped.", form.skipped.len()));
        }
        messages.push(first.clone());
        auth::flash_err(&dest, &messages.join(" "))
    } else if saved.is_empty() {
        auth::flash_err(&dest, "Choose a file to upload.")
    } else {
        auth::flash_ok(&dest, &messages.join(" "))
    };
    match auth::set_cookie_header(&app, &session) {
        Ok(cookie) => html::redirect_with_cookie(&location, cookie),
        Err(_) => Redirect::to(&location).into_response(),
    }
}

#[derive(Deserialize)]
pub struct DownloadQuery {
    #[serde(default = "default_shared")]
    scope: String,
    #[serde(default, alias = "agentId")]
    agent: String,
    name: String,
}

pub async fn download(
    State(app): State<App>,
    headers: HeaderMap,
    Query(q): Query<DownloadQuery>,
) -> Response {
    if auth::session_from(&app, &headers).is_none() {
        return (StatusCode::UNAUTHORIZED, "Sign in to download files.").into_response();
    }
    if !same_origin(&headers) {
        return html::forbidden("Open the dashboard to download files.");
    }
    let agent = match scoped_agent(&q.scope, &q.agent) {
        Ok(agent) => agent,
        Err(e) => return (StatusCode::BAD_REQUEST, e).into_response(),
    };
    let file = match api::call(
        &app,
        Call::File {
            scope: &q.scope,
            agent,
            name: &q.name,
        },
        None,
    )
    .await
    {
        Ok(file) => file,
        Err(e) => {
            let status = if e == "File not found." {
                StatusCode::NOT_FOUND
            } else {
                StatusCode::BAD_REQUEST
            };
            return (status, e).into_response();
        }
    };
    let Some(content) = file["content"].as_str() else {
        return (
            StatusCode::BAD_GATEWAY,
            "The workspace returned an incomplete file.",
        )
            .into_response();
    };
    let bytes = match file["encoding"].as_str() {
        Some("utf8") => content.as_bytes().to_vec(),
        Some("base64") => match STANDARD.decode(content) {
            Ok(bytes) => bytes,
            Err(_) => {
                return (
                    StatusCode::BAD_GATEWAY,
                    "The workspace returned invalid file data.",
                )
                    .into_response();
            }
        },
        _ => return (StatusCode::BAD_GATEWAY, "Unknown workspace file encoding.").into_response(),
    };
    let mime = file["mimeType"]
        .as_str()
        .and_then(|mime| HeaderValue::from_str(mime).ok())
        .unwrap_or(HeaderValue::from_static("application/octet-stream"));
    let Ok(disposition) = HeaderValue::from_str(&format!("attachment; filename=\"{}\"", q.name))
    else {
        return (StatusCode::BAD_REQUEST, "Invalid file name.").into_response();
    };
    (
        [
            (header::CONTENT_DISPOSITION, disposition),
            (header::CONTENT_TYPE, mime),
        ],
        bytes,
    )
        .into_response()
}

#[derive(Deserialize)]
pub struct SaveForm {
    pub csrf: String,
    #[serde(default = "default_shared")]
    pub scope: String,
    #[serde(rename = "agentId", default)]
    pub agent_id: String,
    pub name: String,
    #[serde(default)]
    pub content: String,
}

fn default_shared() -> String {
    "shared".into()
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
        return Redirect::to(&auth::flash_err("/ui/files", &msg)).into_response();
    }
    let scope = if api::valid_scope(form.scope.trim()) {
        form.scope.trim()
    } else {
        "shared"
    };
    let agent = form.agent_id.trim();
    if api::valid_id(agent) {
        session.agent = agent.to_owned();
    }
    let agent_opt = if scope == "private" {
        if !api::valid_id(agent) {
            return Redirect::to(&auth::flash_err(
                "/ui/files?scope=private",
                "Select an agent for private files.",
            ))
            .into_response();
        }
        Some(agent)
    } else {
        None
    };
    let dest = format!(
        "/ui/files?scope={}&agent={}",
        auth::enc_query(scope),
        auth::enc_query(agent)
    );
    match api::call(
        &app,
        Call::SaveFile {
            scope,
            agent: agent_opt,
        },
        Some(json!({
            "name": form.name.trim(),
            "content": form.content,
            "createOnly": false,
        })),
    )
    .await
    {
        Ok(_) => {
            let dest = auth::flash_ok(&dest, "File saved.");
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
                scope,
                agent,
                None,
                Some(Draft {
                    name: form.name.trim().to_owned(),
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
    pub name: String,
    #[serde(default = "default_shared")]
    pub scope: String,
    #[serde(rename = "agentId", default)]
    pub agent_id: String,
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
        return Redirect::to(&auth::flash_err("/ui/files", &msg)).into_response();
    }
    let scope = if api::valid_scope(form.scope.trim()) {
        form.scope.trim()
    } else {
        "shared"
    };
    let agent = form.agent_id.trim();
    if api::valid_id(agent) {
        session.agent = agent.to_owned();
    }
    let agent_opt = if scope == "private" {
        Some(agent)
    } else {
        None
    };
    let dest = format!(
        "/ui/files?scope={}&agent={}",
        auth::enc_query(scope),
        auth::enc_query(agent)
    );
    match api::call(
        &app,
        Call::DeleteFile {
            scope,
            agent: agent_opt,
            name: form.name.trim(),
        },
        None,
    )
    .await
    {
        Ok(_) => {
            let dest = auth::flash_ok(&dest, "File deleted.");
            match auth::set_cookie_header(&app, &session) {
                Ok(c) => html::redirect_with_cookie(&dest, c),
                Err(_) => Redirect::to(&dest).into_response(),
            }
        }
        Err(e) => Redirect::to(&auth::flash_err(&dest, &e)).into_response(),
    }
}
