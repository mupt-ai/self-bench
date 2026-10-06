CREATE TABLE "group_releases" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" bigint NOT NULL,
	"group_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
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
	CONSTRAINT "group_releases_line_predecessor" UNIQUE NULLS NOT DISTINCT("org_id","group_id","predecessor_id")
);
--> statement-breakpoint
CREATE INDEX "group_releases_line_time" ON "group_releases" USING btree ("org_id","group_id","released_at");--> statement-breakpoint
CREATE UNIQUE INDEX "group_releases_slug" ON "group_releases" USING btree (lower("slug")) WHERE "group_releases"."predecessor_id" is null;