import type { Client } from "@temporalio/client";
import {
  WorkflowExecutionAlreadyStartedError,
  WorkflowIdReusePolicy,
  WorkflowNotFoundError,
} from "@temporalio/common";
import type { StopEvaluation } from "./cancel.js";
import type { EvaluationInput } from "./types.js";

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

export function evaluationStopper(client: Client): StopEvaluation {
  return async (repoId, id) => {
    try {
      await client.workflow.getHandle(evaluationWorkflowId(repoId, id)).cancel();
    } catch (error) {
      if (!(error instanceof WorkflowNotFoundError)) throw error;
    }
  };
}
