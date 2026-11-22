//! Sign in with ChatGPT for locally hosted open-source applications.
//! Only the short-lived inference credential crosses the worker/container boundary.
use anyhow::{Context, Result, bail, ensure};
use axum::{
    Router,
    extract::{Path as RoutePath, Query, State},
    http::{HeaderMap, StatusCode, header},
    response::{IntoResponse, Redirect, Response},
    routing::get,
};
use base64::{Engine as _, engine::general_purpose::URL_SAFE_NO_PAD};
use openssl::{
    bn::BigNum, hash::MessageDigest, pkey::PKey, rand::rand_bytes, rsa::Rsa, sign::Verifier,
};
use reqwest::Client;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, OpenOptions, TryLockError},
    io::{ErrorKind, Read, Write},
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::{
    net::TcpListener,
    sync::{mpsc, oneshot},
    time::{sleep, timeout},
};
use url::Url;
use uuid::Uuid;

const ISSUER: &str = "https://auth.openai.com";
const DISCOVERY: &str = "https://auth.openai.com/.well-known/openid-configuration";
const RESOURCE: &str = "https://api.openai.com/v1";
const DIRECT: &str = "chatgpt.tokens.use.direct";
const SCOPES: &str =
    "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
const REGISTRATION: &str = "dynamic_agent_client";
const APP_NAME: &str = "open_harness";
const MAX_RESPONSE: usize = 256 * 1024;

#[derive(Serialize, Deserialize)]
struct Session {
    access: String,
    refresh: String,
    id_token: String,
    scopes: String,
    expires: u64,
    earliest_refresh_at: u64,
}

#[derive(Serialize, Deserialize)]
struct Registration {
    binding: Uuid,
    client_id: String,
    subject: String,
    session: Option<Session>,
    needs_sign_in: bool,
}

struct Store(PathBuf);
impl Store {
    fn open(root: &Path, agent: &str) -> Result<Self> {
        ensure!(
            agent.len() <= 80
                && agent.starts_with(|c: char| c.is_ascii_alphanumeric())
                && agent
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_')),
            "Invalid agent ID."
        );
        let base = root.join("worker-plan-auth");
        let dir = base.join(agent);
        for path in [&base, &dir] {
            crate::directory(path)?;
            let meta = fs::symlink_metadata(path)?;
            ensure!(
                meta.is_dir()
                    && meta.uid() == unsafe { libc::geteuid() }
                    && meta.mode() & 0o077 == 0,
                "The ChatGPT sign-in directory must belong to this worker and have mode 0700."
            );
        }
        Ok(Self(dir))
    }
    fn load(&self) -> Result<Option<Registration>> {
        match read_file(&self.0.join("registration.json"))? {
            None => Ok(None),
            Some(bytes) => Ok(Some(
                serde_json::from_slice(&bytes)
                    .context("Could not read the worker’s ChatGPT registration.")?,
            )),
        }
    }
    fn save(&self, registration: &Registration) -> Result<()> {
        crate::write_private(
            &self.0.join("registration.json"),
            &serde_json::to_vec(registration)?,
        )
    }
    async fn lock(&self) -> Result<File> {
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
            .open(self.0.join("session.lock"))?;
        check_file(&file)?;
        timeout(Duration::from_secs(45), async {
            loop {
                match file.try_lock() {
                    Ok(()) => return Ok(file),
                    Err(TryLockError::WouldBlock) => sleep(Duration::from_millis(100)).await,
                    Err(TryLockError::Error(e)) => return Err(e.into()),
                }
            }
        })
        .await
        .context("Another sign-in operation is still in progress on this worker.")?
    }
    fn host_id(&self) -> Result<String> {
        let dir = self.0.parent().context("Missing worker credential root")?;
        let path = dir.join("host-id");
        if let Some(bytes) = read_file(&path)? {
            return parse_host(&bytes);
        }
        let id = Uuid::new_v4().urn().to_string();
        let mut temp = tempfile::NamedTempFile::new_in(dir)?;
        temp.write_all(id.as_bytes())?;
        crate::sync_state_file(temp.as_file())?;
        match temp.persist_noclobber(&path) {
            Ok(_) => {
                crate::sync_state_file(&File::open(dir)?)?;
                Ok(id)
            }
            Err(e) if e.error.kind() == ErrorKind::AlreadyExists => {
                parse_host(&read_file(&path)?.context("The worker host ID disappeared.")?)
            }
            Err(e) => Err(e.into()),
        }
    }
}

fn parse_host(bytes: &[u8]) -> Result<String> {
    let s = std::str::from_utf8(bytes)?;
    let id = Uuid::parse_str(
        s.strip_prefix("urn:uuid:")
            .context("Invalid worker host ID.")?,
    )?;
    ensure!(id.get_version_num() == 4, "Invalid worker host ID.");
    Ok(s.into())
}

fn check_file(file: &File) -> Result<()> {
    let m = file.metadata()?;
    ensure!(
        m.is_file() && m.uid() == unsafe { libc::geteuid() } && m.mode() & 0o077 == 0,
        "The ChatGPT credential file must belong to this worker and have mode 0600."
    );
    Ok(())
}

fn read_file(path: &Path) -> Result<Option<Vec<u8>>> {
    let f = match OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)
    {
        Ok(f) => f,
        Err(e) if e.kind() == ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.into()),
    };
    check_file(&f)?;
    let mut buf = Vec::new();
    f.take((MAX_RESPONSE + 1) as u64).read_to_end(&mut buf)?;
    ensure!(
        buf.len() <= MAX_RESPONSE,
        "The ChatGPT credential file is too large."
    );
    Ok(Some(buf))
}
fn binding_id(s: &str) -> Result<Uuid> {
    Uuid::parse_str(s).context("Select ChatGPT plan for this agent on its assigned worker.")
}
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}
fn random() -> Result<String> {
    let mut bytes = [0; 32];
    rand_bytes(&mut bytes)?;
    Ok(URL_SAFE_NO_PAD.encode(bytes))
}
fn identity(value: &str) -> bool {
    !value.is_empty() && value.len() <= 512 && value.bytes().all(|c| c.is_ascii_graphic())
}
fn token(value: &str) -> bool {
    !value.is_empty() && value.len() <= 64 * 1024 && value.bytes().all(|b| b.is_ascii_graphic())
}

#[derive(Deserialize)]
struct Provider {
    issuer: String,
    authorization_endpoint: Url,
    token_endpoint: Url,
    revocation_endpoint: Url,
    jwks_uri: Url,
}
fn client() -> Result<Client> {
    Ok(Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(15))
        .build()?)
}
async fn payload(mut response: reqwest::Response) -> Result<Value> {
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .context("Could not read the OpenAI response.")?
    {
        ensure!(
            bytes.len() + chunk.len() <= MAX_RESPONSE,
            "OpenAI returned an oversized response."
        );
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).context("OpenAI returned an unreadable response.")
}
async fn metadata(client: &Client, discovery: &str) -> Result<Provider> {
    let origin = Url::parse(discovery)?.origin();
    let response = client
        .get(discovery)
        .send()
        .await
        .context("Could not contact OpenAI for sign-in.")?
        .error_for_status()
        .context("OpenAI sign-in is unavailable.")?;
    let p: Provider = serde_json::from_value(payload(response).await?)?;
    ensure!(
        p.issuer == ISSUER
            && [
                &p.authorization_endpoint,
                &p.token_endpoint,
                &p.revocation_endpoint,
                &p.jwks_uri
            ]
            .into_iter()
            .all(|url| url.origin() == origin
                && url.username().is_empty()
                && url.password().is_none()
                && url.query().is_none()
                && url.fragment().is_none()),
        "Invalid OpenAI sign-in configuration."
    );
    Ok(p)
}

struct Attempt {
    state: String,
    nonce: String,
    verifier: String,
    redirect: String,
}
impl Attempt {
    fn new(port: u16) -> Result<Self> {
        Ok(Self {
            state: random()?,
            nonce: random()?,
            verifier: random()?,
            redirect: format!("http://127.0.0.1:{port}/auth/callback"),
        })
    }
    fn authorization(&self, endpoint: &Url, host: &str, reg: Option<&Registration>) -> Url {
        let mut url = endpoint.clone();
        let mut q = url.query_pairs_mut();
        q.append_pair("client_id", reg.map_or(REGISTRATION, |r| &r.client_id))
            .append_pair("ext_agent_host_id", host)
            .append_pair("response_type", "code")
            .append_pair("redirect_uri", &self.redirect)
            .append_pair("scope", SCOPES)
            .append_pair("resource", RESOURCE)
            .append_pair("state", &self.state)
            .append_pair("nonce", &self.nonce)
            .append_pair("code_challenge_method", "S256")
            .append_pair(
                "code_challenge",
                &URL_SAFE_NO_PAD.encode(Sha256::digest(self.verifier.as_bytes())),
            );
        if let Some(r) = reg {
            if let Some(s) = &r.session {
                q.append_pair("id_token_hint", &s.id_token);
            }
        } else {
            q.append_pair("agent_name_hint", APP_NAME);
        }
        drop(q);
        url
    }
}

#[derive(Deserialize)]
struct Callback {
    state: String,
    code: Option<String>,
    client_id: Option<String>,
    error: Option<String>,
}
impl Callback {
    fn credentials(self, saved: Option<&Registration>) -> Result<(String, String)> {
        ensure!(
            self.error.is_none(),
            "ChatGPT sign-in was declined or cancelled."
        );
        let id = match (saved, self.client_id) {
            (Some(r), None) => r.client_id.clone(),
            (Some(r), Some(id)) if r.client_id == id => id,
            (None, Some(id)) if identity(&id) && id != REGISTRATION => id,
            _ => bail!(
                "ChatGPT returned an unexpected or missing registration. Start sign-in again."
            ),
        };
        let code = self
            .code
            .filter(|c| token(c))
            .context("ChatGPT returned no authorization code.")?;
        Ok((id, code))
    }
}
struct Browser {
    address: String,
    start_secret: String,
    state: String,
    authorize: Url,
    result: Mutex<Option<oneshot::Sender<Callback>>>,
}
fn local(h: &HeaderMap, b: &Browser) -> bool {
    h.get(header::HOST).and_then(|v| v.to_str().ok()) == Some(b.address.as_str())
}
async fn start(
    State(b): State<Arc<Browser>>,
    RoutePath(key): RoutePath<String>,
    headers: HeaderMap,
) -> Response {
    if !local(&headers, &b) || key != b.start_secret {
        return StatusCode::NOT_FOUND.into_response();
    }
    (
        [
            (header::CACHE_CONTROL, "no-store"),
            (header::REFERRER_POLICY, "no-referrer"),
        ],
        Redirect::to(b.authorize.as_str()),
    )
        .into_response()
}
async fn callback(
    State(b): State<Arc<Browser>>,
    headers: HeaderMap,
    Query(cb): Query<Callback>,
) -> Response {
    if !local(&headers, &b) || cb.state != b.state {
        return (StatusCode::BAD_REQUEST, "Invalid sign-in request.").into_response();
    }
    let sent = b
        .result
        .lock()
        .unwrap()
        .take()
        .is_some_and(|s| s.send(cb).is_ok());
    if !sent {
        return StatusCode::GONE.into_response();
    }
    (
        [
            (header::CACHE_CONTROL, "no-store"),
            (header::REFERRER_POLICY, "no-referrer"),
        ],
        "Return to the Open Harness terminal to see your sign-in result.",
    )
        .into_response()
}

fn ssh_target() -> String {
    fn safe(s: &str) -> bool {
        !s.is_empty()
            && !s.starts_with('-')
            && s.bytes()
                .all(|c| c.is_ascii_alphanumeric() || b"._-".contains(&c))
    }
    let host = hostname::get()
        .ok()
        .and_then(|s| s.into_string().ok())
        .filter(|s| safe(s))
        .unwrap_or_else(|| "WORKER_HOST".into());
    std::env::var("USER")
        .ok()
        .filter(|s| safe(s))
        .map_or(host.clone(), |u| format!("{u}@{host}"))
}

pub(crate) async fn login(
    root: &Path,
    agent: &str,
    binding: &str,
    progress: mpsc::Sender<String>,
) -> Result<Value> {
    login_at(root, agent, binding, progress, DISCOVERY).await
}
async fn login_at(
    root: &Path,
    agent: &str,
    binding: &str,
    progress: mpsc::Sender<String>,
    discovery: &str,
) -> Result<Value> {
    let store = Store::open(root, agent)?;
    let _lock = store.lock().await?;
    let binding = binding_id(binding)?;
    let previous = store.load()?;
    let old = previous.as_ref().filter(|r| r.binding == binding);
    let host = store.host_id()?;
    let client = client()?;
    let provider = metadata(&client, discovery).await?;
    let listener = TcpListener::bind(("127.0.0.1", 0)).await?;
    let port = listener.local_addr()?.port();
    let attempt = Attempt::new(port)?;
    let (send, recv) = oneshot::channel();
    let b = Arc::new(Browser {
        address: format!("127.0.0.1:{port}"),
        start_secret: random()?,
        state: attempt.state.clone(),
        authorize: attempt.authorization(&provider.authorization_endpoint, &host, old),
        result: Mutex::new(Some(send)),
    });
    let notice = format!(
        "Sign in to authorize this agent’s manual runs, schedules, and handoffs to use your ChatGPT plan.\nFor SSH, forward the port from your computer first (use your usual SSH destination):\nssh -N -o ExitOnForwardFailure=yes -L 127.0.0.1:{port}:127.0.0.1:{port} -- {}\nOpen http://{}/start/{} in your browser.",
        ssh_target(),
        b.address,
        b.start_secret
    );
    let app = Router::new()
        .route("/start/{key}", get(start))
        .route("/auth/callback", get(callback))
        .with_state(b);
    progress
        .send(notice)
        .await
        .context("The sign-in terminal disconnected.")?;
    let (shutdown, closing) = oneshot::channel::<()>();
    let mut server = tokio::task::JoinSet::new();
    server.spawn(async move {
        axum::serve(listener, app)
            .with_graceful_shutdown(async {
                let _ = closing.await;
            })
            .await
    });
    let session = async {
        let cb = tokio::select! {
            r=timeout(Duration::from_secs(300),recv)=>r.context("ChatGPT sign-in expired. Start sign-in again.")??,
            _=progress.closed()=>bail!("The sign-in terminal disconnected."),
        };
        let (id, code) = cb.credentials(old)?;
        let body = client
            .post(provider.token_endpoint.clone())
            .form(&[
                ("grant_type", "authorization_code"),
                ("client_id", &id),
                ("code", &code),
                ("code_verifier", &attempt.verifier),
                ("redirect_uri", &attempt.redirect),
                ("resource", RESOURCE),
            ])
            .send()
            .await
            .context("Could not complete ChatGPT sign-in.")?;
        ensure!(
            body.status().is_success(),
            "The authorization code was rejected. Start sign-in again."
        );
        let data = payload(body).await?;
        let id_token = data["id_token"]
            .as_str()
            .filter(|s| token(s))
            .context("ChatGPT did not return an identity token.")?;
        let keys = client
            .get(provider.jwks_uri.clone())
            .send()
            .await?
            .error_for_status()?;
        let subject =
            validate_identity(id_token, &payload(keys).await?, &id, &attempt.nonce, now())?;
        ensure!(
            old.is_none_or(|r| r.subject == subject),
            "Sign in with the ChatGPT account that registered this agent."
        );
        let session = session(&data, None, id_token)?;
        let warn_if_unrevoked = previous
            .as_ref()
            .filter(|r| r.binding != binding && r.client_id != id);
        store.save(&Registration {
            binding,
            client_id: id,
            subject,
            session: Some(session),
            needs_sign_in: false,
        })?;
        let mut result =
            json!({"state":"connected","usageUrl":"https://chatgpt.com/settings/usage"});
        if let Some(r) = warn_if_unrevoked
            && let Some(s) = &r.session
            && revoke(r, s, discovery).await.is_err()
        {
            result["warning"] = json!(
                "The new plan is connected. OpenAI could not confirm revocation of the previous connection. Review it in ChatGPT Settings."
            );
        }
        Ok(result)
    };
    let result = tokio::select! {
        result=session=>result,
        _=server.join_next()=>bail!("The local ChatGPT sign-in listener stopped."),
    };
    drop(shutdown);
    let _ = timeout(Duration::from_secs(1), server.join_next()).await;
    result
}

fn validate_identity(
    jwt: &str,
    keys: &Value,
    client_id: &str,
    nonce: &str,
    time: u64,
) -> Result<String> {
    let invalid = || anyhow::anyhow!("ChatGPT returned an invalid identity token.");
    let parts: Vec<_> = jwt.split('.').collect();
    ensure!(parts.len() == 3, "Invalid identity token format.");
    let header: Value = serde_json::from_slice(&URL_SAFE_NO_PAD.decode(parts[0])?)?;
    ensure!(
        header["alg"] == "RS256" && header.get("crit").is_none(),
        "Unsupported identity token algorithm."
    );
    let kid = header["kid"].as_str().ok_or_else(invalid)?;
    let key = keys["keys"]
        .as_array()
        .and_then(|a| {
            a.iter().find(|k| {
                k["kid"] == kid && k["kty"] == "RSA" && k["alg"] == "RS256" && k["use"] == "sig"
            })
        })
        .ok_or_else(invalid)?;
    let bn = |field: &str| -> Result<BigNum> {
        Ok(BigNum::from_slice(
            &URL_SAFE_NO_PAD.decode(key[field].as_str().ok_or_else(invalid)?)?,
        )?)
    };
    let rsa = Rsa::from_public_components(bn("n")?, bn("e")?)?;
    ensure!(rsa.size() >= 256, "Invalid OpenAI signing key.");
    let key = PKey::from_rsa(rsa)?;
    let mut v = Verifier::new(MessageDigest::sha256(), &key)?;
    v.update(parts[0].as_bytes())?;
    v.update(b".")?;
    v.update(parts[1].as_bytes())?;
    ensure!(
        v.verify(&URL_SAFE_NO_PAD.decode(parts[2])?)?,
        "ChatGPT identity signature verification failed."
    );
    let claims: Value = serde_json::from_slice(&URL_SAFE_NO_PAD.decode(parts[1])?)?;
    let audience = &claims["aud"];
    let multiple = audience.as_array().is_some_and(|a| a.len() > 1);
    ensure!(
        claims["iss"] == ISSUER
            && claims["nonce"] == nonce
            && (audience == client_id
                || audience
                    .as_array()
                    .is_some_and(|a| a.iter().any(|v| v == client_id)))
            && (!multiple || claims["azp"] == client_id)
            && claims.get("azp").is_none_or(|v| v == client_id)
            && claims["exp"].as_u64().is_some_and(|exp| exp > time)
            && claims["iat"]
                .as_u64()
                .is_some_and(|iat| iat <= time.saturating_add(60))
            && claims
                .get("nbf")
                .is_none_or(|v| v.as_u64().is_some_and(|n| n <= time.saturating_add(60))),
        "ChatGPT identity claims did not match the pending sign-in."
    );
    Ok(claims["sub"]
        .as_str()
        .filter(|s| identity(s))
        .ok_or_else(invalid)?
        .into())
}

fn session(v: &Value, previous_scopes: Option<&str>, id_token: &str) -> Result<Session> {
    let scopes = v["scope"]
        .as_str()
        .or(previous_scopes)
        .context("Missing ChatGPT plan consent.")?;
    ensure!(
        scopes.split_ascii_whitespace().any(|s| s == DIRECT),
        "Enable ChatGPT plan usage during sign-in."
    );
    ensure!(
        v["token_type"]
            .as_str()
            .is_some_and(|t| t.eq_ignore_ascii_case("bearer")),
        "Unsupported ChatGPT credential type."
    );
    let field = |k: &str| {
        v[k].as_str()
            .filter(|s| token(s))
            .map(str::to_owned)
            .context("OpenAI returned an incomplete token set.")
    };
    let expires = v["expires_in"]
        .as_u64()
        .filter(|n| *n > 0)
        .context("Invalid ChatGPT token lifetime.")?;
    Ok(Session {
        access: field("access_token")?,
        refresh: field("refresh_token")?,
        id_token: id_token.into(),
        scopes: scopes.into(),
        expires: now()
            .checked_add(expires)
            .context("Invalid token lifetime.")?,
        earliest_refresh_at: v["earliest_refresh_at"].as_u64().unwrap_or_default(),
    })
}

pub(crate) fn status(root: &Path, agent: &str, binding: &str) -> Result<Value> {
    let binding = binding_id(binding)?;
    let r = Store::open(root, agent)?
        .load()?
        .filter(|r| r.binding == binding);
    let state = match r {
        Some(r) if r.needs_sign_in => "signInRequired",
        Some(r) if r.session.is_some() => "connected",
        _ => "signedOut",
    };
    Ok(json!({"state":state}))
}

/// A late failure must not invalidate credentials from a subsequent sign-in or rotation.
pub(crate) async fn mark_rejected(
    root: &Path,
    agent: &str,
    binding: &str,
    token: &str,
) -> Result<()> {
    let binding = binding_id(binding)?;
    let store = Store::open(root, agent)?;
    let _lock = store.lock().await?;
    if let Some(mut reg) = store.load()?
        && reg.binding == binding
        && let Some(s) = &reg.session
        && s.access == token
        && s.expires > now()
    {
        // Keep the renewable credential for explicit logout or reauthorization.
        reg.needs_sign_in = true;
        store.save(&reg)?;
    }
    Ok(())
}

pub(crate) async fn access_token(root: &Path, agent: &str, binding: &str) -> Result<String> {
    token_at(root, agent, binding, DISCOVERY).await
}
async fn token_at(root: &Path, agent: &str, binding: &str, discovery: &str) -> Result<String> {
    let binding = binding_id(binding)?;
    let store = Store::open(root, agent)?;
    let _lock = store.lock().await?;
    let mut reg = store
        .load()?
        .filter(|r| r.binding == binding)
        .context("Sign in to your ChatGPT plan on the assigned worker.")?;
    ensure!(
        !reg.needs_sign_in,
        "ChatGPT rejected this session. Sign in again on the assigned worker."
    );
    let s = reg
        .session
        .as_ref()
        .context("Sign in to your ChatGPT plan on the assigned worker.")?;
    let time = now();
    if time.saturating_add(90) < s.expires || (time < s.earliest_refresh_at && time < s.expires) {
        return Ok(s.access.clone());
    }
    let client = client()?;
    let p = metadata(&client, discovery).await?;
    let response = client
        .post(p.token_endpoint)
        .form(&[
            ("grant_type", "refresh_token"),
            ("client_id", &reg.client_id),
            ("refresh_token", &s.refresh),
            ("resource", RESOURCE),
        ])
        .send()
        .await
        .context("Could not renew ChatGPT plan access. Try again when the worker is online.")?;
    let code = response.status();
    let v = payload(response).await?;
    if !code.is_success() {
        let reason = v["error"]["code"].as_str().or_else(|| v["error"].as_str());
        if code.is_client_error()
            && matches!(
                reason,
                Some(
                    "invalid_grant"
                        | "invalid_refresh_token"
                        | "token_expired"
                        | "refresh_token_expired"
                        | "refresh_token_invalidated"
                        | "refresh_token_reused"
                )
            )
        {
            reg.session = None;
            reg.needs_sign_in = true;
            store.save(&reg)?;
            bail!(
                "ChatGPT plan access expired or was revoked. Sign in again on the assigned worker."
            );
        }
        bail!(
            "OpenAI could not renew ChatGPT plan access (HTTP {}). Try again later.",
            code.as_u16()
        );
    }
    let refreshed = session(&v, Some(&s.scopes), &s.id_token)?;
    let access = refreshed.access.clone();
    reg.session = Some(refreshed);
    store.save(&reg)?;
    Ok(access)
}

async fn revoke(reg: &Registration, s: &Session, discovery: &str) -> Result<()> {
    let client = client()?;
    let p = metadata(&client, discovery).await?;
    for attempt in 0..2 {
        let result = client
            .post(p.revocation_endpoint.clone())
            .form(&[
                ("token", s.refresh.as_str()),
                ("token_type_hint", "refresh_token"),
                ("client_id", &reg.client_id),
            ])
            .send()
            .await;
        match result {
            Ok(r) if r.status() == StatusCode::OK => return Ok(()),
            Ok(r) if !r.status().is_server_error() => break,
            _ if attempt == 0 => sleep(Duration::from_millis(400)).await,
            _ => break,
        }
    }
    bail!("Unconfirmed remote revocation.")
}
pub(crate) async fn logout(root: &Path, agent: &str) -> Result<Value> {
    logout_at(root, agent, DISCOVERY).await
}
async fn logout_at(root: &Path, agent: &str, discovery: &str) -> Result<Value> {
    let store = Store::open(root, agent)?;
    let _lock = store.lock().await?;
    let mut result = json!({"state":"signedOut"});
    if let Some(mut reg) = store.load()? {
        if let Some(ref s) = reg.session
            && revoke(&reg, s, discovery).await.is_err()
        {
            result["warning"] = json!(
                "Signed out on this worker. OpenAI could not confirm revocation. Disconnect the app in ChatGPT Settings."
            );
        }
        reg.session = None;
        reg.needs_sign_in = false;
        store.save(&reg)?;
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{Form, Json, routing::post};
    use openssl::{pkey::Private, sign::Signer};
    use std::{
        collections::HashMap,
        sync::atomic::{AtomicBool, AtomicUsize, Ordering},
    };

    fn sign(key: &PKey<Private>, claims: &Value) -> String {
        let encoded = |v: &Value| URL_SAFE_NO_PAD.encode(serde_json::to_vec(v).unwrap());
        let message = format!(
            "{}.{}",
            encoded(&json!({"kid":"test","alg":"RS256"})),
            encoded(claims)
        );
        let mut signer = Signer::new(MessageDigest::sha256(), key).unwrap();
        signer.update(message.as_bytes()).unwrap();
        format!(
            "{message}.{}",
            URL_SAFE_NO_PAD.encode(signer.sign_to_vec().unwrap())
        )
    }
    fn keys(key: &PKey<Private>) -> Value {
        let rsa = key.rsa().unwrap();
        json!({"keys":[{"kid":"test","alg":"RS256","kty":"RSA","use":"sig",
            "n":URL_SAFE_NO_PAD.encode(rsa.n().to_vec()),"e":URL_SAFE_NO_PAD.encode(rsa.e().to_vec())}]})
    }
    fn claims(nonce: &str) -> Value {
        json!({"iss":ISSUER,"aud":"issued","sub":"account","iat":now(),"exp":now()+3600,"nonce":nonce})
    }
    #[test]
    fn identity_is_bound_to_issuer_registration_browser_and_signing_key() {
        let key = PKey::from_rsa(Rsa::generate(2048).unwrap()).unwrap();
        let jwks = keys(&key);
        let validate =
            |v: &Value| validate_identity(&sign(&key, v), &jwks, "issued", "nonce", now());
        assert_eq!(validate(&claims("nonce")).unwrap(), "account");
        for (field, value) in [
            ("iss", json!("different")),
            ("aud", json!("other")),
            ("aud", json!(["issued", "other"])),
            ("exp", json!(now())),
            ("nonce", json!("stale")),
            ("iat", json!(now() + 600)),
            ("sub", json!("")),
        ] {
            let mut c = claims("nonce");
            c[field] = value;
            assert!(validate(&c).is_err(), "{field}");
        }
        let mut wrong = jwks.clone();
        wrong["keys"][0]["kid"] = json!("rotated");
        assert!(
            validate_identity(
                &sign(&key, &claims("nonce")),
                &wrong,
                "issued",
                "nonce",
                now()
            )
            .is_err()
        );
        let alternate = PKey::from_rsa(Rsa::generate(2048).unwrap()).unwrap();
        assert!(
            validate_identity(
                &sign(&alternate, &claims("nonce")),
                &jwks,
                "issued",
                "nonce",
                now()
            )
            .is_err()
        );
    }
    #[test]
    fn reauthorization_keeps_the_issued_registration_and_declined_consent_never_exchanges() {
        let saved = Registration {
            binding: Uuid::new_v4(),
            client_id: "issued".into(),
            subject: "owner".into(),
            session: None,
            needs_sign_in: false,
        };
        let callback = |id: Option<&str>, error: Option<&str>| Callback {
            state: "state".into(),
            code: Some("one-time-code".into()),
            client_id: id.map(str::to_owned),
            error: error.map(str::to_owned),
        };
        assert_eq!(
            callback(None, None).credentials(Some(&saved)).unwrap().0,
            "issued"
        );
        assert!(
            callback(Some("other"), None)
                .credentials(Some(&saved))
                .is_err()
        );
        assert!(callback(None, None).credentials(None).is_err());
        assert!(
            callback(Some(REGISTRATION), None)
                .credentials(None)
                .is_err()
        );
        assert!(
            callback(Some("issued"), Some("access_denied"))
                .credentials(None)
                .is_err()
        );
        let attempt = Attempt::new(1455).unwrap();
        let url = attempt.authorization(
            &Url::parse("https://auth.openai.com/api/accounts/authorize").unwrap(),
            "urn:uuid:example",
            Some(&saved),
        );
        let query = url.query_pairs().into_owned().collect::<HashMap<_, _>>();
        assert!(!query.contains_key("agent_name_hint"));
        assert_eq!(query["client_id"], "issued");
        assert!(!query.contains_key("id_token_hint"));
        assert!(!query.contains_key("code_verifier"));
    }

    #[test]
    fn host_id_is_stable_across_agents_and_credentials_are_private() {
        let root = tempfile::tempdir().unwrap();
        let a = Store::open(root.path(), "one").unwrap();
        let b = Store::open(root.path(), "two").unwrap();
        let (left, right) = std::thread::scope(|s| {
            let l = s.spawn(|| a.host_id().unwrap());
            let r = s.spawn(|| b.host_id().unwrap());
            (l.join().unwrap(), r.join().unwrap())
        });
        assert_eq!(left, right);
        assert!(Store::open(root.path(), "../one").is_err());
        assert!(
            std::os::unix::fs::symlink(
                a.0.join("registration.json"),
                b.0.join("registration.json")
            )
            .is_ok()
        );
        assert!(b.load().is_err());
        assert!(!root.path().join("agents").exists());
        let data = json!({"token_type":"Bearer","access_token":"a","refresh_token":"r","scope":"openid","expires_in":3600});
        assert!(session(&data, None, "i").is_err());
        assert!(session(&json!({"scope":DIRECT}), None, "i").is_err());
    }

    struct Fixture {
        url: String,
        key: PKey<Private>,
        transaction: Mutex<HashMap<String, String>>,
        refreshes: AtomicUsize,
        revoked: AtomicBool,
        invalid: AtomicBool,
    }
    async fn discovery(State(f): State<Arc<Fixture>>) -> Json<Value> {
        Json(
            json!({"issuer":ISSUER,"authorization_endpoint":format!("{}/authorize",f.url),"token_endpoint":format!("{}/token",f.url),"revocation_endpoint":format!("{}/revoke",f.url),"jwks_uri":format!("{}/keys",f.url)}),
        )
    }
    async fn exchange(
        State(f): State<Arc<Fixture>>,
        Form(form): Form<HashMap<String, String>>,
    ) -> Response {
        assert_eq!(form["client_id"], "issued");
        assert_eq!(form["resource"], RESOURCE);
        let v = match form["grant_type"].as_str() {
            "authorization_code" => {
                let q = f.transaction.lock().unwrap();
                assert_eq!(
                    URL_SAFE_NO_PAD.encode(Sha256::digest(form["code_verifier"].as_bytes())),
                    q["code_challenge"]
                );
                assert_eq!(form["redirect_uri"], q["redirect_uri"]);
                assert_eq!(form["code"], "testcode");
                json!({"token_type":"Bearer","access_token":"first","refresh_token":"rotation-1","scope":SCOPES,
                    "id_token":sign(&f.key,&claims(&q["nonce"])),"expires_in":1})
            }
            "refresh_token" => {
                if f.invalid.load(Ordering::Relaxed) {
                    return (
                        StatusCode::BAD_REQUEST,
                        Json(json!({"error":"invalid_grant"})),
                    )
                        .into_response();
                }
                assert_eq!(form["refresh_token"], "rotation-1");
                f.refreshes.fetch_add(1, Ordering::Relaxed);
                json!({"access_token":"renewed","refresh_token":"rotation-2","token_type":"Bearer","expires_in":3600})
            }
            _ => panic!("Unexpected grant"),
        };
        Json(v).into_response()
    }
    async fn revoke_fixture(
        State(f): State<Arc<Fixture>>,
        Form(v): Form<HashMap<String, String>>,
    ) -> StatusCode {
        assert_eq!(v["token"], "rotation-2");
        assert_eq!(v["token_type_hint"], "refresh_token");
        assert_eq!(v["client_id"], "issued");
        f.revoked.store(true, Ordering::Relaxed);
        StatusCode::OK
    }

    #[tokio::test]
    async fn browser_callback_refresh_and_logout_keep_tokens_on_assigned_worker() -> Result<()> {
        let root = tempfile::tempdir()?;
        let listener = TcpListener::bind(("127.0.0.1", 0)).await?;
        let addr = listener.local_addr()?;
        let f = Arc::new(Fixture {
            url: format!("http://{addr}"),
            key: PKey::from_rsa(Rsa::generate(2048)?)?,
            transaction: Mutex::new(HashMap::new()),
            refreshes: AtomicUsize::new(0),
            revoked: AtomicBool::new(false),
            invalid: AtomicBool::new(false),
        });
        let d = format!("{}/discovery", f.url);
        let binding = Uuid::new_v4().to_string();
        let other = Uuid::new_v4().to_string();
        let app = Router::new()
            .route("/discovery", get(discovery))
            .route("/token", post(exchange))
            .route("/revoke", post(revoke_fixture))
            .route(
                "/keys",
                get(|State(f): State<Arc<Fixture>>| async move { Json(keys(&f.key)) }),
            )
            .with_state(f.clone());
        let mut server = tokio::task::JoinSet::new();
        server.spawn(async move { axum::serve(listener, app).await });
        let (progress, mut prompts) = mpsc::channel::<String>(1);
        let browser = async {
            let text = prompts
                .recv()
                .await
                .context("Missing browser launch link")?;
            let url = text
                .split_ascii_whitespace()
                .find(|s| s.starts_with("http://"))
                .unwrap();
            let http = client()?;
            assert_eq!(
                http.get(url)
                    .header("host", "other.host")
                    .send()
                    .await?
                    .status(),
                StatusCode::NOT_FOUND
            );
            let res = http.get(url).send().await?;
            assert!(res.status().is_redirection());
            let auth = Url::parse(res.headers().get(header::LOCATION).unwrap().to_str()?)?;
            let q: HashMap<String, String> = auth.query_pairs().into_owned().collect();
            assert_eq!(q["client_id"], REGISTRATION);
            assert_eq!(q["agent_name_hint"], APP_NAME);
            assert_eq!(q["code_challenge_method"], "S256");
            let mut callback = Url::parse(&q["redirect_uri"])?;
            assert_eq!(
                http.get(callback.clone())
                    .query(&[("state", "wrong")])
                    .send()
                    .await?
                    .status(),
                StatusCode::BAD_REQUEST
            );
            callback
                .query_pairs_mut()
                .append_pair("state", &q["state"])
                .append_pair("client_id", "issued")
                .append_pair("code", "testcode");
            *f.transaction.lock().unwrap() = q;
            assert_eq!(
                http.get(callback.clone()).send().await?.status(),
                StatusCode::OK
            );
            Ok::<_, anyhow::Error>(())
        };
        let (login, b) = tokio::join!(
            login_at(root.path(), "one", &binding, progress, &d),
            browser
        );
        b?;
        assert_eq!(login?["state"], "connected");
        let (a, b) = tokio::join!(
            token_at(root.path(), "one", &binding, &d),
            token_at(root.path(), "one", &binding, &d)
        );
        assert_eq!(a?, "renewed");
        assert_eq!(b?, "renewed");
        assert_eq!(f.refreshes.load(Ordering::Relaxed), 1);
        let store = Store::open(root.path(), "one")?;
        let meta = store.0.join("registration.json").metadata()?;
        assert_eq!(meta.mode() & 0o777, 0o600);
        assert_eq!(
            status(root.path(), "one", &binding)?,
            json!({"state":"connected"})
        );
        assert_eq!(
            status(root.path(), "two", &binding)?,
            json!({"state":"signedOut"})
        );
        assert_eq!(status(root.path(), "one", &other)?["state"], "signedOut");
        assert!(token_at(root.path(), "one", &other, &d).await.is_err());
        let mut reg = store.load()?.unwrap();
        mark_rejected(root.path(), "one", &binding, "first").await?;
        mark_rejected(root.path(), "one", &other, "renewed").await?;
        assert_eq!(status(root.path(), "one", &binding)?["state"], "connected");
        mark_rejected(root.path(), "one", &binding, "renewed").await?;
        assert_eq!(
            status(root.path(), "one", &binding)?["state"],
            "signInRequired"
        );
        assert!(token_at(root.path(), "one", &binding, &d).await.is_err());
        assert_eq!(
            logout_at(root.path(), "one", &d).await?,
            json!({"state":"signedOut"})
        );
        assert!(f.revoked.load(Ordering::Relaxed));
        let cleared = store.load()?.unwrap();
        assert_eq!(cleared.client_id, "issued");
        assert!(cleared.session.is_none());
        reg.session.as_mut().unwrap().expires = now();
        store.save(&reg)?;
        f.invalid.store(true, Ordering::Relaxed);
        assert!(token_at(root.path(), "one", &binding, &d).await.is_err());
        assert_eq!(
            status(root.path(), "one", &binding)?["state"],
            "signInRequired"
        );
        assert!(store.load()?.unwrap().session.is_none());
        Ok(())
    }
}
