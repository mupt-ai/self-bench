CREATE TABLE "comparisons" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" bigint NOT NULL,
	"repo_id" bigint NOT NULL,
	"signature" text NOT NULL,
	"inputs" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "credentials" (
	"id" uuid PRIMARY KEY NOT NULL,
	"org_id" bigint NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"auth" text NOT NULL,
	"endpoint" text,
	"secret" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE INDEX "comparisons_repo" ON "comparisons" USING btree ("repo_id");--> statement-breakpoint
CREATE INDEX "credentials_org" ON "credentials" USING btree ("org_id");