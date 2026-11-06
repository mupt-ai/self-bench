ALTER TABLE "benchmarks" ADD COLUMN "status" text DEFAULT 'ready' NOT NULL;--> statement-breakpoint
ALTER TABLE "benchmarks" ADD COLUMN "error" text;