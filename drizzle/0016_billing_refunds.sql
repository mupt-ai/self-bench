CREATE TABLE "billing_refunds" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"org_id" bigint NOT NULL,
	"admin_user_id" bigint,
	"reason" text NOT NULL,
	"units" bigint NOT NULL,
	"unit_scale" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "billing_outbox" ALTER COLUMN "usage_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "billing_outbox" ADD COLUMN "refund_id" bigint;--> statement-breakpoint
ALTER TABLE "billing_refunds" ADD CONSTRAINT "billing_refunds_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_outbox" ADD CONSTRAINT "billing_outbox_refund_id_billing_refunds_id_fk" FOREIGN KEY ("refund_id") REFERENCES "public"."billing_refunds"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "billing_outbox" ADD CONSTRAINT "billing_outbox_refund_id_unique" UNIQUE("refund_id");--> statement-breakpoint
ALTER TABLE "billing_outbox" ADD CONSTRAINT "billing_outbox_source" CHECK (num_nonnulls("billing_outbox"."usage_id", "billing_outbox"."refund_id") = 1);--> statement-breakpoint
-- Record the refund an operator already sent to Stripe for mupt-ai's first period, so the
-- billing page shows it and later refunds only cover usage after it. No-op without that customer.
WITH "refund" AS (
	INSERT INTO "billing_refunds" ("org_id", "reason", "units", "unit_scale", "created_at")
	SELECT "org_id", 'Full refund of managed usage', 11132048275, 10000000, '2026-09-30T01:08:51Z'
	FROM "org_billing" WHERE "stripe_customer_id" = 'cus_VIszZFNOH02rjt'
	RETURNING "id", "org_id", "units", "created_at"
)
INSERT INTO "billing_outbox" ("refund_id", "org_id", "identifier", "event_name", "customer_id", "value", "status", "attempts", "next_attempt_at", "sent_at", "created_at")
SELECT "id", "org_id", 'selfbench-refund-cus_VIszZFNOH02rjt-1790035530', 'selfbench_managed_usage', 'cus_VIszZFNOH02rjt', -"units", 'sent', 1, "created_at", "created_at", "created_at"
FROM "refund";
