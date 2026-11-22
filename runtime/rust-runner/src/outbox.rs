use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::Duration,
};
use tokio::{sync::Notify, time::sleep};
use uuid::Uuid;

use crate::{protocol::Coordinator, write_private};

// The coordinator rejects request bodies over five million characters.
const MAX_BODY_BYTES: usize = 4_900_000;
const MAX_TRANSFER_BODY_BYTES: usize = 32_000_000;

#[derive(Clone, Serialize, Deserialize)]
struct Record {
    command: Uuid,
    #[serde(flatten)]
    message: Message,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
enum Message {
    Event { run: String, id: Uuid, event: Value },
    Complete { body: Value },
}

pub struct Outbox {
    directory: PathBuf,
    state: Mutex<State>,
    changed: Notify,
}

struct State {
    next: u64,
    pending: BTreeMap<u64, Record>,
}

impl Outbox {
    pub fn open(directory: PathBuf) -> Result<Self> {
        fs::create_dir_all(&directory)?;
        let mut pending = BTreeMap::new();
        for entry in fs::read_dir(&directory)? {
            let entry = entry?;
            let path = entry.path();
            if path.extension().and_then(|extension| extension.to_str()) != Some("json") {
                continue;
            }
            let index: u64 = path
                .file_stem()
                .and_then(|stem| stem.to_str())
                .context("Invalid runner outbox filename")?
                .parse()?;
            ensure!(
                entry.file_type()?.is_file() && path == record_path(&directory, index),
                "Invalid runner outbox file."
            );
            pending.insert(index, serde_json::from_slice(&fs::read(&path)?)?);
        }
        let next = pending.last_key_value().map_or(0, |(index, _)| index + 1);
        Ok(Self {
            directory,
            state: Mutex::new(State { next, pending }),
            changed: Notify::new(),
        })
    }

    fn enqueue(&self, record: Record) -> Result<()> {
        let mut state = self.state.lock().unwrap();
        let index = state.next;
        write_private(
            &record_path(&self.directory, index),
            &serde_json::to_vec(&record)?,
        )
        .context("Could not persist runner output")?;
        state.next += 1;
        state.pending.insert(index, record);
        self.changed.notify_one();
        Ok(())
    }

    pub fn event(&self, command: Uuid, run: &str, event: Value) -> Result<()> {
        ensure!(
            serde_json::to_vec(&event)?.len() <= MAX_BODY_BYTES,
            "Hermes sent an event larger than the coordinator can accept."
        );
        self.enqueue(Record {
            command,
            message: Message::Event {
                run: run.to_owned(),
                id: Uuid::new_v4(),
                event,
            },
        })
    }

    pub fn complete(&self, command: Uuid, result: Result<Value>, transfer: bool) -> Result<()> {
        let body = match result {
            Ok(result) => json!({"result": result}),
            Err(error) if error.is::<crate::cli_protocol::Interrupted>() => {
                json!({"error":format!("{error:#}"),"interrupted":true})
            }
            Err(error) => json!({"error": format!("{error:#}")}),
        };
        let limit = if transfer {
            MAX_TRANSFER_BODY_BYTES
        } else {
            MAX_BODY_BYTES
        };
        let body = if serde_json::to_vec(&body)?.len() <= limit {
            body
        } else {
            json!({"error": "The result is too large for the coordinator. Inspect the agent workspace for any saved files."})
        };
        self.enqueue(Record {
            command,
            message: Message::Complete { body },
        })
    }

    pub fn pending_commands(&self) -> BTreeSet<Uuid> {
        self.state
            .lock()
            .unwrap()
            .pending
            .values()
            .map(|record| record.command)
            .collect()
    }

    pub fn adopt(&self, root: &Path) -> Result<()> {
        let previous = crate::legacy::pending(root)?;
        if previous.is_empty() {
            return Ok(());
        }
        let archive = root.join("spool/rust-adopted");
        crate::directory(&archive)?;
        let converted = previous
            .into_iter()
            .map(|(file, value)| -> Result<_> {
                let route = crate::required_str(&value, "path")?
                    .strip_prefix("/v1/runner/commands/")
                    .context("Invalid legacy spool endpoint")?;
                let (id, action) = route
                    .split_once('/')
                    .context("Invalid legacy spool endpoint")?;
                let command = Uuid::parse_str(id)?;
                let body = &value["body"];
                let key = crate::required_str(&value, "id")?;
                let message = match action {
                    "events" => {
                        let id = Uuid::parse_str(key)?;
                        ensure!(
                            body["eventId"] == key && body["event"].is_object(),
                            "Invalid legacy event."
                        );
                        Message::Event {
                            run: crate::required_str(body, "runId")?.to_owned(),
                            id,
                            event: body["event"].clone(),
                        }
                    }
                    "complete" => {
                        ensure!(
                            key == format!("complete-{command}")
                                && (body.get("result").is_some() || body["error"].is_string()),
                            "Invalid legacy completion."
                        );
                        Message::Complete { body: body.clone() }
                    }
                    _ => anyhow::bail!("Unknown legacy spool endpoint."),
                };
                Ok((file, Record { command, message }))
            })
            .collect::<Result<Vec<_>>>()?;
        for (file, record) in converted {
            let queued = self.state.lock().unwrap().pending.values().any(|prior| {
                prior.command == record.command
                    && match (&prior.message, &record.message) {
                        (Message::Event { id: a, .. }, Message::Event { id: b, .. }) => a == b,
                        (Message::Complete { .. }, Message::Complete { .. }) => true,
                        _ => false,
                    }
            });
            if !queued {
                self.enqueue(record)?;
            }
            let backup = archive.join(file.file_name().context("Invalid spool filename")?);
            if backup.try_exists()? {
                ensure!(
                    fs::read(&backup)? == fs::read(&file)?,
                    "The archived legacy receipt has different contents."
                );
            }
            fs::rename(&file, &backup)?;
            crate::sync_state_file(&fs::File::open(&archive)?)?;
            crate::sync_state_file(&fs::File::open(root.join("spool"))?)?;
        }
        Ok(())
    }

    pub async fn delivery(self: Arc<Self>, coordinator: Arc<Coordinator>) -> Result<()> {
        loop {
            let first = self
                .state
                .lock()
                .unwrap()
                .pending
                .first_key_value()
                .map(|(index, record)| (*index, record.clone()));
            let Some((index, record)) = first else {
                self.changed.notified().await;
                continue;
            };
            let command = record.command;
            let (action, body) = match record.message {
                Message::Event { run, id, event } => (
                    "events",
                    json!({"runId": run, "eventId": id, "event": event}),
                ),
                Message::Complete { body } => ("complete", body),
            };
            let endpoint = format!("/v1/runner/commands/{command}/{action}");
            match coordinator.post(&endpoint, &body).await {
                Ok(()) => {
                    let mut state = self.state.lock().unwrap();
                    fs::remove_file(record_path(&self.directory, index))?;
                    crate::sync_state_file(&fs::File::open(&self.directory)?)?;
                    state.pending.remove(&index);
                }
                Err(error) => {
                    eprintln!("Runner output delivery paused: {error}");
                    sleep(Duration::from_secs(2)).await;
                }
            }
        }
    }
}

fn record_path(directory: &Path, index: u64) -> PathBuf {
    directory.join(format!("{index:020}.json"))
}
