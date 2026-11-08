ALTER TABLE "releases" DROP CONSTRAINT "releases_line_predecessor";--> statement-breakpoint
ALTER TABLE "releases" DROP CONSTRAINT "releases_line";--> statement-breakpoint
ALTER TABLE "releases" ADD COLUMN "eval_repo_id" bigint;--> statement-breakpoint
ALTER TABLE "releases" ADD CONSTRAINT "releases_line_predecessor" UNIQUE NULLS NOT DISTINCT("org_id","github_repo_id","group_id","eval_repo_id","predecessor_id");--> statement-breakpoint
ALTER TABLE "releases" ADD CONSTRAINT "releases_line" CHECK (num_nonnulls("releases"."github_repo_id", "releases"."group_id", "releases"."eval_repo_id") = 1);