mod coordination;
mod slack;

use anyhow::{Context, Result, ensure};
use serde_json::{Value, json};
use tokio::{
    io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader},
    task::JoinSet,
};

#[derive(Clone, Copy)]
enum Server {
    Coordination,
    Slack,
}

impl Server {
    async fn response(self, request: Value) -> Option<Value> {
        let id = request.get("id")?;
        if !(id.is_string() || id.is_number()) {
            return None;
        }
        let method = request["method"].as_str().unwrap_or("");
        let params = &request["params"];
        let result = match method {
            "initialize" => Ok(
                json!({"protocolVersion":"2025-06-18","capabilities":{"tools":{}},"serverInfo":{
                "name":match self {Self::Coordination=>"open-harness-coordination",Self::Slack=>"open-harness-slack"},
                "version":env!("CARGO_PKG_VERSION")}}),
            ),
            "ping" => Ok(json!({})),
            "tools/list" => Ok(
                json!({"tools":match self {Self::Coordination=>coordination::tools(),Self::Slack=>slack::tools()}}),
            ),
            "tools/call" => {
                let name = params["name"].as_str().unwrap_or("");
                let empty = json!({});
                let args = params.get("arguments").unwrap_or(&empty);
                let value = match self {
                    Self::Coordination => coordination::call(name, args).await,
                    Self::Slack => slack::call(name, args).await,
                };
                match value {
                    Ok(value) => Ok(
                        json!({"content":[{"type":"text","text":serde_json::to_string(&value).ok()?}]}),
                    ),
                    Err(err) => Ok(
                        json!({"isError":true,"content":[{"type":"text","text":err.to_string()}]}),
                    ),
                }
            }
            _ => Err(json!({"code":-32601,"message":"Unsupported MCP method."})),
        };
        Some(match result {
            Ok(value) => json!({"jsonrpc":"2.0","id":id,"result":value}),
            Err(error) => json!({"jsonrpc":"2.0","id":id,"error":error}),
        })
    }
}

async fn check_model() -> Result<()> {
    let mut line = Vec::new();
    let mut input = BufReader::new(tokio::io::stdin().take(256_001));
    input.read_until(b'\n', &mut line).await?;
    ensure!(line.len() <= 256_000, "Model check request is too large.");
    let spec: Value = serde_json::from_slice(&line)?;
    let base = spec["baseUrl"]
        .as_str()
        .context("Select a model endpoint.")?;
    let mut endpoint = reqwest::Url::parse(base).context("Invalid model endpoint.")?;
    ensure!(
        matches!(endpoint.scheme(), "http" | "https")
            && endpoint.has_host()
            && endpoint.username().is_empty()
            && endpoint.password().is_none()
            && endpoint.query().is_none()
            && endpoint.fragment().is_none(),
        "Invalid model endpoint."
    );
    let path = format!("{}/models", endpoint.path().trim_end_matches('/'));
    endpoint.set_path(&path);
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(std::time::Duration::from_secs(10))
        .build()?;
    let mut req = client.get(endpoint);
    if let Some(key) = spec["apiKey"].as_str().filter(|s| !s.is_empty()) {
        req = req.bearer_auth(key);
    }
    let ok = req.send().await.is_ok_and(|r| r.status().is_success());
    println!(
        "{}",
        json!({"ok":ok,"message":if ok {"Endpoint reached from the agent container."}else{"Model endpoint did not confirm the connection."}})
    );
    Ok(())
}

#[tokio::main]
async fn main() -> Result<()> {
    let server = match std::env::args().nth(1).as_deref() {
        Some("check-model") => return check_model().await,
        Some("coordination") => Server::Coordination,
        Some("slack") => Server::Slack,
        _ => anyhow::bail!("Select coordination or slack."),
    };
    let mut input = BufReader::new(tokio::io::stdin());
    let mut output = tokio::io::stdout();
    let mut jobs = JoinSet::new();
    let mut line = Vec::new();
    let mut eof = false;
    while !eof || !jobs.is_empty() {
        tokio::select! {
            result=async { (&mut input).take((1_000_001-line.len()) as u64).read_until(b'\n',&mut line).await }, if !eof && jobs.len()<32 => {
                ensure!(line.len()<=1_000_000,"MCP request too large.");
                if result?==0 {eof=true;continue;}
                if let Ok(request)=serde_json::from_slice::<Value>(&line) {jobs.spawn(async move {server.response(request).await});}
                line.clear();
            }
            Some(result)=jobs.join_next(),if !jobs.is_empty()=>{
                if let Some(value)=result.context("Agent tool request stopped")? {
                    let mut encoded=serde_json::to_vec(&value)?;
                    encoded.push(b'\n');
                    output.write_all(&encoded).await?; output.flush().await?;
                }
            }
        }
    }
    Ok(())
}
