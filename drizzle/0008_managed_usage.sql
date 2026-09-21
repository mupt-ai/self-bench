CREATE TABLE "generation_usage" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"org_id" bigint NOT NULL,
	"stage" text NOT NULL,
	"managed" boolean NOT NULL,
	"provider" text,
	"model" text,
	"input_tokens" integer,
	"output_tokens" integer,
	"cache_read_tokens" integer,
	"cache_write_tokens" integer,
	"model_cost_usd" double precision,
	"sandbox_seconds" integer NOT NULL,
	"sandbox_cost_usd" double precision,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "generation_usage_run_id" ON "generation_usage" USING btree ("run_id");