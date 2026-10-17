import type { Client } from "@temporalio/client";
import {
  WorkflowExecutionAlreadyStartedError,
  WorkflowIdReusePolicy,
  WorkflowNotFoundError,
} from "@temporalio/common";
import type { StopEvaluation } from "./cancel.js";
import { type EvaluationScope, scopeKey } from "./scope.js";
import type { TaskAuditRequest } from "./task-audit.js";
import type { EvaluationInput, FailedTrial } from "./types.js";

function evaluationWorkflowId(scope: EvaluationScope, id: string): string {
  return `evaluation/${scopeKey(scope)}/${id}`;
}

export function evaluationStarter(
  client: Client,
  fallbackQueue: string,
  env: NodeJS.ProcessEnv = process.env,
) {
  return async (input: EvaluationInput): Promise<void> => {
    try {
      await client.workflow.start("selfBenchEvaluationRunWorkflow", {
        workflowId: evaluationWorkflowId(input, input.id),
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
    `${evaluationWorkflowId(trial, trial.id)}/trial/${trial.index}/explain`;
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

/** Starts one task's audit, and tells whether one is running. */
export interface TaskAuditor {
  start(request: TaskAuditRequest): Promise<void>;
  state(
    request: Pick<TaskAuditRequest, "repoId" | "runId" | "taskId">,
  ): Promise<{ running: boolean }>;
}

/** Audits a task under one workflow ID per task, so two audits of it never run at once. */
export function taskAuditor(
  client: Client,
  fallbackQueue: string,
  env: NodeJS.ProcessEnv = process.env,
): TaskAuditor {
  const workflowId = ({
    repoId,
    runId,
    taskId,
  }: Pick<TaskAuditRequest, "repoId" | "runId" | "taskId">) => `audit/${repoId}/${runId}/${taskId}`;
  return {
    async start(request) {
      try {
        await client.workflow.start("selfBenchTaskAuditWorkflow", {
          workflowId: workflowId(request),
          taskQueue: env.SELFBENCH_EVAL_TASK_QUEUE ?? fallbackQueue,
          args: [request],
          workflowIdReusePolicy: WorkflowIdReusePolicy.ALLOW_DUPLICATE,
        });
      } catch (error) {
        if (!(error instanceof WorkflowExecutionAlreadyStartedError)) throw error;
      }
    },
    async state(request) {
      try {
        const { status } = await client.workflow.getHandle(workflowId(request)).describe();
        return { running: status.name === "RUNNING" };
      } catch (error) {
        if (error instanceof WorkflowNotFoundError) return { running: false };
        throw error;
      }
    },
  };
}

export function evaluationStopper(client: Client): StopEvaluation {
  return async (scope, id) => {
    try {
      await client.workflow.getHandle(evaluationWorkflowId(scope, id)).cancel();
    } catch (error) {
      if (!(error instanceof WorkflowNotFoundError)) throw error;
    }
  };
}
