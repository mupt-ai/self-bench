import type { RunStatus } from "../../contracts/index.js";
import type { SandboxCostSnapshot } from "../../sandbox/contracts.js";

/** What the Temporal server reports about a candidate's current activity attempt. */
export interface TaskActivityDetail {
  state: "running" | "queued" | "unknown";
  activityType?: string;
  attempt?: number;
  maximumAttempts?: number;
  /** The previous attempt's failure, without its artifact log reference. */
  lastFailure?: string;
  /** ISO time of the next retry, while the activity waits on backoff. */
  nextAttemptAt?: string;
  cost?: SandboxCostSnapshot;
}
export type BatchStatus = Pick<RunStatus, "runId" | "phase"> &
  Partial<Omit<RunStatus, "runId" | "phase">> & {
    activity?: Record<string, TaskActivityDetail>;
  };
