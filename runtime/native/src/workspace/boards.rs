use super::*;
use axum::extract::{Path, State};
use axum::routing::{get, post, put};

const BOARD: &str = "SELECT id,name,description,color,default_owner_agent_id AS defaultOwnerAgentId,position,archived,revision,settings_json AS settings,created_at AS createdAt,updated_at AS updatedAt FROM task_boards";
const STAGE: &str = "SELECT id,name,board_id AS boardId,category,position FROM task_stages";
pub(super) fn router() -> Router<App> {
    Router::new()
        .route("/v1/boards", get(index).post(new_board))
        .route("/v1/boards/reorder", post(reorder))
        .route(
            "/v1/boards/{id}",
            get(show).put(update_board).delete(delete_board),
        )
        .route("/v1/boards/{id}/duplicate", post(duplicate))
        .route("/v1/boards/{id}/stages", post(add_stage))
        .route("/v1/stages/{id}", put(update_stage).delete(delete_stage))
}
fn settings(stages: &[Value], v: &Value) -> Value {
    let dest = |key: &str, category: &str| {
        stages
            .iter()
            .find(|s| s["id"] == v[key])
            .or_else(|| stages.iter().find(|s| s["category"] == category))
            .map(|s| text(&s["id"]))
            .unwrap_or("")
    };
    json!({"runStageId":dest("runStageId","in_progress"),"doneStageId":dest("doneStageId","review"),
        "autoRunOnDrop":v["autoRunOnDrop"].as_bool().unwrap_or(true),"allowAgentDispatch":v["allowAgentDispatch"].as_bool().unwrap_or(true)})
}
fn hydrate(db: &Connection, mut row: Value) -> Data {
    let stages = rows(
        db,
        &format!("{STAGE} WHERE board_id=? ORDER BY position,id"),
        [text(&row["id"])],
    )?;
    let raw = serde_json::from_str(text(&row["settings"])).unwrap_or(Value::Null);
    row["settings"] = settings(&stages, &raw);
    row["stages"] = json!(stages);
    row["archived"] = json!(row["archived"].as_i64() == Some(1));
    if !COLORS.contains(&text(&row["color"])) {
        row["color"] = json!("sage");
    }
    Ok(row)
}
pub(super) fn list_boards(db: &Connection, all: bool) -> Data<Vec<Value>> {
    rows(
        db,
        &format!("{BOARD} WHERE (? OR archived=0) ORDER BY position,created_at"),
        [all],
    )?
    .into_iter()
    .map(|v| hydrate(db, v))
    .collect()
}
pub(super) fn board(db: &Connection, key: &str) -> Data {
    hydrate(
        db,
        one(
            db,
            &format!("{BOARD} WHERE id=?"),
            [key],
            "Board not found.",
        )?,
    )
}
pub(super) fn summaries(db: &Connection) -> Data<Vec<Value>> {
    let mut result = vec![];
    for key in strings(
        db,
        "SELECT id FROM task_boards ORDER BY position,created_at",
        [],
    )? {
        let mut cats = json!({"backlog":0,"ready":0,"in_progress":0,"review":0,"done":0});
        for r in rows(
            db,
            "SELECT s.category AS category,count(*) AS n FROM tasks t JOIN task_stages s ON s.id=t.stage_id WHERE t.board_id=? AND t.archived=0 GROUP BY s.category",
            [&key],
        )? {
            cats[text(&r["category"])] = r["n"].clone();
        }
        let counts = one(
            db,
            "SELECT COUNT(*)-COALESCE(SUM(archived),0) AS total,COALESCE(SUM(archived),0) AS archivedCount FROM tasks WHERE board_id=?",
            [&key],
            "Project not found.",
        )?;
        let active = count(
            db,
            "SELECT count(*) FROM tasks t JOIN runs r ON r.id=t.active_run_id WHERE t.board_id=? AND t.archived=0 AND r.state IN ('queued','running','waiting_approval','waiting_input')",
            [&key],
        )?;
        let owners = strings(
            db,
            "SELECT DISTINCT owner_agent_id FROM tasks WHERE board_id=? AND archived=0 AND owner_agent_id IS NOT NULL ORDER BY owner_agent_id",
            [&key],
        )?;
        result.push(json!({"boardId":key,"total":counts["total"],"archivedCount":counts["archivedCount"],"byCategory":cats,"activeRuns":active,"ownerAgentIds":owners}));
    }
    Ok(result)
}
fn metadata(input: &Value, prior: &Value) -> (String, String, Option<String>) {
    let color = text(&input["color"]);
    let color = if COLORS.contains(&color) {
        color
    } else {
        optional(&prior["color"]).unwrap_or("sage")
    };
    (
        take(
            text(input.get("description").unwrap_or(&prior["description"])),
            500,
        ),
        color.to_string(),
        optional(
            input
                .get("defaultOwnerAgentId")
                .unwrap_or(&prior["defaultOwnerAgentId"]),
        )
        .map(|id| take(id, 120)),
    )
}
fn insert(db: &Connection, input: &Value, prior: &Value) -> Data<String> {
    let name = required(&input["name"], "Board name", 120)?;
    let key = id();
    let stamp = now();
    let (desc, color, owner) = metadata(input, prior);
    db.execute("INSERT INTO task_boards(id,name,description,color,position,default_owner_agent_id,created_at,updated_at) SELECT ?,?,?,?,COALESCE(MAX(position),0)+1000,?,?,? FROM task_boards",params![key,name,desc,color,owner,stamp,stamp])?;
    Ok(key)
}
pub(super) fn create(db: &Connection, input: &Value) -> Data {
    transaction(db, || {
        let key = insert(db, input, &Value::Null)?;
        for (index, (name, category)) in ["Backlog", "Ready", "In progress", "Review", "Done"]
            .iter()
            .zip(CATEGORIES)
            .enumerate()
        {
            db.execute(
                "INSERT INTO task_stages(id,board_id,name,category,position) VALUES(?,?,?,?,?)",
                params![id(), key, name, category, index as i64],
            )?;
        }
        board(db, &key)
    })
}
pub(super) fn update(db: &Connection, key: &str, input: &Value) -> Data {
    let current = board(db, key)?;
    revision(input, &current, "board", false)?;
    let archived = input
        .get("archived")
        .unwrap_or(&current["archived"])
        .as_bool()
        .unwrap_or(false);
    if archived
        && exists(
            db,
            "SELECT 1 FROM tasks WHERE board_id=? AND active_run_id IS NOT NULL LIMIT 1",
            [key],
        )?
    {
        return Err(ApiError::conflict(
            "Finish or stop active tasks before archiving this board.",
        ));
    }
    let name = required(
        input.get("name").unwrap_or(&current["name"]),
        "Board name",
        120,
    )?;
    let (desc, color, owner) = metadata(input, &current);
    let mut merged = current["settings"].clone();
    if let Some(add) = input["settings"].as_object() {
        for (k, v) in add {
            merged[k] = v.clone();
        }
    }
    let config = settings(list(&current["stages"]), &merged);
    db.execute("UPDATE task_boards SET name=?,description=?,color=?,default_owner_agent_id=?,archived=?,settings_json=?,revision=revision+1,updated_at=? WHERE id=?",params![name,desc,color,owner,archived,config.to_string(),now(),key])?;
    board(db, key)
}
async fn index(State(app): State<App>, Query(q): Options) -> Reply {
    let db = app.lock();
    Ok(Json(
        json!({"boards":list_boards(&db,q.get("includeArchived").is_some_and(|s|s=="1"))?,"summaries":summaries(&db)?}),
    ))
}
async fn show(State(app): State<App>, Path(key): Path<String>) -> Reply {
    Ok(Json(board(&app.lock(), &key)?))
}
async fn new_board(State(app): State<App>, Json(input): Json<Value>) -> Http {
    response(StatusCode::CREATED, create(&app.lock(), &input)?)
}
async fn update_board(
    State(app): State<App>,
    Path(key): Path<String>,
    Json(input): Json<Value>,
) -> Reply {
    Ok(Json(update(&app.lock(), &key, &input)?))
}
async fn delete_board(State(app): State<App>, Path(key): Path<String>) -> Reply {
    let db = app.lock();
    Ok(Json(transaction(&db, || {
        board(&db, &key)?;
        if !exists(
            &db,
            "SELECT 1 FROM task_boards WHERE id<>? AND archived=0 LIMIT 1",
            [&key],
        )? {
            return Err(ApiError::conflict(
                "Create another project before deleting this one.",
            ));
        }
        if exists(
            &db,
            "SELECT 1 FROM tasks t JOIN runs r ON r.id=t.active_run_id WHERE t.board_id=? AND r.state IN ('queued','running','waiting_approval','waiting_input') LIMIT 1",
            [&key],
        )? {
            return Err(ApiError::conflict(
                "Stop this project's running tasks before deleting it.",
            ));
        }
        let removed = db.execute("DELETE FROM tasks WHERE board_id=?", [&key])?;
        db.execute("DELETE FROM task_stages WHERE board_id=?", [&key])?;
        db.execute("DELETE FROM task_boards WHERE id=?", [&key])?;
        Ok(json!({"ok":true,"id":key,"deletedTasks":removed}))
    })?))
}
async fn reorder(State(app): State<App>, Json(input): Json<Value>) -> Reply {
    let db = app.lock();
    let order = array_strings(&input["ids"]);
    if order.is_empty() {
        return Err(ApiError::bad("Send the project order."));
    }
    transaction(&db, || {
        for (i, key) in order.iter().enumerate() {
            db.execute(
                "UPDATE task_boards SET position=?,updated_at=? WHERE id=?",
                params![1000 * (i + 1) as i64, now(), key],
            )?;
        }
        Ok(())
    })?;
    Ok(Json(
        json!({"boards":list_boards(&db,true)?,"summaries":summaries(&db)?}),
    ))
}
fn duplicate_board(db: &Connection, key: &str, mut input: Value) -> Data {
    let source = board(db, key)?;
    if optional(&input["name"]).is_none() {
        input["name"] = json!(format!("{} copy", text(&source["name"])));
    }
    transaction(db, || {
        let new_key = insert(db, &input, &source)?;
        let mut map = HashMap::new();
        for s in list(&source["stages"]) {
            let next = id();
            map.insert(text(&s["id"]), next.clone());
            db.execute("INSERT INTO task_stages(id,board_id,name,category,position) SELECT ?,?,name,category,position FROM task_stages WHERE id=?",params![next,new_key,text(&s["id"])])?;
        }
        let mut config = source["settings"].clone();
        for dest in ["runStageId", "doneStageId"] {
            config[dest] = json!(
                map.get(text(&config[dest]))
                    .map(String::as_str)
                    .unwrap_or("")
            );
        }
        db.execute(
            "UPDATE task_boards SET settings_json=? WHERE id=?",
            params![config.to_string(), new_key],
        )?;
        if input["includeTasks"] == true {
            for old in strings(db, "SELECT id FROM tasks WHERE board_id=?", [key])? {
                let original = tasks::task(db, &old)?;
                let next = id();
                db.execute("INSERT INTO tasks(id,board_id,stage_id,title,description,team_id,owner_agent_id,priority,due_at,position,archived,created_at,updated_at) SELECT ?,?,?,title,description,team_id,owner_agent_id,priority,due_at,position,archived,?,? FROM tasks WHERE id=?",params![next,new_key,map.get(text(&original["stageId"])),now(),now(),old])?;
                let mut collections = original.clone();
                if let Some(items) = collections["checklist"].as_array_mut() {
                    for item in items {
                        item["id"] = json!(id());
                        item["done"] = json!(false);
                    }
                }
                tasks::collections(db, &next, &collections)?;
                tasks::activity(
                    db,
                    &next,
                    "created",
                    &format!("Copied from {}", text(&source["name"])),
                )?;
            }
        }
        board(db, &new_key)
    })
}
async fn duplicate(State(app): State<App>, Path(key): Path<String>, body: Bytes) -> Http {
    response(
        StatusCode::CREATED,
        duplicate_board(&app.lock(), &key, json_body(body)?)?,
    )
}
fn category(value: &Value) -> Data<&str> {
    let category = text(value);
    if !CATEGORIES.contains(&category) {
        return Err(ApiError::bad("Invalid workflow category."));
    }
    Ok(category)
}
async fn add_stage(
    State(app): State<App>,
    Path(key): Path<String>,
    Json(input): Json<Value>,
) -> Http {
    let db = app.lock();
    board(&db, &key)?;
    let name = required(&input["name"], "Stage name", 80)?;
    let category = input
        .get("category")
        .map(category)
        .transpose()?
        .unwrap_or("backlog");
    db.execute("INSERT INTO task_stages(id,board_id,name,category,position) SELECT ?,?,?,?,COALESCE(MAX(position),-1)+1 FROM task_stages WHERE board_id=?",params![id(),key,name,category,key])?;
    response(StatusCode::CREATED, board(&db, &key)?)
}
async fn update_stage(
    State(app): State<App>,
    Path(key): Path<String>,
    Json(input): Json<Value>,
) -> Reply {
    let db = app.lock();
    let stage = one(
        &db,
        &format!("{STAGE} WHERE id=?"),
        [&key],
        "Stage not found.",
    )?;
    let name = required(
        input.get("name").unwrap_or(&stage["name"]),
        "Stage name",
        80,
    )?;
    let c = category(input.get("category").unwrap_or(&stage["category"]))?;
    let position = input
        .get("position")
        .unwrap_or(&stage["position"])
        .as_f64()
        .ok_or_else(|| ApiError::bad("Invalid position."))?;
    db.execute(
        "UPDATE task_stages SET name=?,category=?,position=? WHERE id=?",
        params![name, c, position, key],
    )?;
    Ok(Json(board(&db, text(&stage["boardId"]))?))
}
async fn delete_stage(State(app): State<App>, Path(key): Path<String>, Query(q): Options) -> Reply {
    let db = app.lock();
    let stage = one(
        &db,
        &format!("{STAGE} WHERE id=?"),
        [&key],
        "Stage not found.",
    )?;
    let c = text(&stage["category"]);
    let board_id = text(&stage["boardId"]);
    if ["in_progress", "review", "done"].contains(&c)
        && !exists(
            &db,
            "SELECT 1 FROM task_stages WHERE board_id=? AND category=? AND id<>?",
            params![board_id, c, key],
        )?
    {
        return Err(ApiError::bad(
            "Keep at least one In progress, Review, and Done destination.",
        ));
    }
    Ok(Json(transaction(&db, || {
        if let Some(dest) = q.get("moveToStageId") {
            if dest == &key
                || !exists(
                    &db,
                    "SELECT 1 FROM task_stages WHERE board_id=? AND id=?",
                    params![board_id, dest],
                )?
            {
                return Err(ApiError::bad("Move-to stage is not on this board."));
            }
            db.execute(
                "UPDATE tasks SET stage_id=?,revision=revision+1,updated_at=? WHERE stage_id=?",
                params![dest, now(), key],
            )?;
        } else if exists(&db, "SELECT 1 FROM tasks WHERE stage_id=?", [&key])? {
            return Err(ApiError::bad(
                "Choose another stage for the tasks in this stage.",
            ));
        }
        db.execute("DELETE FROM task_stages WHERE id=?", [&key])?;
        let config = board(&db, board_id)?["settings"].to_string();
        db.execute(
            "UPDATE task_boards SET settings_json=?,revision=revision+1,updated_at=? WHERE id=?",
            params![config, now(), board_id],
        )?;
        board(&db, board_id)
    })?))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn duplicated_card_gets_its_own_unchecked_items_and_stage_settings() -> anyhow::Result<()> {
        let db = test_db()?;
        let board = list_boards(&db, false)?.remove(0);
        let key = text(&board["id"]);
        let profile = json!({"id":"atlas","name":"Atlas"});
        let (_, original) = tasks::agent_task(
            &db,
            &profile,
            &json!({"action":"create","input":{"boardId":key,"title":"Prepare brief","checklist":[{"text":"Draft","done":true}]}}),
        )?;
        let copy = duplicate_board(&db, key, json!({"includeTasks":true}))?;
        let copy_id = text(&copy["id"]);
        let new_id = strings(&db, "SELECT id FROM tasks WHERE board_id=?", [copy_id])?.remove(0);
        let copied = tasks::task(&db, &new_id)?;
        assert_eq!(copy["name"], "Product launch copy");
        assert_ne!(
            copy["settings"]["doneStageId"],
            board["settings"]["doneStageId"]
        );
        assert_ne!(copied["checklist"][0]["id"], original["checklist"][0]["id"]);
        assert_eq!(copied["checklist"][0]["done"], false);
        assert_eq!(
            tasks::task(&db, text(&original["id"]))?["checklist"][0]["done"],
            true
        );
        Ok(())
    }
}
