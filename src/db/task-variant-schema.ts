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
 * An environment: changes to a repository's tasks' files (packages installed over their own,
 * files written into or removed from /app), applied to each approved task as a variant of it. A
 * run condition names one, so a comparison runs every task as its environment built it.
 */
export const taskEnvironments = pgTable(
  "task_environments",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    repoId: bigint("repo_id", { mode: "number" })
      .notNull()
      .references(() => repos.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** What it changes; environments from per-task variants recorded only their name. */
    changes: jsonb("changes").$type<VariantChanges>(),
    createdBy: bigint("created_by", { mode: "number" }).references(() => users.id),
    createdAt: timestamptz("created_at").notNull().defaultNow(),
    deletedAt: timestamptz("deleted_at"),
  },
  (table) => [index("task_environments_repo_id").on(table.repoId)],
);

/**
 * One task built in one environment: the task with only its environment changed, checked once by
 * its own candidate workflow and never re-authored (generation/tasks/variant.ts). It is not a
 * task: it never appears in task lists, counts, reviews, or releases, and its trials count as its
 * task's under the run condition that ran it.
 */
export const taskVariants = pgTable(
  "task_variants",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    environmentId: bigint("environment_id", { mode: "number" })
      .notNull()
      .references(() => taskEnvironments.id, { onDelete: "cascade" }),
    /** The approved task it changes. */
    parentId: bigint("parent_id", { mode: "number" })
      .notNull()
      .references(() => tasks.id, { onDelete: "cascade" }),
    repoId: bigint("repo_id", { mode: "number" })
      .notNull()
      .references(() => repos.id, { onDelete: "cascade" }),
    /** Its own run, so its bundle never mixes with the task's. */
    runId: text("run_id").notNull(),
    candidateId: text("candidate_id").notNull(),
    /** The task's name in its bundle: the parent's. */
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
    index("task_variants_environment_id").on(table.environmentId),
    index("task_variants_parent_id").on(table.parentId),
    index("task_variants_repo_id").on(table.repoId),
  ],
);
