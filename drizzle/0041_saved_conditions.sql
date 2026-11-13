CREATE TABLE "saved_conditions" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"org_id" bigint NOT NULL,
	"name" text NOT NULL,
	"changes" jsonb NOT NULL,
	"created_by" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "saved_conditions" ADD CONSTRAINT "saved_conditions_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_conditions" ADD CONSTRAINT "saved_conditions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "saved_conditions_org_name" ON "saved_conditions" USING btree ("org_id",lower("name"));