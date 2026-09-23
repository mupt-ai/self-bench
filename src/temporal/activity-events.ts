import type { Context, Info } from "@temporalio/activity";
import type { ActivityInterceptorsFactory } from "@temporalio/worker";
import { errorMessage } from "../lib/util.js";

/**
 * One line per activity start and failure, machine-readable and prefixed so operators can grep
 * a worker's output without parsing the SDK's multi-line warnings. Successes are left to the
 * SDK's own logging: with a single activity slot a completed round is already visible from the
 * next start. Never includes activity arguments, environment, or stack traces.
 */
interface ActivityEvent {
  readonly event: "selfbench.activity";
  readonly phase: "start" | "error";
  readonly activityType: string;
  readonly activityId: string;
  readonly workflowId?: string;
  readonly workflowType?: string;
  readonly attempt: number;
  readonly durationMs?: number;
  readonly error?: string;
}

function activityEventLine(event: ActivityEvent): string {
  return `[selfbench] ${JSON.stringify(event)}`;
}

export function activityEventInterceptor(
  write: (line: string) => void = (line) => console.log(line),
  now: () => number = Date.now,
): ActivityInterceptorsFactory {
  return (context: Context) => ({
    inbound: {
      async execute(input, next) {
        const base = describe(context.info);
        write(activityEventLine({ ...base, phase: "start" }));
        const started = now();
        try {
          return await next(input);
        } catch (error) {
          write(
            activityEventLine({
              ...base,
              phase: "error",
              durationMs: now() - started,
              error: errorMessage(error),
            }),
          );
          throw error;
        }
      },
    },
  });
}

function describe(info: Info): Omit<ActivityEvent, "phase"> {
  return {
    event: "selfbench.activity",
    activityType: info.activityType,
    activityId: info.activityId,
    ...(info.workflowExecution ? { workflowId: info.workflowExecution.workflowId } : {}),
    ...(info.workflowType ? { workflowType: info.workflowType } : {}),
    attempt: info.attempt,
  };
}
