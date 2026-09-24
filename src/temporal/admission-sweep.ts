import { type Client, WorkflowNotFoundError } from "@temporalio/client";
import type { AdmissionStore } from "../db/admissions.js";

/**
 * Drains the admission slots of executions that ended without releasing them (terminated or
 * reset), which the workflow's own `finally` never sees.
 */
export async function sweepAdmissions(store: AdmissionStore, client: Client): Promise<void> {
  for (const holder of await store.holders()) {
    const status = await client.workflow
      .getHandle(holder.workflowId, holder.workflowRunId)
      .describe()
      .then(
        (description) => description.status.name,
        (error: unknown) => {
          if (error instanceof WorkflowNotFoundError) return "NOT_FOUND";
          throw error;
        },
      );
    if (status !== "RUNNING") await store.drainEnded(holder.workflowId, holder.workflowRunId);
  }
}

export function keepAdmissionsSwept(store: AdmissionStore, client: Client): () => void {
  const timer = setInterval(() => {
    sweepAdmissions(store, client).catch(() =>
      console.error("Admission sweep failed; it will be retried"),
    );
  }, 60_000);
  timer.unref();
  return () => clearInterval(timer);
}
