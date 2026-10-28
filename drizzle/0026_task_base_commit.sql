-- A task's base commit was part of the definition its author wrote; authors now write native
-- files, so the commit is the task's own column. Existing rows take it from their definition,
-- which stays only as history; rows still running take it from their batch's candidate.
ALTER TABLE "tasks" ADD COLUMN "base_commit" text;--> statement-breakpoint
UPDATE "tasks"
SET "base_commit" = lower("definition" ->> 'baseCommit')
WHERE "definition" ->> 'baseCommit' ~ '^[0-9a-fA-F]{40}$';--> statement-breakpoint
UPDATE "tasks"
SET "base_commit" = lower("item" -> 'candidate' ->> 'baseCommit')
FROM "generation_batches",
  jsonb_array_elements(
    CASE WHEN jsonb_typeof("generation_batches"."state" -> 'candidates') = 'array'
      THEN "generation_batches"."state" -> 'candidates' ELSE '[]'::jsonb END
  ) AS "item"
WHERE "tasks"."base_commit" IS NULL
  AND "generation_batches"."run_id" = "tasks"."run_id"
  AND "item" -> 'candidate' ->> 'candidateId' = "tasks"."candidate_id"
  AND "item" -> 'candidate' ->> 'baseCommit' ~ '^[0-9a-fA-F]{40}$';
