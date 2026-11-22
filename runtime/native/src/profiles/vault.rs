use anyhow::{Context, Result, bail, ensure};
use sha2::{Digest, Sha256};
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::{
    collections::BTreeMap,
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
};
const SERVICE: &str = "dev.openharness.secrets";
pub const FILE: &str = "restricted local file";
pub type Values = BTreeMap<String, String>;

pub fn atomic(path: &Path, bytes: &[u8]) -> Result<()> {
    let parent = path.parent().context("Missing state directory")?;
    let mut file = tempfile::NamedTempFile::new_in(parent)?;
    file.write_all(bytes)?;
    open_harness_runner::sync_state_file(file.as_file())?;
    file.persist(path)?;
    open_harness_runner::sync_state_file(&fs::File::open(parent)?)?;
    Ok(())
}
enum Lookup {
    Found(String),
    Empty,
    Unavailable,
}
#[cfg(target_os = "macos")]
fn noninteractive_keychain() -> bool {
    use security_framework::os::macos::keychain::{KeychainUserInteractionLock, SecKeychain};
    static GUARD: std::sync::OnceLock<Option<KeychainUserInteractionLock>> =
        std::sync::OnceLock::new();
    // The guard is process-wide. Keep it for the service lifetime so parallel reads
    // cannot re-enable a graphical unlock prompt while the coordinator is unattended.
    GUARD
        .get_or_init(|| SecKeychain::disable_user_interaction().ok())
        .is_some()
}
#[cfg(target_os = "macos")]
fn lookup(account: &str) -> Lookup {
    if !noninteractive_keychain() {
        return Lookup::Unavailable;
    }
    match security_framework::passwords::get_generic_password(SERVICE, account) {
        Ok(bytes) => String::from_utf8(bytes)
            .map(Lookup::Found)
            .unwrap_or(Lookup::Unavailable),
        Err(err) if err.code() == -25300 => Lookup::Empty,
        Err(_) => Lookup::Unavailable,
    }
}
#[cfg(target_os = "macos")]
fn save_system(account: &str, data: &str) -> Result<()> {
    ensure!(
        noninteractive_keychain(),
        "The system password vault cannot be opened headlessly."
    );
    security_framework::passwords::set_generic_password(SERVICE, account, data.as_bytes())
        .map_err(|_| anyhow::anyhow!("Could not save credentials in macOS Keychain."))
}
#[cfg(target_os = "macos")]
const SYSTEM: &str = "macOS Keychain";

#[cfg(target_os = "linux")]
fn system_command(args: &[&str], input: Option<&str>) -> Result<(Option<i32>, String, bool)> {
    use std::io::{Seek, SeekFrom};
    use std::process::{Command, Stdio};
    use std::time::{Duration, Instant};
    // Use anonymous files for the pipes to avoid blocking a full pipe while the process
    // is waiting for an unlocked session. No argument contains credential data.
    let mut stdin = tempfile::tempfile()?;
    if let Some(value) = input {
        stdin.write_all(value.as_bytes())?;
        stdin.rewind()?;
    }
    let mut stdout = tempfile::tempfile()?;
    let stderr = tempfile::tempfile()?;
    let mut child = Command::new("secret-tool")
        .args(args)
        .stdin(Stdio::from(stdin))
        .stdout(Stdio::from(stdout.try_clone()?))
        .stderr(Stdio::from(stderr.try_clone()?))
        .spawn()?;
    let start = Instant::now();
    let status = loop {
        if let Some(status) = child.try_wait()? {
            break status;
        }
        if start.elapsed() >= Duration::from_secs(8) {
            let _ = child.kill();
            let _ = child.wait();
            bail!("The system password vault timed out.");
        }
        std::thread::sleep(Duration::from_millis(20));
    };
    ensure!(
        stdout.metadata()?.len() <= 2_000_000,
        "The system password vault returned too much data."
    );
    stdout.seek(SeekFrom::Start(0))?;
    let mut text = String::new();
    stdout.read_to_string(&mut text)?;
    Ok((status.code(), text, stderr.metadata()?.len() != 0))
}
#[cfg(target_os = "linux")]
fn lookup(account: &str) -> Lookup {
    if std::env::var_os("DBUS_SESSION_BUS_ADDRESS").is_none() {
        return Lookup::Unavailable;
    }
    match system_command(
        &["lookup", "application", SERVICE, "workspace", account],
        None,
    ) {
        Ok((Some(0), s, _)) if !s.trim().is_empty() => Lookup::Found(s),
        Ok((Some(0), _, _)) | Ok((Some(1), _, false)) => Lookup::Empty,
        _ => Lookup::Unavailable,
    }
}
#[cfg(target_os = "linux")]
fn save_system(account: &str, data: &str) -> Result<()> {
    ensure!(
        system_command(
            &[
                "store",
                "--label=Open Harness credentials",
                "application",
                SERVICE,
                "workspace",
                account
            ],
            Some(data)
        )?
        .0 == Some(0),
        "Could not save credentials in the system password vault."
    );
    Ok(())
}
#[cfg(target_os = "linux")]
const SYSTEM: &str = "system password vault";
#[cfg(not(any(target_os = "linux", target_os = "macos")))]
const SYSTEM: &str = "OS vault";
#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn lookup(_: &str) -> Lookup {
    Lookup::Unavailable
}
#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn save_system(_: &str, _: &str) -> Result<()> {
    bail!("OS vault unavailable.")
}

pub struct Vault {
    path: PathBuf,
    account: String,
    pub backend: &'static str,
    pub values: Values,
}
impl Vault {
    pub fn load(root: &Path) -> Result<Self> {
        let path = root.join("secrets.json");
        let marker = root.join("secrets.backend");
        let recorded = match fs::read_to_string(&marker) {
            Ok(s) => s,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
            Err(e) => return Err(e.into()),
        };
        let account = format!(
            "open-harness-{}",
            &format!("{:x}", Sha256::digest(path.as_os_str().as_encoded_bytes()))[..16]
        );
        let file_exists = path.try_exists()?;
        let disabled = std::env::var("OPEN_HARNESS_DISABLE_OS_VAULT").as_deref() == Ok("1");
        let stored = if disabled || (recorded.trim() == "file" && file_exists) {
            Lookup::Unavailable
        } else {
            lookup(&account)
        };
        let (backend, values) = match stored {
            Lookup::Found(data) => (
                SYSTEM,
                serde_json::from_str(&data)
                    .context("The system password vault contains unreadable credentials.")?,
            ),
            _ if file_exists => {
                let mut file = fs::OpenOptions::new()
                    .read(true)
                    .custom_flags(rustix::fs::OFlags::NOFOLLOW.bits() as i32)
                    .open(&path)?;
                ensure!(file.metadata()?.is_file(), "Invalid credential file.");
                file.set_permissions(fs::Permissions::from_mode(0o600))?;
                let mut data = String::new();
                file.read_to_string(&mut data)?;
                (FILE,serde_json::from_str(&data).context("The stored credentials are unreadable. Restore the original credential store.")?)
            }
            _ if recorded.trim().starts_with("vault:") => bail!(
                "Open Harness cannot read its recorded password vault. Unlock the original vault to use this workspace."
            ),
            Lookup::Empty => (SYSTEM, Values::new()),
            Lookup::Unavailable => (FILE, Values::new()),
        };
        Ok(Self {
            path,
            account,
            backend,
            values,
        })
    }
    pub fn save(&mut self) -> Result<()> {
        let json = serde_json::to_string(&self.values)?;
        if self.backend != FILE {
            save_system(&self.account, &json)?;
            ensure!(
                matches!(lookup(&self.account),Lookup::Found(raw) if raw.trim()==json),
                "The system password vault could not confirm the saved values."
            );
            atomic(
                &self.path.with_extension("backend"),
                format!("vault:{}", self.backend).as_bytes(),
            )?;
            if self.path.try_exists()? {
                fs::remove_file(&self.path)?;
            }
        } else {
            atomic(&self.path, json.as_bytes())?;
            atomic(&self.path.with_extension("backend"), b"file")?;
        }
        Ok(())
    }
}
pub fn control_token(root: &Path) -> Result<String> {
    // The operator CLI can request the token while the service initializes a fresh
    // workspace. Only one process may mint the first token for this vault.
    let lock = fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .mode(0o600)
        .custom_flags(rustix::fs::OFlags::NOFOLLOW.bits() as i32)
        .open(root.join("native-credentials.lock"))?;
    lock.lock()?;
    let mut vault = Vault::load(root)?;
    if let Some(token) = vault.values.get("controlToken").filter(|t| !t.is_empty()) {
        return Ok(token.clone());
    }
    let token = format!("{}{}", crate::id(), crate::id());
    vault.values.insert("controlToken".into(), token.clone());
    vault.save()?;
    Ok(token)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn simultaneous_token_requests_create_one_control_token() -> Result<()> {
        let root = tempfile::tempdir()?;
        atomic(&root.path().join("secrets.backend"), b"file")?;
        atomic(&root.path().join("secrets.json"), b"{}")?;
        let start = std::sync::Barrier::new(4);
        let tokens = std::thread::scope(|scope| {
            let workers = (0..4)
                .map(|_| {
                    scope.spawn(|| {
                        start.wait();
                        control_token(root.path())
                    })
                })
                .collect::<Vec<_>>();
            workers
                .into_iter()
                .map(|w| w.join().unwrap())
                .collect::<Result<Vec<_>>>()
        })?;
        let stored = control_token(root.path())?;
        assert!(tokens.iter().all(|t| t == &stored));
        Ok(())
    }
}
