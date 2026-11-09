/** An environment's name: the change it makes to every task (generation/tasks/variant.ts). */
export const MAX_VARIANT_LABEL_LENGTH = 60;

/**
 * What an environment changes in each task: packages installed over the task's own with its
 * package manager, and files written into or removed from /app before the agent starts.
 */
export interface VariantChanges {
  readonly packages: readonly {
    readonly name: string;
    readonly spec: string;
    /** The workspace under /app, for a monorepo; "" is /app. */
    readonly directory: string;
  }[];
  readonly files: readonly {
    readonly path: string;
    readonly mode: "replace" | "append" | "delete";
    /** What a replace or append writes; a delete has none. */
    readonly content: string;
  }[];
}

/** Where one task's variant stands: it is checked once, so it never waits for a review. */
export type VariantState = "in_progress" | "accepted" | "rejected" | "failed" | "cancelled";

/** How many of an environment's tasks are ready to run, still being checked, or failed. */
export interface EnvironmentCoverage {
  readonly ready: number;
  readonly checking: number;
  readonly failed: number;
  readonly total: number;
}

/** An environment as the API and the app show it. */
export interface EnvironmentItem {
  readonly id: number;
  readonly name: string;
  /** Absent for environments made from per-task variants before changes were recorded. */
  readonly changes?: VariantChanges;
  readonly createdBy?: string;
  readonly createdAt: string;
  readonly tasks: EnvironmentCoverage;
}

/** One task in an environment: its variant's check, by the task it changes. */
export interface EnvironmentTaskItem {
  readonly task: { readonly runId: string; readonly taskId: string };
  /** The variant's own run. */
  readonly runId: string;
  readonly state: VariantState;
  readonly reasonSummary?: string;
}
