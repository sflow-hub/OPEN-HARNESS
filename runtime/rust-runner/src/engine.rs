use anyhow::{Context, Result, bail, ensure};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    fs,
    io::Write,
    os::unix::fs::MetadataExt,
    path::{Path, PathBuf},
    process::Stdio,
    sync::Mutex,
    time::Duration,
};
use tokio::{process::Command, time::timeout};

pub const HARNESSES: [&str; 3] = ["hermes", "claude-code", "codex"];
pub const OWNER_LABEL: &str = "dev.openharness.rust-runner";
pub type Keys = BTreeMap<String, String>;

pub fn mock() -> bool {
    std::env::var_os("OPEN_HARNESS_MOCK").is_some_and(|v| v == "1")
}

pub fn harness(snapshot: &Value) -> Result<&str> {
    let name = snapshot
        .get("harness")
        .map_or(Some("hermes"), Value::as_str)
        .filter(|name| HARNESSES.contains(name))
        .context("Unknown agent harness")?;
    ensure!(
        matches!(
            snapshot["computer"]["access"].as_str(),
            Some("private" | "folders")
        ) && snapshot["computer"]["desktop"] == "none",
        "Choose a private workspace or shared folders with desktop access off."
    );
    Ok(name)
}

pub fn image_tag(harness: &str) -> Result<String> {
    if harness == "hermes" {
        return Ok(std::env::var("OPEN_HARNESS_HERMES_IMAGE")
            .unwrap_or_else(|_| "open-harness-hermes:2026.9.11-headless-1".into()));
    }
    Ok(format!(
        "open-harness-{harness}:{}-headless-1",
        cli_version(harness)?
    ))
}

fn cli_version(harness: &str) -> Result<&'static str> {
    match harness {
        "claude-code" => Ok("2.1.322"),
        "codex" => Ok("0.167.1"),
        _ => bail!("Unknown agent harness."),
    }
}

pub fn image_id(value: &str) -> Result<&str> {
    ensure!(
        value
            .strip_prefix("sha256:")
            .is_some_and(|s| s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit())),
        "Invalid container image ID."
    );
    Ok(value)
}

pub async fn image(harness: &str) -> Result<String> {
    if harness == "hermes" {
        return crate::hermes::image().await;
    }
    let image = image_tag(harness)?;
    let value = crate::hermes::docker(&["image", "inspect", "--format", "{{.Id}}", &image], 10)
        .await
        .with_context(|| format!("Install the pinned {harness} image first"))?;
    Ok(image_id(value.trim())?.to_owned())
}

// Image installs can take many minutes. Allow different engines to build in parallel
// while coalescing simultaneous requests for the same engine in this process.
static INSTALLS: [tokio::sync::Mutex<()>; 3] = [const { tokio::sync::Mutex::const_new(()) }; 3];

pub async fn install(harness: &str) -> Result<()> {
    let index = HARNESSES
        .iter()
        .position(|v| *v == harness)
        .context("Unknown agent harness")?;
    if mock() {
        return Ok(());
    }
    let _lock = INSTALLS[index].lock().await;
    if image(harness).await.is_ok() {
        return Ok(());
    }
    ensure!(
        crate::hermes::docker_ready().await,
        "Start Docker on this computer, then retry installation."
    );
    let context = tempfile::tempdir()?;
    let recipe = if harness == "hermes" {
        hermes_context(context.path())?
    } else {
        let recipe = context.path().join("Dockerfile");
        fs::write(&recipe, cli_recipe(harness)?)?;
        recipe
    };
    let status = timeout(
        Duration::from_secs(45 * 60),
        Command::new("docker")
            .arg("build")
            .arg("--file")
            .arg(recipe)
            .arg("--tag")
            .arg(image_tag(harness)?)
            .arg(context.path())
            .stdin(Stdio::null())
            .stdout(Stdio::inherit())
            .stderr(Stdio::inherit())
            .kill_on_drop(true)
            .status(),
    )
    .await??;
    ensure!(
        status.success(),
        "Docker failed to build the {harness} image."
    );
    image(harness).await?;
    Ok(())
}

fn cli_recipe(harness: &str) -> Result<String> {
    let version = cli_version(harness)?;
    let (binary, package, stage) = if harness == "codex" {
        (
            "codex",
            format!("@openai/codex@{version}-linux-$arch"),
            "cp -a /stage/node_modules/@openai/codex/vendor/*/. /out/",
        )
    } else {
        (
            "claude",
            format!("@anthropic-ai/claude-code-linux-$arch@{version}"),
            "mkdir -p /out/bin && cp /stage/node_modules/@anthropic-ai/claude-code-linux-$arch/claude /out/bin/claude",
        )
    };
    Ok(format!(
        r#"FROM node:22-bookworm-slim AS fetch
RUN set -eu; case "$(dpkg --print-architecture)" in amd64) arch=x64 ;; arm64) arch=arm64 ;; *) exit 1 ;; esac; \
    npm install --prefix /stage --ignore-scripts --no-audit --no-fund "{package}" && mkdir -p /out && {stage}
FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ripgrep ca-certificates && rm -rf /var/lib/apt/lists/*
COPY --from=fetch /out/ /opt/harness/
RUN ln -s /opt/harness/bin/{binary} /usr/local/bin/{binary} && {binary} --version
ENV HOME=/home/agent
WORKDIR /workspace/shared
"#
    ))
}

fn hermes_context(context: &Path) -> Result<PathBuf> {
    // A remote runner can build a native image without any host-side checkout.
    let hermes = context.join("runtime/hermes");
    fs::create_dir_all(hermes.join("extension"))?;
    fs::create_dir_all(hermes.join("headless"))?;
    for (name, data) in [
        (
            "Dockerfile.headless",
            include_str!("../../hermes/Dockerfile.headless"),
        ),
        ("NOTICE.md", include_str!("../../hermes/NOTICE.md")),
        (
            "headless/managed_entry.py",
            include_str!("../../hermes/headless/managed_entry.py"),
        ),
        (
            "inspect_runtime.py",
            include_str!("../../hermes/inspect_runtime.py"),
        ),
        (
            "extension/pyproject.toml",
            include_str!("../../hermes/extension/pyproject.toml"),
        ),
        (
            "headless/open_harness_policy.py",
            include_str!("../../hermes/headless/open_harness_policy.py"),
        ),
    ] {
        fs::write(hermes.join(name), data)?;
    }
    let helper = context.join("runtime/agent-tools");
    fs::create_dir_all(helper.join("src"))?;
    for (name, data) in [
        ("Cargo.toml", include_str!("../../agent-tools/Cargo.toml")),
        ("Cargo.lock", include_str!("../../agent-tools/Cargo.lock")),
        ("src/main.rs", include_str!("../../agent-tools/src/main.rs")),
        (
            "src/coordination.rs",
            include_str!("../../agent-tools/src/coordination.rs"),
        ),
        (
            "src/slack.rs",
            include_str!("../../agent-tools/src/slack.rs"),
        ),
    ] {
        fs::write(helper.join(name), data)?;
    }
    Ok(hermes.join("Dockerfile.headless"))
}

pub async fn prepare_image(
    harness: &str,
    controls: &mut tokio::sync::mpsc::Receiver<crate::hermes::Control>,
    shutdown: &mut tokio::sync::watch::Receiver<bool>,
) -> Result<String> {
    let preparing = async {
        install(harness).await?;
        image(harness).await
    };
    tokio::pin!(preparing);
    loop {
        tokio::select! {
            result=&mut preparing=>return result,
            _=shutdown.wait_for(|v| *v)=>bail!("The runner stopped during preparation."),
            Some(control)=controls.recv()=>{
                if control.command.kind=="stop" {
                    let _=control.reply.send(Ok(json!({"ok":true})));
                    bail!("This run was stopped before execution completed.");
                }
                let _=control.reply.send(Err(anyhow::anyhow!("The harness is still preparing its image.")));
            }
        }
    }
}

pub fn bind(source: &Path, target: &str, readonly: bool) -> Result<String> {
    let s = source.to_str().context("Folder path must be UTF-8")?;
    ensure!(!s.contains(['\0', '\n', '\r']), "Unsupported folder path.");
    let field = |s: &str| {
        if s.contains([',', '"']) {
            format!("\"{}\"", s.replace('"', "\"\""))
        } else {
            s.to_owned()
        }
    };
    Ok(format!(
        "type=bind,{},{target}{}",
        field(&format!("source={s}")),
        if readonly { ",readonly" } else { "" }
    ))
}

fn workspace_state(path: &Path) -> bool {
    [
        "rust-connection.json",
        "rust-runner.lock",
        "native-control.lock",
        "native-credentials.lock",
    ]
    .iter()
    .any(|name| path.join(name).is_file())
        || path.join("state.db").is_file() && path.join("agents").is_dir()
        || path.join("connection.json").is_file() && path.join("spool").is_dir()
        || path.join("runner.json").is_file() && path.join("agents").is_dir()
}

// A parent share includes everything beneath it. Inspect actual directories, skipping
// symlinks, which resolve in the container's own mount namespace. Stop at a bounded size.
fn inspect_shared_tree(source: &Path) -> Result<()> {
    use std::os::unix::fs::FileTypeExt;
    let mut dirs = vec![source.to_owned()];
    let mut visited = 0usize;
    while let Some(dir) = dirs.pop() {
        for entry in fs::read_dir(&dir)
            .with_context(|| format!("Cannot inspect shared directory {}.", dir.display()))?
        {
            let entry = entry?;
            visited += 1;
            ensure!(
                visited <= 1_000_000,
                "This folder is too large to check for private workspace state. Select a smaller folder."
            );
            let ty = entry.file_type()?;
            let name = entry.file_name();
            let name = name.to_str().unwrap_or("");
            if ty.is_dir() {
                ensure!(
                    name != ".open-harness",
                    "This shared folder contains Open Harness state."
                );
                dirs.push(entry.path());
            } else if (ty.is_file()
                && matches!(
                    name,
                    "rust-connection.json"
                        | "rust-runner.lock"
                        | "native-control.lock"
                        | "native-credentials.lock"
                        | "state.db"
                        | "connection.json"
                        | "runner.json"
                )
                && workspace_state(&dir))
                || (ty.is_socket()
                    && matches!(name, "docker.sock" | "containerd.sock" | "podman.sock"))
            {
                bail!(
                    "This folder would expose private worker state or a container engine socket."
                );
            }
        }
    }
    Ok(())
}

fn check_shared_folder(
    source: &Path,
    root: &Path,
    docker_socket: Option<&Path>,
    home: Option<&Path>,
) -> Result<()> {
    ensure!(
        source.is_dir()
            && !root.starts_with(source)
            && !source.starts_with(root)
            && !home.is_some_and(|home| home.starts_with(source)),
        "Choose a workspace folder outside the runner state and home root."
    );
    ensure!(
        !["/run", "/var/run", "/proc", "/dev", "/sys"]
            .iter()
            .filter_map(|p| fs::canonicalize(p).ok())
            .any(|p| source.starts_with(&p) || p.starts_with(source)),
        "System directories cannot be shared with an agent."
    );
    if let Some(socket) = docker_socket {
        let file = socket.canonicalize().unwrap_or_else(|_| socket.to_owned());
        ensure!(
            !file.starts_with(source),
            "This share would expose the Docker socket."
        );
    }
    // Old and colocated installations may keep state in the source tree or beneath the
    // conventional .open-harness directory. A selected subfolder must not expose either.
    ensure!(
        !source.ancestors().any(workspace_state)
            && !source
                .components()
                .any(|c| c.as_os_str() == ".open-harness")
            && !source.join(".open-harness").is_dir(),
        "This folder contains managed Open Harness state."
    );
    inspect_shared_tree(source)?;
    Ok(())
}

pub async fn folder_mounts(root: &Path, snapshot: &Value) -> Result<Vec<String>> {
    let root = root.to_owned();
    let snapshot = snapshot["computer"].clone();
    tokio::task::spawn_blocking(move || collect_mounts(&root, &snapshot)).await?
}
fn collect_mounts(root: &Path, computer: &Value) -> Result<Vec<String>> {
    if computer["access"] == "private" {
        return Ok(Vec::new());
    }
    let folders = computer["folders"]
        .as_array()
        .filter(|v| v.len() <= 50)
        .context("Invalid shared folders")?;
    let home = std::env::var_os("HOME").and_then(|p| fs::canonicalize(p).ok());
    let socket = std::env::var("DOCKER_HOST")
        .ok()
        .and_then(|v| v.strip_prefix("unix://").map(PathBuf::from));
    let root = fs::canonicalize(root)?;
    folders
        .iter()
        .enumerate()
        .map(|(index, folder)| {
            let supplied = Path::new(crate::required_str(folder, "path")?);
            ensure!(
                supplied.is_absolute(),
                "A shared folder must have an absolute path."
            );
            let source = supplied
                .canonicalize()
                .context("The shared folder is unavailable on this computer")?;
            check_shared_folder(&source, &root, socket.as_deref(), home.as_deref())?;
            if let Some(home) = &home {
                ensure!(
                    !home.join(".docker/run/docker.sock").starts_with(&source),
                    "This share would expose the Docker socket."
                );
            }
            let readonly = match folder["mode"].as_str() {
                Some("read") => true,
                Some("write") => false,
                _ => bail!("Invalid shared folder access."),
            };
            bind(
                &source,
                &format!("target=/workspace/mounts/folder-{}", index + 1),
                readonly,
            )
        })
        .collect()
}

pub fn container_flags(name: &str, machine: &str, resources: &Value) -> Result<Vec<String>> {
    let memory = resources["memoryMb"]
        .as_u64()
        .filter(|n| (256..=262144).contains(n))
        .context("Invalid memory limit")?;
    let cpu = resources["cpu"]
        .as_f64()
        .filter(|n| (0.25..=64.).contains(n))
        .context("Invalid CPU limit")?;
    let uid = unsafe { libc::geteuid() };
    let gid = unsafe { libc::getegid() };
    ensure!(
        uid != 0,
        "Start the worker as a non-root user with access to Docker."
    );
    Ok([
        "--pull",
        "never",
        "--name",
        name,
        "--label",
        &format!("{OWNER_LABEL}={machine}"),
        "--security-opt",
        "no-new-privileges",
        "--cap-drop",
        "ALL",
        "--pids-limit",
        "512",
        "--memory",
        &format!("{memory}m"),
        "--cpus",
        &cpu.to_string(),
        "--add-host",
        "host.docker.internal:host-gateway",
        "--user",
        &format!("{uid}:{gid}"),
    ]
    .into_iter()
    .map(str::to_owned)
    .collect())
}

pub struct Secrets {
    path: PathBuf,
    state: Mutex<Keys>,
    legacy: Keys,
}

impl Secrets {
    pub fn load(root: &Path, legacy: Keys) -> Result<Self> {
        let path = root.join("rust-runner-secrets.json");
        let state = match fs::symlink_metadata(&path) {
            Ok(meta) => {
                ensure!(
                    meta.is_file()
                        && meta.uid() == unsafe { libc::geteuid() }
                        && meta.mode() & 0o077 == 0,
                    "Runner credentials must be private."
                );
                serde_json::from_slice(&fs::read(&path)?)
                    .context("The runner credential file is invalid")?
            }
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Keys::new(),
            Err(e) => return Err(e.into()),
        };
        Ok(Self {
            path,
            state: Mutex::new(state),
            legacy,
        })
    }
    pub fn store(&self, name: &str, value: String) -> Result<()> {
        ensure!(
            crate::profile::is_env_name(name)
                && !name.starts_with("OPEN_HARNESS_")
                && !value.is_empty()
                && value.len() <= 64_000,
            "Invalid runner credential."
        );
        let mut current = self.state.lock().unwrap();
        let mut next = current.clone();
        next.insert(name.to_owned(), value);
        crate::write_private(&self.path, &serde_json::to_vec(&next)?)?;
        *current = next;
        Ok(())
    }
    pub fn has(&self, name: &str) -> bool {
        self.state.lock().unwrap().contains_key(name) || self.legacy.contains_key(name)
    }
    pub fn for_profile(&self, profile: &Value, mut dispatched: Keys) -> Keys {
        let stored = self.state.lock().unwrap();
        let names = profile["connectors"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|c| c["enabled"] == true)
            .filter_map(|c| c["secretRef"].as_str())
            .chain(profile["effectiveModel"]["credentialRef"].as_str());
        for name in names {
            if let Some(value) = stored.get(name).or_else(|| self.legacy.get(name)) {
                dispatched
                    .entry(name.to_owned())
                    .or_insert_with(|| value.clone());
            }
        }
        dispatched
    }
}

pub fn redact(value: &mut Value, keys: &Keys) {
    fn string(text: &mut String, keys: &Keys) {
        for key in keys.values().filter(|key| !key.is_empty()) {
            *text = text.replace(key, "[redacted]");
            let quoted = json!(key).to_string();
            *text = text.replace(&quoted[1..quoted.len() - 1], "[redacted]");
        }
    }
    match value {
        Value::String(s) => string(s, keys),
        Value::Array(v) => v.iter_mut().for_each(|v| redact(v, keys)),
        Value::Object(v) => {
            for (mut k, mut val) in std::mem::take(v) {
                string(&mut k, keys);
                redact(&mut val, keys);
                v.insert(k, val);
            }
        }
        _ => {}
    }
}

pub fn environment_file(root: &Path, vars: &[(&str, &str)]) -> Result<tempfile::NamedTempFile> {
    let mut file = input_file(root, "env-")?;
    for (k, v) in vars {
        ensure!(
            !v.contains(['\n', '\r', '\0']),
            "The credential or endpoint contains an unsupported line break."
        );
        writeln!(file, "{k}={v}")?;
    }
    file.flush()?;
    Ok(file)
}

pub fn prompt_file(root: &Path, prompt: &str) -> Result<tempfile::NamedTempFile> {
    let mut file = input_file(root, "prompt-")?;
    file.write_all(prompt.as_bytes())?;
    file.flush()?;
    Ok(file)
}

fn input_file(root: &Path, prefix: &str) -> Result<tempfile::NamedTempFile> {
    Ok(tempfile::Builder::new()
        .prefix(prefix)
        .tempfile_in(root.join("rust-inputs"))?)
}

// Runs under the worker lock, before it takes any new leases.
pub fn recover_inputs(root: &Path) -> Result<()> {
    let directory = root.join("rust-inputs");
    crate::directory(&directory)?;
    for item in fs::read_dir(directory)? {
        let item = item?;
        if item.file_type()?.is_file()
            && item
                .file_name()
                .to_str()
                .is_some_and(|n| n.starts_with("env-") || n.starts_with("prompt-"))
        {
            fs::remove_file(item.path())?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn embedded_images_contain_native_headless_entrypoints() {
        let dir = tempfile::tempdir().unwrap();
        let recipe = hermes_context(dir.path()).unwrap();
        let recipe = fs::read_to_string(recipe).unwrap();
        assert!(
            recipe.contains("cargo build --release --locked")
                && recipe.contains("COPY --from=agent-tools")
        );
        for unwanted in [
            "xvfb",
            "openbox",
            "computer-use install",
            "nodejs",
            "coordination.mjs",
        ] {
            assert!(!recipe.contains(unwanted));
        }
        assert!(
            dir.path()
                .join("runtime/agent-tools/src/slack.rs")
                .is_file()
        );
        for h in ["claude-code", "codex"] {
            let dockerfile = cli_recipe(h).unwrap();
            assert!(dockerfile.contains(cli_version(h).unwrap()));
            let runtime = dockerfile
                .split("FROM debian:bookworm-slim")
                .nth(1)
                .unwrap();
            assert!(!runtime.contains("npm") && !runtime.contains("node"));
            assert!(dockerfile.contains("amd64)") && dockerfile.contains("arm64)"));
        }
    }
    #[test]
    fn shared_folders_exclude_neighboring_worker_state_and_engine_socket() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().join("local");
        fs::create_dir(&root).unwrap();
        let project = temp.path().join("project");
        fs::create_dir(&project).unwrap();
        let state = project.join("nested").join("another-worker");
        fs::create_dir_all(&state).unwrap();
        fs::write(state.join("rust-connection.json"), "fixture").unwrap();
        let nested = state.join("agents");
        fs::create_dir(&nested).unwrap();
        assert!(check_shared_folder(&nested, &root, None, None).is_err());
        assert!(check_shared_folder(&project, &root, None, None).is_err());
        let public = temp.path().join("work");
        fs::create_dir(&public).unwrap();
        assert!(check_shared_folder(&public, &root, None, None).is_ok());
        assert!(
            check_shared_folder(&public, &root, Some(&public.join("custom.sock")), None).is_err()
        );
    }
}
