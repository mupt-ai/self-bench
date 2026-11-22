ALTER TABLE "comparisons" RENAME TO "run_batches";--> statement-breakpoint
ALTER INDEX "comparisons_repo" RENAME TO "run_batches_repo";--> statement-breakpoint
ALTER INDEX "comparisons_benchmark" RENAME TO "run_batches_benchmark";--> statement-breakpoint
ALTER INDEX "comparisons_group" RENAME TO "run_batches_group";--> statement-breakpoint
ALTER TABLE "run_batches" RENAME CONSTRAINT "comparisons_scope" TO "run_batches_scope";--> statement-breakpoint
ALTER TABLE "run_batches" RENAME CONSTRAINT "comparisons_pkey" TO "run_batches_pkey";
