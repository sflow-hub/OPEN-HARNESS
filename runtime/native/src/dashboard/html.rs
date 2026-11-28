//! Escaped HTML helpers and shared chrome for the operator dashboard.
use super::auth::Session;
use axum::http::{HeaderValue, StatusCode, header};
use axum::response::{Html, IntoResponse, Redirect, Response};
use open_harness_runner::harnesses::{HARNESSES, MODEL_PROVIDERS};
use serde_json::Value;

pub fn esc(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#39;"),
            _ => out.push(c),
        }
    }
    out
}

pub fn attr(s: &str) -> String {
    esc(s)
}

const TABS: &[(&str, &str)] = &[
    ("agents", "Agents"),
    ("jobs", "Jobs"),
    ("profile", "Profile"),
    ("memory", "Memory"),
    ("skills", "Skills"),
    ("credentials", "Credentials"),
    ("teams", "Teams"),
    ("boards", "Boards"),
    ("routines", "Routines"),
    ("files", "Files"),
    ("machines", "Machines"),
];

pub struct Page {
    pub title: &'static str,
    pub panel: &'static str,
    pub status: String,
    pub notice: Option<(String, String)>,
    pub session: Session,
    pub body: String,
    pub refresh: Option<u32>,
}

pub fn page(p: Page) -> Html<String> {
    let mut tabs = String::new();
    for (id, label) in TABS {
        let active = if *id == p.panel { " active" } else { "" };
        tabs.push_str(&format!(
            r#"<a class="tab{active}" href="/ui/{id}">{label}</a>"#
        ));
    }
    let notice = p
        .notice
        .as_ref()
        .map(|(msg, kind)| {
            let class = if kind.is_empty() {
                "notice".into()
            } else {
                format!("notice {kind}")
            };
            format!(r#"<p class="{class}" role="status">{}</p>"#, esc(msg))
        })
        .unwrap_or_default();
    let refresh = p
        .refresh
        .map(|n| format!(r#"<meta http-equiv="refresh" content="{n}" />"#))
        .unwrap_or_default();
    let csrf = esc(&p.session.csrf);
    Html(format!(
        r#"<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>{title} · Open Harness</title>
  <link rel="stylesheet" href="/assets/dashboard.css" />
  {refresh}
</head>
<body>
  <header class="top">
    <div class="brand">
      <strong>Open Harness</strong>
      <span class="muted">{status}</span>
    </div>
    <nav class="tabs" aria-label="Sections">{tabs}</nav>
    <form method="post" action="/ui/signout" class="row">
      <input type="hidden" name="csrf" value="{csrf}" />
      <button type="submit" class="subtle">Sign out</button>
    </form>
  </header>
  <main>
    {notice}
    {body}
  </main>
</body>
</html>"#,
        title = esc(p.title),
        status = esc(&p.status),
        body = p.body,
    ))
}

pub fn sign_in(notice: Option<(String, String)>, can_auto: bool) -> Html<String> {
    let notice = notice
        .as_ref()
        .map(|(msg, kind)| {
            let class = if kind.is_empty() {
                "notice".into()
            } else {
                format!("notice {kind}")
            };
            format!(r#"<p class="{class}" role="status">{}</p>"#, esc(msg))
        })
        .unwrap_or_default();
    let hint = if can_auto {
        "<p class=\"muted\">This browser is on the coordinator machine. Submit without a token to enter, or paste the CLI token.</p>"
    } else {
        "<p class=\"muted\">Paste the CLI control token to enter. Automatic entry is only available from loopback on this host.</p>"
    };
    Html(format!(
        r#"<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Open Harness</title>
  <link rel="stylesheet" href="/assets/dashboard.css" />
</head>
<body>
  <main class="signin">
    <h1>Open Harness</h1>
    {notice}
    {hint}
    <form method="post" action="/" class="stack card">
      <label>CLI token
        <input name="token" type="password" autocomplete="current-password" />
      </label>
      <button type="submit" class="primary">Enter</button>
    </form>
  </main>
</body>
</html>"#
    ))
}

pub fn redirect_with_cookie(to: &str, cookie: HeaderValue) -> Response {
    let mut res = Redirect::to(to).into_response();
    res.headers_mut().insert(header::SET_COOKIE, cookie);
    res
}

pub fn forbidden(message: &str) -> Response {
    (
        StatusCode::FORBIDDEN,
        Html(format!(
            "<!DOCTYPE html><html><body><p>{}</p><p><a href=\"/\">Back</a></p></body></html>",
            esc(message)
        )),
    )
        .into_response()
}

pub fn csrf_field(session: &Session) -> String {
    format!(
        r#"<input type="hidden" name="csrf" value="{}" />"#,
        attr(&session.csrf)
    )
}

pub fn option(value: &str, label: &str, selected: bool) -> String {
    format!(
        r#"<option value="{}"{}>{}</option>"#,
        attr(value),
        if selected { " selected" } else { "" },
        esc(label)
    )
}

pub fn harness_options(selected: &str) -> String {
    HARNESSES
        .iter()
        .map(|harness| {
            option(
                harness.id,
                harness.name,
                selected == harness.id || (selected.is_empty() && harness.id == "hermes"),
            )
        })
        .collect()
}

pub async fn model_connection_options(app: &crate::App) -> String {
    let providers: String = MODEL_PROVIDERS
        .iter()
        .map(|provider| {
            let label = match *provider {
                "openai" => "OpenAI",
                "anthropic" => "Anthropic",
                "xai" => "xAI",
                "openrouter" => "OpenRouter",
                "local" => "Local",
                _ => "Custom",
            };
            option(provider, label, false)
        })
        .collect();
    let credentials = super::api::call(app, super::api::Call::Credentials, None)
        .await
        .unwrap_or(Value::Null);
    let references: String = credentials["credentials"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|entry| entry["present"] == true)
        .filter_map(|entry| {
            let reference = entry["ref"].as_str()?;
            Some(option(
                reference,
                entry["label"].as_str().unwrap_or(reference),
                false,
            ))
        })
        .collect();
    format!(
        r#"<datalist id="model-providers">{providers}</datalist><datalist id="model-credentials">{references}</datalist>"#
    )
}

pub fn agent_options(agents: &[serde_json::Value], selected: &str, empty: Option<&str>) -> String {
    let mut out = String::new();
    if let Some(label) = empty {
        out.push_str(&option("", label, selected.is_empty()));
    }
    for agent in agents {
        let id = agent["id"].as_str().unwrap_or("");
        let name = agent["name"].as_str().unwrap_or(id);
        let harness = agent["profile"]["harness"]
            .as_str()
            .or_else(|| agent["harness"].as_str())
            .unwrap_or("hermes");
        let label = format!("{} · {}", name, super::api::harness_label(harness));
        out.push_str(&option(id, &label, id == selected));
    }
    out
}

pub fn machine_options(machines: &[serde_json::Value], selected: &str) -> String {
    let selected = if selected.is_empty() {
        "local"
    } else {
        selected
    };
    let mut out = option("local", "This computer · local", selected == "local");
    for machine in machines {
        let id = machine["id"].as_str().unwrap_or("");
        if id.is_empty() || id == "local" {
            continue;
        }
        let name = machine["name"].as_str().unwrap_or(id);
        let status = machine["status"]
            .as_str()
            .or_else(|| machine["connection"].as_str())
            .unwrap_or("unknown");
        let platform = machine["platform"].as_str().unwrap_or("");
        let label = format!("{name} · {id} · {status} · {platform}");
        out.push_str(&option(id, &label, id == selected));
    }
    if selected != "local" && !machines.iter().any(|m| m["id"].as_str() == Some(selected)) {
        out.push_str(&option(selected, &format!("{selected} · current"), true));
    }
    out
}

pub fn list_item(title: &str, meta: &str, actions: &str) -> String {
    format!(
        r#"<li><div><strong>{}</strong><div class="meta">{}</div></div><div class="actions">{}</div></li>"#,
        esc(title),
        esc(meta),
        actions
    )
}

pub fn post_button(
    action: &str,
    csrf: &str,
    label: &str,
    class: &str,
    fields: &[(&str, &str)],
) -> String {
    let mut hidden = format!(
        r#"<input type="hidden" name="csrf" value="{}" />"#,
        attr(csrf)
    );
    for (k, v) in fields {
        hidden.push_str(&format!(
            r#"<input type="hidden" name="{}" value="{}" />"#,
            attr(k),
            attr(v)
        ));
    }
    format!(
        r#"<form method="post" action="{action}" class="inline">{hidden}<button type="submit" class="{class}">{label}</button></form>"#,
        label = esc(label)
    )
}

pub fn asset(content_type: &'static str, body: &'static str) -> impl IntoResponse {
    (
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, HeaderValue::from_static(content_type)),
            (header::CACHE_CONTROL, HeaderValue::from_static("no-store")),
            (
                header::X_CONTENT_TYPE_OPTIONS,
                HeaderValue::from_static("nosniff"),
            ),
        ],
        body,
    )
}

#[cfg(test)]
mod tests {
    use super::{esc, machine_options};
    use serde_json::json;

    #[test]
    fn escapes_markup() {
        assert_eq!(esc(r#"<a href="x">&"#), "&lt;a href=&quot;x&quot;&gt;&amp;");
    }

    #[test]
    fn machine_options_include_local_and_selection() {
        let machines = vec![json!({"id":"m1","name":"VPS","status":"online","platform":"linux"})];
        let html = machine_options(&machines, "m1");
        assert!(html.contains("value=\"local\""));
        assert!(html.contains("value=\"m1\" selected"));
    }
}
