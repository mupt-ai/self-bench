CREATE TABLE "releases" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" bigint NOT NULL,
	"github_repo_id" bigint NOT NULL,
	"full_name" text NOT NULL,
	"publisher_login" text NOT NULL,
	"predecessor_id" uuid,
	"released_by" bigint NOT NULL,
	"released_by_login" text NOT NULL,
	"released_at" timestamp with time zone DEFAULT now() NOT NULL,
	"withdrawn_at" timestamp with time zone,
	"withdrawn_by_login" text,
	"hash" text NOT NULL,
	"payload" jsonb NOT NULL,
	"detail" jsonb NOT NULL,
	CONSTRAINT "releases_line_predecessor" UNIQUE NULLS NOT DISTINCT("org_id","github_repo_id","predecessor_id")
);
--> statement-breakpoint
CREATE INDEX "releases_line_time" ON "releases" USING btree ("org_id","github_repo_id","released_at");--> statement-breakpoint
CREATE INDEX "releases_full_name" ON "releases" USING btree (lower("full_name"));