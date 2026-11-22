use anyhow::{Context, Result, anyhow, ensure};
use base64::{
    Engine,
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
};
use openssl::{
    encrypt::Decrypter,
    hash::MessageDigest,
    pkey::{PKey, Private},
    rsa::{Padding, Rsa},
    symm::{Cipher, decrypt_aead},
};
use reqwest::{
    Client, Method,
    header::{HeaderMap, HeaderValue},
};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, path::Path, time::Duration};
use url::{Host, Url};
use uuid::Uuid;

use crate::write_private;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Command {
    pub id: Uuid,
    pub agent_id: Option<String>,
    pub kind: String,
    pub payload: Value,
}

#[derive(Deserialize)]
pub struct Commands {
    pub commands: Vec<Command>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Identity {
    machine_id: String,
    token: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Connection {
    coordinator: Url,
    #[serde(flatten)]
    identity: Identity,
    encryption_private_key: String,
}

#[derive(Deserialize)]
struct EncryptedSecret {
    version: u8,
    key: String,
    iv: String,
    data: String,
}

pub struct Coordinator {
    client: Client,
    pub url: Url,
    pub machine_id: String,
    pub public_key: String,
    pub container_owner: String,
    key: PKey<Private>,
}

impl Coordinator {
    pub async fn connect(
        root: &Path,
        pair: Option<(&str, &str)>,
        capabilities: Value,
        local_url: Option<&str>,
    ) -> Result<Self> {
        // Use a separate file from the JavaScript runner. An existing Rust identity
        // must keep its key and spool together across restarts.
        let path = root.join("rust-connection.json");
        let local = local_url.map(coordinator_url).transpose()?;
        if let Some(url) = &local {
            ensure!(
                loopback(url),
                "A colocated runner must use a loopback coordinator."
            );
        }
        if !path.try_exists()? && root.join("connection.json").try_exists()? && local.is_none() {
            ensure!(
                pair.is_none(),
                "This directory contains an existing runner. Start without a pairing code to adopt it, or select a new directory."
            );
            let identity = crate::legacy::identity(root)?;
            write_private(&path, &serde_json::to_vec(&identity)?)?;
        }
        let (connection, key) = if let Some((url, code)) = pair {
            ensure!(
                !path.exists(),
                "This state directory is already paired. Use a new directory for another connection."
            );
            let coordinator = coordinator_url(url)?;
            if let Some(local) = &local {
                ensure!(local == &coordinator, "Mismatched local pairing address.");
            }
            let client = http_client(&coordinator, HeaderMap::new())?;
            let rsa = Rsa::generate(2048)?;
            let arch = match std::env::consts::ARCH {
                "aarch64" => "arm64",
                "x86_64" => "x64",
                arch => arch,
            };
            let body = json!({
                "code": code, "name": hostname::get()?.to_string_lossy(),
                "platform": std::env::consts::OS, "arch": arch,
                "capabilities": capabilities, "encryptionPublicKey": public_key(&rsa),
            });
            let identity: Identity = read_response(
                client
                    .post(endpoint(&coordinator, "/v1/runner/pair"))
                    .json(&body)
                    .send()
                    .await,
            )
            .await
            .context("Runner pairing failed")?;
            if local.is_some() {
                ensure!(
                    identity.machine_id == "machine-local",
                    "This code belongs to a different machine."
                );
            }
            let key = PKey::from_rsa(rsa)?;
            let connection = Connection {
                coordinator,
                identity,
                encryption_private_key: STANDARD.encode(key.private_key_to_pkcs8()?),
            };
            write_private(&path, &serde_json::to_vec(&connection)?)?;
            (connection, key)
        } else {
            let data = std::fs::read(&path)
                .context("Pass --coordinator and --pairing-code to pair this runner")?;
            let mut connection: Connection = serde_json::from_slice(&data)?;
            if let Some(local) = &local {
                ensure!(
                    connection.identity.machine_id == "machine-local"
                        && loopback(&connection.coordinator),
                    "The existing pairing belongs to a different computer."
                );
                if connection.coordinator != *local {
                    connection.coordinator = local.clone();
                    write_private(&path, &serde_json::to_vec(&connection)?)?;
                }
            }
            coordinator_url(connection.coordinator.as_str())?;
            let key = PKey::private_key_from_pkcs8(
                &STANDARD.decode(&connection.encryption_private_key)?,
            )?;
            (connection, key)
        };
        let Identity { machine_id, token } = connection.identity;
        ensure!(
            machine_id.starts_with("machine-")
                && machine_id
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-'),
            "Invalid paired machine ID."
        );
        let mut headers = HeaderMap::new();
        let mut auth = HeaderValue::from_str(&format!("Bearer {token}"))?;
        auth.set_sensitive(true);
        headers.insert(reqwest::header::AUTHORIZATION, auth);
        headers.insert(
            "x-open-harness-machine",
            HeaderValue::from_str(&machine_id)?,
        );
        let client = http_client(&connection.coordinator, headers)?;
        let public_key = public_key(key.rsa()?.as_ref());
        let container_owner = owner_label(&machine_id, &public_key);
        Ok(Self {
            client,
            container_owner,
            url: connection.coordinator,
            machine_id,
            public_key,
            key,
        })
    }

    pub async fn get<T: DeserializeOwned>(&self, path: &str) -> Result<T> {
        read_response(
            self.client
                .request(Method::GET, endpoint(&self.url, path))
                .send()
                .await,
        )
        .await
    }

    pub async fn post(&self, path: &str, body: &Value) -> Result<()> {
        self.post_json(path, body).await?;
        Ok(())
    }

    pub async fn post_json(&self, path: &str, body: &Value) -> Result<Value> {
        read_response(
            self.client
                .post(endpoint(&self.url, path))
                .json(body)
                .send()
                .await,
        )
        .await
    }

    pub fn secrets(&self, values: Option<&Value>) -> Result<BTreeMap<String, String>> {
        let Some(values) = values else {
            return Ok(BTreeMap::new());
        };
        let values: BTreeMap<String, EncryptedSecret> = serde_json::from_value(values.clone())?;
        values
            .into_iter()
            .map(|(name, input)| Ok((name, self.open_secret(input)?)))
            .collect()
    }

    fn open_secret(&self, input: EncryptedSecret) -> Result<String> {
        ensure!(
            input.version == 1,
            "Unsupported encrypted credential version."
        );
        let wrapped = STANDARD.decode(input.key)?;
        let iv = STANDARD.decode(input.iv)?;
        let data = STANDARD.decode(input.data)?;
        ensure!(
            iv.len() == 12 && data.len() >= 16,
            "Malformed encrypted credential."
        );
        let mut rsa = Decrypter::new(&self.key)?;
        rsa.set_rsa_padding(Padding::PKCS1_OAEP)?;
        rsa.set_rsa_oaep_md(MessageDigest::sha256())?;
        rsa.set_rsa_mgf1_md(MessageDigest::sha256())?;
        let mut key = vec![0; rsa.decrypt_len(&wrapped)?];
        let key_len = rsa.decrypt(&wrapped, &mut key)?;
        ensure!(key_len == 32, "Invalid encrypted credential key.");
        let (ciphertext, tag) = data.split_at(data.len() - 16);
        let clear = decrypt_aead(
            Cipher::aes_256_gcm(),
            &key[..key_len],
            Some(&iv),
            &[],
            ciphertext,
            tag,
        )?;
        Ok(String::from_utf8(clear)?)
    }
}

fn public_key<T: openssl::pkey::HasPublic>(rsa: &openssl::rsa::RsaRef<T>) -> String {
    json!({
        "kty": "RSA", "alg": "RSA-OAEP-256", "ext": true, "key_ops": ["encrypt"],
        "n": URL_SAFE_NO_PAD.encode(rsa.n().to_vec()), "e": URL_SAFE_NO_PAD.encode(rsa.e().to_vec()),
    }).to_string()
}

fn loopback(url: &Url) -> bool {
    match url.host() {
        Some(Host::Domain(name)) => name == "localhost",
        Some(Host::Ipv4(ip)) => ip.is_loopback(),
        Some(Host::Ipv6(ip)) => ip.is_loopback(),
        None => false,
    }
}

pub(crate) fn coordinator_url(input: &str) -> Result<Url> {
    let mut url = Url::parse(input).context("Invalid coordinator URL")?;
    ensure!(
        url.has_host() && (url.scheme() == "https" || (loopback(&url) && url.scheme() == "http")),
        "Remote coordinators must use HTTPS. Plain HTTP is only permitted on loopback."
    );
    ensure!(
        url.username().is_empty()
            && url.password().is_none()
            && url.query().is_none()
            && url.fragment().is_none(),
        "The coordinator URL cannot include user info, a query, or a fragment."
    );
    let path = url.path().trim_end_matches('/').to_owned();
    url.set_path(&path);
    Ok(url)
}

fn http_client(url: &Url, headers: HeaderMap) -> Result<Client> {
    let client = Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(8))
        .default_headers(headers);
    // Unencrypted loopback traffic must stay local even when a proxy is configured.
    let client = if url.scheme() == "http" {
        client.no_proxy()
    } else {
        client
    };
    Ok(client.build()?)
}

pub(crate) fn endpoint(base: &Url, path: &str) -> Url {
    let mut url = base.clone();
    url.set_path(&format!("{}{path}", base.path().trim_end_matches('/')));
    url
}

async fn read_response<T: DeserializeOwned>(
    response: reqwest::Result<reqwest::Response>,
) -> Result<T> {
    let response = response.map_err(|error| anyhow!(error.without_url()))?;
    if !response.status().is_success() {
        return Err(anyhow::Error::new(CoordinatorStatus(response.status())));
    }
    response
        .json()
        .await
        .map_err(|error| anyhow!(error.without_url()))
}

#[derive(Debug)]
pub(crate) struct CoordinatorStatus(pub reqwest::StatusCode);
impl std::fmt::Display for CoordinatorStatus {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "Coordinator returned HTTP {}.", self.0.as_u16())
    }
}
impl std::error::Error for CoordinatorStatus {}

fn owner_label(machine: &str, key: &str) -> String {
    if machine == "machine-local" {
        format!("machine-local-{:x}", Sha256::digest(key.as_bytes()))
    } else {
        machine.to_owned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn colocated_worker_container_ownership_is_unique_and_survives_restarts() {
        assert_ne!(
            owner_label("machine-local", "one"),
            owner_label("machine-local", "two")
        );
        assert_eq!(
            owner_label("machine-local", "one"),
            owner_label("machine-local", "one")
        );
        assert_eq!(owner_label("machine-remote", "one"), "machine-remote");
    }
}
