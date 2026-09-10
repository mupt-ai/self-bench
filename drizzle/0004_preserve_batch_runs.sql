CREATE TABLE IF NOT EXISTS "repo_runs" (
  "repo_id" bigint NOT NULL CONSTRAINT "repo_runs_repo_id_repos_id_fk" REFERENCES "repos"("id") ON DELETE cascade,
  "run_id" text NOT NULL,
  "attached_by" bigint NOT NULL CONSTRAINT "repo_runs_attached_by_users_id_fk" REFERENCES "users"("id"),
  "attached_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "repo_runs_pk" ON "repo_runs" USING btree ("repo_id", "run_id");
