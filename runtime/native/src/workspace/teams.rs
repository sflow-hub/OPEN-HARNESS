use super::*;
use axum::extract::{Path, State};
use axum::routing::{get, post};
use rusqlite::OptionalExtension;

const ICONS: [&str; 8] = [
    "people",
    "rocket",
    "briefcase",
    "flask",
    "writing",
    "code",
    "compass",
    "shield",
];
const TEAM: &str = "SELECT id,revision,name,description,color,icon,retired_at AS retiredAt,created_at AS createdAt,updated_at AS updatedAt FROM teams";

pub(super) fn router() -> Router<App> {
    Router::new()
        .route("/v1/teams", get(index).post(create))
        .route("/v1/teams/sync", post(sync))
        .route("/v1/teams/{id}", get(show).put(update).delete(retire))
}
fn with_members(db: &Connection, mut row: Value) -> Data {
    row["memberAgentIds"] = json!(strings(
        db,
        "SELECT agent_id FROM team_members WHERE team_id=? ORDER BY created_at,agent_id",
        [text(&row["id"])]
    )?);
    Ok(row)
}
fn get_team(db: &Connection, key: &str, all: bool) -> Data {
    let row = one(
        db,
        &format!("{TEAM} WHERE id=? AND (? OR retired_at IS NULL)"),
        params![key, all],
        "Team not found.",
    )?;
    with_members(db, row)
}
async fn index(State(app): State<App>, Query(q): Options) -> Reply {
    let db = app.lock();
    let raw = rows(
        &db,
        &format!("{TEAM} WHERE (? OR retired_at IS NULL) ORDER BY lower(name),created_at"),
        [q.get("includeRetired").is_some_and(|s| s == "1")],
    )?;
    let all = raw
        .into_iter()
        .map(|r| with_members(&db, r))
        .collect::<Data<Vec<_>>>()?;
    Ok(Json(json!({"teams":all})))
}
async fn show(State(app): State<App>, Path(id): Path<String>, Query(q): Options) -> Reply {
    Ok(Json(get_team(
        &app.lock(),
        &id,
        q.get("includeRetired").is_some_and(|s| s == "1"),
    )?))
}
fn valid_id(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 80
        && s.as_bytes()[0].is_ascii_alphanumeric()
        && s.bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_'))
}
fn save(db: &Connection, key: &str, input: &Value, current: Option<&Value>) -> Data {
    if let Some(prior) = current {
        revision(input, prior, "team", false)?;
    }
    let name = required(&input["name"], "Team name", 60)?;
    let description = text(&input["description"]).trim();
    let color = text(&input["color"]);
    let icon = text(&input["icon"]);
    if description.chars().count() > 240 {
        return Err(ApiError::bad(
            "Team description must be at most 240 characters.",
        ));
    }
    if !COLORS.contains(&color) || !ICONS.contains(&icon) {
        return Err(ApiError::bad("Choose a valid team color and icon."));
    }
    if !input["memberAgentIds"]
        .as_array()
        .is_some_and(|a| a.len() <= 50 && a.iter().all(|v| valid_id(text(v))))
    {
        return Err(ApiError::bad("Team members must be valid agents."));
    }
    let members = array_strings(&input["memberAgentIds"]);
    if exists(
        db,
        "SELECT 1 FROM teams WHERE retired_at IS NULL AND lower(name)=lower(?) AND id<>?",
        params![name, key],
    )? {
        return Err(ApiError::conflict("An active team already uses that name."));
    }
    for member in &members {
        if !exists(db, "SELECT 1 FROM agent_profiles WHERE id=?", [member])? {
            return Err(ApiError::bad(format!("Agent {member} does not exist.")));
        }
    }
    let stamp = now();
    transaction(db, || {
        if let Some(prior) = current {
            for removed in array_strings(&prior["memberAgentIds"])
                .iter()
                .filter(|id| !members.contains(id))
            {
                if exists(
                    db,
                    "SELECT 1 FROM tasks LEFT JOIN task_collaborators ON task_collaborators.task_id=tasks.id WHERE team_id=? AND archived=0 AND (owner_agent_id=? OR task_collaborators.agent_id=?) LIMIT 1",
                    params![key, removed, removed],
                )? {
                    return Err(ApiError::conflict(
                        "Reassign or archive this member's team tasks before removing them.",
                    ));
                }
            }
            db.execute("DELETE FROM team_members WHERE team_id=?", [key])?;
            db.execute("UPDATE teams SET revision=revision+1,name=?,description=?,color=?,icon=?,updated_at=? WHERE id=?",params![name,description,color,icon,stamp,key])?;
        } else {
            db.execute("INSERT INTO teams(id,name,description,color,icon,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",params![key,name,description,color,icon,stamp,stamp])?;
        }
        for member in members {
            db.execute(
                "INSERT INTO team_members(team_id,agent_id,created_at) VALUES(?,?,?)",
                params![key, member, stamp],
            )?;
        }
        get_team(db, key, false)
    })
}
async fn create(State(app): State<App>, Json(input): Json<Value>) -> Http {
    response(StatusCode::CREATED, save(&app.lock(), &id(), &input, None)?)
}
async fn update(State(app): State<App>, Path(id): Path<String>, Json(input): Json<Value>) -> Reply {
    let db = app.lock();
    let current = get_team(&db, &id, false)?;
    Ok(Json(save(&db, &id, &input, Some(&current))?))
}
async fn sync(State(app): State<App>, Json(input): Json<Value>) -> Reply {
    let db = app.lock();
    let saved = transaction(&db, || {
        let mut out = vec![];
        for team in list(&input["teams"]) {
            let given = text(&team["id"]);
            let prior:Option<String>=db.query_row("SELECT id FROM teams WHERE retired_at IS NULL AND (id=? OR lower(name)=lower(?)) ORDER BY id=? DESC LIMIT 1",params![given,text(&team["name"]),given],|r|r.get(0)).optional()?;
            if let Some(key) = prior {
                let current = get_team(&db, &key, false)?;
                let mut t = team.clone();
                t["revision"] = current["revision"].clone();
                out.push(save(&db, &key, &t, Some(&current))?);
            } else {
                let key = if valid_id(given)
                    && !exists(&db, "SELECT 1 FROM teams WHERE id=?", [given])?
                {
                    given.to_string()
                } else {
                    id()
                };
                out.push(save(&db, &key, team, None)?);
            }
        }
        Ok(out)
    })?;
    Ok(Json(json!({"teams":saved})))
}
async fn retire(State(app): State<App>, Path(id): Path<String>) -> Reply {
    let db = app.lock();
    Ok(Json(transaction(&db, || {
        get_team(&db, &id, false)?;
        if exists(
            &db,
            "SELECT 1 FROM tasks WHERE team_id=? AND archived=0 LIMIT 1",
            [&id],
        )? {
            return Err(ApiError::conflict(
                "Reassign or archive this team's tasks before deleting it.",
            ));
        }
        db.execute("DELETE FROM team_members WHERE team_id=?", [&id])?;
        let stamp = now();
        db.execute(
            "UPDATE teams SET revision=revision+1,retired_at=?,updated_at=? WHERE id=?",
            params![stamp, stamp, id],
        )?;
        get_team(&db, &id, true)
    })?))
}
pub fn shares_team(db: &Connection, source: &str, target: &str) -> anyhow::Result<bool> {
    Ok(exists(
        db,
        "SELECT 1 FROM team_members a JOIN team_members b ON a.team_id=b.team_id JOIN teams t ON t.id=a.team_id WHERE a.agent_id=? AND b.agent_id=? AND t.retired_at IS NULL LIMIT 1",
        params![source, target],
    )?)
}
pub(super) fn member(db: &Connection, team: &str, agent: &str) -> rusqlite::Result<bool> {
    exists(
        db,
        "SELECT 1 FROM team_members m JOIN teams t ON t.id=m.team_id WHERE m.team_id=? AND m.agent_id=? AND t.retired_at IS NULL",
        params![team, agent],
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn active_tasks_protect_membership_and_stale_team_edits_leave_members_intact()
    -> anyhow::Result<()> {
        let db = test_db()?;
        let saved = save(
            &db,
            "ops",
            &json!({"name":"Operations","description":"Release","color":"teal","icon":"code","memberAgentIds":["atlas","scout"]}),
            None,
        )?;
        let board = boards::list_boards(&db, false)?.remove(0);
        let (_, card) = tasks::agent_task(
            &db,
            &json!({"id":"atlas"}),
            &json!({"action":"create","input":{"boardId":board["id"],"title":"Fix","teamId":"ops","collaboratorAgentIds":["scout"]}}),
        )?;
        let mut changed = saved.clone();
        changed["memberAgentIds"] = json!(["atlas"]);
        assert_eq!(
            save(&db, "ops", &changed, Some(&saved)).unwrap_err().status,
            StatusCode::CONFLICT
        );
        assert!(shares_team(&db, "atlas", "scout")?);
        db.execute(
            "UPDATE tasks SET archived=1 WHERE id=?",
            [text(&card["id"])],
        )?;
        let new = save(&db, "ops", &changed, Some(&saved))?;
        assert_eq!(new["memberAgentIds"], json!(["atlas"]));
        assert_eq!(
            save(&db, "ops", &changed, Some(&new)).unwrap_err().status,
            StatusCode::CONFLICT
        );
        assert!(!shares_team(&db, "atlas", "scout")?);
        Ok(())
    }
}
