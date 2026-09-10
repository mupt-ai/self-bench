import { expect, mock, test } from "bun:test";
import type { Client } from "@temporalio/client";
import { evaluationStarter } from "../src/site/evaluation-start.js";
import { evaluationInput } from "./support/evaluation-fixture.js";

test("all solver runs use the evaluation queue regardless of credential ownership", async () => {
  for (const env of [
    { SELFBENCH_EVAL_TASK_QUEUE: "solver", SELFBENCH_GENERATION_TASK_QUEUE: "author" },
    { SELFBENCH_GENERATION_TASK_QUEUE: "author" },
    {},
  ]) {
    const start = mock(async () => {});
    const client = { workflow: { start } } as unknown as Client;
    for (const scope of [{}, { credentialOrgId: 1 }, { credentialOwnerId: 2 }]) {
      const input = { ...evaluationInput(), ...scope };
      await evaluationStarter(client, "default", env)(input);
      expect(start).toHaveBeenLastCalledWith("selfBenchEvaluationWorkflow", {
        workflowId: `evaluation/${input.repoId}/${input.id}`,
        taskQueue: env.SELFBENCH_EVAL_TASK_QUEUE ?? "default",
        args: [input],
        workflowExecutionTimeout: "73 hours",
        workflowIdReusePolicy: "REJECT_DUPLICATE",
      });
    }
  }
});
