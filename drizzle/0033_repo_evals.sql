ALTER TABLE "repos" ALTER COLUMN "github_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "repos" ADD COLUMN "kind" text DEFAULT 'github' NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "repos_org_eval_name" ON "repos" USING btree ("org_id",lower("full_name")) WHERE "repos"."kind" = 'eval';--> statement-breakpoint
ALTER TABLE "repos" ADD CONSTRAINT "repos_kind_identity" CHECK (("repos"."kind" = 'github' and "repos"."github_id" is not null) or ("repos"."kind" = 'eval' and "repos"."github_id" is null));