ALTER TABLE "tasks" ADD COLUMN "revised_from" bigint;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "feedback" text;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_revised_from_tasks_id_fk" FOREIGN KEY ("revised_from") REFERENCES "public"."tasks"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tasks_revised_from" ON "tasks" USING btree ("revised_from");