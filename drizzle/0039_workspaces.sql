CREATE TABLE "github_connections" (
	"github_id" bigint PRIMARY KEY NOT NULL,
	"org_id" bigint NOT NULL,
	"login" text NOT NULL,
	"kind" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "org_invites" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"org_id" bigint NOT NULL,
	"github_login" text NOT NULL,
	"role" text NOT NULL,
	"invited_by" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- Every existing tenant becomes a workspace connected to the GitHub account it was.
INSERT INTO "github_connections" ("github_id", "org_id", "login", "kind", "created_at", "updated_at")
SELECT "github_id", "id", "login", "kind", "created_at", "updated_at" FROM "orgs";--> statement-breakpoint
-- Slugs are unique case-insensitively now; a renamed account could have left two alike. The
-- newest keeps the name; each older one takes the first free `<login>-<n>`.
DO $$
DECLARE
	dup record;
	n integer;
BEGIN
	FOR dup IN
		SELECT "id", "login" FROM (
			SELECT "id", "login", row_number() OVER (
				PARTITION BY lower("login") ORDER BY "updated_at" DESC, "id" DESC
			) AS "rank"
			FROM "orgs"
		) "ranked"
		WHERE "rank" > 1
	LOOP
		n := 2;
		WHILE EXISTS (SELECT 1 FROM "orgs" WHERE lower("login") = lower(dup."login" || '-' || n)) LOOP
			n := n + 1;
		END LOOP;
		UPDATE "orgs" SET "login" = dup."login" || '-' || n WHERE "id" = dup."id";
	END LOOP;
END $$;--> statement-breakpoint
ALTER TABLE "orgs" DROP CONSTRAINT "orgs_github_id_unique";--> statement-breakpoint
DROP INDEX "orgs_login";--> statement-breakpoint
ALTER TABLE "org_members" ADD COLUMN "source" text DEFAULT 'github' NOT NULL;--> statement-breakpoint
ALTER TABLE "github_connections" ADD CONSTRAINT "github_connections_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_invites" ADD CONSTRAINT "org_invites_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_invites" ADD CONSTRAINT "org_invites_invited_by_users_id_fk" FOREIGN KEY ("invited_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "github_connections_org_id" ON "github_connections" USING btree ("org_id");--> statement-breakpoint
CREATE UNIQUE INDEX "org_invites_org_login" ON "org_invites" USING btree ("org_id",lower("github_login"));--> statement-breakpoint
CREATE INDEX "org_invites_login" ON "org_invites" USING btree (lower("github_login"));--> statement-breakpoint
CREATE UNIQUE INDEX "orgs_login" ON "orgs" USING btree (lower("login"));--> statement-breakpoint
ALTER TABLE "orgs" DROP COLUMN "github_id";