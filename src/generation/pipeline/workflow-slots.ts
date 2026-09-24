import type { SlotLimits, WorkflowSlots } from "../../db/workflow-slots.js";

function limit(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const value = Number(env[name]?.trim() || fallback);
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}

/**
 * Managed generation workflows running at once: 100 across the platform (each runs at most one
 * E2B sandbox, so this keeps the E2B account under its 100-sandbox plan), 20 per organization.
 */
export function workflowSlotLimits(env: NodeJS.ProcessEnv = process.env): SlotLimits {
  return {
    total: limit(env, "SELFBENCH_WORKFLOW_LIMIT", 100),
    perOrg: limit(env, "SELFBENCH_ORG_WORKFLOW_LIMIT", 20),
  };
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
