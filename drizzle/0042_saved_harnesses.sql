ALTER TABLE "saved_conditions" RENAME TO "saved_harnesses";--> statement-breakpoint
ALTER TABLE "saved_harnesses" RENAME CONSTRAINT "saved_conditions_pkey" TO "saved_harnesses_pkey";--> statement-breakpoint
ALTER TABLE "saved_harnesses" RENAME CONSTRAINT "saved_conditions_org_id_orgs_id_fk" TO "saved_harnesses_org_id_orgs_id_fk";--> statement-breakpoint
ALTER TABLE "saved_harnesses" RENAME CONSTRAINT "saved_conditions_created_by_users_id_fk" TO "saved_harnesses_created_by_users_id_fk";--> statement-breakpoint
ALTER INDEX "saved_conditions_org_name" RENAME TO "saved_harnesses_org_name";--> statement-breakpoint
ALTER SEQUENCE "saved_conditions_id_seq" RENAME TO "saved_harnesses_id_seq";--> statement-breakpoint
UPDATE "saved_harnesses" SET "changes" = ("changes" - 'harness') || jsonb_build_object('agent', "changes"->'harness') WHERE "changes" ? 'harness';
