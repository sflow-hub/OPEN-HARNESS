use serde_json::{Value, json};
use std::{
    io::Write,
    process::{Command, Stdio},
};

fn session(mode: &str, requests: &[Value]) -> Vec<Value> {
    let mut child = Command::new(env!("CARGO_BIN_EXE_open-harness-agent-tools"))
        .arg(mode)
        .env_remove("SLACK_BOT_TOKEN")
        .env_remove("OPEN_HARNESS_AGENT_TOKEN")
        .env_remove("OPEN_HARNESS_AGENT_ID")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut input = child.stdin.take().unwrap();
    for request in requests {
        writeln!(input, "{request}").unwrap();
    }
    drop(input);
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let mut responses = String::from_utf8(output.stdout)
        .unwrap()
        .lines()
        .map(|line| serde_json::from_str::<Value>(line).unwrap())
        .collect::<Vec<_>>();
    responses.sort_by_key(|v| v["id"].as_u64());
    responses
}

#[test]
fn both_servers_speak_stdio_mcp_with_no_display_or_credentials() {
    for (mode, names) in [
        (
            "coordination",
            [
                "task",
                "delegate_named_agent",
                "create_open_harness_routine",
            ],
        ),
        ("slack", ["list_channels", "read_channel", "send_message"]),
    ] {
        let replies = session(
            mode,
            &[
                json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}),
                json!({"jsonrpc":"2.0","method":"notifications/initialized"}),
                json!({"jsonrpc":"2.0","id":2,"method":"tools/list"}),
                json!({"jsonrpc":"2.0","id":3,"method":"ping"}),
                json!({"jsonrpc":"2.0","id":4,"method":"tools/call","params":{"name":"not-a-tool","arguments":{}}}),
            ],
        );
        assert_eq!(replies.len(), 4);
        assert_eq!(replies[0]["result"]["protocolVersion"], "2025-06-18");
        let tools = replies[1]["result"]["tools"].as_array().unwrap();
        assert_eq!(
            tools
                .iter()
                .map(|t| t["name"].as_str().unwrap())
                .collect::<Vec<_>>(),
            names
        );
        assert_eq!(replies[2]["result"], json!({}));
        assert_eq!(replies[3]["result"]["isError"], true);
    }
}
