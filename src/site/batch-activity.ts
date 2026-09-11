import type { Client } from "@temporalio/client";
import { queryStatus } from "../api/status.js";
import type { BatchStatus } from "./batch-progress.js";

/** Workflow stages describe intent; pending activities distinguish execution from queueing. */
export async function liveBatchStatus(client: Client, runId: string): Promise<BatchStatus> {
  const status = (await queryStatus(client.workflow.getHandle(runId))) as BatchStatus;
  if (["complete", "failed", "blocked", "cancelled"].includes(status.phase)) return status;
  const tasks = (status.tasks ?? []).filter((task) =>
    ["authoring", "verifying", "reviewing"].includes(task.status),
  );
  const activity: NonNullable<BatchStatus["activity"]> = {};
  // Generation admits at most 100 candidate workflows concurrently; limit each refresh's reads.
  for (let index = 0; index < Math.min(tasks.length, 100); index += 8) {
    await Promise.all(
      tasks.slice(index, Math.min(index + 8, 100)).map(async (task) => {
        try {
          const description = await client.workflowService.describeWorkflowExecution({
            namespace: client.options.namespace,
            execution: { workflowId: `${runId}/candidate/${task.candidateId}` },
          });
          const pending = description.pendingActivities ?? [];
          activity[task.candidateId] = pending.some((entry) => entry.state === 2)
            ? "running"
            : pending.some((entry) => entry.state === 1)
              ? "queued"
              : "unknown";
        } catch {
          activity[task.candidateId] = "unknown";
        }
      }),
    );
  }
  return { ...status, activity };
}
