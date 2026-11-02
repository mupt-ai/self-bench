CREATE TABLE "group_releases" (
	"id" uuid PRIMARY KEY NOT NULL,
	"group_id" bigint NOT NULL,
	"org_id" bigint NOT NULL,
	"slug" text NOT NULL,
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
	CONSTRAINT "group_releases_line_predecessor" UNIQUE NULLS NOT DISTINCT("group_id","predecessor_id")
);
--> statement-breakpoint
CREATE TABLE "group_summaries" (
	"group_id" bigint NOT NULL,
	"id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"body" text NOT NULL,
	CONSTRAINT "group_summaries_group_id_id_pk" PRIMARY KEY("group_id","id")
);
--> statement-breakpoint
CREATE TABLE "repository_groups" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"org_id" bigint NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"repository_ids" jsonb NOT NULL,
	"updated_by_login" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "comparisons" DROP CONSTRAINT "comparisons_scope";--> statement-breakpoint
ALTER TABLE "comparisons" ADD COLUMN "group_id" bigint;--> statement-breakpoint
ALTER TABLE "group_summaries" ADD CONSTRAINT "group_summaries_group_id_repository_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."repository_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repository_groups" ADD CONSTRAINT "repository_groups_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "group_releases_line_time" ON "group_releases" USING btree ("group_id","released_at");--> statement-breakpoint
CREATE INDEX "group_releases_address" ON "group_releases" USING btree (lower("publisher_login"),"slug");--> statement-breakpoint
CREATE UNIQUE INDEX "repository_groups_org_slug" ON "repository_groups" USING btree ("org_id","slug");--> statement-breakpoint
CREATE INDEX "comparisons_group" ON "comparisons" USING btree ("group_id");--> statement-breakpoint
ALTER TABLE "comparisons" ADD CONSTRAINT "comparisons_scope" CHECK (num_nonnulls("comparisons"."repo_id", "comparisons"."benchmark_id", "comparisons"."group_id") = 1);