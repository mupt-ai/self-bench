import type { Client } from "@temporalio/client";
import {
  WorkflowExecutionAlreadyStartedError,
  WorkflowIdReusePolicy,
  WorkflowNotFoundError,
} from "@temporalio/common";
import type { StopEvaluation } from "./cancel.js";
import type { EvaluationInput, FailedTrial } from "./types.js";

function evaluationWorkflowId(repoId: number, id: string): string {
  return `evaluation/${repoId}/${id}`;
}

export function evaluationStarter(
  client: Client,
  fallbackQueue: string,
  env: NodeJS.ProcessEnv = process.env,
) {
  return async (input: EvaluationInput): Promise<void> => {
    try {
      await client.workflow.start("selfBenchEvaluationRunWorkflow", {
        workflowId: evaluationWorkflowId(input.repoId, input.id),
        taskQueue: env.SELFBENCH_EVAL_TASK_QUEUE ?? fallbackQueue,
        args: [input],
        workflowExecutionTimeout: "73 hours",
        workflowIdReusePolicy: WorkflowIdReusePolicy.REJECT_DUPLICATE,
      });
    } catch (error) {
      if (!(error instanceof WorkflowExecutionAlreadyStartedError)) throw error;
    }
  };
}

/** Starts one failed trial's explanation, and tells whether it is running or when it last ended. */
export interface FailureExplainer {
  start(trial: FailedTrial): Promise<void>;
  state(trial: FailedTrial): Promise<{ running: boolean; endedAt?: number }>;
}

/**
 * Explains failed trials under the ID their trial workflow starts it with, so the two never run
 * at once. A finished one may run again: it leaves a trial already explained.
 */
export function failureExplainer(
  client: Client,
  fallbackQueue: string,
  env: NodeJS.ProcessEnv = process.env,
): FailureExplainer {
  const workflowId = (trial: FailedTrial) =>
    `${evaluationWorkflowId(trial.repoId, trial.id)}/trial/${trial.index}/explain`;
  return {
    async start(trial) {
      try {
        await client.workflow.start("selfBenchFailedTrialWorkflow", {
          workflowId: workflowId(trial),
          taskQueue: env.SELFBENCH_EVAL_TASK_QUEUE ?? fallbackQueue,
          args: [trial],
          workflowIdReusePolicy: WorkflowIdReusePolicy.ALLOW_DUPLICATE,
        });
      } catch (error) {
        if (!(error instanceof WorkflowExecutionAlreadyStartedError)) throw error;
      }
    },
    async state(trial) {
      try {
        const { status, closeTime } = await client.workflow.getHandle(workflowId(trial)).describe();
        return {
          running: status.name === "RUNNING",
          ...(closeTime ? { endedAt: closeTime.getTime() } : {}),
        };
      } catch (error) {
        if (error instanceof WorkflowNotFoundError) return { running: false };
        throw error;
      }
    },
  };
}

export function evaluationStopper(client: Client): StopEvaluation {
  return async (repoId, id) => {
    try {
      await client.workflow.getHandle(evaluationWorkflowId(repoId, id)).cancel();
    } catch (error) {
      if (!(error instanceof WorkflowNotFoundError)) throw error;
    }
  };
}
