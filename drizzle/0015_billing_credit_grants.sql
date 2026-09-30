CREATE TABLE "billing_credit_grants" (
	"request_id" text PRIMARY KEY NOT NULL,
	"admin_user_id" bigint NOT NULL,
	"target_org_id" bigint NOT NULL,
	"amount_cents" integer NOT NULL,
	"reason" text NOT NULL,
	"stripe_customer_id" text NOT NULL,
	"stripe_transaction_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "billing_credit_grants" ADD CONSTRAINT "billing_credit_grants_target_org_id_orgs_id_fk" FOREIGN KEY ("target_org_id") REFERENCES "public"."orgs"("id") ON DELETE restrict ON UPDATE no action;