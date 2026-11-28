use anyhow::{Context, Result};
use clap::{Parser, Subcommand};
use std::{env, path::PathBuf};

#[derive(Parser)]
#[command(
    version,
    about = "Run named Open Harness agents on a paired headless worker"
)]
struct Args {
    #[arg(long, global = true)]
    state_dir: Option<PathBuf>,
    #[arg(long, requires = "pairing_code")]
    coordinator: Option<String>,
    #[arg(long, requires = "coordinator", allow_hyphen_values = true)]
    pairing_code: Option<String>,
    #[arg(long)]
    once: bool,
    #[command(subcommand)]
    action: Option<Action>,
}

#[derive(Subcommand)]
enum Action {
    /// Use a named agent on this paired worker.
    Worker {
        #[command(subcommand)]
        action: open_harness_runner::worker_local::Action,
    },
}

#[tokio::main]
async fn main() -> Result<()> {
    let args = Args::parse();
    let root = match args.state_dir.or_else(|| {
        env::var_os("OPEN_HARNESS_RUNNER_STATE_DIR")
            .filter(|p| !p.is_empty())
            .map(PathBuf::from)
    }) {
        Some(path) => path,
        _ => PathBuf::from(env::var_os("HOME").context("HOME is not set")?)
            .join(".open-harness-rust-runner"),
    };
    if let Some(Action::Worker { action }) = args.action {
        anyhow::ensure!(
            args.coordinator.is_none() && !args.once,
            "Pair the worker separately before using a named agent."
        );
        return open_harness_runner::worker_local::command(&root, action).await;
    }
    open_harness_runner::start(root, args.coordinator.zip(args.pairing_code), args.once).await
}
