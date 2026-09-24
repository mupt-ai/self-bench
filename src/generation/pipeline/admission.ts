import { MAX_HARBOR_CONCURRENCY } from "../../contracts/config/execution-limits.js";
import type { SelfBenchWorkerConfig } from "../../contracts/config/index.js";
import type { RunRequest } from "../../contracts/index.js";
import type { AdmissionStore } from "../../db/admissions.js";
import {
  limitVariable,
  type SandboxAccount,
  sandboxPool,
  sandboxPoolLimit,
} from "../../sandbox/admission.js";
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
 * Per-organization defaults, so one organization's large batch cannot hold every slot of a
 * shared account or every Harbor slot while other organizations wait.
 */
const ORG_AGENT_LIMIT = { variable: "SELFBENCH_ORG_AGENT_SANDBOX_LIMIT", fallback: 12 };
const ORG_HARBOR_LIMIT = { variable: "SELFBENCH_ORG_HARBOR_LIMIT", fallback: 6 };

/**
 * Admission before a sandbox starts, so a stage waits for a slot instead of failing at the
 * provider's concurrency cap or queueing unfairly for a Harbor slot. Agents on an organization's
 * own account are admitted at once; Harbor always takes a slot because workers' Harbor capacity
 * is shared by every organization. Without a database every request is admitted.
 */
export function createSandboxAdmission(
  config: SelfBenchWorkerConfig,
  store: AdmissionStore | undefined,
  harborSlots?: number,
  env: NodeJS.ProcessEnv = process.env,
) {
  const org = {
    agent: limitVariable(env, ORG_AGENT_LIMIT.variable) ?? ORG_AGENT_LIMIT.fallback,
    harbor: limitVariable(env, ORG_HARBOR_LIMIT.variable) ?? ORG_HARBOR_LIMIT.fallback,
  };
  // Harbor-only replicas (infra/runtime compose) are memory-limited to the per-worker cap.
  const replicas = Number(env.SELFBENCH_HARBOR_WORKERS?.trim() || 0);
  const harbor =
    limitVariable(env, "SELFBENCH_HARBOR_ADMISSION_LIMIT") ??
    (harborSlots === undefined ? undefined : harborSlots + replicas * MAX_HARBOR_CONCURRENCY);
  return {
    async acquireSandboxSlot(input: SandboxSlotInput): Promise<boolean> {
      const { provider, account } = sandboxAccount(config, input.run, input.kind);
      const pool = sandboxPoolLimit(provider, account, env);
      if (!store || (input.kind === "agent" && pool === undefined)) return true;
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
        { ...(pool ? { pool } : {}), org, ...(harbor ? { harbor } : {}) },
      );
    },
    async releaseSandboxSlot(input: { id: string; drain: boolean }): Promise<void> {
      await store?.release(input.id, input.drain);
    },
  };
}
