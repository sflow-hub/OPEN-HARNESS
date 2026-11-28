//! Recover work issued by the Node coordinator before the first native startup.
use crate::{machines, now, rows, runs};
use anyhow::{Context, Result};
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use uuid::Uuid;

const NEW_MODE: &str = "The original job requires desktop or direct-host access. Open Harness now runs all agents headlessly.";
const UNCERTAIN: &str = "The old worker command could not be matched to a single saved run. Its execution was not repeated.";

fn json_column(row: &Value, field: &str) -> Option<Value> {
    serde_json::from_str(row[field].as_str()?).ok()
}
fn open(state: &Value) -> bool {
    matches!(state.as_str(), Some("queued" | "leased"))
}
fn active(state: &Value) -> bool {
    matches!(
        state.as_str(),
        Some("queued" | "running" | "waiting_input" | "waiting_approval")
    )
}
fn mark_command(db: &Connection, row: &Value, message: &str) -> Result<()> {
    if open(&row["state"]) {
        db.execute("UPDATE runner_commands SET state='failed',finished_at=?,result_json=? WHERE id=? AND state IN ('leased','queued')",params![now(),json!({"error":message,"interrupted":true}).to_string(),row["id"].as_str()])?;
    }
    Ok(())
}
// This runs before older databases have initialized the task tables. Their board store
// reconciles active task links from these terminal run rows later in the same transaction.
fn finish(
    db: &Connection,
    run: &str,
    state: &str,
    result: Option<&str>,
    reason: Option<&str>,
) -> Result<()> {
    if db.execute("UPDATE runs SET state=?,result=?,error=?,updated_at=? WHERE id=? AND state IN ('queued','running','waiting_input','waiting_approval')",params![state,result,reason,now(),run])?!=0{
        runs::record(db,run,&format!("run.{state}"),&json!({"result":result,"error":reason}))?;
        db.execute("UPDATE approvals SET state='expired',resolved_at=? WHERE run_id=? AND state IN ('pending','resolving')",params![now(),run])?;
    }
    Ok(())
}
fn stop(db: &Connection, row: &Value, run: &str) -> Result<()> {
    let machine = row["machine_id"]
        .as_str()
        .context("Missing legacy machine")?;
    let command = row["id"].as_str().context("Missing legacy command")?;
    let exists:bool=db.query_row("SELECT EXISTS(SELECT 1 FROM runner_commands WHERE kind='stop' AND machine_id=? AND agent_id=? AND state IN ('queued','leased') AND CASE WHEN json_valid(payload_json) THEN json_extract(payload_json,'$.runId') END=? AND CASE WHEN json_valid(payload_json) THEN json_extract(payload_json,'$.commandId') END=?)",params![machine,row["agent_id"].as_str(),run,command],|r|r.get(0))?;
    if !exists {
        machines::enqueue(
            db,
            machine,
            row["agent_id"].as_str(),
            "stop",
            &json!({"runId":run,"commandId":command}),
        )?;
    }
    Ok(())
}
fn authentic(row: &Value, payload: &Value, profile: &Value) -> bool {
    let Some(run) = row["run_id"].as_str() else {
        return false;
    };
    let Some(machine) = row["machine_id"].as_str() else {
        return false;
    };
    // The issuer saved the exact same snapshot into run_profiles and the command. The
    // current agent profile may since have changed, including its assigned computer.
    Uuid::parse_str(run).is_ok()
        && row["id"]
            .as_str()
            .is_some_and(|id| Uuid::parse_str(id).is_ok())
        && machine
            .strip_prefix("machine-")
            .is_some_and(|id| Uuid::parse_str(id).is_ok())
        && row["remote"] == 1
        && (!open(&row["state"]) || row["authorized"] == 1)
        && payload["runId"] == run
        && payload["prompt"] == row["prompt"]
        && row["agent_id"].is_string()
        && row["agent_id"] == row["run_agent"]
        && row["agent_id"] == row["profile_agent"]
        && profile["id"] == row["agent_id"]
        && profile["revision"] == row["revision"]
        && profile["computer"]["machineId"] == machine
        && payload["snapshot"] == *profile
}
fn headless(profile: &Value) -> bool {
    let valid_harness = profile
        .get("harness")
        .is_none_or(|h| matches!(h.as_str(), Some("hermes" | "claude-code" | "codex")));
    valid_harness
        && profile["computer"]["desktop"] == "none"
        && matches!(
            profile["computer"]["access"].as_str(),
            Some("private" | "folders")
        )
        && profile["allowedTools"]
            .as_array()
            .is_some_and(|tools| tools.iter().all(|t| t.is_string() && t != "computer_use"))
}
pub(super) fn reconcile(db: &Connection) -> Result<()> {
    db.execute_batch("CREATE TABLE IF NOT EXISTS native_legacy_leases(run_id TEXT PRIMARY KEY,command_id TEXT NOT NULL UNIQUE)")?;
    let done: bool = db.query_row(
        "SELECT EXISTS(SELECT 1 FROM migrations WHERE key='native-remote-leases-v1')",
        [],
        |r| r.get(0),
    )?;
    if done {
        return Ok(());
    }
    let old=rows(db,"SELECT c.id,c.machine_id,c.agent_id,c.state,c.payload_json,c.result_json,r.id AS run_id,r.agent_id AS run_agent,r.state AS run_state,r.prompt,rp.agent_id AS profile_agent,rp.revision,rp.json AS profile_json,
        (m.id IS NOT NULL AND m.local=0) AS remote, (m.revoked_at IS NULL AND length(m.credential_hash)>0) AS authorized
        FROM runner_commands c LEFT JOIN runs r ON r.id=CASE WHEN json_valid(c.payload_json) THEN json_extract(c.payload_json,'$.runId') END
        LEFT JOIN run_profiles rp ON rp.run_id=r.id LEFT JOIN machines m ON m.id=c.machine_id
        WHERE c.kind='run' AND (c.state IN ('queued','leased') OR r.state IN ('queued','running','waiting_approval','waiting_input'))
        AND NOT EXISTS(SELECT 1 FROM native_run_bindings b WHERE b.command_id=c.id)
        ORDER BY c.rowid",&[])?;
    let mut groups: BTreeMap<String, Vec<(Value, Value)>> = BTreeMap::new();
    for row in old {
        let payload = json_column(&row, "payload_json").unwrap_or(Value::Null);
        let profile = json_column(&row, "profile_json").unwrap_or(Value::Null);
        let valid = authentic(&row, &payload, &profile);
        if valid && row["state"] == "leased" && !active(&row["run_state"]) {
            stop(db, &row, row["run_id"].as_str().unwrap())?;
        }
        if !valid || !active(&row["run_state"]) {
            mark_command(db, &row, UNCERTAIN)?;
            continue;
        }
        let run = row["run_id"].as_str().unwrap().to_owned();
        groups.entry(run).or_default().push((row, profile));
    }
    for (run, mut matches) in groups {
        let bound: bool = db.query_row(
            "SELECT EXISTS(SELECT 1 FROM native_run_bindings WHERE run_id=?)",
            [&run],
            |r| r.get(0),
        )?;
        if bound || matches.len() != 1 {
            for (row, _) in matches {
                if row["state"] == "leased" {
                    stop(db, &row, &run)?;
                }
                mark_command(db, &row, UNCERTAIN)?;
            }
            if !bound {
                finish(db, &run, "interrupted", None, Some(UNCERTAIN))?;
            }
            continue;
        }
        let (row, profile) = matches.pop().unwrap();
        let prior_stop:Option<String>=db.query_row("SELECT state FROM runner_commands WHERE kind='stop' AND machine_id=?1 AND agent_id=?2 AND CASE WHEN json_valid(payload_json) THEN json_extract(payload_json,'$.runId') END=?3 AND CASE WHEN json_valid(payload_json) THEN json_extract(payload_json,'$.commandId') END=?4 ORDER BY (state='completed') DESC,rowid DESC LIMIT 1",params![row["machine_id"].as_str(),row["agent_id"].as_str(),run,row["id"].as_str()],|r|r.get(0)).optional()?;
        // Acknowledged cancellation remains terminal even if its original run receipt
        // had not reached the Node coordinator's in-memory polling loop.
        if prior_stop.as_deref() == Some("completed") && row["state"] != "completed" {
            mark_command(
                db,
                &row,
                "The original worker confirmed that it stopped this job.",
            )?;
            finish(db, &run, "cancelled", None, None)?;
            continue;
        }
        if !open(&row["state"]) {
            let result = json_column(&row, "result_json");
            match (row["state"].as_str(), result.as_ref()) {
                (Some("completed"), Some(result)) => {
                    let answer = ["text", "final_response", "message", "result"]
                        .iter()
                        .find_map(|f| result[*f].as_str())
                        .or_else(|| result.as_str())
                        .unwrap_or("");
                    finish(db, &run, "completed", Some(answer), None)?;
                }
                (Some("failed"), Some(result)) => {
                    let reason = result["error"]
                        .as_str()
                        .unwrap_or("The original worker reported a failed run.");
                    let state = if result["interrupted"] == true {
                        "interrupted"
                    } else {
                        "failed"
                    };
                    finish(db, &run, state, None, Some(reason))?;
                }
                _ => finish(db, &run, "interrupted", None, Some(UNCERTAIN))?,
            }
            continue;
        }
        let safe = headless(&profile);
        let stop_pending = matches!(prior_stop.as_deref(), Some("queued" | "leased"));
        if stop_pending && row["state"] == "queued" {
            mark_command(
                db,
                &row,
                "The operator stopped this job before it was leased.",
            )?;
            db.execute("UPDATE runner_commands SET state='completed',result_json=?,finished_at=? WHERE kind='stop' AND machine_id=? AND agent_id=? AND state IN ('queued','leased') AND CASE WHEN json_valid(payload_json) THEN json_extract(payload_json,'$.runId') END=? AND CASE WHEN json_valid(payload_json) THEN json_extract(payload_json,'$.commandId') END=?",params![json!({"ok":true}).to_string(),now(),row["machine_id"].as_str(),row["agent_id"].as_str(),run,row["id"].as_str()])?;
            finish(db, &run, "cancelled", None, None)?;
            continue;
        }
        if safe && prior_stop.as_deref() == Some("failed") {
            let message = "The original worker could not confirm that it stopped this job.";
            mark_command(db, &row, message)?;
            finish(db, &run, "interrupted", None, Some(message))?;
            continue;
        }
        if !safe && row["state"] == "queued" {
            mark_command(db, &row, NEW_MODE)?;
            finish(db, &run, "cancelled", None, Some(NEW_MODE))?;
            continue;
        }
        db.execute("INSERT INTO native_run_bindings(run_id,command_id,machine_id,stopping) VALUES(?,?,?,?)",params![run,row["id"].as_str(),row["machine_id"].as_str(),!safe || stop_pending])?;
        // A durable command is the sole owner of this run. Keeping it out of the
        // scheduler avoids issuing an additional command after any subsequent restart.
        db.execute(
            "UPDATE runs SET state='running',updated_at=? WHERE id=? AND state='queued'",
            params![now(), run],
        )?;
        if safe && !stop_pending {
            db.execute(
                "INSERT INTO native_legacy_leases VALUES(?,?)",
                params![run, row["id"].as_str()],
            )?;
        } else if !safe {
            stop(db, &row, &run)?;
            runs::record(db, &run, "run.stop_requested", &json!({"reason":NEW_MODE}))?;
        }
    }
    db.execute("INSERT INTO migrations(key,payload_json,created_at) VALUES('native-remote-leases-v1','{}',?)",[now()])?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::id;
    struct Fixture {
        db: Connection,
        host: String,
    }
    impl Fixture {
        fn new() -> Result<Self> {
            let db = Connection::open_in_memory()?;
            db.execute_batch(include_str!("../schema.sql"))?;
            db.execute_batch("CREATE TABLE run_profiles(run_id TEXT PRIMARY KEY,agent_id TEXT,revision INTEGER,json TEXT)")?;
            let host = format!("machine-{}", id());
            db.execute("INSERT INTO machines(id,name,platform,arch,status,local,capabilities_json,credential_hash,created_at,updated_at) VALUES(?,'Old worker','linux','arm64','online',0,'{}','test-hash','then','then')",[&host])?;
            Ok(Self { db, host })
        }
        fn job(&self, worker_state: &str, desktop: bool) -> Result<(String, String)> {
            let run = id();
            let command = id();
            let snapshot = json!({"id":"test-agent","revision":2,"harness":"hermes","allowedTools":["read_file"],"computer":{"machineId":self.host,"access":if desktop{"direct"}else{"private"},"desktop":if desktop{"existing"}else{"none"}}});
            self.db.execute("INSERT INTO runs(id,agent_id,conversation_id,prompt,state,created_at,updated_at) VALUES(?,'test-agent','c','work','running','then','then')",[&run])?;
            self.db.execute(
                "INSERT INTO run_profiles VALUES(?,'test-agent',2,?)",
                params![run, snapshot.to_string()],
            )?;
            let payload = json!({"snapshot":snapshot,"prompt":"work","runId":run}).to_string();
            self.db.execute("INSERT INTO runner_commands(id,machine_id,agent_id,kind,payload_json,state,created_at) VALUES(?,?,'test-agent','run',?,?,'then')",params![command,self.host,payload,worker_state])?;
            Ok((run, command))
        }
        fn count(&self, sql: &str) -> Result<i64> {
            Ok(self.db.query_row(sql, [], |r| r.get(0))?)
        }
        fn state(&self, key: &str) -> Result<String> {
            Ok(self
                .db
                .query_row("SELECT state FROM runs WHERE id=?", [key], |r| r.get(0))?)
        }
    }
    #[test]
    fn adopts_only_matching_snapshots_and_stops_legacy_graphical_work_once() -> Result<()> {
        let f = Fixture::new()?;
        let (kept, command) = f.job("leased", false)?;
        let (queued, _) = f.job("queued", true)?;
        let (unsafe_run, unsafe_cmd) = f.job("leased", true)?;
        let (_, bad) = f.job("leased", false)?;
        f.db.execute(
            "UPDATE runner_commands SET agent_id='another-agent' WHERE id=?",
            [bad],
        )?;
        reconcile(&f.db)?;
        reconcile(&f.db)?;
        assert_eq!(f.state(&kept)?, "running");
        assert_eq!(f.state(&queued)?, "cancelled");
        assert_eq!(f.count("SELECT count(*) FROM native_legacy_leases")?, 1);
        assert_eq!(f.count("SELECT count(*) FROM native_run_bindings")?, 2);
        assert_eq!(
            f.count("SELECT count(*) FROM runner_commands WHERE kind='stop'")?,
            1
        );
        let binding: String = f.db.query_row(
            "SELECT command_id FROM native_legacy_leases WHERE run_id=?",
            [kept],
            |r| r.get(0),
        )?;
        assert_eq!(binding, command);
        let payload: String = f.db.query_row(
            "SELECT payload_json FROM runner_commands WHERE kind='stop'",
            [],
            |r| r.get(0),
        )?;
        assert_eq!(
            serde_json::from_str::<Value>(&payload)?,
            json!({"commandId":unsafe_cmd,"runId":unsafe_run})
        );
        assert_eq!(
            f.count("SELECT count(*) FROM runner_commands WHERE kind='run' AND state='queued'")?,
            0
        );
        Ok(())
    }
    #[test]
    fn saved_results_survive_a_crash_between_command_receipt_and_run_completion() -> Result<()> {
        let f = Fixture::new()?;
        let (done, cmd) = f.job("completed", false)?;
        let (failed, err) = f.job("failed", true)?;
        f.db.execute(
            "UPDATE runner_commands SET result_json=? WHERE id=?",
            params![r#"{"final_response":"original answer"}"#, cmd],
        )?;
        f.db.execute(
            "UPDATE runner_commands SET result_json=? WHERE id=?",
            params![r#"{"error":"original failure"}"#, err],
        )?;
        f.db.execute(
            "UPDATE machines SET revoked_at='afterward',credential_hash=NULL",
            [],
        )?;
        reconcile(&f.db)?;
        reconcile(&f.db)?;
        assert_eq!(f.state(&done)?, "completed");
        assert_eq!(f.state(&failed)?, "failed");
        let answer: String =
            f.db.query_row("SELECT result FROM runs WHERE id=?", [done], |r| r.get(0))?;
        assert_eq!(answer, "original answer");
        let reason: String =
            f.db.query_row("SELECT error FROM runs WHERE id=?", [failed], |r| r.get(0))?;
        assert_eq!(reason, "original failure");
        assert_eq!(f.count("SELECT count(*) FROM events")?, 2);
        assert_eq!(f.count("SELECT count(*) FROM native_legacy_leases")?, 0);
        Ok(())
    }
    #[test]
    fn previously_confirmed_and_pending_stop_controls_retain_their_outcomes() -> Result<()> {
        let f = Fixture::new()?;
        let (stopped, work) = f.job("leased", false)?;
        let (waiting, active) = f.job("leased", false)?;
        let (unstarted, unleased) = f.job("queued", false)?;
        for (state, run, cmd) in [
            ("completed", &stopped, &work),
            ("queued", &waiting, &active),
            ("queued", &unstarted, &unleased),
        ] {
            f.db.execute("INSERT INTO runner_commands(id,machine_id,agent_id,kind,payload_json,state,created_at) VALUES(?,?,'test-agent','stop',?,?,'then')",params![id(),f.host,json!({"runId":run,"commandId":cmd}).to_string(),state])?;
        }
        reconcile(&f.db)?;
        assert_eq!(f.state(&stopped)?, "cancelled");
        assert_eq!(f.state(&unstarted)?, "cancelled");
        assert_eq!(f.state(&waiting)?, "running");
        assert_eq!(
            f.count("SELECT count(*) FROM native_run_bindings WHERE stopping=1")?,
            1
        );
        assert_eq!(f.count("SELECT count(*) FROM native_legacy_leases")?, 0);
        assert_eq!(
            f.count("SELECT count(*) FROM runner_commands WHERE kind='stop'")?,
            3
        );
        Ok(())
    }

    #[test]
    fn two_plausible_commands_for_the_same_run_are_never_released_again() -> Result<()> {
        let f = Fixture::new()?;
        let (run, _) = f.job("leased", false)?;
        f.db.execute("INSERT INTO runner_commands(id,machine_id,agent_id,kind,payload_json,state,created_at) SELECT ?,machine_id,agent_id,kind,payload_json,'queued',created_at FROM runner_commands",[id()])?;
        reconcile(&f.db)?;
        assert_eq!(f.state(&run)?, "interrupted");
        assert_eq!(f.count("SELECT count(*) FROM native_run_bindings")?, 0);
        assert_eq!(
            f.count("SELECT count(*) FROM runner_commands WHERE kind='run' AND state='failed'")?,
            2
        );
        Ok(())
    }
}
