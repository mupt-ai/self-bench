import type { WorkflowSlots } from "../../db/workflow-slots.js";

/**
 * Managed generation workflows running at once across the platform. Each runs at most one E2B
 * sandbox at a time, so this also keeps the E2B account under its 100-sandbox plan.
 */
export function workflowSlotLimit(env: NodeJS.ProcessEnv = process.env): number {
  const value = Number(env.SELFBENCH_WORKFLOW_LIMIT?.trim() || 100);
  if (!Number.isInteger(value) || value < 1)
    throw new Error("SELFBENCH_WORKFLOW_LIMIT must be a positive integer");
  return value;
}

/** Without a database (local runs) every workflow is admitted at once. */
export function createWorkflowSlotActivities(slots: WorkflowSlots | undefined) {
  return {
    acquireWorkflowSlot: async (input: { id: string; orgId: string }) =>
      slots ? slots.acquire(input.id, input.orgId) : true,
    releaseWorkflowSlot: async (input: { id: string; drain: boolean }) =>
      slots?.release(input.id, input.drain),
  };
}
export type WorkflowSlotActivities = ReturnType<typeof createWorkflowSlotActivities>;
