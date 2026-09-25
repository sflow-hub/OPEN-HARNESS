-- Phones pair as companion-only 'device' machines. Existing rows predate phones, so they
-- default to 'runner' and keep their computer-runner reach.
ALTER TABLE machines ADD COLUMN kind TEXT NOT NULL DEFAULT 'runner';
--> statement-breakpoint
ALTER TABLE machine_pairings ADD COLUMN kind TEXT NOT NULL DEFAULT 'runner';
