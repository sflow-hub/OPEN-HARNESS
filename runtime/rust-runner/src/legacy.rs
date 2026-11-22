use anyhow::{Context, Result, ensure};
use base64::{
    Engine,
    engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD},
};
use openssl::{bn::BigNum, pkey::PKey, rsa::Rsa};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs::{self, OpenOptions},
    io::Read,
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};

pub fn private_file(path: &Path, max: u64) -> Result<Vec<u8>> {
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)?;
    let meta = file.metadata()?;
    ensure!(
        meta.is_file()
            && meta.uid() == unsafe { libc::geteuid() }
            && meta.mode() & 0o077 == 0
            && meta.len() <= max,
        "A legacy runner file is oversized or accessible to another user. Review its permissions before adoption."
    );
    let mut data = Vec::new();
    file.take(max + 1).read_to_end(&mut data)?;
    ensure!(data.len() as u64 <= max, "Legacy runner file too large.");
    Ok(data)
}

pub fn identity(root: &Path) -> Result<Value> {
    let source: Value =
        serde_json::from_slice(&private_file(&root.join("connection.json"), 64_000)?)?;
    let field = |key| crate::required_str(&source, key);
    let machine = field("machineId")?;
    ensure!(
        machine.starts_with("machine-")
            && machine != "machine-local"
            && machine
                .bytes()
                .all(|v| v.is_ascii_alphanumeric() || v == b'-'),
        "Invalid legacy machine ID."
    );
    let url = crate::protocol::coordinator_url(field("coordinator")?)?;
    let token = field("token")?;
    ensure!(
        !token.is_empty() && token.len() <= 512 && !token.contains(['\n', '\r', '\0']),
        "Invalid legacy runner token."
    );
    let private: Value = serde_json::from_str(field("encryptionPrivateKey")?)
        .context("No usable legacy runner key")?;
    let public: Value = serde_json::from_str(field("encryptionPublicKey")?)
        .context("No usable legacy runner public key")?;
    ensure!(
        private["kty"] == "RSA"
            && public["kty"] == "RSA"
            && private["n"] == public["n"]
            && private["e"] == public["e"],
        "Legacy runner key pair does not match."
    );
    let num = |field: &str| -> Result<BigNum> {
        Ok(BigNum::from_slice(
            &URL_SAFE_NO_PAD.decode(crate::required_str(&private, field)?)?,
        )?)
    };
    let key = Rsa::from_private_components(
        num("n")?,
        num("e")?,
        num("d")?,
        num("p")?,
        num("q")?,
        num("dp")?,
        num("dq")?,
        num("qi")?,
    )?;
    ensure!(
        key.size() >= 256 && key.check_key()?,
        "Invalid legacy runner private key."
    );
    let pkcs8 = PKey::from_rsa(key)?.private_key_to_pkcs8()?;
    Ok(
        json!({"machineId":machine,"token":token,"coordinator":url,"encryptionPrivateKey":STANDARD.encode(pkcs8)}),
    )
}

pub async fn secrets(root: &Path) -> Result<BTreeMap<String, String>> {
    let path = root.join("secrets.json");
    let marker = match fs::read_to_string(root.join("secrets.backend")) {
        Ok(s) => s.trim().to_owned(),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(e) => return Err(e.into()),
    };
    let read_file = || -> Result<_> { private_file(&path, 2_000_000) };
    let bytes = if marker.starts_with("vault") {
        let read = vault(&path).await;
        match read {
            Ok(bytes)=>bytes,
            Err(_) if path.exists()=>read_file()?,
            Err(e)=>return Err(e.context("The legacy runner credential vault is unavailable. Unlock the original account vault and restart the worker")),
        }
    } else if path.exists() {
        read_file()?
    } else {
        return Ok(BTreeMap::new());
    };
    let mut values: BTreeMap<String, String> =
        serde_json::from_slice(&bytes).context("Legacy runner credentials are unreadable")?;
    values
        .retain(|name, _| crate::profile::is_env_name(name) && !name.starts_with("OPEN_HARNESS_"));
    Ok(values)
}

async fn vault(path: &Path) -> Result<Vec<u8>> {
    ensure!(
        std::env::var("OPEN_HARNESS_DISABLE_OS_VAULT").as_deref() != Ok("1"),
        "The OS vault was disabled."
    );
    let digest = format!(
        "{:x}",
        Sha256::digest(
            path.to_str()
                .context("Invalid legacy state path")?
                .as_bytes()
        )
    );
    let account = format!("open-harness-{}", &digest[..16]);
    #[cfg(target_os = "macos")]
    let (program, args) = (
        "security",
        vec![
            "find-generic-password",
            "-s",
            "dev.openharness.secrets",
            "-a",
            &account,
            "-w",
        ],
    );
    #[cfg(not(target_os = "macos"))]
    let (program, args) = (
        "secret-tool",
        vec![
            "lookup",
            "application",
            "dev.openharness.secrets",
            "workspace",
            &account,
        ],
    );
    let output = tokio::time::timeout(
        Duration::from_secs(8),
        tokio::process::Command::new(program)
            .args(args)
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .output(),
    )
    .await??;
    ensure!(
        output.status.success() && !output.stdout.is_empty() && output.stdout.len() <= 2_000_000,
        "The legacy keychain lookup failed."
    );
    Ok(output.stdout)
}

pub fn matching_identity(root: &Path, machine: &str, public_key: &str) -> Result<bool> {
    let path = root.join("connection.json");
    if !path.try_exists()? {
        return Ok(false);
    }
    let saved: Value = serde_json::from_slice(&private_file(&path, 64_000)?)?;
    if saved["machineId"] != machine {
        return Ok(false);
    }
    let legacy: Value = serde_json::from_str(crate::required_str(&saved, "encryptionPublicKey")?)?;
    let native: Value = serde_json::from_str(public_key)?;
    ensure!(
        legacy["n"] == native["n"] && legacy["e"] == native["e"],
        "Legacy machine and native key disagree. Use the original state directory."
    );
    Ok(true)
}

pub fn pending(root: &Path) -> Result<Vec<(PathBuf, Value)>> {
    let dir = root.join("spool");
    if !dir.try_exists()? {
        return Ok(Vec::new());
    }
    ensure!(
        dir.symlink_metadata()?.is_dir(),
        "Invalid legacy spool directory."
    );
    let mut records = Vec::new();
    for entry in fs::read_dir(&dir)? {
        let path = entry?.path();
        if path.extension().and_then(|v| v.to_str()) != Some("json") {
            continue;
        }
        let record: Value = serde_json::from_slice(&private_file(&path, 32_000_000)?)?;
        let meta = path.symlink_metadata()?;
        let id = crate::required_str(&record, "id")?;
        ensure!(
            path.file_stem().and_then(|v| v.to_str()) == Some(id),
            "Legacy spool filename does not match its record."
        );
        records.push((
            id.starts_with("complete-"),
            meta.modified()?,
            meta.ino(),
            path,
            record,
        ));
    }
    // The old spool named events by random UUID. File times and creation order are its
    // available chronology. Every pending event must reach the coordinator before its completion.
    records.sort_by(|a, b| (&a.0, &a.1, &a.2, &a.3).cmp(&(&b.0, &b.1, &b.2, &b.3)));
    Ok(records.into_iter().map(|(_, _, _, p, v)| (p, v)).collect())
}
