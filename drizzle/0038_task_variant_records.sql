CREATE TABLE "task_variants" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"parent_id" bigint NOT NULL,
	"repo_id" bigint NOT NULL,
	"label" text NOT NULL,
	"changes" jsonb,
	"run_id" text NOT NULL,
	"candidate_id" text NOT NULL,
	"task_id" text NOT NULL,
	"pipeline_status" text NOT NULL,
	"stage" text NOT NULL,
	"reason" text,
	"bundle_key" text,
	"images" jsonb,
	"workflow_id" text,
	"started_by" bigint,
	"started_at" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "task_variants" ADD CONSTRAINT "task_variants_parent_id_tasks_id_fk" FOREIGN KEY ("parent_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_variants" ADD CONSTRAINT "task_variants_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_variants" ADD CONSTRAINT "task_variants_started_by_users_id_fk" FOREIGN KEY ("started_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "task_variants_run_candidate" ON "task_variants" USING btree ("run_id","candidate_id");--> statement-breakpoint
CREATE UNIQUE INDEX "task_variants_workflow_id" ON "task_variants" USING btree ("workflow_id");--> statement-breakpoint
CREATE INDEX "task_variants_parent_id" ON "task_variants" USING btree ("parent_id");--> statement-breakpoint
CREATE INDEX "task_variants_repo_id" ON "task_variants" USING btree ("repo_id");--> statement-breakpoint
-- Variants made before this table were task rows revising their task: move each here, as it stood,
-- under the nearest task that is not itself a variant (a variant of a variant changes that task
-- too). A variant a person rejected leaves with it; one with no such task stays a task.
INSERT INTO "task_variants" (
	"parent_id", "repo_id", "label", "run_id", "candidate_id", "task_id", "pipeline_status", "stage",
	"reason", "bundle_key", "images", "workflow_id", "started_by", "started_at", "deleted_at",
	"synced_at", "created_at"
)
WITH RECURSIVE "lineage" ("id", "ancestor") AS (
	SELECT "id", "revised_from" FROM "tasks" WHERE "variant" IS NOT NULL AND "revised_from" IS NOT NULL
	UNION ALL
	SELECT "lineage"."id", "above"."revised_from" FROM "lineage"
	JOIN "tasks" "above" ON "above"."id" = "lineage"."ancestor"
	WHERE "above"."variant" IS NOT NULL AND "above"."revised_from" IS NOT NULL
)
SELECT
	"lineage"."ancestor", "v"."repo_id", "v"."variant", "v"."run_id", "v"."candidate_id", "v"."task_id",
	"v"."pipeline_status", "v"."stage", "v"."reason", "v"."bundle_key", "v"."images", "v"."workflow_id",
	"v"."started_by", "v"."started_at",
	CASE WHEN "v"."review_decision" = 'reject' THEN coalesce("v"."deleted_at", now()) ELSE "v"."deleted_at" END,
	"v"."synced_at", "v"."created_at"
FROM "lineage"
JOIN "tasks" "root" ON "root"."id" = "lineage"."ancestor" AND "root"."variant" IS NULL
JOIN "tasks" "v" ON "v"."id" = "lineage"."id";--> statement-breakpoint
-- Rows made from a moved variant (a revision, or another variant) no longer point at it.
UPDATE "tasks" SET "revised_from" = NULL
WHERE "revised_from" IN (
	SELECT "t"."id" FROM "tasks" "t"
	JOIN "task_variants" "m" ON "m"."run_id" = "t"."run_id" AND "m"."candidate_id" = "t"."candidate_id"
	WHERE "t"."variant" IS NOT NULL
);--> statement-breakpoint
DELETE FROM "tasks" "t" USING "task_variants" "m"
WHERE "t"."variant" IS NOT NULL AND "m"."run_id" = "t"."run_id" AND "m"."candidate_id" = "t"."candidate_id";--> statement-breakpoint
ALTER TABLE "tasks" DROP COLUMN "variant";