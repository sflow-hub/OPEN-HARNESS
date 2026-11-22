//! Same-origin dashboard sessions: loopback auto-entry or CLI token password.
use crate::App;
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use openssl::{hash::MessageDigest, memcmp, pkey::PKey, sign::Signer};
use serde::{Deserialize, Serialize};
use std::net::{IpAddr, SocketAddr};
use uuid::Uuid;

pub const COOKIE: &str = "oh_session";
const TTL_SECS: i64 = 12 * 60 * 60;

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Session {
    pub exp: i64,
    pub csrf: String,
    #[serde(default)]
    pub agent: String,
}

pub fn loopback_peer(addr: Option<SocketAddr>) -> bool {
    addr.map(|a| match a.ip() {
        IpAddr::V4(v) => v.is_loopback(),
        IpAddr::V6(v) => v.is_loopback() || v.to_ipv4_mapped().is_some_and(|m| m.is_loopback()),
    })
    .unwrap_or(false)
}

pub fn loopback_host(headers: &HeaderMap) -> bool {
    let Some(raw) = headers.get(header::HOST).and_then(|v| v.to_str().ok()) else {
        return false;
    };
    crate::server::loopback_host(raw)
}

pub fn origin_matches_host(headers: &HeaderMap) -> bool {
    let Some(host) = headers.get(header::HOST).and_then(|v| v.to_str().ok()) else {
        return false;
    };
    let Some(origin) = headers.get(header::ORIGIN).and_then(|v| v.to_str().ok()) else {
        return false;
    };
    if origin == "null" {
        return false;
    }
    let Ok(url) = reqwest::Url::parse(origin) else {
        return false;
    };
    let Some(o_host) = url.host_str() else {
        return false;
    };
    let origin_host = match url.port() {
        Some(p) => format!("{o_host}:{p}"),
        None => o_host.to_owned(),
    };
    origin_host.eq_ignore_ascii_case(host)
}

pub fn token_matches(app: &App, offered: &str) -> bool {
    let expect = app.token.as_str();
    if offered.len() != expect.len() || offered.is_empty() {
        return false;
    }
    memcmp::eq(offered.as_bytes(), expect.as_bytes())
}

pub fn new_session(agent: impl Into<String>) -> Session {
    Session {
        exp: chrono::Utc::now().timestamp() + TTL_SECS,
        csrf: Uuid::new_v4().to_string(),
        agent: agent.into(),
    }
}

fn signing_key(app: &App) -> Result<PKey<openssl::pkey::Private>, String> {
    let mut material = Vec::with_capacity(app.token.len() + 24);
    material.extend_from_slice(b"open-harness-dashboard-v1:");
    material.extend_from_slice(app.token.as_bytes());
    PKey::hmac(&material).map_err(|e| e.to_string())
}

fn sign(app: &App, payload: &[u8]) -> Result<Vec<u8>, String> {
    let key = signing_key(app)?;
    let mut signer = Signer::new(MessageDigest::sha256(), &key).map_err(|e| e.to_string())?;
    signer.update(payload).map_err(|e| e.to_string())?;
    signer.sign_to_vec().map_err(|e| e.to_string())
}

pub fn encode_cookie(app: &App, session: &Session) -> Result<String, String> {
    let body = serde_json::to_vec(session).map_err(|e| e.to_string())?;
    let sig = sign(app, &body)?;
    Ok(format!(
        "v1.{}.{}",
        URL_SAFE_NO_PAD.encode(body),
        URL_SAFE_NO_PAD.encode(sig)
    ))
}

pub fn decode_cookie(app: &App, raw: &str) -> Option<Session> {
    let rest = raw.strip_prefix("v1.")?;
    let (body_b64, sig_b64) = rest.split_once('.')?;
    let body = URL_SAFE_NO_PAD.decode(body_b64).ok()?;
    let sig = URL_SAFE_NO_PAD.decode(sig_b64).ok()?;
    let expect = sign(app, &body).ok()?;
    if expect.len() != sig.len() || !memcmp::eq(&expect, &sig) {
        return None;
    }
    let session: Session = serde_json::from_slice(&body).ok()?;
    if session.exp < chrono::Utc::now().timestamp() || session.csrf.is_empty() {
        return None;
    }
    Some(session)
}

pub fn read_cookie(headers: &HeaderMap) -> Option<String> {
    let cookie = headers.get(header::COOKIE)?.to_str().ok()?;
    for part in cookie.split(';') {
        let part = part.trim();
        if let Some(v) = part.strip_prefix(COOKIE).and_then(|s| s.strip_prefix('=')) {
            return Some(v.to_owned());
        }
    }
    None
}

pub fn session_from(app: &App, headers: &HeaderMap) -> Option<Session> {
    read_cookie(headers).and_then(|v| decode_cookie(app, &v))
}

pub fn set_cookie_header(app: &App, session: &Session) -> Result<HeaderValue, String> {
    let value = encode_cookie(app, session)?;
    HeaderValue::from_str(&format!(
        "{COOKIE}={value}; Path=/; HttpOnly; SameSite=Strict; Max-Age={TTL_SECS}"
    ))
    .map_err(|e| e.to_string())
}

pub fn clear_cookie_header() -> HeaderValue {
    HeaderValue::from_static("oh_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0")
}

pub fn mutation_allowed(headers: &HeaderMap, session: &Session, form_csrf: &str) -> bool {
    origin_matches_host(headers) || (!form_csrf.is_empty() && form_csrf == session.csrf)
}

pub fn require_mutation(
    headers: &HeaderMap,
    session: &Session,
    form_csrf: &str,
) -> Result<(), (StatusCode, String)> {
    if mutation_allowed(headers, session, form_csrf) {
        Ok(())
    } else {
        Err((
            StatusCode::FORBIDDEN,
            "This form could not be verified. Reload the page and try again.".into(),
        ))
    }
}

pub fn flash_ok(path: &str, message: &str) -> String {
    flash(path, "ok", message)
}

pub fn flash_err(path: &str, message: &str) -> String {
    flash(path, "err", message)
}

fn flash(path: &str, kind: &str, message: &str) -> String {
    let separator = if path.contains('?') { '&' } else { '?' };
    format!("{path}{separator}k={kind}&m={}", enc_query(message))
}

pub fn enc_query(s: &str) -> String {
    let mut out = String::with_capacity(s.len() * 3);
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(b as char)
            }
            b' ' => out.push('+'),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

pub fn dec_query(s: &str) -> String {
    let mut out = Vec::with_capacity(s.len());
    let bytes = s.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        match bytes[i] {
            b'+' => {
                out.push(b' ');
                i += 1;
            }
            b'%' if i + 2 < bytes.len() => {
                let h = |c: u8| -> Option<u8> {
                    match c {
                        b'0'..=b'9' => Some(c - b'0'),
                        b'a'..=b'f' => Some(c - b'a' + 10),
                        b'A'..=b'F' => Some(c - b'A' + 10),
                        _ => None,
                    }
                };
                if let (Some(a), Some(b)) = (h(bytes[i + 1]), h(bytes[i + 2])) {
                    out.push((a << 4) | b);
                    i += 3;
                } else {
                    out.push(b'%');
                    i += 1;
                }
            }
            c => {
                out.push(c);
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

pub fn notice_from_query(
    q: &std::collections::HashMap<String, String>,
) -> Option<(String, String)> {
    let m = q.get("m").filter(|s| !s.is_empty())?;
    let kind = match q.get("k").map(String::as_str) {
        Some("ok") => "ok",
        Some("err") => "error",
        _ => "",
    };
    Some((m.clone(), kind.into()))
}

pub fn status_line(app: &App) -> String {
    let mode = if crate::mock_mode() { "mock" } else { "live" };
    format!("{mode} · session · {}", trim_url(app.local_url.as_str()))
}

fn trim_url(url: &str) -> String {
    url.trim_end_matches('/').to_owned()
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::HeaderValue;

    #[test]
    fn loopback_hosts() {
        let mut h = HeaderMap::new();
        h.insert(header::HOST, HeaderValue::from_static("127.0.0.1:4317"));
        assert!(loopback_host(&h));
        h.insert(header::HOST, HeaderValue::from_static("example.com"));
        assert!(!loopback_host(&h));
    }

    #[test]
    fn query_roundtrip() {
        let s = "Job queued: a/b & c";
        assert_eq!(dec_query(&enc_query(s)), s);
    }
}
