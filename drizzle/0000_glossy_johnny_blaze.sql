CREATE TABLE "org_members" (
	"org_id" bigint NOT NULL,
	"user_id" bigint NOT NULL,
	"role" text NOT NULL,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "orgs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"github_id" bigint NOT NULL,
	"login" text NOT NULL,
	"kind" text NOT NULL,
	"name" text,
	"avatar_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "orgs_github_id_unique" UNIQUE("github_id")
);
--> statement-breakpoint
CREATE TABLE "repo_runs" (
	"repo_id" bigint NOT NULL,
	"run_id" text NOT NULL,
	"attached_by" bigint NOT NULL,
	"attached_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "repos" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"org_id" bigint NOT NULL,
	"github_id" bigint NOT NULL,
	"full_name" text NOT NULL,
	"default_branch" text NOT NULL,
	"private" boolean DEFAULT false NOT NULL,
	"continuous" boolean DEFAULT false NOT NULL,
	"connected_by" bigint NOT NULL,
	"connected_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "repos_github_id_unique" UNIQUE("github_id")
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"repo_id" bigint NOT NULL,
	"run_id" text NOT NULL,
	"candidate_id" text NOT NULL,
	"task_id" text NOT NULL,
	"source_pr" integer,
	"source_url" text,
	"difficulty" text NOT NULL,
	"pipeline_status" text NOT NULL,
	"stage" text NOT NULL,
	"round" integer,
	"reason" text,
	"bundle_key" text,
	"definition" jsonb,
	"review_decision" text,
	"review_note" text,
	"reviewed_by" bigint,
	"reviewed_at" timestamp with time zone,
	"workflow_id" text,
	"started_by" bigint,
	"started_at" timestamp with time zone,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"github_id" bigint NOT NULL,
	"login" text NOT NULL,
	"name" text,
	"avatar_url" text,
	"github_token" text NOT NULL,
	"github_scopes" text DEFAULT '' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_github_id_unique" UNIQUE("github_id")
);
--> statement-breakpoint
ALTER TABLE "org_members" ADD CONSTRAINT "org_members_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_members" ADD CONSTRAINT "org_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repo_runs" ADD CONSTRAINT "repo_runs_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repo_runs" ADD CONSTRAINT "repo_runs_attached_by_users_id_fk" FOREIGN KEY ("attached_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repos" ADD CONSTRAINT "repos_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "repos" ADD CONSTRAINT "repos_connected_by_users_id_fk" FOREIGN KEY ("connected_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_started_by_users_id_fk" FOREIGN KEY ("started_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "org_members_pk" ON "org_members" USING btree ("org_id","user_id");--> statement-breakpoint
CREATE INDEX "org_members_user_id" ON "org_members" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "orgs_login" ON "orgs" USING btree ("login");--> statement-breakpoint
CREATE UNIQUE INDEX "repo_runs_pk" ON "repo_runs" USING btree ("repo_id","run_id");--> statement-breakpoint
CREATE INDEX "repos_org_id" ON "repos" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tasks_run_candidate" ON "tasks" USING btree ("run_id","candidate_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tasks_workflow_id" ON "tasks" USING btree ("workflow_id");--> statement-breakpoint
CREATE INDEX "tasks_repo_id" ON "tasks" USING btree ("repo_id");--> statement-breakpoint
CREATE INDEX "tasks_repo_pr" ON "tasks" USING btree ("repo_id","source_pr");--> statement-breakpoint
CREATE INDEX "users_login" ON "users" USING btree ("login");