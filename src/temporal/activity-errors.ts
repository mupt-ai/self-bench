import { CancelledFailure, CompleteAsyncError, type Context } from "@temporalio/activity";
import type { ActivityInterceptorsFactory } from "@temporalio/worker";
import { reportError } from "../lib/telemetry/sentry.js";

/**
 * Reports each failed activity attempt to Sentry, tagged with the activity and workflow types so
 * issues group by what failed rather than by run. Cancellations and async completions are how
 * activities are meant to end, not failures.
 */
export function activityErrorInterceptor(report = reportError): ActivityInterceptorsFactory {
  return (context: Context) => ({
    inbound: {
      async execute(input, next) {
        try {
          return await next(input);
        } catch (error) {
          if (!(error instanceof CompleteAsyncError || error instanceof CancelledFailure)) {
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
