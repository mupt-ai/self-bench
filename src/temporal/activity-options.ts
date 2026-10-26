import { type ActivityOptions, workflowInfo } from "@temporalio/workflow";

/**
 * How every workflow schedules its activities. Activities run on one of two queues, by the
 * resource they hold:
 *
 * - the workflow's own queue: workflow tasks, database records, and sandbox hand-offs (an activity
 *   that starts a remote sandbox, waits for its callback, or reads what it reported), all light;
 * - `<queue>-harbor`: one Harbor process each (~300 MiB of Python plus a task on disk), on workers
 *   sized to memory (SELFBENCH_HARBOR_CONCURRENCY) that KEDA scales on this queue's backlog.
 *
 * Capacity is not an option here: an activity refused at a sandbox account's or model key's limit
 * fails with SandboxCapacityError, and the workflow waits and starts it again (whenSandboxFree,
 * src/temporal/sandbox-capacity.ts; admission in src/sandbox/capacity.ts).
 */

/** The Harbor queue beside a workflow queue. */
export function harborQueue(taskQueue: string): string {
  return `${taskQueue}-harbor`;
}

const backoff = {
  initialInterval: "5 seconds",
  backoffCoefficient: 2,
  maximumInterval: "2 minutes",
};

interface Preset {
  /** How long one attempt may run: a duration string, or milliseconds. */
  readonly timeout: NonNullable<ActivityOptions["startToCloseTimeout"]>;
  /** Attempts in all; Infinity retries until it succeeds (Temporal's SDK refuses 0). */
  readonly attempts?: number;
  /** Error types no retry can fix. */
  readonly final?: readonly string[];
  /** Set for an activity that heartbeats while it runs. */
  readonly heartbeat?: string;
}

function options({ timeout, attempts, final, heartbeat }: Preset): ActivityOptions {
  return {
    startToCloseTimeout: timeout,
    ...(heartbeat
      ? { heartbeatTimeout: heartbeat, cancellationType: "WAIT_CANCELLATION_COMPLETED" as const }
      : {}),
    retry: {
      ...backoff,
      ...(attempts !== undefined ? { maximumAttempts: attempts } : {}),
      ...(final ? { nonRetryableErrorTypes: [...final] } : {}),
    },
  };
}

/** A read or write of SelfBench's own records (a batch, a task row, an evaluation snapshot). */
export function record(preset: Omit<Preset, "timeout" | "heartbeat"> = {}): ActivityOptions {
  return options({ timeout: "1 minute", attempts: 5, ...preset });
}

/**
 * Work on the workflow's queue that runs for a while: starting a sandbox and waiting for it to
 * report (it heartbeats through the callback API every minute), compaction, an explanation.
 * Cancelling the workflow waits for a heartbeating activity to stop.
 */
export function task(preset: Preset): ActivityOptions {
  return options(preset);
}

/** One Harbor process on the Harbor queue; call it inside the workflow, which names the queue. */
export function harbor(preset: Preset & { readonly heartbeat: string }): ActivityOptions {
  return { ...options(preset), taskQueue: harborQueue(workflowInfo().taskQueue) };
}
