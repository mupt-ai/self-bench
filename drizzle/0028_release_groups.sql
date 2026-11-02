CREATE TABLE "release_groups" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" bigint NOT NULL,
	"publisher_login" text NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"repository_ids" jsonb NOT NULL,
	"updated_by_login" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "release_groups_org_slug" UNIQUE("org_id","slug")
);
--> statement-breakpoint
CREATE INDEX "release_groups_publisher_slug" ON "release_groups" USING btree (lower("publisher_login"),"slug");