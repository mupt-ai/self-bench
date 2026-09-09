import type { Client } from "@temporalio/client";
import { WorkflowExecutionAlreadyStartedError, WorkflowIdReusePolicy } from "@temporalio/common";
import type { EvaluationInput } from "../evaluation/types.js";

export function evaluationStarter(
  client: Client,
  fallbackQueue: string,
  env: NodeJS.ProcessEnv = process.env,
) {
  return async (input: EvaluationInput): Promise<void> => {
    try {
      await client.workflow.start("selfBenchEvaluationWorkflow", {
        workflowId: `evaluation/${input.repoId}/${input.id}`,
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
