import type { SandboxSlots } from "../../db/sandbox-slots.js";

/** The E2B plan allows 100 concurrent sandboxes. */
export function sandboxSlotLimit(env: NodeJS.ProcessEnv = process.env): number {
  const value = Number(env.SELFBENCH_SANDBOX_LIMIT?.trim() || 100);
  if (!Number.isInteger(value) || value < 1)
    throw new Error("SELFBENCH_SANDBOX_LIMIT must be a positive integer");
  return value;
}

/** Without a database (local runs) every stage is admitted at once. */
export function createSandboxSlotActivities(slots: SandboxSlots | undefined) {
  return {
    acquireSandboxSlot: async (input: { id: string; orgId: string }) =>
      slots ? slots.acquire(input.id, input.orgId) : true,
    releaseSandboxSlot: async (input: { id: string; drain: boolean }) =>
      slots?.release(input.id, input.drain),
  };
}
export type SandboxSlotActivities = ReturnType<typeof createSandboxSlotActivities>;
