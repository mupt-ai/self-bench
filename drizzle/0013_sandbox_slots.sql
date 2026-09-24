CREATE TABLE "sandbox_slots" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"granted_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL
);
