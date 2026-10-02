CREATE TABLE "evaluation_summaries" (
	"repo_id" bigint NOT NULL,
	"id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"body" text NOT NULL,
	CONSTRAINT "evaluation_summaries_repo_id_id_pk" PRIMARY KEY("repo_id","id")
);
--> statement-breakpoint
ALTER TABLE "evaluation_summaries" ADD CONSTRAINT "evaluation_summaries_repo_id_repos_id_fk" FOREIGN KEY ("repo_id") REFERENCES "public"."repos"("id") ON DELETE cascade ON UPDATE no action;