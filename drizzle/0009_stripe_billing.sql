CREATE TABLE "billing_outbox" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"usage_id" bigint NOT NULL,
	"org_id" bigint NOT NULL,
	"identifier" text NOT NULL,
	"event_name" text NOT NULL,
	"customer_id" text NOT NULL,
	"value" bigint NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "billing_outbox_usage_id_unique" UNIQUE("usage_id"),
	CONSTRAINT "billing_outbox_identifier_unique" UNIQUE("identifier")
);
--> statement-breakpoint
CREATE TABLE "billing_rate_snapshots" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"config_hash" text NOT NULL,
	"policy_version" text NOT NULL,
	"unit_scale" integer NOT NULL,
	"markup_bps" integer NOT NULL,
	"meter_event_name" text NOT NULL,
	"model_rates" jsonb NOT NULL,
	"vcpu_units_per_second" integer NOT NULL,
	"gib_units_per_second" integer NOT NULL,
	CONSTRAINT "billing_rate_snapshots_config_hash_unique" UNIQUE("config_hash")
);
--> statement-breakpoint
CREATE TABLE "billing_webhook_events" (
	"id" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"processed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "org_billing" (
	"org_id" bigint PRIMARY KEY NOT NULL,
	"stripe_customer_id" text,
	"stripe_subscription_id" text,
	"status" text DEFAULT 'none' NOT NULL,
	"cancel_at_period_end" boolean DEFAULT false NOT NULL,
	"current_period_end" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "org_billing_stripe_customer_id_unique" UNIQUE("stripe_customer_id")
);
--> statement-breakpoint
ALTER TABLE "generation_usage" ADD COLUMN "managed_model" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "generation_usage" ADD COLUMN "managed_sandbox" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "generation_usage" ADD COLUMN "rate_snapshot_id" bigint;--> statement-breakpoint
ALTER TABLE "generation_usage" ADD COLUMN "model_billable_units" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "generation_usage" ADD COLUMN "sandbox_billable_units" bigint DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "billing_outbox" ADD CONSTRAINT "billing_outbox_usage_id_generation_usage_id_fk" FOREIGN KEY ("usage_id") REFERENCES "public"."generation_usage"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "org_billing" ADD CONSTRAINT "org_billing_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "billing_outbox_delivery" ON "billing_outbox" USING btree ("status","next_attempt_at");--> statement-breakpoint
ALTER TABLE "generation_usage" ADD CONSTRAINT "generation_usage_rate_snapshot_id_billing_rate_snapshots_id_fk" FOREIGN KEY ("rate_snapshot_id") REFERENCES "public"."billing_rate_snapshots"("id") ON DELETE no action ON UPDATE no action;