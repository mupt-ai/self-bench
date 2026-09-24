CREATE TABLE "sandbox_admissions" (
	"id" text PRIMARY KEY NOT NULL,
	"pool" text NOT NULL,
	"org_id" text NOT NULL,
	"kind" text NOT NULL,
	"workflow_id" text NOT NULL,
	"workflow_run_id" text NOT NULL,
	"granted_at" timestamp with time zone,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE INDEX "sandbox_admissions_pool" ON "sandbox_admissions" USING btree ("pool","granted_at");