ALTER TABLE "repos" DROP CONSTRAINT "repos_github_id_unique";--> statement-breakpoint
CREATE UNIQUE INDEX "repos_org_github_id" ON "repos" USING btree ("org_id","github_id");