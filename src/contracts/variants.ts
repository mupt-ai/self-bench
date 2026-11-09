/** A task variant's label: the environment change it makes (generation/tasks/variant.ts). */
export const MAX_VARIANT_LABEL_LENGTH = 60;

/**
 * What a variant changes in its task's environment: packages installed over the task's own with
 * its package manager, and files written into /app before the agent starts.
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
    readonly mode: "replace" | "append";
    readonly content: string;
  }[];
}

/** Where a variant stands: it is checked once, so it never waits for a person's review. */
export type VariantState = "in_progress" | "accepted" | "rejected" | "failed" | "cancelled";

/** A variant as the API and the app show it, beside the task it changes. */
export interface VariantItem {
  /** Its own run, which names it in URLs, comparisons, and trials. */
  readonly runId: string;
  readonly taskId: string;
  readonly label: string;
  /** Absent for variants made before their changes were recorded. */
  readonly changes?: VariantChanges;
  readonly state: VariantState;
  readonly stage: string;
  readonly reason?: string;
  readonly reasonSummary?: string;
  readonly startedBy?: string;
  readonly startedAt?: string;
  readonly syncedAt: string;
  /** The task it changes. */
  readonly of: { readonly runId: string; readonly taskId: string };
}
