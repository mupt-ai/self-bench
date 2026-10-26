CREATE TABLE "registry_grants" (
	"id" uuid PRIMARY KEY NOT NULL,
	"label" text NOT NULL,
	"task_ids" jsonb NOT NULL,
	"images" jsonb NOT NULL,
	"with_verifier" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone
);
