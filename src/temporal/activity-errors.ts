import {
  ApplicationFailure,
  CancelledFailure,
  CompleteAsyncError,
  type Context,
} from "@temporalio/activity";
import type { ActivityInterceptorsFactory } from "@temporalio/worker";
import { reportError } from "../lib/telemetry/sentry.js";
import { SandboxCapacityError } from "../sandbox/contracts.js";

/**
 * Failures that are how things are meant to go: a user's generation settings or credentials, a
 * full provider (the workflow waits and starts again), and a trial that already spent.
 */
const EXPECTED = new Set([
  "GenerationConfiguration",
  SandboxCapacityError.type,
  "RepeatSpendError",
]);

/**
 * Reports failed activities to Sentry, tagged with the activity and workflow types so issues
 * group by what failed rather than by run. A failure is reported on its first attempt and when it
 * ends retries, not on every retry in between. Async completion and cancellation are how
 * activities are meant to end, except a cancellation because the server timed the activity out.
 */
export function activityErrorInterceptor(report = reportError): ActivityInterceptorsFactory {
  return (context: Context) => ({
    inbound: {
      async execute(input, next) {
        try {
          return await next(input);
        } catch (error) {
          if (reportable(error, context.info.attempt)) {
            const { info } = context;
            report(error, {
              tags: {
                activity_type: info.activityType,
                workflow_type: info.workflowType ?? "none",
                attempt: info.attempt,
                task_queue: info.taskQueue,
              },
            });
          }
          throw error;
        }
      },
    },
  });
}

function reportable(error: unknown, attempt: number): boolean {
  if (error instanceof CompleteAsyncError) return false;
  if (error instanceof CancelledFailure) return error.message === "TIMED_OUT";
  const type =
    error instanceof ApplicationFailure
      ? error.type
      : error instanceof Error
        ? error.name
        : undefined;
  if (type && EXPECTED.has(type)) return false;
  return attempt === 1 || (error instanceof ApplicationFailure && error.nonRetryable === true);
}
