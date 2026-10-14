import {
  bigint,
  bigserial,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { orgs, repos, users } from "./schema.js";

const timestamptz = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

/**
 * Each evaluation's record without its trials' logs, transcripts and artifact lists: what lists
 * of runs show. A copy of the snapshot at `revision`, which stays in the bucket and stays the
 * truth; reads rebuild a copy that is missing or behind.
 */
export const evaluationSummaries = pgTable(
  "evaluation_summaries",
  {
    repoId: bigint("repo_id", { mode: "number" })
      .notNull()
      .references(() => repos.id, { onDelete: "cascade" }),
    id: uuid("id").notNull(),
    revision: integer("revision").notNull(),
    /** The summary as JSON text, kept as written: jsonb would reorder keys and refuse NULs. */
    body: text("body").notNull(),
  },
  (table) => [primaryKey({ columns: [table.repoId, table.id] })],
);

/**
 * A Harbor registry dataset an org added to run models on, apart from any repository: a box on the
 * Benchmarks page, with its own runs and results. Each comparison downloads and freezes `name` at
 * `ref` when it starts.
 */
export const benchmarks = pgTable(
  "benchmarks",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    orgId: bigint("org_id", { mode: "number" })
      .notNull()
      .references(() => orgs.id, { onDelete: "cascade" }),
    /** The registry package, `org/name`. */
    name: text("name").notNull(),
    /** A tag, revision, or `sha256:` digest; `latest` follows the dataset's newest version. */
    ref: text("ref").notNull(),
    /** How many tasks it had when added and checked. */
    tasks: integer("tasks").notNull(),
    /** Those tasks, frozen when added (FrozenTask[]), for the Dataset tab and its task pages. */
    taskList: jsonb("task_list").notNull(),
    addedBy: bigint("added_by", { mode: "number" })
      .notNull()
      .references(() => users.id),
    addedAt: timestamptz("added_at").notNull().defaultNow(),
  },
  (table) => [uniqueIndex("benchmarks_org_name").on(table.orgId, table.name)],
);

/** The same summaries for a benchmark's runs (EvaluationScope's `benchmarkId`). */
export const benchmarkSummaries = pgTable(
  "benchmark_summaries",
  {
    benchmarkId: bigint("benchmark_id", { mode: "number" })
      .notNull()
      .references(() => benchmarks.id, { onDelete: "cascade" }),
    id: uuid("id").notNull(),
    revision: integer("revision").notNull(),
    body: text("body").notNull(),
  },
  (table) => [primaryKey({ columns: [table.benchmarkId, table.id] })],
);
