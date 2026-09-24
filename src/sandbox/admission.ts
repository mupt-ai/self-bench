import type { ExecutionBackend, HarborEnvironment } from "../contracts/config/providers.js";

type Provider = ExecutionBackend | HarborEnvironment;

/** Whose provider account a sandbox runs on: SelfBench's, the deployment's, or a credential's. */
export type SandboxAccount = "managed" | "deployment" | { readonly credentialId: string };

/** Admission pools are named by provider account, so every use of one account shares a count. */
export function sandboxPool(provider: Provider, account: SandboxAccount): string {
  return `${provider}:${typeof account === "string" ? account : `credential:${account.credentialId}`}`;
}

/**
 * Default concurrent-sandbox limits for SelfBench's managed accounts. The platform E2B team
 * caps concurrent sandboxes at 20 (measured 2026-09-24 via the team `concurrent_sandboxes`
 * metric and the provider's rate-limit error); two are left for API export sandboxes and
 * template builds. Modal's Starter plan allows 100 containers.
 */
const MANAGED_LIMITS: Partial<Record<Provider, { variable: string; fallback: number }>> = {
  e2b: { variable: "SELFBENCH_MANAGED_E2B_SANDBOX_LIMIT", fallback: 18 },
  modal: { variable: "SELFBENCH_MANAGED_MODAL_SANDBOX_LIMIT", fallback: 100 },
};

/** A positive integer limit from `env[name]`, or undefined when unset. */
export function limitVariable(env: NodeJS.ProcessEnv, name: string): number | undefined {
  const value = env[name];
  if (!value?.trim()) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1)
    throw new Error(`${name} must be a positive integer`);
  return parsed;
}

/**
 * How many sandboxes one account may run at once, or undefined when SelfBench does not limit
 * it: Docker runs on the worker, and an organization's own account enforces its own plan.
 */
export function sandboxPoolLimit(
  provider: Provider,
  account: SandboxAccount,
  env: NodeJS.ProcessEnv = process.env,
): number | undefined {
  if (provider === "docker" || typeof account !== "string") return undefined;
  if (account === "deployment") {
    const variable = `SELFBENCH_${provider.toUpperCase()}_SANDBOX_LIMIT`;
    return limitVariable(env, variable);
  }
  const managed = MANAGED_LIMITS[provider];
  if (!managed) return undefined;
  return limitVariable(env, managed.variable) ?? managed.fallback;
}
