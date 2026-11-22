//! Exercise the installed executable and its real polling worker over loopback. Inference
//! alone is simulated. No executable from PATH, display server, or browser is available.
use anyhow::{Context, Result, bail, ensure};
use reqwest::{Client, Method, RequestBuilder, StatusCode};
use serde_json::{Value, json};
use std::{
    collections::HashSet,
    fs::OpenOptions,
    os::unix::process::CommandExt,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    time::Duration,
};
use tempfile::TempDir;
use tokio::time::{Instant, sleep};

const BINARY: &str = env!("CARGO_BIN_EXE_open-harness");
const LIMIT: Duration = Duration::from_secs(45);
const HARNESSES: [(&str, &str, &str); 6] = [
    ("atlas", "hermes", "Hermes"),
    ("ada", "claude-code", "Claude Code"),
    ("scout", "codex", "Codex"),
    ("builder", "opencode", "OpenCode"),
    ("analyst", "pi", "Pi"),
    ("maintainer", "openhands", "OpenHands"),
];

struct Process(Option<Child>);
impl Process {
    fn start(args: &[&str], log: &Path, state: &Path, empty_bin: &Path) -> Result<Self> {
        let output = OpenOptions::new().create(true).append(true).open(log)?;
        let mut cmd = Command::new(BINARY);
        cmd.args(args)
            .env_clear()
            .env("OPEN_HARNESS_MOCK", "1")
            .env("OPEN_HARNESS_DISABLE_OS_VAULT", "1")
            .env("OPEN_HARNESS_RUNNER_STATE_DIR", state)
            .env("PATH", empty_bin)
            .env("NO_PROXY", "127.0.0.1,localhost")
            .current_dir(state)
            .stdin(Stdio::null())
            .stdout(output.try_clone()?)
            .stderr(output)
            .process_group(0);
        Ok(Self(Some(cmd.spawn()?)))
    }
    async fn stopped(&mut self) -> Result<()> {
        let until = Instant::now() + Duration::from_secs(15);
        let child = self.0.as_mut().context("Process already stopped")?;
        loop {
            if let Some(status) = child.try_wait()? {
                ensure!(status.success(), "Native service exited with {status}");
                self.0 = None;
                return Ok(());
            }
            ensure!(
                Instant::now() < until,
                "Timed out waiting for native service shutdown"
            );
            sleep(Duration::from_millis(40)).await;
        }
    }
}
impl Drop for Process {
    fn drop(&mut self) {
        if let Some(mut child) = self.0.take() {
            // A failing assertion must also release the separately spawned local worker.
            unsafe {
                libc::kill(-(child.id() as i32), libc::SIGKILL);
            }
            let _ = child.wait();
        }
    }
}

struct Service {
    _files: TempDir,
    state: PathBuf,
    empty_bin: PathBuf,
    process: Process,
    url: String,
    token: String,
}
impl Service {
    async fn launch() -> Result<Self> {
        let files = tempfile::tempdir()?;
        let state = files.path().join("state");
        std::fs::create_dir(&state)?;
        let empty_bin = files.path().join("empty-bin");
        std::fs::create_dir(&empty_bin)?;
        let mut service = Self {
            _files: files,
            state,
            empty_bin,
            process: Process(None),
            url: String::new(),
            token: String::new(),
        };
        service.open().await?;
        Ok(service)
    }
    async fn open(&mut self) -> Result<()> {
        let log = self
            .state
            .join(format!("fixture-{}.log", uuid::Uuid::new_v4()));
        self.process = Process::start(
            &[
                "serve",
                "--port",
                "0",
                "--state-dir",
                self.state.to_str().context("Invalid temp path")?,
            ],
            &log,
            &self.state,
            &self.empty_bin,
        )?;
        let client = client()?;
        let until = Instant::now() + LIMIT;
        loop {
            let output = std::fs::read_to_string(&log)?;
            if let Some(status) = self.process.0.as_mut().unwrap().try_wait()? {
                bail!("Native service exited with {status}: {output}");
            }
            if let Some(url) = output
                .lines()
                .filter_map(|line| line.split_once(" serving "))
                .filter_map(|(_, tail)| tail.split_whitespace().next())
                .find(|s| s.starts_with("http://127.0.0.1:"))
            {
                self.url = url.to_owned();
                if let Ok(res) = client.get(format!("{url}/v1/bootstrap")).send().await
                    && res.status() == StatusCode::OK
                {
                    let bootstrap: Value = res.json().await?;
                    if bootstrap["runtime"]["available"] == true {
                        self.token = field(&bootstrap, "token")?.to_owned();
                        return Ok(());
                    }
                }
            }
            ensure!(
                Instant::now() < until,
                "Native coordinator and worker did not become ready: {output}"
            );
            sleep(Duration::from_millis(100)).await;
        }
    }
    fn operator(&self, client: &Client, method: Method, path: &str) -> RequestBuilder {
        client
            .request(method, format!("{}{path}", self.url))
            .bearer_auth(&self.token)
    }
    async fn cli(&self, args: &[&str]) -> Result<Value> {
        let port = reqwest::Url::parse(&self.url)?
            .port()
            .context("Missing port")?;
        let mut cmd = tokio::process::Command::new(BINARY);
        cmd.env_clear()
            .env("PATH", &self.empty_bin)
            .arg("--port")
            .arg(port.to_string())
            .arg("--state-dir")
            .arg(&self.state)
            .args(args)
            .current_dir(&self.state)
            .stdin(Stdio::null())
            .kill_on_drop(true);
        let r = tokio::time::timeout(LIMIT, cmd.output()).await??;
        ensure!(
            r.status.success(),
            "Native CLI command failed: {}",
            String::from_utf8_lossy(&r.stderr)
        );
        Ok(serde_json::from_slice(&r.stdout)?)
    }
    async fn stop(&mut self) -> Result<()> {
        checked(self.operator(&client()?, Method::POST, "/v1/shutdown")).await?;
        self.process.stopped().await
    }
}
fn client() -> Result<Client> {
    Ok(Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(5))
        .build()?)
}
async fn checked(req: RequestBuilder) -> Result<Value> {
    let res = req.send().await?;
    let status = res.status();
    let body: Value = res.json().await?;
    ensure!(status.is_success(), "HTTP {status}: {}", body["error"]);
    Ok(body)
}
fn field<'a>(v: &'a Value, key: &str) -> Result<&'a str> {
    v[key]
        .as_str()
        .with_context(|| format!("Missing field {key}"))
}
async fn wait_state(s: &Service, client: &Client, key: &str, wanted: &str) -> Result<Value> {
    let until = Instant::now() + LIMIT;
    loop {
        let r = checked(s.operator(client, Method::GET, &format!("/v1/runs/{key}"))).await?;
        if r["state"] == wanted {
            return Ok(r);
        }
        ensure!(
            !matches!(
                r["state"].as_str(),
                Some("failed" | "cancelled" | "interrupted" | "completed")
            ),
            "Expected {wanted}, run ended as {}: {}",
            r["state"],
            r["error"]
        );
        ensure!(
            Instant::now() < until,
            "Run {key} remained {} while awaiting {wanted}",
            r["state"]
        );
        sleep(Duration::from_millis(100)).await;
    }
}
async fn events(s: &Service, c: &Client, key: &str, after: u64) -> Result<Vec<Value>> {
    let log = checked(s.operator(
        c,
        Method::GET,
        &format!("/v1/runs/{key}/events?after={after}"),
    ))
    .await?;
    log["events"]
        .as_array()
        .cloned()
        .context("Missing event list")
}
async fn submit(s: &Service, c: &Client, agent: &str, prompt: &str) -> Result<String> {
    let run = checked(
        s.operator(c, Method::POST, "/v1/runs")
            .json(&json!({"agentId":agent,"prompt":prompt})),
    )
    .await?;
    Ok(field(&run, "id")?.into())
}
async fn add_agents(s: &Service, c: &Client) -> Result<()> {
    for (id, harness, name) in HARNESSES {
        checked(
            s.operator(c, Method::POST, "/v1/agents")
                .json(&json!({"id":id,"name":name,"harness":harness})),
        )
        .await?;
    }
    Ok(())
}
#[tokio::test]
async fn all_harnesses_finish_without_a_connected_client_and_replay_after_restart() -> Result<()> {
    let mut s = Service::launch().await?;
    let browser = client()?;
    assert_eq!(
        browser
            .get(format!("{}/v1/bootstrap", s.url))
            .header("Origin", "http://localhost:3000")
            .send()
            .await?
            .status(),
        StatusCode::FORBIDDEN
    );
    add_agents(&s, &browser).await?;
    let client_dir = tempfile::tempdir()?;
    let port = reqwest::Url::parse(&s.url)?
        .port()
        .context("Missing fixture port")?;
    std::fs::write(
        client_dir.path().join(".env"),
        format!("OPEN_HARNESS_PORT={port}\n"),
    )?;
    let listed = Command::new(BINARY)
        .args(["agent", "list"])
        .current_dir(client_dir.path())
        .env_remove("OPEN_HARNESS_PORT")
        .env_remove("OPEN_HARNESS_BIND")
        .output()?;
    ensure!(
        listed.status.success(),
        "CLI using workspace .env: {}",
        String::from_utf8_lossy(&listed.stderr)
    );
    assert!(String::from_utf8(listed.stdout)?.contains("scout"));
    let mut runs = vec![];
    for (agent, harness, name) in HARNESSES {
        let route = format!("/v1/agents/{agent}/profile");
        let original = checked(s.operator(&browser, Method::GET, &route)).await?;
        let mut edited = original["profile"].clone();
        edited["computer"]["desktop"] = json!("virtual");
        assert_eq!(
            s.operator(&browser, Method::PUT, &route)
                .json(&edited)
                .send()
                .await?
                .status(),
            StatusCode::BAD_REQUEST
        );
        assert_eq!(
            checked(s.operator(&browser, Method::GET, &route)).await?["profile"],
            original["profile"]
        );
        let key = submit(&s, &browser, agent, "MOCK_SLOW summarize the brief").await?;
        runs.push((agent, harness, name, key));
    }
    drop(browser);
    let reader = client()?;
    let mut replay = vec![];
    for (agent, harness, name, key) in &runs {
        let r = wait_state(&s, &reader, key, "completed").await?;
        assert_eq!(r["agent_id"], *agent);
        assert_eq!(r["result"], format!("{name} mock completed the task."));
        let all = events(&s, &reader, key, 0).await?;
        let snapshot = all
            .iter()
            .find(|v| v["type"] == "profile.applied")
            .context("Missing immutable run profile")?;
        assert_eq!(snapshot["payload"]["harness"], *harness);
        assert_eq!(snapshot["payload"]["computer"]["desktop"], "none");
        assert_eq!(snapshot["payload"]["computer"]["access"], "private");
        assert!(
            all.iter()
                .any(|v| v["type"] == "gateway.ready" && v["payload"]["harness"] == *harness)
        );
        assert_eq!(
            all.iter().filter(|v| v["type"] == "run.completed").count(),
            1
        );
        assert!(
            all.windows(2)
                .all(|w| w[0]["seq"].as_u64() < w[1]["seq"].as_u64())
        );
        assert_eq!(
            all.iter()
                .map(|e| field(e, "id"))
                .collect::<Result<HashSet<_>>>()?
                .len(),
            all.len()
        );
        let cutoff = all.len() / 2;
        assert_eq!(
            events(&s, &reader, key, all[cutoff - 1]["seq"].as_u64().unwrap()).await?,
            all[cutoff..]
        );
        replay.push(all);
    }
    // The run still belongs to the originating agent after both clients and the
    // coordinator process have exited. Re-opening the database cannot execute it twice.
    drop(reader);
    s.stop().await?;
    s.open().await?;
    let reopened = client()?;
    for ((agent, _, _, key), saved) in runs.iter().zip(replay) {
        assert_eq!(
            wait_state(&s, &reopened, key, "completed").await?["agent_id"],
            *agent
        );
        assert_eq!(events(&s, &reopened, key, 0).await?, saved);
    }
    assert_eq!(
        checked(s.operator(&reopened, Method::GET, "/v1/runs")).await?["runs"]
            .as_array()
            .unwrap()
            .len(),
        HARNESSES.len()
    );
    s.stop().await
}

#[tokio::test]
async fn additional_harnesses_offer_all_model_connections() -> Result<()> {
    let mut s = Service::launch().await?;
    let c = client()?;
    let catalog = checked(s.operator(&c, Method::GET, "/v1/harnesses")).await?;
    let catalog = catalog["harnesses"]
        .as_array()
        .context("Missing harness catalog")?;
    assert_eq!(catalog.len(), HARNESSES.len());
    let providers = [
        ("openai", "OPENAI_API_KEY"),
        ("anthropic", "ANTHROPIC_API_KEY"),
        ("xai", "XAI_API_KEY"),
        ("openrouter", "OPENROUTER_API_KEY"),
        ("local", ""),
        ("custom", ""),
    ];
    for (agent, harness, name) in &HARNESSES[3..] {
        let entry = catalog
            .iter()
            .find(|item| item["id"] == *harness)
            .context("Missing harness")?;
        assert_eq!(entry["name"], *name);
        assert_eq!(entry["headless"], true);
        assert_eq!(
            entry["modelProviders"],
            json!(providers.map(|(provider, _)| provider))
        );
        let created = checked(
            s.operator(&c, Method::POST, "/v1/agents")
                .json(&json!({"id":agent,"name":name,"harness":harness})),
        )
        .await?;
        assert_eq!(created["profile"]["model"]["provider"], "xai");
        assert_eq!(created["profile"]["model"]["credentialRef"], "XAI_API_KEY");
        assert_eq!(created["profile"]["model"]["inherit"], false);
        let mut profile = created["profile"].clone();
        let route = format!("/v1/agents/{agent}/profile");
        for (provider, reference) in providers {
            let base = if matches!(provider, "local" | "custom") {
                "http://model.invalid/v1"
            } else {
                ""
            };
            profile["model"] = json!({"inherit":false,"provider":provider,"model":"fixture-model","credentialRef":"","baseUrl":base});
            let saved = checked(s.operator(&c, Method::PUT, &route).json(&profile)).await?;
            profile = saved["profile"].clone();
            assert_eq!(profile["model"]["provider"], provider);
            assert_eq!(profile["model"]["credentialRef"], reference);
            assert_eq!(profile["model"]["baseUrl"], base);
        }
        profile["model"]["baseUrl"] = json!("");
        assert_eq!(
            s.operator(&c, Method::PUT, &route)
                .json(&profile)
                .send()
                .await?
                .status(),
            StatusCode::BAD_REQUEST,
        );
        profile["model"]["provider"] = json!("unsupported");
        assert_eq!(
            s.operator(&c, Method::PUT, &route)
                .json(&profile)
                .send()
                .await?
                .status(),
            StatusCode::BAD_REQUEST,
        );
    }
    s.stop().await
}

#[tokio::test]
async fn switching_harnesses_keeps_the_active_revision_and_dormant_grants() -> Result<()> {
    let mut s = Service::launch().await?;
    let c = client()?;
    let created = checked(
        s.operator(&c, Method::POST, "/v1/agents")
            .json(&json!({"id":"switcher","name":"Switcher","harness":"opencode"})),
    )
    .await?;
    let before = created["profile"]["revision"].clone();
    let run = submit(&s, &c, "switcher", "MOCK_SLOW update a report").await?;
    wait_state(&s, &c, &run, "running").await?;
    let route = "/v1/agents/switcher/profile";
    let mut profile = created["profile"].clone();
    profile["harness"] = json!("openhands");
    profile["allowedTools"] = json!(["write_file", "terminal", "search_files"]);
    let saved = checked(s.operator(&c, Method::PUT, route).json(&profile)).await?;
    assert_eq!(saved["activeRevision"], before);
    assert_eq!(saved["pending"], true);
    assert!(
        saved["profile"]["allowedTools"]
            .as_array()
            .is_some_and(|ids| ids.contains(&json!("search_files")))
    );
    assert_eq!(
        wait_state(&s, &c, &run, "completed").await?["result"],
        "OpenCode mock completed the task.",
    );
    let next = submit(&s, &c, "switcher", "Review a report").await?;
    assert_eq!(
        wait_state(&s, &c, &next, "completed").await?["result"],
        "OpenHands mock completed the task.",
    );
    let snapshots = events(&s, &c, &next, 0).await?;
    let applied = snapshots
        .iter()
        .find(|e| e["type"] == "profile.applied")
        .context("Missing run profile")?;
    assert_eq!(applied["payload"]["revision"], saved["profile"]["revision"]);
    assert_eq!(applied["payload"]["allowedTools"], json!(["terminal"]));
    s.stop().await
}

#[tokio::test]
async fn approvals_cancellation_and_board_review_use_the_durable_worker_queue() -> Result<()> {
    let mut s = Service::launch().await?;
    let c = client()?;
    add_agents(&s, &c).await?;
    let r = submit(&s, &c, "atlas", "MOCK_APPROVAL review a report").await?;
    wait_state(&s, &c, &r, "waiting_approval").await?;
    let approval = events(&s, &c, &r, 0)
        .await?
        .into_iter()
        .find(|e| e["type"] == "approval.request")
        .context("Coordinator did not persist the approval")?;
    let vote = json!({"approvalId":approval["payload"]["approvalId"],"decision":"approve"});
    checked(
        s.operator(&c, Method::POST, &format!("/v1/runs/{r}/approval"))
            .json(&vote),
    )
    .await?;
    wait_state(&s, &c, &r, "completed").await?;
    assert_eq!(
        s.operator(&c, Method::POST, &format!("/v1/runs/{r}/approval"))
            .json(&vote)
            .send()
            .await?
            .status(),
        StatusCode::CONFLICT
    );
    let pending = submit(&s, &c, "atlas", "MOCK_APPROVAL wait for cancellation").await?;
    wait_state(&s, &c, &pending, "waiting_approval").await?;
    checked(s.operator(&c, Method::POST, &format!("/v1/runs/{pending}/stop"))).await?;
    wait_state(&s, &c, &pending, "cancelled").await?;
    let boards = checked(s.operator(&c, Method::GET, "/v1/boards")).await?;
    let board = &boards["boards"][0];
    let task=checked(s.operator(&c,Method::POST,"/v1/tasks").json(&json!({"title":"Prepare checklist","boardId":board["id"],"ownerAgentId":"scout","checklist":[{"text":"Check draft"}]}))).await?;
    let base = format!("/v1/tasks/{}", field(&task, "id")?);
    let start = json!({"revision":task["revision"],"idempotencyKey":"attempt-one"});
    let attempt = checked(
        s.operator(&c, Method::POST, &format!("{base}/start"))
            .json(&start),
    )
    .await?;
    let retry = checked(
        s.operator(&c, Method::POST, &format!("{base}/start"))
            .json(&start),
    )
    .await?;
    assert_eq!(attempt["run"]["id"], retry["run"]["id"]);
    wait_state(&s, &c, field(&attempt["run"], "id")?, "completed").await?;
    let review = checked(s.operator(&c, Method::GET, &base)).await?;
    assert_eq!(review["stageId"], board["settings"]["doneStageId"]);
    assert_eq!(review["runs"].as_array().unwrap().len(), 1);
    assert!(review["activeRunId"].is_null());
    let done = checked(
        s.operator(&c, Method::POST, &format!("{base}/approve"))
            .json(&json!({"revision":review["revision"]})),
    )
    .await?;
    assert_eq!(done["stageId"], board["stages"][4]["id"]);
    s.stop().await
}

struct WorkerCredential {
    machine: String,
    token: String,
}
impl WorkerCredential {
    fn request(&self, s: &Service, c: &Client, method: Method, path: &str) -> RequestBuilder {
        c.request(method, format!("{}{path}", s.url))
            .bearer_auth(&self.token)
            .header("x-open-harness-machine", &self.machine)
    }
}
async fn pair_fixture(s: &Service, c: &Client, name: &str) -> Result<WorkerCredential> {
    let grant = checked(
        s.operator(c, Method::POST, "/v1/machines")
            .json(&json!({"name":name,"platform":"linux"})),
    )
    .await?;
    let input = json!({"code":grant["code"],"name":name,"platform":"linux","arch":"aarch64","capabilities":{"container":true,"desktop":true,"direct":true}});
    let endpoint = format!("{}/v1/runner/pair", s.url);
    let worker = checked(c.post(&endpoint).json(&input)).await?;
    assert_eq!(worker["machine"]["capabilities"]["desktop"], false);
    assert_eq!(worker["machine"]["capabilities"]["direct"], false);
    assert_eq!(
        c.post(&endpoint).json(&input).send().await?.status(),
        StatusCode::GONE
    );
    Ok(WorkerCredential {
        machine: field(&worker, "machineId")?.into(),
        token: field(&worker, "token")?.into(),
    })
}

async fn claim_run(s: &Service, c: &Client, worker: &WorkerCredential, id: &str) -> Result<Value> {
    let until = Instant::now() + LIMIT;
    loop {
        let jobs = checked(worker.request(s, c, Method::GET, "/v1/runner/commands")).await?;
        if let Some(job) = jobs["commands"].as_array().and_then(|commands| {
            commands
                .iter()
                .find(|job| job["kind"] == "run" && job["payload"]["runId"] == id)
        }) {
            return Ok(job.clone());
        }
        ensure!(
            Instant::now() < until,
            "Remote worker did not receive run {id}"
        );
        sleep(Duration::from_millis(100)).await;
    }
}

#[tokio::test]
async fn older_workers_can_install_a_new_harness_after_their_next_compatible_heartbeat()
-> Result<()> {
    let mut s = Service::launch().await?;
    let c = client()?;
    let worker = pair_fixture(&s, &c, "Older worker").await?;
    let created = checked(
        s.operator(&c, Method::POST, "/v1/agents")
            .json(&json!({"id":"template","name":"Template","harness":"pi"})),
    )
    .await?;
    let mut profile = created["profile"].clone();
    profile["id"] = json!("remote");
    profile["computer"]["machineId"] = json!(worker.machine);
    checked(
        s.operator(&c, Method::POST, "/v1/agents")
            .json(&json!({"id":"remote","profile":profile})),
    )
    .await?;
    let route = "/v1/agents/remote/harness";
    let before = checked(s.operator(&c, Method::POST, route)).await?;
    assert_eq!(before["harnessInstallation"]["workerUpgradeRequired"], true);
    assert!(
        before["harnessInstallation"]["detail"]
            .as_str()
            .unwrap_or("")
            .contains("Update the Open Harness worker")
    );
    let run = submit(&s, &c, "remote", "Review a report").await?;
    let failed = wait_state(&s, &c, &run, "failed").await?;
    assert!(
        failed["error"]
            .as_str()
            .unwrap_or("")
            .contains("Update the Open Harness worker")
    );
    let upgraded = checked(
        worker.request(&s, &c, Method::POST, "/v1/runner/heartbeat")
            .json(&json!({"capabilities":{"container":true,"harnesses":["hermes","pi","unknown","pi"]}})),
    ).await?;
    assert_eq!(
        upgraded["capabilities"]["harnesses"],
        json!(["hermes", "pi"])
    );
    let queued = checked(s.operator(&c, Method::POST, route)).await?;
    assert_eq!(queued["harnessInstallation"]["state"], "queued");
    let commands = checked(worker.request(&s, &c, Method::GET, "/v1/runner/commands")).await?;
    let commands = commands["commands"]
        .as_array()
        .context("Missing worker commands")?;
    assert_eq!(commands.len(), 1);
    assert_eq!(commands[0]["kind"], "install-harness");
    assert_eq!(commands[0]["payload"], json!({"harness":"pi"}));
    let complete = format!(
        "/v1/runner/commands/{}/complete",
        field(&commands[0], "id")?
    );
    checked(
        worker
            .request(&s, &c, Method::POST, &complete)
            .json(&json!({"result":{"ok":true}})),
    )
    .await?;
    let ready = checked(s.operator(&c, Method::GET, route)).await?;
    assert_eq!(ready["harnessInstallation"]["state"], "ready");
    s.stop().await
}

#[tokio::test]
async fn worker_credentials_are_machine_scoped_and_agent_controls_expire_with_the_run() -> Result<()>
{
    let mut s = Service::launch().await?;
    let c = client()?;
    assert_eq!(
        c.get(format!("{}/v1/runs", s.url)).send().await?.status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        c.get(format!("{}/v1/bootstrap", s.url))
            .header("Host", "example.invalid")
            .send()
            .await?
            .status(),
        StatusCode::FORBIDDEN
    );
    let first = pair_fixture(&s, &c, "Worker one").await?;
    let other = pair_fixture(&s, &c, "Worker two").await?;
    assert_eq!(
        first
            .request(&s, &c, Method::GET, "/v1/agents")
            .send()
            .await?
            .status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        c.get(format!("{}/v1/runner/commands", s.url))
            .header("x-open-harness-machine", &first.machine)
            .bearer_auth(&other.token)
            .send()
            .await?
            .status(),
        StatusCode::UNAUTHORIZED
    );
    // A new agent can be assigned to a paired machine before it has any files.
    checked(
        s.operator(&c, Method::POST, "/v1/agents")
            .json(&json!({"id":"template","name":"Template"})),
    )
    .await?;
    let mut profile =
        checked(s.operator(&c, Method::GET, "/v1/agents/template/profile")).await?["profile"]
            .clone();
    profile["id"] = json!("remote");
    profile["computer"]["machineId"] = json!(first.machine);
    checked(
        s.operator(&c, Method::POST, "/v1/agents")
            .json(&json!({"id":"remote","profile":profile})),
    )
    .await?;
    let run = submit(&s, &c, "remote", "Review the project columns").await?;
    let job = claim_run(&s, &c, &first, &run).await?;
    assert_eq!(job["agentId"], "remote");
    assert_eq!(job["payload"]["runId"], run);
    let scoped = field(&job["payload"], "coordinationToken")?;
    let internal = |service: &Service, agent: &str, id: &str| {
        c.post(format!("{}/internal/task", service.url))
            .bearer_auth(scoped)
            .header("x-open-harness-agent", agent)
            .header("x-open-harness-run", id)
            .json(&json!({"action":"columns"}))
    };
    assert!(checked(internal(&s, "remote", &run)).await?["boards"].is_array());
    assert_eq!(
        internal(&s, "template", &run).send().await?.status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        internal(&s, "remote", "unrelated").send().await?.status(),
        StatusCode::UNAUTHORIZED
    );
    assert_eq!(
        c.get(format!("{}/v1/runs", s.url))
            .bearer_auth(scoped)
            .send()
            .await?
            .status(),
        StatusCode::UNAUTHORIZED
    );
    let route = format!("/v1/runner/commands/{}", field(&job, "id")?);
    let answer = json!({"result":{"text":"Finished"}});
    let event = json!({"eventId":"same-delivery","runId":run,"event":{"type":"message.delta","payload":{"text":"Done"}}});
    assert_eq!(
        other
            .request(&s, &c, Method::POST, &format!("{route}/complete"))
            .json(&answer)
            .send()
            .await?
            .status(),
        StatusCode::NOT_FOUND
    );
    // Drop the accepted event acknowledgement, restart the receiving coordinator, and
    // retry with the worker and operation identifiers already stored by the sender.
    first
        .request(&s, &c, Method::POST, &format!("{route}/events"))
        .json(&event)
        .send()
        .await?
        .error_for_status()?;
    s.stop().await?;
    s.open().await?;
    checked(
        first
            .request(&s, &c, Method::POST, &format!("{route}/events"))
            .json(&event),
    )
    .await?;
    for _ in 0..2 {
        checked(
            first
                .request(&s, &c, Method::POST, &format!("{route}/complete"))
                .json(&answer),
        )
        .await?;
    }
    assert_eq!(
        wait_state(&s, &c, &run, "completed").await?["result"],
        "Finished"
    );
    let log = events(&s, &c, &run, 0).await?;
    assert_eq!(
        log.iter().filter(|v| v["type"] == "message.delta").count(),
        1
    );
    assert_eq!(
        log.iter().filter(|v| v["type"] == "run.completed").count(),
        1
    );
    assert_eq!(
        internal(&s, "remote", &run).send().await?.status(),
        StatusCode::FORBIDDEN
    );
    checked(s.operator(
        &c,
        Method::POST,
        &format!("/v1/machines/{}/revoke", first.machine),
    ))
    .await?;
    assert_eq!(
        first
            .request(&s, &c, Method::GET, "/v1/runner/commands")
            .send()
            .await?
            .status(),
        StatusCode::UNAUTHORIZED
    );
    s.stop().await
}

#[tokio::test]
async fn paired_native_worker_runs_every_harness_and_transfers_private_files() -> Result<()> {
    let mut s = Service::launch().await?;
    let c = client()?;
    add_agents(&s, &c).await?;
    for reference in ["XAI_API_KEY", "ANTHROPIC_API_KEY", "OPENAI_API_KEY"] {
        checked(
            s.operator(&c, Method::POST, "/v1/secrets")
                .json(&json!({"name":reference,"value":"synthetic-transfer-fixture-key"})),
        )
        .await?;
    }
    let pair = checked(
        s.operator(&c, Method::POST, "/v1/machines")
            .json(&json!({"name":"Second host","platform":"linux"})),
    )
    .await?;
    let remote = tempfile::tempdir()?;
    let path = remote.path().to_str().context("Invalid fixture path")?;
    std::fs::set_permissions(
        remote.path(),
        std::os::unix::fs::PermissionsExt::from_mode(0o700),
    )?;
    let mut worker = Process::start(
        &[
            "runner",
            "--state-dir",
            path,
            "--coordinator",
            &s.url,
            "--pairing-code",
            field(&pair, "code")?,
        ],
        &remote.path().join("worker.log"),
        remote.path(),
        &s.empty_bin,
    )?;
    let until = Instant::now() + LIMIT;
    let machine = loop {
        if let Some(status) = worker.0.as_mut().unwrap().try_wait()? {
            bail!(
                "Paired worker exited with {status}: {}",
                std::fs::read_to_string(remote.path().join("worker.log"))?
            );
        }
        let machines = checked(s.operator(&c, Method::GET, "/v1/machines")).await?;
        if let Some(remote) = machines["machines"].as_array().and_then(|a| {
            a.iter()
                .find(|m| m["id"] != "local" && m["capabilities"]["container"] == true)
        }) {
            break field(remote, "id")?.to_owned();
        }
        ensure!(
            Instant::now() < until,
            "Remote native worker did not pair: {}",
            std::fs::read_to_string(remote.path().join("worker.log"))?
        );
        sleep(Duration::from_millis(120)).await;
    };
    // Each upload stays below the ordinary file limit, while the agent's base64 transfer
    // envelope exceeds five megabytes and must use the authenticated export body limit.
    let large_chunk = "x".repeat(975_000);
    for i in 0..4 {
        checked(
            s.operator(&c, Method::POST, "/v1/files?scope=private&agentId=atlas")
                .json(&json!({"name":format!("chunk-{i}.txt"),"content":large_chunk})),
        )
        .await?;
    }
    let mut moves = vec![];
    for (agent, harness, name) in HARNESSES {
        let body = json!({"scope":"private","agentId":agent,"name":"brief.txt","content":format!("Brief for {agent}")});
        checked(
            s.operator(
                &c,
                Method::POST,
                &format!("/v1/files?scope=private&agentId={agent}"),
            )
            .json(&body),
        )
        .await?;
        checked(
            s.operator(&c, Method::POST, &format!("/v1/agents/{agent}/transfer"))
                .json(&json!({"destinationMachineId":machine})),
        )
        .await?;
        moves.push((agent, harness, name));
    }
    for (agent, harness, name) in moves {
        let until = Instant::now() + LIMIT;
        loop {
            let profile =
                checked(s.operator(&c, Method::GET, &format!("/v1/agents/{agent}/profile")))
                    .await?;
            if profile["profile"]["computer"]["machineId"] == machine {
                break;
            }
            ensure!(
                profile["transfer"]["state"] != "failed",
                "Transfer failed: {}",
                profile["transfer"]["detail"]
            );
            ensure!(
                Instant::now() < until,
                "Agent transfer remained {}",
                profile["transfer"]
            );
            sleep(Duration::from_millis(150)).await;
        }
        let work = remote
            .path()
            .join("agents")
            .join(agent)
            .join("private/brief.txt");
        assert_eq!(
            std::fs::read_to_string(&work)?,
            format!("Brief for {agent}")
        );
        let run = submit(&s, &c, agent, "Work on the second computer").await?;
        let completed = wait_state(&s, &c, &run, "completed").await?;
        assert_eq!(
            completed["result"],
            format!("{name} mock completed the task.")
        );
        assert_eq!(completed["machine_id"], machine);
        let log = events(&s, &c, &run, 0).await?;
        assert!(log.iter().any(|v| v["type"] == "profile.applied"
            && v["payload"]["harness"] == harness
            && v["payload"]["computer"]["desktop"] == "none"));
    }
    for i in 0..4 {
        let bytes = std::fs::read(
            remote
                .path()
                .join(format!("agents/atlas/private/chunk-{i}.txt")),
        )?;
        ensure!(
            bytes == large_chunk.as_bytes(),
            "A chunk changed during export or import"
        );
    }
    s.stop().await
}

#[tokio::test]
async fn native_operator_cli_creates_and_runs_an_agent_without_a_browser() -> Result<()> {
    let mut s = Service::launch().await?;
    let v = s
        .cli(&[
            "agent",
            "add",
            "Operator",
            "--id",
            "operator",
            "--harness",
            "claude-code",
        ])
        .await?;
    assert_eq!(v["id"], "operator");
    let configured = s
        .cli(&[
            "agent",
            "add",
            "Local Pi",
            "--id",
            "cli-pi",
            "--harness",
            "pi",
            "--model",
            "fixture-model",
            "--provider",
            "local",
            "--base-url",
            "http://model.invalid/v1",
        ])
        .await?;
    assert_eq!(configured["profile"]["model"]["provider"], "local");
    assert_eq!(configured["profile"]["model"]["credentialRef"], "");
    let r = s
        .cli(&[
            "run",
            "--agent",
            "operator",
            "--wait",
            "Summarize the brief",
        ])
        .await?;
    assert_eq!(r["state"], "completed");
    let log = s.cli(&["events", field(&r, "id")?]).await?;
    assert!(
        log["events"]
            .as_array()
            .unwrap()
            .iter()
            .any(|v| v["type"] == "gateway.ready" && v["payload"]["harness"] == "claude-code")
    );
    s.stop().await
}

#[tokio::test]
async fn worker_terminal_reconnect_uses_one_run_and_revocation_invalidates_its_grant() -> Result<()>
{
    let mut s = Service::launch().await?;
    let c = client()?;
    let assigned = pair_fixture(&s, &c, "Terminal host").await?;
    let other = pair_fixture(&s, &c, "Other worker").await?;
    checked(
        assigned
            .request(&s, &c, Method::POST, "/v1/runner/heartbeat")
            .json(&json!({"capabilities":{"container":true,"workerLaunch":true}})),
    )
    .await?;
    let unavailable = s
        .cli(&[
            "agent",
            "add",
            "Editor",
            "--id",
            "editor",
            "--machine",
            "machine-unknown",
        ])
        .await
        .unwrap_err();
    assert!(
        unavailable
            .to_string()
            .contains("The assigned machine is unavailable.")
    );
    let editor = s
        .cli(&[
            "agent",
            "add",
            "Editor",
            "--id",
            "editor",
            "--machine",
            &assigned.machine,
            "--harness",
            "claude-code",
            "--worker-launch",
        ])
        .await?;
    assert_eq!(editor["profile"]["computer"]["machineId"], assigned.machine);
    assert_eq!(editor["profile"]["workerLaunch"], true);
    let path = "/v1/runner/launch/editor";
    let call = |w: &WorkerCredential, v: Value| w.request(&s, &c, Method::POST, path).json(&v);
    assert_eq!(
        call(&other, json!({"action":"authorize"}))
            .send()
            .await?
            .status(),
        StatusCode::FORBIDDEN
    );
    let auth = checked(call(&assigned, json!({"action":"authorize"}))).await?;
    let grant = field(&auth, "grant")?;
    let first =
        json!({"action":"terminal","grant":grant,"requestId":uuid::Uuid::new_v4().to_string()});
    let opened = checked(call(&assigned, first.clone())).await?;
    let run = field(&opened, "id")?;
    assert_eq!(checked(call(&assigned, first)).await?["id"], run);
    assert_eq!(
        checked(call(
            &assigned,
            json!({"action":"terminal","grant":grant,"requestId":uuid::Uuid::new_v4().to_string()})
        ))
        .await?["id"],
        run
    );
    assert_eq!(
        call(&other, json!({"action":"read","grant":grant,"runId":run}))
            .send()
            .await?
            .status(),
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        call(
            &assigned,
            json!({"action":"read","grant":grant,"runId":uuid::Uuid::new_v4().to_string()})
        )
        .send()
        .await?
        .status(),
        StatusCode::FORBIDDEN
    );
    wait_state(&s, &c, run, "running").await?;
    let commands = checked(assigned.request(&s, &c, Method::GET, "/v1/runner/commands")).await?;
    let terminal = commands["commands"]
        .as_array()
        .unwrap()
        .iter()
        .find(|v| v["payload"]["runId"] == run)
        .context("Missing terminal lease")?;
    assert_eq!(terminal["payload"]["mode"], "terminal");
    assert_eq!(terminal["payload"]["encryptedSecrets"], json!({}));
    assert!(!commands.to_string().contains(grant));
    let route = "/v1/agents/editor/profile";
    let mut profile = checked(s.operator(&c, Method::GET, route)).await?["profile"].clone();
    profile["workerLaunch"] = json!(false);
    let saved = checked(s.operator(&c, Method::PUT, route).json(&profile)).await?;
    assert_eq!(
        call(
            &assigned,
            json!({"action":"read","grant":grant,"runId":run})
        )
        .send()
        .await?
        .status(),
        StatusCode::FORBIDDEN
    );
    let mut again = saved["profile"].clone();
    again["workerLaunch"] = json!(true);
    again["computer"]["reserveMachine"] = json!(true);
    checked(s.operator(&c, Method::PUT, route).json(&again)).await?;
    assert_ne!(
        checked(call(&assigned, json!({"action":"authorize"}))).await?["grant"],
        grant
    );
    assert_eq!(
        call(
            &assigned,
            json!({"action":"read","grant":grant,"runId":run})
        )
        .send()
        .await?
        .status(),
        StatusCode::FORBIDDEN
    );
    let reserved = s
        .cli(&["agent", "add", "Another", "--machine", &assigned.machine])
        .await
        .unwrap_err();
    assert!(
        reserved
            .to_string()
            .contains("This computer is reserved for another agent.")
    );
    checked(s.operator(
        &c,
        Method::POST,
        &format!("/v1/machines/{}/revoke", other.machine),
    ))
    .await?;
    let revoked = s
        .cli(&["agent", "add", "Another", "--machine", &other.machine])
        .await
        .unwrap_err();
    assert!(
        revoked
            .to_string()
            .contains("The assigned machine is unavailable.")
    );
    s.stop().await
}

#[tokio::test]
async fn codex_plan_worker_cli_and_routine_use_same_profile_and_never_send_an_api_key() -> Result<()>
{
    let mut s = Service::launch().await?;
    let c = client()?;
    let profile = json!({"id":"researcher","name":"Researcher","harness":"codex","modelAuth":"chatgpt-plan","workerLaunch":true});
    checked(s.operator(&c, Method::POST, "/v1/agents").json(&profile)).await?;
    let p = checked(s.operator(&c, Method::GET, "/v1/agents/researcher/profile")).await?;
    assert_eq!(p["profile"]["model"]["credentialRef"], "");
    assert_eq!(p["workerAccess"]["capable"], true);
    let mut bad = p["profile"].clone();
    bad["model"]["baseUrl"] = json!("https://example.invalid");
    assert_eq!(
        s.operator(&c, Method::PUT, "/v1/agents/researcher/profile")
            .json(&bad)
            .send()
            .await?
            .status(),
        StatusCode::BAD_REQUEST
    );
    let call = |args: &[&str]| {
        let mut cmd = tokio::process::Command::new(BINARY);
        cmd.env_clear()
            .arg("--state-dir")
            .arg(&s.state)
            .arg("worker")
            .args(args)
            .kill_on_drop(true);
        async move {
            let r = tokio::time::timeout(LIMIT, cmd.output()).await??;
            ensure!(
                r.status.success(),
                "Worker CLI failed: {}",
                String::from_utf8_lossy(&r.stderr)
            );
            Ok::<Value, anyhow::Error>(serde_json::from_slice(&r.stdout)?)
        }
    };
    let status = call(&["status", "--agent", "researcher"]).await?;
    assert!(!status.to_string().contains("\"grant\""));
    let key = uuid::Uuid::new_v4().to_string();
    let args = [
        "run",
        "--agent",
        "researcher",
        "--wait",
        "--request-id",
        &key,
        "Review this change",
    ];
    let from_worker = call(&args).await?;
    assert_eq!(from_worker["state"], "completed");
    assert_eq!(call(&args).await?["id"], from_worker["id"]);
    let routine=checked(s.operator(&c,Method::POST,"/v1/routines").json(&json!({"agentId":"researcher","name":"Daily review","prompt":"Review changes","intervalMinutes":60}))).await?;
    let scheduled = checked(s.operator(
        &c,
        Method::POST,
        &format!("/v1/routines/{}/run", field(&routine, "id")?),
    ))
    .await?;
    let scheduled_id = field(&scheduled, "id")?;
    wait_state(&s, &c, scheduled_id, "completed").await?;
    let lead_worker = pair_fixture(&s, &c, "Review team worker").await?;
    checked(
        s.operator(&c, Method::POST, "/v1/agents")
            .json(&json!({"id":"lead","name":"Lead","machineId":lead_worker.machine})),
    )
    .await?;
    let lead_profile = "/v1/agents/lead/profile";
    let mut lead = checked(s.operator(&c, Method::GET, lead_profile)).await?["profile"].clone();
    lead["allowedTools"]
        .as_array_mut()
        .unwrap()
        .push(json!("mcp__open_harness__delegate_named_agent"));
    checked(s.operator(&c, Method::PUT, lead_profile).json(&lead)).await?;
    checked(s.operator(&c,Method::POST,"/v1/teams").json(&json!({"name":"Research","description":"","color":"teal","icon":"code","memberAgentIds":["lead","researcher"]}))).await?;
    let parent = submit(&s, &c, "lead", "Ask Researcher to check the draft.").await?;
    let job = claim_run(&s, &c, &lead_worker, &parent).await?;
    let handoff = checked(
        c.post(format!("{}/internal/handoff", s.url))
            .bearer_auth(field(&job["payload"], "coordinationToken")?)
            .header("x-open-harness-agent", "lead")
            .header("x-open-harness-run", &parent)
            .json(&json!({"agentId":"researcher","prompt":"Check the draft"})),
    )
    .await?;
    let delegated = field(&handoff, "runId")?;
    wait_state(&s, &c, delegated, "completed").await?;
    let complete = format!("/v1/runner/commands/{}/complete", field(&job, "id")?);
    checked(
        lead_worker
            .request(&s, &c, Method::POST, &complete)
            .json(&json!({"result":{"text":"Review completed."}})),
    )
    .await?;
    // Inspect the final durable dispatches after the coordinator has checkpointed its WAL.
    s.stop().await?;
    let db = rusqlite::Connection::open_with_flags(
        s.state.join("state.db"),
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
    )?;
    let integrity: String = db.pragma_query_value(None, "quick_check", |row| row.get(0))?;
    ensure!(
        integrity == "ok",
        "Stopped workspace failed its SQLite integrity check: {integrity}"
    );
    for key in [field(&from_worker, "id")?, scheduled_id, delegated] {
        let payload: String = db.query_row(
            "SELECT c.payload_json FROM runner_commands c JOIN native_run_bindings b ON b.command_id=c.id WHERE b.run_id=?",
            [key], |r| r.get(0),
        ).with_context(|| format!("Read the dispatched worker command for completed run {key}"))?;
        let payload: Value = serde_json::from_str(&payload)?;
        assert_eq!(payload["snapshot"]["modelAuth"], "chatgpt-plan");
        assert_eq!(payload["encryptedSecrets"], json!({}));
    }
    Ok(())
}
