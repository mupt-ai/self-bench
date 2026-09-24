import type { SandboxSlots, SlotLimits } from "../../db/sandbox-slots.js";

function limit(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const value = Number(env[name]?.trim() || fallback);
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}

/** The E2B plan allows 100 concurrent sandboxes; one organization may hold 20 of them. */
export function sandboxSlotLimits(env: NodeJS.ProcessEnv = process.env): SlotLimits {
  return {
    total: limit(env, "SELFBENCH_SANDBOX_LIMIT", 100),
    perOrg: limit(env, "SELFBENCH_ORG_SANDBOX_LIMIT", 20),
  };
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
