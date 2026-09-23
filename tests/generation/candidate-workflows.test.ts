import { expect, test } from "bun:test";
import type { Client } from "@temporalio/client";
import { temporalStatus } from "../../src/generation/tasks/workflow-client.js";

test("Temporal cancellation tolerates a workflow settling during the request", async () => {
  let workflowState = "RUNNING";
  const client = {
    workflow: {
      getHandle: () => ({
        cancel: async () => {
          workflowState = "COMPLETED";
          throw new Error("workflow already completed");
        },
        describe: async () => ({ status: { name: workflowState } }),
      }),
    },
  } as unknown as Client;

  await expect(temporalStatus(client).cancel?.("workflow-one")).resolves.toBeUndefined();
});

test("Temporal cancellation surfaces failures while the workflow is still running", async () => {
  const client = {
    workflow: {
      getHandle: () => ({
        cancel: async () => {
          throw new Error("Temporal unavailable");
        },
        describe: async () => ({ status: { name: "RUNNING" } }),
      }),
    },
  } as unknown as Client;

  await expect(temporalStatus(client).cancel?.("workflow-one")).rejects.toThrow(
    "Temporal unavailable",
  );
});

test("cancelled workflows remain distinct from infrastructure failures", async () => {
  const client = {
    workflow: {
      getHandle: () => ({
        describe: async () => ({ status: { name: "CANCELLED" } }),
      }),
    },
  } as unknown as Client;

  await expect(temporalStatus(client).snapshot("workflow-one")).resolves.toEqual({
    kind: "cancelled",
  });
});
