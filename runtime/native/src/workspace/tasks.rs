use super::*;
use axum::extract::{Path, State};
use axum::routing::get;
use std::collections::BTreeSet;

const TASK: &str = "SELECT t.id,t.board_id AS boardId,t.stage_id AS stageId,t.team_id AS teamId,t.title,t.description,t.owner_agent_id AS ownerAgentId,t.priority,t.due_at AS dueAt,t.position,t.archived,t.revision,t.active_run_id AS activeRunId,t.created_at AS createdAt,t.updated_at AS updatedAt,COALESCE(active.state,(SELECT r.state FROM task_runs x JOIN runs r ON x.run_id=r.id WHERE x.task_id=t.id ORDER BY x.attempt DESC LIMIT 1)) AS runState FROM tasks t JOIN task_boards b ON b.id=t.board_id LEFT JOIN runs active ON active.id=t.active_run_id";
const PRIORITIES: [&str; 4] = ["low", "normal", "high", "urgent"];
pub(super) fn router() -> Router<App> {
    Router::new()
        .route("/v1/tasks", get(index).post(new_task))
        .route("/v1/tasks/{id}", get(show).put(edit).delete(remove))
        .route("/v1/tasks/{id}/{action}", get(history).post(action))
}
fn hydrate(db: &Connection, mut row: Value) -> Data {
    let key = text(&row["id"]).to_owned();
    row["archived"] = json!(row["archived"].as_i64().unwrap_or(0) != 0);
    row["collaboratorAgentIds"] = json!(strings(
        db,
        "SELECT agent_id FROM task_collaborators WHERE task_id=? ORDER BY agent_id",
        [&key]
    )?);
    row["labels"] = json!(strings(
        db,
        "SELECT label FROM task_labels WHERE task_id=? ORDER BY label",
        [&key]
    )?);
    let mut checklist = rows(
        db,
        "SELECT id,text,done,position FROM task_checklist WHERE task_id=? ORDER BY position,id",
        [&key],
    )?;
    for item in &mut checklist {
        item["done"] = json!(item["done"].as_i64().unwrap_or(0) != 0);
    }
    row["checklist"] = json!(checklist);
    row["comments"] = json!(rows(
        db,
        "SELECT id,body,author,created_at AS createdAt FROM task_comments WHERE task_id=? ORDER BY created_at DESC,rowid DESC",
        [&key]
    )?);
    row["activity"] = json!(rows(
        db,
        "SELECT id,type,detail,created_at AS createdAt FROM task_activity WHERE task_id=? ORDER BY created_at DESC,rowid DESC LIMIT 100",
        [&key]
    )?);
    row["runs"] = json!(rows(
        db,
        "SELECT r.id,r.agent_id,r.conversation_id,r.prompt,r.state,r.result,r.error,x.attempt,x.started_at AS startedAt,substr(COALESCE(NULLIF(x.output,''),r.result,''),-20000) AS output,COALESCE(x.stop_reason,CASE WHEN r.state='completed' THEN 'end_turn' ELSE r.error END) AS stopReason FROM task_runs x JOIN runs r ON x.run_id=r.id WHERE x.task_id=? ORDER BY x.attempt DESC",
        [&key]
    )?);
    Ok(row)
}
pub(super) fn task(db: &Connection, key: &str) -> Data {
    hydrate(
        db,
        one(
            db,
            &format!("{TASK} WHERE t.id=?"),
            [key],
            "Task not found.",
        )?,
    )
}
fn list_tasks(db: &Connection, all: bool) -> Data<Vec<Value>> {
    rows(
        db,
        &format!(
            "{TASK} WHERE (? OR (t.archived=0 AND b.archived=0)) ORDER BY t.position,t.created_at"
        ),
        [all],
    )?
    .into_iter()
    .map(|v| hydrate(db, v))
    .collect()
}
pub(super) fn activity(
    db: &Connection,
    key: &str,
    kind: &str,
    detail: &str,
) -> rusqlite::Result<()> {
    db.execute(
        "INSERT INTO task_activity(id,task_id,type,detail,created_at) VALUES(?,?,?,?,?)",
        params![id(), key, kind, detail, now()],
    )?;
    Ok(())
}
pub(super) fn collections(db: &Connection, key: &str, input: &Value) -> Data<()> {
    if input["collaboratorAgentIds"].is_array() {
        db.execute("DELETE FROM task_collaborators WHERE task_id=?", [key])?;
        for owner in array_strings(&input["collaboratorAgentIds"])
            .iter()
            .take(25)
        {
            db.execute(
                "INSERT INTO task_collaborators(task_id,agent_id) VALUES(?,?)",
                params![key, owner],
            )?;
        }
    }
    if input["labels"].is_array() {
        db.execute("DELETE FROM task_labels WHERE task_id=?", [key])?;
        let mut stored = BTreeSet::new();
        for label in array_strings(&input["labels"]) {
            let label = take(label.trim(), 40);
            if !label.is_empty() && stored.insert(label.clone()) {
                db.execute(
                    "INSERT INTO task_labels(task_id,label) VALUES(?,?)",
                    params![key, label],
                )?;
                if stored.len() == 20 {
                    break;
                }
            }
        }
    }
    if let Some(items) = input["checklist"].as_array() {
        db.execute("DELETE FROM task_checklist WHERE task_id=?", [key])?;
        for (pos, item) in items.iter().take(100).enumerate() {
            let body = take(text(&item["text"]).trim(), 500);
            if body.is_empty() {
                continue;
            }
            let entry = optional(&item["id"])
                .map(ToOwned::to_owned)
                .unwrap_or_else(id);
            db.execute(
                "INSERT INTO task_checklist(id,task_id,text,done,position) VALUES(?,?,?,?,?)",
                params![entry, key, body, item["done"] == true, pos as i64],
            )?;
        }
    }
    Ok(())
}
fn assignment(db: &Connection, input: &Value, prior: &Value, board: &Value) -> Data<Value> {
    let team = optional(input.get("teamId").unwrap_or(&prior["teamId"]));
    let owner = optional(
        input
            .get("ownerAgentId")
            .or_else(|| prior.get("ownerAgentId"))
            .unwrap_or(&board["defaultOwnerAgentId"]),
    );
    let mut people = array_strings(
        input
            .get("collaboratorAgentIds")
            .unwrap_or(&prior["collaboratorAgentIds"]),
    );
    if input.get("collaboratorAgentIds").is_some() && !input["collaboratorAgentIds"].is_array() {
        return Err(ApiError::bad("Choose valid collaborators."));
    }
    people.retain(|p| Some(p.as_str()) != owner);
    people.sort();
    if let Some(team) = team {
        if !exists(
            db,
            "SELECT 1 FROM teams WHERE id=? AND retired_at IS NULL",
            [team],
        )? {
            return Err(ApiError::bad("Choose an active team."));
        }
        for agent in owner.into_iter().chain(people.iter().map(String::as_str)) {
            if !teams::member(db, team, agent)? {
                return Err(ApiError::bad(
                    "Task owners and collaborators must belong to the selected team.",
                ));
            }
        }
    } else if !people.is_empty()
        && (prior.is_null()
            || !prior["teamId"].is_null()
            || input.get("collaboratorAgentIds").is_some())
    {
        return Err(ApiError::bad("Choose a team before adding collaborators."));
    }
    Ok(json!({"teamId":team,"ownerAgentId":owner,"collaboratorAgentIds":people}))
}
fn checked_stage<'a>(board: &'a Value, key: &str) -> Data<&'a Value> {
    list(&board["stages"])
        .iter()
        .find(|s| s["id"] == key)
        .ok_or_else(|| ApiError::bad("Stage is not on this board."))
}
fn create(db: &Connection, input: &Value) -> Data {
    let board = boards::board(db, &required(&input["boardId"], "Board", 100)?)?;
    let stage = optional(&input["stageId"])
        .or_else(|| {
            list(&board["stages"])
                .iter()
                .find(|s| s["category"] == "backlog")
                .map(|s| text(&s["id"]))
        })
        .unwrap_or("");
    checked_stage(&board, stage)?;
    let title = required(&input["title"], "Task title", 240)?;
    let scoped = assignment(db, input, &Value::Null, &board)?;
    let mut fields = input.clone();
    fields["collaboratorAgentIds"] = scoped["collaboratorAgentIds"].clone();
    let priority = optional(&input["priority"])
        .filter(|p| PRIORITIES.contains(p))
        .unwrap_or("normal");
    let key = id();
    let stamp = now();
    transaction(db, || {
        db.execute("INSERT INTO tasks(id,board_id,stage_id,title,description,team_id,owner_agent_id,priority,due_at,position,created_at,updated_at) SELECT ?,?,?,?,?,?,?,?,?,COALESCE(MAX(position),-1)+1,?,? FROM tasks WHERE stage_id=?",params![key,text(&board["id"]),stage,title,take(text(&input["description"]),20000),optional(&scoped["teamId"]),optional(&scoped["ownerAgentId"]),priority,optional(&input["dueAt"]),stamp,stamp,stage])?;
        collections(db, &key, &fields)?;
        activity(db, &key, "created", "Task created")?;
        task(db, &key)
    })
}
fn locked(task: &Value) -> bool {
    !task["activeRunId"].is_null()
        && matches!(
            text(&task["runState"]),
            "queued" | "running" | "waiting_approval" | "waiting_input"
        )
}
fn update(db: &Connection, key: &str, input: &Value) -> Data {
    let current = task(db, key)?;
    revision(input, &current, "task", false)?;
    let board = boards::board(
        db,
        text(input.get("boardId").unwrap_or(&current["boardId"])),
    )?;
    let stage = text(input.get("stageId").unwrap_or(&current["stageId"]));
    checked_stage(&board, stage)?;
    let scoped = assignment(db, input, &current, &board)?;
    let archived = input
        .get("archived")
        .unwrap_or(&current["archived"])
        .as_bool()
        .unwrap_or(false);
    if locked(&current)
        && (board["id"] != current["boardId"]
            || current["stageId"] != stage
            || current["archived"] != archived
            || ["ownerAgentId", "teamId", "collaboratorAgentIds"]
                .iter()
                .any(|k| scoped[*k] != current[*k]))
    {
        return Err(ApiError::conflict(
            "Team, owner, collaborators, project, stage, and archive status are locked while this task is active.",
        ));
    }
    let title = required(
        input.get("title").unwrap_or(&current["title"]),
        "Task title",
        240,
    )?;
    let priority = text(input.get("priority").unwrap_or(&current["priority"]));
    if !PRIORITIES.contains(&priority) {
        return Err(ApiError::bad("Invalid task priority."));
    }
    let position = input
        .get("position")
        .unwrap_or(&current["position"])
        .as_f64()
        .ok_or_else(|| ApiError::bad("Invalid task position."))?;
    let mut fields = input.clone();
    fields["collaboratorAgentIds"] = scoped["collaboratorAgentIds"].clone();
    transaction(db, || {
        db.execute("UPDATE tasks SET board_id=?,stage_id=?,title=?,description=?,team_id=?,owner_agent_id=?,priority=?,due_at=?,position=?,archived=?,revision=revision+1,updated_at=? WHERE id=?",params![text(&board["id"]),stage,title,take(text(input.get("description").unwrap_or(&current["description"])),20000),optional(&scoped["teamId"]),optional(&scoped["ownerAgentId"]),priority,optional(input.get("dueAt").unwrap_or(&current["dueAt"])),position,archived,now(),key])?;
        collections(db, key, &fields)?;
        activity(db, key, "updated", "Task details updated")?;
        task(db, key)
    })
}
fn move_task(db: &Connection, key: &str, input: &Value) -> Data {
    let current = task(db, key)?;
    let board = boards::board(db, text(&current["boardId"]))?;
    if locked(&current) {
        return Err(ApiError::conflict(
            "Stage and owner are locked while this task is active.",
        ));
    }
    let stage = required(&input["stageId"], "Stage", 100)?;
    let stage_name = text(&checked_stage(&board, &stage)?["name"]);
    // A move changes only stage and owner. Validate the resulting stored scope.
    let mut changes = json!({});
    if let Some(owner) = input.get("ownerAgentId") {
        changes["ownerAgentId"] = owner.clone();
    }
    let scoped = assignment(db, &changes, &current, &board)?;
    let siblings = rows(
        db,
        "SELECT id,position FROM tasks WHERE stage_id=? AND archived=0 AND id<>? ORDER BY position,id",
        params![stage, key],
    )?;
    let pos = |row: &Value| row["position"].as_f64().unwrap_or(0.0);
    let position = match siblings.iter().position(|r| r["id"] == input["beforeId"]) {
        Some(0) => pos(&siblings[0]) - 1000.0,
        Some(n) => (pos(&siblings[n - 1]) + pos(&siblings[n])) / 2.0,
        None => siblings.last().map_or(1000.0, |v| pos(v) + 1000.0),
    };
    transaction(db, || {
        db.execute("UPDATE tasks SET stage_id=?,owner_agent_id=?,position=?,revision=revision+1,updated_at=? WHERE id=?",params![stage,optional(&scoped["ownerAgentId"]),position,now(),key])?;
        let all = rows(
            db,
            "SELECT id,position FROM tasks WHERE stage_id=? ORDER BY position,id",
            [&stage],
        )?;
        if all.windows(2).any(|w| pos(&w[1]) - pos(&w[0]) < 0.001) {
            for (i, row) in all.iter().enumerate() {
                db.execute(
                    "UPDATE tasks SET position=? WHERE id=?",
                    params![1000 * (i + 1) as i64, text(&row["id"])],
                )?;
            }
        }
        activity(db, key, "moved", &format!("Moved to {stage_name}"))?;
        task(db, key)
    })
}
fn comment(db: &Connection, key: &str, body: &str, author: &str) -> Data {
    let body = required(&json!(body), "Comment", 5000)?;
    db.execute(
        "INSERT INTO task_comments(id,task_id,body,author,created_at) VALUES(?,?,?,?,?)",
        params![id(), key, body, take(author, 80), now()],
    )?;
    activity(db, key, "commented", "Comment added")?;
    task(db, key)
}
fn checklist(db: &Connection, key: &str, input: &Value, add: bool) -> Data {
    let current = task(db, key)?;
    if add {
        let body = required(&input["text"], "Checklist item", 500)?;
        db.execute("INSERT INTO task_checklist(id,task_id,text,done,position) SELECT ?,?,?,0,COALESCE(MAX(position),-1)+1 FROM task_checklist WHERE task_id=?",params![id(),key,body,key])?;
        activity(db, key, "checklist", "Checklist item added")?;
    } else {
        let items = list(&current["checklist"]);
        let item = &input["item"];
        let n = item.as_u64().or_else(|| text(item).parse().ok());
        let entry = items
            .iter()
            .find(|v| v["id"] == *item)
            .or_else(|| {
                n.and_then(|n| n.checked_sub(1))
                    .and_then(|i| items.get(i as usize))
            })
            .ok_or_else(|| ApiError::missing("Checklist item not found."))?;
        let done = input["done"].as_bool().unwrap_or(entry["done"] != true);
        db.execute(
            "UPDATE task_checklist SET done=? WHERE id=? AND task_id=?",
            params![done, text(&entry["id"]), key],
        )?;
        activity(
            db,
            key,
            "checked",
            &format!(
                "{} {}",
                if done { "Checked" } else { "Unchecked" },
                text(&entry["text"])
            ),
        )?;
    }
    task(db, key)
}
fn start(db: &Connection, key: &str, input: &Value) -> Data {
    let current = task(db, key)?;
    let idempotency = format!(
        "{key}:{}",
        required(&input["idempotencyKey"], "Idempotency key", 200)?
    );
    if let Some(run) = rows(
        db,
        "SELECT r.* FROM runs r JOIN task_runs x ON x.run_id=r.id WHERE x.idempotency_key=?",
        [&idempotency],
    )?
    .pop()
    {
        return Ok(json!({"task":current,"run":run}));
    }
    if locked(&current) {
        return Err(ApiError::conflict("This task already has an active run."));
    }
    let owner = optional(&current["ownerAgentId"])
        .ok_or_else(|| ApiError::bad("Assign an owner before starting this task."))?;
    revision(input, &current, "task", true)?;
    let board = boards::board(db, text(&current["boardId"]))?;
    let stage = checked_stage(&board, text(&board["settings"]["runStageId"]))?;
    let mut parts = vec![
        format!(
            "You are completing board task {key}: {}",
            text(&current["title"])
        ),
        format!("Stage: {}", text(&stage["name"])),
        format!("Priority: {}", text(&current["priority"])),
    ];
    if let Some(due) = optional(&current["dueAt"]) {
        parts.push(format!("Due: {due}"));
    }
    if let Some(brief) = optional(&current["description"]) {
        parts.push(format!("Brief:\n{brief}"));
    }
    let checklist = list(&current["checklist"])
        .iter()
        .map(|item| {
            format!(
                "- [{}] {} ({})",
                if item["done"] == true { "x" } else { " " },
                text(&item["text"]),
                text(&item["id"])
            )
        })
        .collect::<Vec<_>>();
    if !checklist.is_empty() {
        parts.push(format!(
            "Checklist (use item IDs when reporting progress):\n{}",
            checklist.join("\n")
        ));
    }
    let recent = list(&current["comments"])
        .iter()
        .take(3)
        .rev()
        .map(|c| format!("- {}: {}", text(&c["author"]), text(&c["body"])))
        .collect::<Vec<_>>();
    if !recent.is_empty() {
        parts.push(format!("Recent comments:\n{}", recent.join("\n")));
    }
    let feedback = text(&input["feedback"]).trim();
    if !feedback.is_empty() {
        parts.push(format!("Requested changes:\n{feedback}"));
    }
    parts.push("Work independently. Update checklist items and leave concise progress comments when useful. Do not move this card; successful work is sent for review automatically. End with a short report for the card.".to_owned());
    transaction(db, || {
        let run = crate::runs::create(db, &json!({"agentId":owner,"prompt":parts.join("\n\n")}))?;
        let attempt = count(
            db,
            "SELECT COALESCE(MAX(attempt),0)+1 FROM task_runs WHERE task_id=?",
            [key],
        )?;
        let run_id = run["id"]
            .as_str()
            .ok_or_else(|| ApiError::bad("Run creation returned no ID."))?;
        db.execute("INSERT INTO task_runs(task_id,run_id,attempt,instructions_snapshot,checklist_snapshot,idempotency_key,started_at) VALUES(?,?,?,?,?,?,?)",params![key,run_id,attempt,text(&current["description"]),current["checklist"].to_string(),idempotency,now()])?;
        db.execute("UPDATE tasks SET stage_id=?,active_run_id=?,revision=revision+1,updated_at=? WHERE id=?",params![text(&stage["id"]),run_id,now(),key])?;
        if feedback.is_empty() {
            activity(db, key, "started", &format!("Started attempt {attempt}"))?;
        } else {
            activity(db, key, "changes_requested", feedback)?;
        }
        Ok(json!({"task":task(db,key)?,"run":run}))
    })
}
fn approve(db: &Connection, key: &str, input: &Value) -> Data {
    let current = task(db, key)?;
    revision(input, &current, "task", true)?;
    if !current["activeRunId"].is_null() {
        return Err(ApiError::conflict("Wait for the active run to finish."));
    }
    let dest = strings(
        db,
        "SELECT id FROM task_stages WHERE board_id=? AND category='done' ORDER BY position LIMIT 1",
        [text(&current["boardId"])],
    )?
    .pop()
    .ok_or_else(|| ApiError::bad("This board needs a Done stage."))?;
    db.execute(
        "UPDATE tasks SET stage_id=?,revision=revision+1,updated_at=? WHERE id=?",
        params![dest, now(), key],
    )?;
    activity(db, key, "approved", "Task approved and marked done")?;
    task(db, key)
}
pub fn run_changed(db: &Connection, run_id: &str) -> anyhow::Result<()> {
    // Only the active attempt can change its task. Duplicate deliveries and old
    // completions cannot advance a retried card or append a second report.
    let mut links = rows(
        db,
        "SELECT r.state,r.result,r.error,t.id AS task,t.board_id AS board FROM runs r JOIN tasks t ON t.active_run_id=r.id JOIN task_runs x ON x.run_id=r.id AND x.task_id=t.id WHERE r.id=? AND r.state IN ('completed','failed','interrupted','cancelled')",
        [run_id],
    )?;
    let Some(link) = links.pop() else {
        return Ok(());
    };
    let key = text(&link["task"]);
    let state = text(&link["state"]);
    let stamp = now();
    transaction(db, || {
        if state == "completed" {
            let board = boards::board(db, text(&link["board"]))?;
            let dest = text(&board["settings"]["doneStageId"]);
            db.execute("UPDATE tasks SET stage_id=COALESCE(NULLIF(?,''),stage_id),active_run_id=NULL,revision=revision+1,updated_at=? WHERE id=?",params![dest,stamp,key])?;
            let output = tail(text(&link["result"]), 20000);
            db.execute("UPDATE task_runs SET output=COALESCE(NULLIF(?,''),output),stop_reason='end_turn' WHERE run_id=?",params![output,run_id])?;
            if !output.is_empty() {
                db.execute("INSERT INTO task_comments(id,task_id,body,author,created_at) VALUES(?,?,?,'agent',?)",params![id(),key,tail(&output,8000),stamp])?;
                activity(db, key, "commented", "Comment added")?;
            }
            activity(db, key, "run_completed", "Agent finished; moved to review")?;
        } else {
            let reason = optional(&link["error"]).unwrap_or(state);
            db.execute(
                "UPDATE tasks SET active_run_id=NULL,revision=revision+1,updated_at=? WHERE id=?",
                params![stamp, key],
            )?;
            db.execute("UPDATE task_runs SET output=CASE WHEN output='' THEN ? ELSE output END,stop_reason=? WHERE run_id=?",params![tail(optional(&link["result"]).unwrap_or(reason),20000),reason,run_id])?;
            activity(db, key, &format!("run_{state}"), reason)?;
        }
        Ok(())
    })?;
    Ok(())
}
async fn index(State(app): State<App>, Query(q): Options) -> Reply {
    let db = app.lock();
    let all = q.get("includeArchived").is_some_and(|v| v == "1");
    Ok(Json(
        json!({"boards":boards::list_boards(&db,all)?,"tasks":list_tasks(&db,all)?,"summaries":boards::summaries(&db)?}),
    ))
}
async fn show(State(app): State<App>, Path(key): Path<String>) -> Reply {
    Ok(Json(task(&app.lock(), &key)?))
}
async fn new_task(State(app): State<App>, Json(input): Json<Value>) -> Http {
    response(StatusCode::CREATED, create(&app.lock(), &input)?)
}
async fn edit(State(app): State<App>, Path(key): Path<String>, Json(input): Json<Value>) -> Reply {
    Ok(Json(update(&app.lock(), &key, &input)?))
}
async fn remove(State(app): State<App>, Path(key): Path<String>) -> Reply {
    let db = app.lock();
    if !task(&db, &key)?["activeRunId"].is_null() {
        return Err(ApiError::conflict(
            "Stop the active run before deleting this task.",
        ));
    }
    db.execute("DELETE FROM tasks WHERE id=?", [&key])?;
    Ok(Json(json!({"ok":true})))
}
async fn history(State(app): State<App>, Path((key, action)): Path<(String, String)>) -> Reply {
    if action != "runs" {
        return Err(ApiError::missing("Task operation not found."));
    }
    Ok(Json(json!({"runs":task(&app.lock(),&key)?["runs"]})))
}
async fn action(
    State(app): State<App>,
    Path((key, action)): Path<(String, String)>,
    body: Bytes,
) -> Http {
    let input = json_body(body)?;
    let db = app.lock();
    let (code, value) = match action.as_str() {
        "comments" => {
            task(&db, &key)?;
            (
                StatusCode::CREATED,
                transaction(&db, || comment(&db, &key, text(&input["body"]), "you"))?,
            )
        }
        "move" => (StatusCode::OK, move_task(&db, &key, &input)?),
        "check" | "additem" => (
            if action == "additem" {
                StatusCode::CREATED
            } else {
                StatusCode::OK
            },
            transaction(&db, || checklist(&db, &key, &input, action == "additem"))?,
        ),
        "start" | "request-changes" => (StatusCode::ACCEPTED, start(&db, &key, &input)?),
        "approve" => (
            StatusCode::OK,
            transaction(&db, || approve(&db, &key, &input))?,
        ),
        "stop" => {
            let current = task(&db, &key)?;
            let run = optional(&current["activeRunId"])
                .ok_or_else(|| ApiError::conflict("This task is not running."))?;
            (
                StatusCode::OK,
                transaction(&db, || Ok(crate::runs::stop_tree(&db, run)?))?,
            )
        }
        _ => return Err(ApiError::missing("Task operation not found.")),
    };
    response(code, value)
}
fn forbidden(message: &str) -> ApiError {
    ApiError::new(StatusCode::FORBIDDEN, message)
}
fn may_touch(db: &Connection, agent: &str, assign: bool, task: &Value) -> rusqlite::Result<bool> {
    if let Some(team) = optional(&task["teamId"])
        && !teams::member(db, team, agent)?
    {
        return Ok(false);
    }
    Ok(assign
        || task["ownerAgentId"].is_null()
        || task["ownerAgentId"] == agent
        || list(&task["collaboratorAgentIds"])
            .iter()
            .any(|v| v == agent))
}
pub fn agent_task(
    db: &Connection,
    profile: &Value,
    input: &Value,
) -> Result<(StatusCode, Value), ApiError> {
    let agent = required(&profile["id"], "Agent", 80)?;
    let assign = profile["board"]["assignOthers"] == true;
    let action = text(&input["action"]);
    let key = text(&input["taskId"]);
    let mut patch = input.clone();
    if let Some(map) = patch.as_object_mut() {
        for k in ["input", "action", "taskId"] {
            map.remove(k);
        }
    }
    let nested = if let Some(raw) = input["input"].as_str() {
        serde_json::from_str(raw).unwrap_or(Value::Null)
    } else {
        input["input"].clone()
    };
    if let Some(extra) = nested.as_object() {
        for (k, v) in extra {
            patch[k] = v.clone();
        }
    }
    if action == "columns" || action == "list" {
        let mut out = json!({"boards":boards::list_boards(db,false)?});
        if action == "list" {
            let mut visible = vec![];
            for t in list_tasks(db, false)? {
                if may_touch(db, &agent, assign, &t)? {
                    visible.push(t);
                }
            }
            out["tasks"] = json!(visible);
        }
        return Ok((StatusCode::OK, out));
    }
    if matches!(action, "board_create" | "board_update") {
        if profile["board"]["manageProjects"] != true {
            return Err(forbidden(
                "Creating or changing projects requires Board: manage projects.",
            ));
        }
        let mut safe = json!({});
        for k in ["name", "description", "color", "defaultOwnerAgentId"] {
            if let Some(v) = patch.get(k) {
                safe[k] = v.clone();
            }
        }
        if action == "board_create" {
            return Ok((StatusCode::CREATED, boards::create(db, &safe)?));
        }
        let key = text(&patch["boardId"]);
        safe["revision"] = boards::board(db, key)?["revision"].clone();
        return Ok((StatusCode::OK, boards::update(db, key, &safe)?));
    }
    if let Some(team) = optional(&patch["teamId"])
        && !teams::member(db, team, &agent)?
    {
        return Err(forbidden("The agent must belong to the selected team."));
    }
    if action == "create" {
        if patch.get("ownerAgentId").is_none() {
            patch["ownerAgentId"] = json!(agent);
        }
        if patch["ownerAgentId"] != agent && !assign {
            return Err(forbidden(
                "Assigning another agent requires Board: assign others.",
            ));
        }
        return Ok((StatusCode::CREATED, create(db, &patch)?));
    }
    let current = task(db, key)?;
    if !may_touch(db, &agent, assign, &current)? {
        return Err(forbidden(
            "Changing another agent’s card requires Board: assign others.",
        ));
    }
    if matches!(action, "update" | "move")
        && patch.get("ownerAgentId").is_some()
        && patch["ownerAgentId"] != agent
        && patch["ownerAgentId"] != current["ownerAgentId"]
        && !assign
    {
        return Err(forbidden(
            "Assigning another agent requires Board: assign others.",
        ));
    }
    patch["revision"] = current["revision"].clone();
    transaction(db, || {
        let pair = match action {
            "get" => (StatusCode::OK, current),
            "update" => (StatusCode::OK, update(db, key, &patch)?),
            "move" => (StatusCode::OK, move_task(db, key, &patch)?),
            "comment" => (
                StatusCode::CREATED,
                comment(
                    db,
                    key,
                    optional(&patch["text"]).unwrap_or(text(&patch["body"])),
                    text(&profile["name"]),
                )?,
            ),
            "check" | "additem" => (
                if action == "additem" {
                    StatusCode::CREATED
                } else {
                    StatusCode::OK
                },
                checklist(db, key, &patch, action == "additem")?,
            ),
            "claim" => (
                StatusCode::OK,
                update(
                    db,
                    key,
                    &json!({"revision":current["revision"],"ownerAgentId":agent}),
                )?,
            ),
            "release" => {
                update(
                    db,
                    key,
                    &json!({"revision":current["revision"],"ownerAgentId":null}),
                )?;
                (
                    StatusCode::OK,
                    comment(
                        db,
                        key,
                        optional(&patch["reason"]).unwrap_or("Released as blocked."),
                        text(&profile["name"]),
                    )?,
                )
            }
            "run" => {
                if !current["ownerAgentId"].is_null()
                    && current["ownerAgentId"] != agent
                    && profile["board"]["dispatch"] != true
                {
                    return Err(forbidden(
                        "Starting another agent’s task requires Board: dispatch.",
                    ));
                }
                if boards::board(db, text(&current["boardId"]))?["settings"]["allowAgentDispatch"]
                    != true
                {
                    return Err(forbidden("Agent task dispatch is disabled for this board."));
                }
                (
                    StatusCode::ACCEPTED,
                    start(
                        db,
                        key,
                        &json!({"revision":current["revision"],"idempotencyKey":id()}),
                    )?,
                )
            }
            _ => return Err(ApiError::bad("Unknown task action.")),
        };
        Ok(pair)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn board_permissions_and_scoped_assignment() -> anyhow::Result<()> {
        let db = test_db()?;
        let board = boards::list_boards(&db, false)?.remove(0);
        db.execute_batch("INSERT INTO teams(id,name,color,icon,created_at,updated_at) VALUES('one','Team','blue','code','today','today');
            INSERT INTO team_members VALUES('one','atlas','today'),('one','scout','today');")?;
        let input = json!({"boardId":board["id"],"title":"Review copy","ownerAgentId":"atlas","teamId":"one","collaboratorAgentIds":["scout","scout"]});
        let created = create(&db, &input)?;
        assert_eq!(created["collaboratorAgentIds"], json!(["scout"]));
        let key = text(&created["id"]);
        let changed = update(&db, key, &json!({"revision":1,"title":"Read copy"}))?;
        assert_eq!(
            update(&db, key, &json!({"revision":1,"title":"Stale"}))
                .unwrap_err()
                .status,
            StatusCode::CONFLICT
        );
        assert!(
            update(
                &db,
                key,
                &json!({"revision":changed["revision"],"ownerAgentId":"solo"})
            )
            .is_err()
        );
        let outsider = json!({"id":"solo","board":{"assignOthers":true}});
        assert_eq!(
            agent_task(&db, &outsider, &json!({"action":"get","taskId":key}))
                .unwrap_err()
                .status,
            StatusCode::FORBIDDEN
        );
        let scoped = json!({"id":"scout","board":{"assignOthers":false,"manageProjects":false}});
        assert_eq!(
            agent_task(
                &db,
                &scoped,
                &json!({"action":"board_create","name":"unexpected"})
            )
            .unwrap_err()
            .status,
            StatusCode::FORBIDDEN
        );
        let moved = agent_task(
            &db,
            &scoped,
            &json!({"action":"move","taskId":key,"input":json!({"stageId":board["settings"]["runStageId"]}).to_string()}),
        )?;
        assert_eq!(moved.1["stageId"], board["settings"]["runStageId"]);
        let assign = agent_task(
            &db,
            &scoped,
            &json!({"action":"move","taskId":key,"ownerAgentId":"solo","stageId":board["stages"][0]["id"]}),
        );
        assert_eq!(assign.unwrap_err().status, StatusCode::FORBIDDEN);
        Ok(())
    }

    #[test]
    fn repeated_start_keeps_one_run_and_failed_start_rolls_back() -> anyhow::Result<()> {
        let db = test_db()?;
        let board = boards::list_boards(&db, false)?.remove(0);
        let card = create(
            &db,
            &json!({"boardId":board["id"],"title":"List checks","ownerAgentId":"atlas"}),
        )?;
        let input = json!({"idempotencyKey":"first","revision":1});
        let key = text(&card["id"]);
        let run = start(&db, key, &input)?;
        assert_eq!(start(&db, key, &input)?["run"]["id"], run["run"]["id"]);
        assert!(start(&db, key, &json!({"idempotencyKey":"other"})).is_err());
        assert_eq!(count(&db, "SELECT count(*) FROM runs", [])?, 1);
        assert_eq!(count(&db, "SELECT count(*) FROM task_runs", [])?, 1);
        assert_eq!(
            update(
                &db,
                key,
                &json!({"revision":run["task"]["revision"],"ownerAgentId":"scout"})
            )
            .unwrap_err()
            .status,
            StatusCode::CONFLICT
        );

        let rejected = create(
            &db,
            &json!({"boardId":board["id"],"title":"Rollback","ownerAgentId":"atlas"}),
        )?;
        db.execute_batch("CREATE TRIGGER reject_link BEFORE INSERT ON task_runs BEGIN SELECT RAISE(ABORT,'disk failure after create'); END;")?;
        assert!(start(&db, text(&rejected["id"]), &input).is_err());
        assert_eq!(count(&db, "SELECT count(*) FROM runs", [])?, 1);
        assert!(task(&db, text(&rejected["id"]))?["activeRunId"].is_null());
        Ok(())
    }

    #[test]
    fn one_final_result_advances_one_active_attempt() -> anyhow::Result<()> {
        let db = test_db()?;
        let board = boards::list_boards(&db, false)?.remove(0);
        let card = create(
            &db,
            &json!({"boardId":board["id"],"title":"Review copy","ownerAgentId":"atlas","checklist":[{"text":"Draft","done":true}]}),
        )?;
        let key = text(&card["id"]);
        let output = "ü".repeat(10_000);
        db.execute("INSERT INTO runs(id,agent_id,conversation_id,prompt,state,created_at,updated_at,result) VALUES('r1','atlas','c','prompt','completed','today','today',?)",[&output])?;
        db.execute("INSERT INTO task_runs(task_id,run_id,attempt,instructions_snapshot,checklist_snapshot,idempotency_key,started_at) VALUES(?,'r1',1,'','[]','once','today')",[key])?;
        db.execute("UPDATE tasks SET active_run_id='r1' WHERE id=?", [key])?;
        run_changed(&db, "r1")?;
        run_changed(&db, "r1")?;
        let done = task(&db, key)?;
        assert_eq!(done["stageId"], board["settings"]["doneStageId"]);
        assert_eq!(done["activeRunId"], Value::Null);
        assert_eq!(list(&done["comments"]).len(), 1);
        assert_eq!(text(&done["comments"][0]["body"]).chars().count(), 8000);
        assert_eq!(done["runs"][0]["output"], output);
        let approved = approve(&db, key, &json!({"revision":done["revision"]}))?;
        assert_eq!(approved["stageId"], board["stages"][4]["id"]);
        Ok(())
    }
}
