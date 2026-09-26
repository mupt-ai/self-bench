import { expect, mock, test } from "bun:test";
import type { Client } from "@temporalio/client";
import { evaluationStarter } from "../src/evaluation/start.js";
import { evaluationInput } from "./support/evaluation-fixture.js";

test("solver runs use the evaluation queue, falling back to the default and never the generation queue", async () => {
  for (const env of [
    { SELFBENCH_EVAL_TASK_QUEUE: "solver", SELFBENCH_GENERATION_TASK_QUEUE: "author" },
    { SELFBENCH_GENERATION_TASK_QUEUE: "author" },
    {},
  ]) {
    const start = mock(async () => {});
    const client = { workflow: { start } } as unknown as Client;
    const input = evaluationInput();
    await evaluationStarter(client, "default", env)(input);
    expect(start).toHaveBeenLastCalledWith("selfBenchEvaluationWorkflow", {
      workflowId: `evaluation/${input.repoId}/${input.id}`,
      taskQueue: env.SELFBENCH_EVAL_TASK_QUEUE ?? "default",
      args: [input],
      workflowExecutionTimeout: "73 hours",
      workflowIdReusePolicy: "REJECT_DUPLICATE",
    });
  }
});
