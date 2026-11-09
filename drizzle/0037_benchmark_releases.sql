ALTER TABLE "releases" DROP CONSTRAINT "releases_line_predecessor";--> statement-breakpoint
ALTER TABLE "releases" DROP CONSTRAINT "releases_line";--> statement-breakpoint
ALTER TABLE "releases" ADD COLUMN "benchmark_id" bigint;--> statement-breakpoint
ALTER TABLE "releases" ADD CONSTRAINT "releases_line_predecessor" UNIQUE NULLS NOT DISTINCT("org_id","github_repo_id","group_id","benchmark_id","predecessor_id");--> statement-breakpoint
ALTER TABLE "releases" ADD CONSTRAINT "releases_line" CHECK (num_nonnulls("releases"."github_repo_id", "releases"."group_id", "releases"."benchmark_id") = 1);