CREATE TABLE "benchmark_summaries" (
	"benchmark_id" bigint NOT NULL,
	"id" uuid NOT NULL,
	"revision" integer NOT NULL,
	"body" text NOT NULL,
	CONSTRAINT "benchmark_summaries_benchmark_id_id_pk" PRIMARY KEY("benchmark_id","id")
);
--> statement-breakpoint
CREATE TABLE "benchmarks" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"org_id" bigint NOT NULL,
	"name" text NOT NULL,
	"ref" text NOT NULL,
	"tasks" integer NOT NULL,
	"task_list" jsonb NOT NULL,
	"added_by" bigint NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "comparisons" ALTER COLUMN "repo_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "comparisons" ADD COLUMN "benchmark_id" bigint;--> statement-breakpoint
ALTER TABLE "benchmark_summaries" ADD CONSTRAINT "benchmark_summaries_benchmark_id_benchmarks_id_fk" FOREIGN KEY ("benchmark_id") REFERENCES "public"."benchmarks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "benchmarks" ADD CONSTRAINT "benchmarks_org_id_orgs_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."orgs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "benchmarks" ADD CONSTRAINT "benchmarks_added_by_users_id_fk" FOREIGN KEY ("added_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "benchmarks_org_name" ON "benchmarks" USING btree ("org_id","name");--> statement-breakpoint
CREATE INDEX "comparisons_benchmark" ON "comparisons" USING btree ("benchmark_id");--> statement-breakpoint
ALTER TABLE "comparisons" ADD CONSTRAINT "comparisons_scope" CHECK (("comparisons"."repo_id" is null) <> ("comparisons"."benchmark_id" is null));