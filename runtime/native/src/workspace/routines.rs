use super::*;
use axum::extract::{Path, State};
use axum::routing::{get, put};
use chrono::{Duration, SecondsFormat, Utc};

pub(super) fn router() -> Router<App> {
    Router::new()
        .route("/v1/routines", get(index).post(create))
        .route("/v1/routines/{id}", put(edit).delete(remove))
        .route("/v1/routines/{id}/{action}", get(history).post(action))
}
fn interval(v: &Value) -> Data<i64> {
    v.as_f64()
        .or_else(|| text(v).parse::<f64>().ok())
        .filter(|n| n.is_finite())
        .map(|n| n.round().clamp(1.0, 525600.0) as i64)
        .ok_or_else(|| ApiError::bad("Enter how often this should run, in minutes."))
}
fn next_time(minutes: i64) -> String {
    (Utc::now() + Duration::minutes(minutes.clamp(1, 525600)))
        .to_rfc3339_opts(SecondsFormat::Millis, true)
}
fn routine(db: &Connection, key: &str) -> Data {
    one(
        db,
        "SELECT * FROM schedules WHERE id=?",
        [key],
        "Routine not found.",
    )
}
fn save(db: &Connection, input: &Value, prior: Option<&Value>) -> Data {
    let current = prior.unwrap_or(&Value::Null);
    let agent = required(
        input.get("agentId").unwrap_or(&current["agent_id"]),
        "Agent",
        80,
    )?;
    if !exists(db, "SELECT 1 FROM agent_profiles WHERE id=?", [&agent])? {
        return Err(ApiError::bad("That agent no longer exists."));
    }
    if text(input.get("name").unwrap_or(&current["name"]))
        .trim()
        .is_empty()
        || text(input.get("prompt").unwrap_or(&current["prompt"]))
            .trim()
            .is_empty()
    {
        return Err(ApiError::bad("A routine needs a name and a task."));
    }
    let name = required(
        input.get("name").unwrap_or(&current["name"]),
        "Routine name",
        200,
    )?;
    let prompt = required(
        input.get("prompt").unwrap_or(&current["prompt"]),
        "Routine task",
        20000,
    )?;
    let minutes = input
        .get("intervalMinutes")
        .or_else(|| current.get("interval_minutes"))
        .map(interval)
        .transpose()?
        .unwrap_or(60);
    let stamp = now();
    let next = next_time(minutes);
    if let Some(r) = prior {
        let key = text(&r["id"]);
        db.execute("UPDATE schedules SET agent_id=?,name=?,prompt=?,interval_minutes=?,next_run_at=?,updated_at=? WHERE id=?",params![agent,name,prompt,minutes,next,stamp,key])?;
        routine(db, key)
    } else {
        let key = id();
        let zone = optional(&input["timezone"]).unwrap_or("UTC");
        db.execute("INSERT INTO schedules(id,agent_id,name,prompt,interval_minutes,timezone,enabled,next_run_at,created_at,updated_at) VALUES(?,?,?,?,?,?,1,?,?,?)",params![key,agent,name,prompt,minutes,zone,next,stamp,stamp])?;
        Ok(json!({"id":key,"nextRunAt":next}))
    }
}
pub fn agent_schedule(db: &Connection, agent: &str, input: &Value) -> Reply {
    if !input.is_object() {
        return Err(ApiError::bad("Send a routine object."));
    }
    let mut input = input.clone();
    input["agentId"] = json!(agent);
    Ok(Json(save(db, &input, None)?))
}
async fn index(State(app): State<App>) -> Reply {
    Ok(Json(
        json!({"routines":rows(&app.lock(),"SELECT * FROM schedules ORDER BY created_at DESC",[])?}),
    ))
}
async fn create(State(app): State<App>, Json(input): Json<Value>) -> Http {
    response(StatusCode::CREATED, save(&app.lock(), &input, None)?)
}
async fn edit(State(app): State<App>, Path(key): Path<String>, Json(input): Json<Value>) -> Reply {
    let db = app.lock();
    let current = routine(&db, &key)?;
    Ok(Json(save(&db, &input, Some(&current))?))
}
async fn remove(State(app): State<App>, Path(key): Path<String>) -> Reply {
    let db = app.lock();
    transaction(&db, || {
        routine(&db, &key)?;
        db.execute("DELETE FROM schedule_runs WHERE schedule_id=?", [&key])?;
        db.execute("DELETE FROM schedules WHERE id=?", [&key])?;
        Ok(())
    })?;
    Ok(Json(json!({"ok":true})))
}
async fn history(State(app): State<App>, Path((key, action)): Path<(String, String)>) -> Reply {
    if action != "history" {
        return Err(ApiError::missing("Routine operation not found."));
    }
    let db = app.lock();
    routine(&db, &key)?;
    Ok(Json(
        json!({"history":rows(&db,"SELECT s.*,r.state,r.result,r.error,r.updated_at FROM schedule_runs s JOIN runs r ON r.id=s.run_id WHERE s.schedule_id=? ORDER BY s.scheduled_for DESC LIMIT 100",[&key])?}),
    ))
}
fn trigger(db: &Connection, r: &Value, scheduled_for: &str) -> Data {
    let run = crate::runs::create(db, &json!({"agentId":r["agent_id"],"prompt":r["prompt"]}))?;
    let key = run["id"]
        .as_str()
        .ok_or_else(|| ApiError::bad("Run creation returned no ID."))?;
    let stamp = now();
    db.execute(
        "INSERT INTO schedule_runs(schedule_id,run_id,scheduled_for) VALUES(?,?,?)",
        params![text(&r["id"]), key, scheduled_for],
    )?;
    db.execute(
        "UPDATE schedules SET last_run_at=?,updated_at=? WHERE id=?",
        params![stamp, stamp, text(&r["id"])],
    )?;
    Ok(run)
}
async fn action(State(app): State<App>, Path((key, action)): Path<(String, String)>) -> Http {
    let db = app.lock();
    let r = routine(&db, &key)?;
    match action.as_str() {
        "run" => response(
            StatusCode::ACCEPTED,
            transaction(&db, || {
                trigger(
                    &db,
                    &r,
                    &Utc::now().to_rfc3339_opts(SecondsFormat::Nanos, true),
                )
            })?,
        ),
        "toggle" => {
            let enabled = r["enabled"].as_i64() == Some(0);
            db.execute(
                "UPDATE schedules SET enabled=?,updated_at=? WHERE id=?",
                params![enabled, now(), key],
            )?;
            response(StatusCode::OK, json!({"enabled":enabled}))
        }
        _ => Err(ApiError::missing("Routine operation not found.")),
    }
}
fn run_due(db: &Connection) -> Data<()> {
    let stamp = now();
    // A slot and its run are committed together. Overdue timers coalesce into a single
    // dispatch on restart rather than replaying every interval while the host was off.
    for r in rows(
        db,
        "SELECT * FROM schedules WHERE enabled=1 AND next_run_at<=? ORDER BY next_run_at LIMIT 100",
        [&stamp],
    )? {
        let key = text(&r["id"]);
        let due = text(&r["next_run_at"]);
        if !exists(
            db,
            "SELECT 1 FROM agent_profiles WHERE id=?",
            [text(&r["agent_id"])],
        )? {
            db.execute(
                "UPDATE schedules SET enabled=0,updated_at=? WHERE id=?",
                params![stamp, key],
            )?;
            continue;
        }
        let next = next_time(r["interval_minutes"].as_i64().unwrap_or(60));
        let result = transaction(db, || {
            if !exists(
                db,
                "SELECT 1 FROM schedule_runs WHERE schedule_id=? AND scheduled_for=?",
                params![key, due],
            )? {
                trigger(db, &r, due)?;
            }
            db.execute(
                "UPDATE schedules SET next_run_at=?,updated_at=? WHERE id=?",
                params![next, stamp, key],
            )?;
            Ok(())
        });
        if let Err(error) = result {
            eprintln!("Routine {key} could not start: {error}");
            db.execute(
                "UPDATE schedules SET next_run_at=?,updated_at=? WHERE id=?",
                params![next, stamp, key],
            )?;
        }
    }
    Ok(())
}
pub fn tick(app: &App) -> anyhow::Result<()> {
    Ok(run_due(&app.lock())?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn overdue_routine_creates_one_durable_run_and_history_entry() -> anyhow::Result<()> {
        let db = test_db()?;
        let r = save(
            &db,
            &json!({"name":"Recurring","prompt":"Review the brief","agentId":"atlas","intervalMinutes":10}),
            None,
        )?;
        let key = text(&r["id"]);
        db.execute("UPDATE schedules SET next_run_at='2000' WHERE id=?", [key])?;
        run_due(&db)?;
        run_due(&db)?;
        assert_eq!(
            count(
                &db,
                "SELECT COUNT(*) FROM schedule_runs s JOIN runs r ON r.id=s.run_id WHERE s.schedule_id=? AND r.agent_id='atlas' AND r.prompt='Review the brief' AND r.state='queued'",
                [key]
            )?,
            1
        );
        assert!(!routine(&db, key)?["last_run_at"].is_null());
        Ok(())
    }

    #[test]
    fn handles_replayed_deadlines_and_missing_agents_without_new_attempts() -> anyhow::Result<()> {
        let db = test_db()?;
        let cfg = json!({"name":"Recurring","prompt":"Review brief","agentId":"atlas","intervalMinutes":10});
        let r = save(&db, &cfg, None)?;
        let key = text(&r["id"]);
        db.execute("UPDATE schedules SET next_run_at='2000' WHERE id=?", [key])?;
        db.execute(
            "INSERT INTO schedule_runs VALUES(?,'previous-run','2000')",
            [key],
        )?;
        run_due(&db)?;
        assert_eq!(count(&db, "SELECT count(*) FROM schedule_runs", [])?, 1);
        assert!(text(&routine(&db, key)?["next_run_at"]) > "2000");
        db.execute(
            "UPDATE schedules SET next_run_at='2000',agent_id='missing' WHERE id=?",
            [key],
        )?;
        run_due(&db)?;
        assert_eq!(routine(&db, key)?["enabled"], 0);
        Ok(())
    }
}
