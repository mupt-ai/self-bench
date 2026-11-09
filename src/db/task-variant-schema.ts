import {
  bigint,
  bigserial,
  index,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import type { TaskImages } from "../contracts/index.js";
import type { VariantChanges } from "../contracts/variants.js";
import { repos, tasks, users } from "./schema.js";

const timestamptz = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

/**
 * A variant of an accepted task: the task with only its environment changed (packages installed
 * over its own, files written into /app), checked once by its own candidate workflow and never
 * re-authored. It is not a task: it never appears in task lists, counts, reviews, or releases, and
 * its trials are reported beside the task it changes (generation/tasks/variant.ts).
 */
export const taskVariants = pgTable(
  "task_variants",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    /** The accepted task it changes. */
    parentId: bigint("parent_id", { mode: "number" })
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    repoId: bigint("repo_id", { mode: "number" })
      .notNull()
      .references(() => repos.id, { onDelete: "cascade" }),
    label: text("label").notNull(),
    /** What it changes; variants made before this table recorded only their label. */
    changes: jsonb("changes").$type<VariantChanges>(),
    /** Its own run, so its bundle and trials never mix with the task's. */
    runId: text("run_id").notNull(),
    candidateId: text("candidate_id").notNull(),
    /** The task's name in its bundle and trials: the parent's. */
    taskId: text("task_id").notNull(),
    pipelineStatus: text("pipeline_status", {
      enum: ["in_progress", "accepted", "rejected", "infrastructure_failed"],
    }).notNull(),
    stage: text("stage").notNull(),
    reason: text("reason"),
    bundleKey: text("bundle_key"),
    images: jsonb("images").$type<TaskImages>(),
    workflowId: text("workflow_id"),
    startedBy: bigint("started_by", { mode: "number" }).references(() => users.id),
    startedAt: timestamptz("started_at"),
    deletedAt: timestamptz("deleted_at"),
    syncedAt: timestamptz("synced_at").notNull().defaultNow(),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("task_variants_run_candidate").on(table.runId, table.candidateId),
    uniqueIndex("task_variants_workflow_id").on(table.workflowId),
    index("task_variants_parent_id").on(table.parentId),
    index("task_variants_repo_id").on(table.repoId),
  ],
);
