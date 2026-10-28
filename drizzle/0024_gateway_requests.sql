CREATE TABLE "gateway_requests" (
	"request_id" text PRIMARY KEY NOT NULL,
	"org_id" bigint NOT NULL,
	"credential_id" uuid NOT NULL,
	"model" text NOT NULL,
	"tags" jsonb NOT NULL,
	"status" text NOT NULL,
	"input_tokens" integer,
	"output_tokens" integer,
	"cache_read_tokens" integer,
	"cache_write_tokens" integer,
	"cost_usd" double precision,
	"cost_source" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "gateway_requests_trial" ON "gateway_requests" USING btree (("tags"->>'trial'));--> statement-breakpoint
CREATE INDEX "gateway_requests_org_created" ON "gateway_requests" USING btree ("org_id","created_at");