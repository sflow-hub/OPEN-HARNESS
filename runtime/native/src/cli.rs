use crate::{mock_mode, profiles, server};
use anyhow::{Context, Result, bail, ensure};
use clap::{Parser, Subcommand, builder::PossibleValuesParser};
use open_harness_runner::harnesses;
use reqwest::{Client, Method};
use serde_json::{Value, json};
use std::{
    fs,
    io::{Read, Write},
    net::{IpAddr, Ipv4Addr},
    os::unix::{fs::OpenOptionsExt, process::CommandExt},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    time::Duration,
};

#[derive(Parser)]
#[command(
    name = "open-harness",
    version,
    about = "Run named agents on headless container workers"
)]
struct Args {
    #[arg(long, global = true, env = "OPEN_HARNESS_STATE_DIR")]
    state_dir: Option<PathBuf>,
    #[arg(long, global = true, env = "OPEN_HARNESS_PORT", default_value_t = 4317)]
    port: u16,
    #[arg(long,global=true,env="OPEN_HARNESS_BIND",default_value_t=IpAddr::V4(Ipv4Addr::LOCALHOST))]
    bind: IpAddr,
    #[command(subcommand)]
    command: Option<Action>,
}
#[derive(Subcommand)]
enum Action {
    /// Serve the dashboard, coordinator and local worker in the foreground.
    Serve,
    /// Start a detached service, logging to the state directory.
    Start {
        /// Open the ready dashboard in the default browser.
        #[arg(long)]
        open: bool,
    },
    /// Gracefully stop the coordinator and its local worker.
    Stop,
    /// Build a pinned worker image. With no argument, prepare Hermes, Claude Code and Codex.
    Setup {
        #[arg(value_parser = harness_parser())]
        harness: Option<String>,
        /// Prepare every harness in the worker catalog.
        #[arg(long, conflicts_with = "harness")]
        all: bool,
    },
    /// Report the service and container engine's readiness.
    Doctor {
        #[arg(long)]
        json: bool,
    },
    Status {
        #[arg(long)]
        json: bool,
    },
    /// Install a service for this user on Linux or macOS.
    InstallService,
    /// Print the local operator's access token.
    Token,
    /// Pair a separate worker or reconnect it using its saved identity.
    Runner {
        #[arg(long, requires = "pairing_code")]
        coordinator: Option<String>,
        #[arg(long, requires = "coordinator", allow_hyphen_values = true)]
        pairing_code: Option<String>,
        #[arg(long)]
        once: bool,
    },
    /// Use a named agent from its assigned worker.
    Worker {
        #[command(subcommand)]
        action: open_harness_runner::worker_local::Action,
    },
    #[command(hide = true)]
    LocalWorker {
        #[arg(long)]
        url: String,
    },
    /// List agents and create named agents with a headless harness.
    Agent {
        #[command(subcommand)]
        action: AgentAction,
    },
    /// Submit a run; pass --wait to follow its result.
    Run {
        #[arg(long)]
        agent: String,
        prompt: String,
        #[arg(long)]
        wait: bool,
    },
    /// Read an existing run and its saved events.
    Events {
        run_id: String,
        #[arg(long, default_value_t = 0)]
        after: u64,
    },
    /// Assign an agent a provider credential from standard input.
    Credential {
        #[arg(long)]
        agent: String,
        #[arg(long)]
        provider: String,
        #[arg(long)]
        reference: String,
    },
    /// Make an authenticated request to the local operator API. Read JSON from standard input using --stdin.
    Api {
        #[arg(value_parser=["GET","POST","PUT","DELETE","PATCH"])]
        method: String,
        path: String,
        #[arg(long)]
        stdin: bool,
    },
    Version,
}
#[derive(Subcommand)]
enum AgentAction {
    List,
    Add {
        name: String,
        #[arg(long)]
        id: Option<String>,
        /// Assign the new agent directly to a paired worker (default: local).
        #[arg(long)]
        machine: Option<String>,
        #[arg(long, default_value = "hermes", value_parser = harness_parser())]
        harness: String,
        #[arg(long)]
        model: Option<String>,
        /// Provider ID, such as openai, anthropic, xai, openrouter, local or custom.
        #[arg(long, requires = "model")]
        provider: Option<String>,
        #[arg(long, requires = "model")]
        base_url: Option<String>,
        #[arg(long, requires = "model")]
        credential_ref: Option<String>,
        /// Use the saved model configuration or the agent's ChatGPT plan.
        #[arg(long, default_value="configured", value_parser=["configured","chatgpt-plan"])]
        model_auth: String,
        /// Allow local commands on the assigned machine to launch this agent.
        #[arg(long)]
        worker_launch: bool,
    },
    /// Change worker launch access or billing for an existing agent.
    Access {
        #[arg(long)]
        agent: String,
        #[arg(long, value_parser=["enable","disable"])]
        worker_launch: Option<String>,
        #[arg(long, value_parser=["configured","chatgpt-plan"])]
        model_auth: Option<String>,
    },
}
fn harness_parser() -> PossibleValuesParser {
    PossibleValuesParser::new(harnesses::HARNESSES.iter().map(|harness| harness.id))
}
fn output(v: &Value) -> Result<()> {
    println!("{}", serde_json::to_string_pretty(v)?);
    Ok(())
}
struct Operator {
    client: Client,
    url: String,
    token: String,
}
impl Operator {
    async fn connect(port: u16, bind: IpAddr) -> Result<Self> {
        let ip = if bind.is_ipv6() { "[::1]" } else { "127.0.0.1" };
        let url = format!("http://{ip}:{port}");
        let client = Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(45))
            .build()?;
        let bootstrap: Value = client
            .get(format!("{url}/v1/bootstrap"))
            .timeout(Duration::from_secs(3))
            .send()
            .await
            .context("Could not reach Open Harness on its local port")?
            .error_for_status()?
            .json()
            .await?;
        let token = bootstrap["token"]
            .as_str()
            .context("The port is not serving an Open Harness coordinator.")?
            .to_owned();
        Ok(Self { client, url, token })
    }
    async fn call(&self, method: Method, path: &str, payload: Option<&Value>) -> Result<Value> {
        ensure!(
            path.starts_with("/v1/") && !path.contains(['\n', '\r', '#']),
            "Choose a local /v1/ endpoint."
        );
        let mut req = self
            .client
            .request(method, format!("{}{path}", self.url))
            .bearer_auth(&self.token);
        if let Some(body) = payload {
            req = req.json(body);
        }
        let res = req.send().await?;
        let status = res.status();
        let v: Value = res.json().await?;
        ensure!(
            status.is_success(),
            "HTTP {}: {}",
            status,
            v["error"]
                .as_str()
                .unwrap_or("The operator request failed.")
        );
        Ok(v)
    }
}
fn state(path: Option<&Path>) -> Result<PathBuf> {
    Ok(path
        .filter(|p| !p.as_os_str().is_empty())
        .map(Path::to_owned)
        .unwrap_or(std::env::current_dir()?.join(".open-harness")))
}
async fn start(root: &Path, port: u16, bind: IpAddr) -> Result<Operator> {
    if let Ok(operator) = Operator::connect(port, bind).await {
        println!("Open Harness is already running on port {port}.");
        return Ok(operator);
    }
    let root = server::state_dir(root)?;
    let log = fs::OpenOptions::new()
        .append(true)
        .create(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(root.join("native-service.log"))?;
    let mut child = Command::new(std::env::current_exe()?)
        .args([
            "serve",
            "--port",
            &port.to_string(),
            "--bind",
            &bind.to_string(),
            "--state-dir",
        ])
        .arg(&root)
        .stdin(Stdio::null())
        .stdout(log.try_clone()?)
        .stderr(log)
        .process_group(0)
        .spawn()?;
    for _ in 0..100 {
        if let Ok(operator) = Operator::connect(port, bind).await {
            println!("Open Harness is running on port {port}.");
            return Ok(operator);
        }
        if child.try_wait()?.is_some() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(120)).await;
    }
    bail!(
        "Open Harness did not become ready. Inspect {}.",
        root.join("native-service.log").display()
    )
}

fn open_dashboard(url: &str) -> Result<()> {
    let opener = if cfg!(target_os = "macos") {
        "open"
    } else {
        "xdg-open"
    };
    println!("Dashboard: {url}");
    let status = Command::new(opener)
        .arg(url)
        .status()
        .with_context(|| format!("Could not launch {opener}. Open {url} in your browser."))?;
    ensure!(
        status.success(),
        "Could not open the dashboard. Open {url} in your browser."
    );
    Ok(())
}

pub async fn main() -> Result<()> {
    let args = Args::parse();
    let root = state(args.state_dir.as_deref())?;
    match args.command.unwrap_or(Action::Serve) {
        Action::Serve => server::serve(&root, args.bind, args.port).await,
        Action::Version => {
            println!("{}", env!("CARGO_PKG_VERSION"));
            Ok(())
        }
        Action::Token => {
            println!("{}", profiles::control_token(&server::state_dir(&root)?)?);
            Ok(())
        }
        Action::LocalWorker { url } => {
            // EOF on the inherited pipe also stops this worker if its coordinator crashes.
            std::thread::spawn(|| {
                let mut byte = [0u8; 1];
                let _ = std::io::stdin().read(&mut byte);
                unsafe {
                    libc::kill(libc::getpid(), libc::SIGTERM);
                }
            });
            open_harness_runner::start_local(
                root,
                url,
                std::env::var("OPEN_HARNESS_LOCAL_PAIR_CODE").ok(),
            )
            .await
        }
        Action::Runner {
            coordinator,
            pairing_code,
            once,
        } => {
            let runner = match args
                .state_dir
                .or_else(|| std::env::var_os("OPEN_HARNESS_RUNNER_STATE_DIR").map(PathBuf::from))
            {
                Some(root) => root,
                None => PathBuf::from(
                    std::env::var_os("HOME").context("Set HOME or pass --state-dir.")?,
                )
                .join(".open-harness-rust-runner"),
            };
            open_harness_runner::start(runner, coordinator.zip(pairing_code), once).await
        }
        Action::Worker { action } => {
            let worker = open_harness_runner::worker_local::client_root(
                args.state_dir.as_deref(),
                Some(&root),
            )?;
            open_harness_runner::worker_local::command(&worker, action).await
        }
        Action::Setup { harness, all } => {
            for spec in &harnesses::HARNESSES {
                let selected = harness.as_deref().map_or(
                    all || harnesses::LEGACY_HARNESSES.contains(&spec.id),
                    |id| id == spec.id,
                );
                if selected {
                    open_harness_runner::install(spec.id).await?;
                    println!("{} ready", spec.id);
                }
            }
            Ok(())
        }
        Action::Start { open } => {
            let operator = start(&root, args.port, args.bind).await?;
            if open {
                open_dashboard(&operator.url)?;
            }
            Ok(())
        }
        Action::InstallService => install_service(&root, args.port, args.bind),
        action => {
            let connection = Operator::connect(args.port, args.bind).await;
            if matches!(action, Action::Doctor { .. } | Action::Status { .. }) {
                let docker = if mock_mode() {
                    true
                } else {
                    tokio::time::timeout(
                        Duration::from_secs(6),
                        tokio::process::Command::new("docker")
                            .arg("info")
                            .stdin(Stdio::null())
                            .stdout(Stdio::null())
                            .stderr(Stdio::null())
                            .kill_on_drop(true)
                            .status(),
                    )
                    .await
                    .ok()
                    .and_then(Result::ok)
                    .is_some_and(|s| s.success())
                };
                let ok = connection.is_ok();
                let v = json!({"version":env!("CARGO_PKG_VERSION"),"implementation":"rust","headless":true,"platform":std::env::consts::OS,"coordinator":{"listening":ok,"port":args.port},"docker":{"available":docker},"stateDir":{"path":root,"initialized":root.join("state.db").is_file()}});
                output(&v)?;
                if matches!(action, Action::Doctor { .. }) && !docker {
                    bail!("Start a Docker-compatible engine for headless execution.")
                }
                return Ok(());
            }
            let op = connection?;
            let result = match action {
                Action::Stop => {
                    let result = op.call(Method::POST, "/v1/shutdown", None).await?;
                    let until = tokio::time::Instant::now()
                        + open_harness_runner::STOP_TIMEOUT
                        + Duration::from_secs(15);
                    while op
                        .client
                        .get(format!("{}/api/health", op.url))
                        .timeout(Duration::from_secs(1))
                        .send()
                        .await
                        .is_ok()
                    {
                        ensure!(
                            tokio::time::Instant::now() < until,
                            "The coordinator is still shutting down."
                        );
                        tokio::time::sleep(Duration::from_millis(150)).await;
                    }
                    result
                }
                Action::Agent {
                    action:
                        AgentAction::Access {
                            agent,
                            worker_launch,
                            model_auth,
                        },
                } => {
                    ensure!(crate::profiles::valid_agent_id(&agent), "Invalid agent ID.");
                    ensure!(
                        worker_launch.is_some() || model_auth.is_some(),
                        "Choose --worker-launch or --model-auth."
                    );
                    let path = format!("/v1/agents/{agent}/profile");
                    let mut p = op.call(Method::GET, &path, None).await?["profile"].take();
                    if let Some(access) = worker_launch {
                        p["workerLaunch"] = json!(access == "enable");
                    }
                    if let Some(auth) = model_auth {
                        if auth == "chatgpt-plan" {
                            p["model"]["credentialRef"] = json!("");
                            p["model"]["baseUrl"] = json!("");
                        } else if p["modelAuth"] == "chatgpt-plan" {
                            p["model"]["credentialRef"] = json!("OPENAI_API_KEY");
                        }
                        p["modelAuth"] = json!(auth);
                    }
                    op.call(Method::PUT, &path, Some(&p)).await?
                }
                Action::Agent {
                    action: AgentAction::List,
                } => op.call(Method::GET, "/v1/agents", None).await?,
                Action::Agent {
                    action:
                        AgentAction::Add {
                            name,
                            id,
                            machine,
                            harness,
                            model,
                            provider,
                            base_url,
                            credential_ref,
                            model_auth,
                            worker_launch,
                        },
                } => {
                    let mut p = json!({"name":name,"harness":harness,"modelAuth":model_auth,"workerLaunch":worker_launch});
                    if let Some(id) = id {
                        p["id"] = json!(id);
                    }
                    if let Some(machine) = machine {
                        p["machineId"] = json!(machine);
                    }
                    if let Some(m) = model {
                        let default = match harness.as_str() {
                            "claude-code" => "anthropic",
                            "codex" => "openai",
                            id if harnesses::is_additional(id) => "xai",
                            _ => "local",
                        };
                        p["model"] = json!({"inherit":false,"model":m,"provider":provider.as_deref().unwrap_or(default),"baseUrl":base_url.unwrap_or_default(),"credentialRef":credential_ref.unwrap_or_default()});
                    }
                    op.call(Method::POST, "/v1/agents", Some(&p)).await?
                }
                Action::Run {
                    agent,
                    prompt,
                    wait,
                } => {
                    let mut r = op
                        .call(
                            Method::POST,
                            "/v1/runs",
                            Some(&json!({"agentId":agent,"prompt":prompt})),
                        )
                        .await?;
                    let path = format!("/v1/runs/{}", r["id"].as_str().context("Missing run ID.")?);
                    if wait {
                        while matches!(
                            r["state"].as_str(),
                            Some("queued" | "running" | "waiting_approval" | "waiting_input")
                        ) {
                            tokio::time::sleep(Duration::from_millis(400)).await;
                            r = op.call(Method::GET, &path, None).await?;
                        }
                        if r["state"] != "completed" {
                            output(&r)?;
                            bail!("Run finished with state {}.", r["state"]);
                        }
                    }
                    r
                }
                Action::Events { run_id, after } => {
                    uuid::Uuid::parse_str(&run_id).context("Expected a run UUID")?;
                    op.call(
                        Method::GET,
                        &format!("/v1/runs/{run_id}/events?after={after}"),
                        None,
                    )
                    .await?
                }
                Action::Credential {
                    agent,
                    provider,
                    reference,
                } => {
                    let mut secret = String::new();
                    std::io::stdin().take(65537).read_to_string(&mut secret)?;
                    let value = secret.trim_end_matches(['\n', '\r']);
                    ensure!(
                        !value.is_empty() && value.len() <= 65536,
                        "Pass the credential value on standard input."
                    );
                    let list = op.call(Method::GET, "/v1/credentials", None).await?;
                    if list["credentials"]
                        .as_array()
                        .is_some_and(|cs| cs.iter().any(|c| c["ref"] == reference))
                    {
                        ensure!(
                            reference
                                .bytes()
                                .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == b'_'),
                            "Invalid credential reference."
                        );
                        op.call(
                            Method::POST,
                            &format!("/v1/credentials/{reference}/value"),
                            Some(&json!({"value":value})),
                        )
                        .await?;
                    } else {
                        op.call(Method::POST,"/v1/credentials",Some(&json!({"ref":reference,"provider":provider,"label":reference,"value":value}))).await?;
                    }
                    ensure!(
                        agent
                            .bytes()
                            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_')),
                        "Invalid agent ID."
                    );
                    op.call(
                        Method::PUT,
                        &format!("/v1/agents/{agent}/credential"),
                        Some(&json!({"ref":reference})),
                    )
                    .await?
                }
                Action::Api {
                    method,
                    path,
                    stdin,
                } => {
                    let v = if stdin {
                        Some(serde_json::from_reader(std::io::stdin().lock())?)
                    } else {
                        None
                    };
                    op.call(Method::from_bytes(method.as_bytes())?, &path, v.as_ref())
                        .await?
                }
                _ => unreachable!(),
            };
            output(&result)
        }
    }
}
fn install_service(root: &Path, port: u16, bind: IpAddr) -> Result<()> {
    let binary = std::env::current_exe()?;
    let root = server::state_dir(root)?;
    let home = PathBuf::from(std::env::var_os("HOME").context("HOME is not set.")?);
    let args = [
        binary
            .to_str()
            .context("Service executable path must be UTF-8.")?,
        "serve",
        "--state-dir",
        root.to_str().context("State path must be UTF-8.")?,
        "--port",
        &port.to_string(),
        "--bind",
        &bind.to_string(),
    ];
    let (file, contents) = if cfg!(target_os = "macos") {
        let escape = |s: &&str| {
            format!(
                "<string>{}</string>",
                s.replace('&', "&amp;")
                    .replace('<', "&lt;")
                    .replace('>', "&gt;")
            )
        };
        (
            home.join("Library/LaunchAgents/dev.openharness.native.plist"),
            format!(
                r#"<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>Label</key><string>dev.openharness.native</string><key>ProgramArguments</key><array>{}</array><key>RunAtLoad</key><true/><key>ExitTimeOut</key><integer>240</integer><key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict></dict></plist>"#,
                args.iter().map(escape).collect::<String>()
            ),
        )
    } else {
        let quote = |s: &&str| {
            format!(
                "\"{}\"",
                s.replace('\\', "\\\\")
                    .replace('"', "\\\"")
                    .replace('%', "%%")
                    .replace('$', "$$")
            )
        };
        (
            std::env::var_os("XDG_CONFIG_HOME")
                .map(PathBuf::from)
                .unwrap_or_else(|| home.join(".config"))
                .join("systemd/user/open-harness.service"),
            format!(
                "[Unit]\nDescription=Open Harness headless coordinator\nAfter=network.target docker.service\n\n[Service]\nExecStart={}\nRestart=on-failure\nTimeoutStopSec=240s\n\n[Install]\nWantedBy=default.target\n",
                args.iter().map(quote).collect::<Vec<_>>().join(" ")
            ),
        )
    };
    ensure!(
        !args.iter().any(|s| s.contains(['\n', '\r'])),
        "Unsupported service path."
    );
    fs::create_dir_all(file.parent().unwrap())?;
    let mut temp = tempfile::NamedTempFile::new_in(file.parent().unwrap())?;
    temp.write_all(contents.as_bytes())?;
    temp.persist(&file)?;
    if cfg!(target_os = "macos") {
        let domain = format!("gui/{}", unsafe { libc::geteuid() });
        let target = format!("{domain}/dev.openharness.native");
        let exists = Command::new("launchctl")
            .args(["print", &target])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()?
            .success();
        let result = if exists {
            Command::new("launchctl")
                .args(["kickstart", &target])
                .status()?
        } else {
            Command::new("launchctl")
                .args(["bootstrap", &domain])
                .arg(&file)
                .status()?
        };
        ensure!(
            result.success(),
            "The LaunchAgent was written but launchd could not activate it."
        );
    } else {
        ensure!(
            Command::new("systemctl")
                .args(["--user", "daemon-reload"])
                .status()?
                .success(),
            "The unit was written but systemd could not reload it."
        );
        ensure!(
            Command::new("systemctl")
                .args(["--user", "enable", "--now", "open-harness.service"])
                .status()?
                .success(),
            "The unit was written but systemd could not start it."
        );
    }
    println!("Installed {}", file.display());
    Ok(())
}
