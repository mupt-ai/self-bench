CREATE TABLE "group_evaluations" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" bigint NOT NULL,
	"group_id" uuid NOT NULL,
	"group_name" text NOT NULL,
	"signature" text NOT NULL,
	"repos" jsonb NOT NULL,
	"created_by_login" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "repo_group_members" (
	"group_id" uuid NOT NULL,
	"repo_id" bigint NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "repo_group_members_group_id_repo_id_pk" PRIMARY KEY("group_id","repo_id")
);
--> statement-breakpoint
CREATE TABLE "repo_groups" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" bigint NOT NULL,
	"name" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "repo_group_members" ADD CONSTRAINT "repo_group_members_group_id_repo_groups_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."repo_groups"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repo_group_members" ADD CONSTRAINT "repo_group_members_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "group_evaluations_group" ON "group_evaluations" USING btree ("group_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "repo_groups_org_name" ON "repo_groups" USING btree ("org_id",lower("name"));