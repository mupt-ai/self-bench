import { expect, test } from "bun:test";
import { type Client, WorkflowNotFoundError } from "@temporalio/client";
import type { AdmissionStore } from "../../src/db/admissions.js";
import { sweepAdmissions } from "../../src/temporal/admission-sweep.js";

test("slots of terminated or vanished executions drain; running ones are kept", async () => {
  const drained: string[] = [];
  const store = {
    holders: async () => [
      { workflowId: "running", workflowRunId: "r" },
      { workflowId: "terminated", workflowRunId: "r" },
      { workflowId: "gone", workflowRunId: "r" },
    ],
    drainEnded: async (workflowId: string) => {
      drained.push(workflowId);
    },
  } as unknown as AdmissionStore;
  const client = {
    workflow: {
      getHandle: (workflowId: string) => ({
        describe: async () => {
          if (workflowId === "gone") throw new WorkflowNotFoundError("gone", workflowId, "r");
          return { status: { name: workflowId === "running" ? "RUNNING" : "TERMINATED" } };
        },
      }),
    },
  } as unknown as Client;

  await sweepAdmissions(store, client);

  expect(drained).toEqual(["terminated", "gone"]);
});
