# Open Harness headless worker

The Rust coordinator starts this worker for its local machine. A paired remote worker uses the same adapters for Hermes, Claude Code, and Codex, along with the same durable event delivery. Each named agent has its own persistent files and harness state. Managed jobs use piped input and output in an isolated Docker container. An interactive Claude Code session uses a private terminal that the worker owner can reattach to over SSH. The worker removes the container and its subprocesses when the run ends or is stopped. The workspace stays on disk between runs.

## Build and pair

From the repository root on Linux or macOS, build with Rust 1.89 or newer, a C toolchain, Perl, and Make.

```sh
cargo build --release --locked -p open-harness-runner
```

Copy `target/release/open-harness-runner` to the worker machine. Docker and a non-root account with access to its daemon are required. The worker prepares the pinned images on first use. The native Hermes image includes the Rust coordination and Slack MCP helper. The Claude Code and Codex images run their vendor binaries.

On the coordinator machine, create a one-time pairing code using the URL reachable by the worker.

```sh
open-harness api POST /v1/machines --stdin <<'JSON'
{"name":"Build host","platform":"linux","coordinatorUrl":"https://coordinator.example"}
JSON
```

On the worker, use the returned code.

```sh
./open-harness-runner --coordinator https://coordinator.example --pairing-code YOUR_CODE
```

A coordinator reached through a loopback tunnel can use plain HTTP. Run the binary without arguments on later starts to reuse its identity. The default state location is `~/.open-harness-rust-runner`. Set `OPEN_HARNESS_RUNNER_STATE_DIR` to choose another private directory. Keep the whole directory together when moving a worker, including its key and outbound queue.

Once the coordinator operator enables launches on an assigned agent, use `open-harness-runner worker login --agent ID` for a ChatGPT-plan Codex agent or `open-harness-runner worker terminal --agent ID` for Claude Code. Run the command as the account that owns this worker. [Subscription setup and launch commands](../../README.md#use-a-subscription-on-the-assigned-worker)

## Adopt an existing worker

Stop its old Node worker and start the Rust worker with the same state directory. Use the original path spelling if the worker stored credentials in the OS vault.

```sh
OPEN_HARNESS_RUNNER_STATE_DIR="$HOME/.open-harness-runner" ./open-harness-runner
```

The worker adopts the paired machine ID, token, RSA key, and agent files. It imports undelivered events and results with their original identifiers before accepting new work. The original spool files are archived under `spool/rust-adopted/`. The old spool preserves file times and UUIDs, which are used to order outstanding events before their completions. The worker loads existing restricted-file or available macOS Keychain/Linux Secret Service credentials into memory. An unavailable vault with no file copy must be unlocked. New runner-local credentials are saved separately in the worker's 0600 file.

## Agent execution

- **Hermes** speaks JSON-RPC over a pipe to its managed gateway. Profiles retain their prompt, model, explicit tool grants and configured MCP connections. Stop, steer and approval requests use the active gateway session. Agent coordination is authenticated per run and relayed through a socket in the agent’s read-only managed directory.
- **Claude Code** uses print mode, streaming JSON, a supplied tool list and non-interactive permissions. The profile selects the Anthropic credential and model.
- **Codex** uses `codex exec --json` with non-interactive permissions, disabled external integrations and the OpenAI credential and model selected by the profile. Its five core workspace tools must be enabled together.

Agents can use a private workspace or explicitly shared folders with a selected read/write mode. All harnesses run with desktop access off. Each CLI job can be stopped. Starting another job supplies further instructions after the active CLI job ends. CLI connectors are unsupported, as in the existing harness contracts. A terminal protocol record and a successful process exit confirm a Claude Code or Codex completion.

The worker reports events and results from a disk-backed queue. An interrupted connection retries delivery with the original IDs. An unconfirmed job is marked interrupted after its lease is reconciled. The coordinator can send the credentials needed by a profile encrypted for the worker’s key. A credential saved directly on a paired worker is kept in its private mode-0600 credential file. Managed file transfers exclude credentials and transient harness configuration.

## Verification

```sh
cargo test --locked -p open-harness-runner
cargo build --locked -p open-harness-runner
OPEN_HARNESS_RUST_RUNNER="$PWD/target/debug/open-harness-runner" \
  node --test runtime/rust-runner/tests/{adoption,harnesses,recovery}.test.mjs
```

The process tests cover all three adapters, isolation, agent-scoped sockets, event delivery, cancellation, and unconfirmed results. The recovery test uses the native coordinator. Build both binaries with `cargo build --locked --workspace` from the repository root. Set `OPEN_HARNESS_RUST_LIVE=1` for its actual Hermes container and local provider fixture. Set `OPEN_HARNESS_RUST_PROVIDER_HOST` if the container needs a different address to reach the fixture.

With the pinned images installed, run all three actual harnesses against local Anthropic Messages, OpenAI Responses, and Chat Completions fixtures. Set the bind address to a test interface reachable from these containers. Use `OPEN_HARNESS_RUST_LIVE_ONLY` to check one harness.

```sh
OPEN_HARNESS_RUST_LIVE=1 OPEN_HARNESS_RUST_PROVIDER_BIND=0.0.0.0 \
  OPEN_HARNESS_RUST_RUNNER="$PWD/target/debug/open-harness-runner" \
  node --test runtime/rust-runner/tests/live.test.mjs
```

To exercise the native coordinator, its worker and the same local model fixture together, run the following against a built coordinator. On a software-emulated machine, set `OPEN_HARNESS_TEST_TURN_TIMEOUT_MS` to allow more than the default seven minutes per model turn.

```sh
OPEN_HARNESS_TEST_LIVE=1 OPEN_HARNESS_RUST_PROVIDER_BIND=0.0.0.0 \
  OPEN_HARNESS_TEST_NATIVE_BINARY="$PWD/target/release/open-harness" \
  node --test runtime/native/tests/live.mjs
```
