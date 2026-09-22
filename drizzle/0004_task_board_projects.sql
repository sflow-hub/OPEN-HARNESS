-- Project metadata and explicit ordering for task boards.
ALTER TABLE task_boards ADD COLUMN description TEXT NOT NULL DEFAULT '';
ALTER TABLE task_boards ADD COLUMN color TEXT NOT NULL DEFAULT 'sage';
ALTER TABLE task_boards ADD COLUMN position REAL NOT NULL DEFAULT 0;
ALTER TABLE task_boards ADD COLUMN default_owner_agent_id TEXT;

-- Rank existing boards by creation so the first render after the upgrade matches the
-- order people already had. Writers only ever store positions of 1000 or more, so this
-- one-time repair never reruns against a board that has been ordered deliberately.
UPDATE task_boards SET position=((SELECT COUNT(*) FROM task_boards other WHERE other.created_at<task_boards.created_at OR (other.created_at=task_boards.created_at AND other.id<task_boards.id))+1)*1000 WHERE position=0;
