/** An environment's name: the change it makes to every task (generation/tasks/variant.ts). */
export const MAX_VARIANT_LABEL_LENGTH = 60;

/**
 * The most an environment's script may hold. It reaches the image build base64-encoded in one
 * command, and Linux refuses a command past 128 KB.
 */
export const MAX_ENVIRONMENT_SCRIPT_BYTES = 64 * 1024;

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
  /**
   * What it changes in each task: a Bash script run in /app as the task's image is built, before
   * the agent starts. Absent for environments saved before they were scripts.
   */
  readonly script?: string;
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
