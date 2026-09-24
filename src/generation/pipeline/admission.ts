import type { SelfBenchWorkerConfig } from "../../contracts/config/index.js";
import type { RunRequest } from "../../contracts/index.js";
import type { AdmissionStore } from "../../db/admissions.js";
import { type SandboxAccount, sandboxPool, sandboxPoolLimit } from "../../sandbox/admission.js";
import { stampedManagedHarbor } from "../billing/managed.js";

export interface SandboxSlotInput {
  /** Unique per wait and stable across its polls; see `withSandboxSlot` in workflows.ts. */
  readonly id: string;
  readonly run: RunRequest;
  /** Agents run on the run's sandbox account; Harbor verifies on its Harbor account. */
  readonly kind: "agent" | "harbor";
  /** The waiting execution, so a sweep can drain the slots of one that was terminated. */
  readonly workflowId: string;
  readonly workflowRunId: string;
}

/** The provider account a stage's sandbox runs on. */
function sandboxAccount(
  config: SelfBenchWorkerConfig,
  run: RunRequest,
  kind: SandboxSlotInput["kind"],
): { provider: Parameters<typeof sandboxPool>[0]; account: SandboxAccount } {
  const settings = run.generation?.settings;
  if (!settings)
    return {
      provider: kind === "agent" ? config.execution.kind : config.harborEnvironment,
      account: "deployment",
    };
  if (settings.sandbox === "managed")
    return {
      provider:
        kind === "agent"
          ? run.version.executionBackend
          : stampedManagedHarbor(run.version.harborEnvironment),
      account: "managed",
    };
  // A Harbor environment without its own credential verifies on the sandbox credential.
  if (kind === "harbor" && settings.harborEnvironment)
    return {
      provider: settings.harborEnvironment,
      account: { credentialId: settings.harborCredentialId ?? "unknown" },
    };
  return {
    provider: settings.sandbox,
    account: { credentialId: settings.sandboxCredentialId ?? "unknown" },
  };
}

/**
 * Admission to a shared provider account before a sandbox starts, so a stage waits for a slot
 * instead of failing at the provider's concurrency cap. Without a database, or on an account
 * SelfBench does not limit, every request is admitted at once.
 */
export function createSandboxAdmission(
  config: SelfBenchWorkerConfig,
  store: AdmissionStore | undefined,
) {
  return {
    async acquireSandboxSlot(input: SandboxSlotInput): Promise<boolean> {
      const { provider, account } = sandboxAccount(config, input.run, input.kind);
      const limit = sandboxPoolLimit(provider, account);
      if (!store || limit === undefined) return true;
      const generation = input.run.generation;
      return store.acquire(
        {
          id: input.id,
          workflowId: input.workflowId,
          workflowRunId: input.workflowRunId,
          pool: sandboxPool(provider, account),
          orgId: String(generation?.orgId ?? generation?.ownerId ?? "deployment"),
          kind: input.kind,
        },
        limit,
      );
    },
    async releaseSandboxSlot(input: { id: string; drain: boolean }): Promise<void> {
      await store?.release(input.id, input.drain);
    },
  };
}
