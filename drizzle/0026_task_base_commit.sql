-- A task's base commit was part of the definition its author wrote; authors now write native
-- files, so the commit is the task's own column. Existing rows take it from their definition,
-- which stays only as history.
ALTER TABLE "tasks" ADD COLUMN "base_commit" text;--> statement-breakpoint
UPDATE "tasks"
SET "base_commit" = lower("definition" ->> 'baseCommit')
WHERE "definition" ->> 'baseCommit' ~ '^[0-9a-fA-F]{40}$';
