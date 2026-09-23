ALTER TABLE "generation_usage" ADD COLUMN "sandbox_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX "generation_usage_sandbox_id" ON "generation_usage" USING btree ("sandbox_id");