import { expect, test } from "bun:test";
import type { Client } from "@temporalio/client";
import { liveBatchStatus } from "../src/site/batch-activity.js";

test("batch progress distinguishes running, queued and unavailable activity state", async () => {
  const client = {
    options: { namespace: "default" },
    workflow: {
      getHandle: () => ({
        query: async () => ({
          runId: "batch-one",
          phase: "authoring",
          tasks: ["active", "waiting", "missing"].map((candidateId) => ({
            candidateId,
            status: "authoring",
          })),
        }),
        describe: async () => ({ status: { name: "RUNNING" } }),
      }),
    },
    workflowService: {
      describeWorkflowExecution: async ({ execution }: { execution: { workflowId: string } }) => {
        if (execution.workflowId.endsWith("missing")) throw new Error("unavailable");
        return { pendingActivities: [{ state: execution.workflowId.endsWith("active") ? 2 : 1 }] };
      },
    },
  } as unknown as Client;
  const status = await liveBatchStatus(client, "batch-one");
  expect(status.activity).toEqual({ active: "running", waiting: "queued", missing: "unknown" });
  expect(status.tasks).toHaveLength(3);
});
