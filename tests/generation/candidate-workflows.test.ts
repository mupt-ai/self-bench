import { expect, test } from "bun:test";
import { type Client, WorkflowNotFoundError } from "@temporalio/client";
import { temporalTaskWorkflows } from "../../src/generation/tasks/workflow-client.js";

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

  await expect(temporalTaskWorkflows(client).cancel("workflow-one")).resolves.toBeUndefined();
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

  await expect(temporalTaskWorkflows(client).cancel("workflow-one")).rejects.toThrow(
    "Temporal unavailable",
  );
});

test("Temporal cancellation of a workflow Temporal does not know succeeds", async () => {
  const client = {
    workflow: {
      getHandle: () => ({
        cancel: async () => {
          throw new Error("not found");
        },
        describe: async () => {
          throw new WorkflowNotFoundError("gone", "workflow-one", undefined);
        },
      }),
    },
  } as unknown as Client;

  await expect(temporalTaskWorkflows(client).cancel("workflow-one")).resolves.toBeUndefined();
});
