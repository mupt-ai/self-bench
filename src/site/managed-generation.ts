/**
 * Managed generation runs model calls and sandboxes on SelfBench's own provider accounts
 * instead of an organization's credentials. The API only advertises what the deployment
 * offers via SELFBENCH_MANAGED_MODELS / SELFBENCH_MANAGED_SANDBOX; the worker (and, for
 * exports, the API itself) hold the matching platform keys.
 */
export interface ManagedOffer {
  readonly models: boolean;
  readonly sandbox: boolean;
}

export const MANAGED_MODEL_KEY = "SELFBENCH_MANAGED_OPENROUTER_API_KEY";
export const MANAGED_SANDBOX_KEY = "SELFBENCH_MANAGED_E2B_API_KEY";
const MANAGED_SANDBOX_DOMAIN = "SELFBENCH_MANAGED_E2B_DOMAIN";

export function managedOffer(env: NodeJS.ProcessEnv = process.env): ManagedOffer {
  return {
    models: env.SELFBENCH_MANAGED_MODELS === "true",
    sandbox: env.SELFBENCH_MANAGED_SANDBOX === "true",
  };
}

/** The offer a route advertises/validates against, from its deployment flag. */
export function managedGenerationOffer(enabled?: boolean): ManagedOffer {
  return { models: !!enabled, sandbox: !!enabled };
}

export function managedModelKey(env: NodeJS.ProcessEnv): string {
  const key = env[MANAGED_MODEL_KEY]?.trim();
  if (!key)
    throw new Error("Managed model access is not configured on this worker (no platform key).");
  return key;
}

export function managedSandboxCredentials(env: NodeJS.ProcessEnv): {
  apiKey: string;
  domain?: string;
} {
  const apiKey = env[MANAGED_SANDBOX_KEY]?.trim();
  if (!apiKey)
    throw new Error("Managed sandboxes are not configured on this worker (no platform key).");
  const domain = env[MANAGED_SANDBOX_DOMAIN]?.trim();
  return { apiKey, ...(domain ? { domain } : {}) };
}

/** The lock owner for the managed E2B template, which is built in the platform account. */
export const MANAGED_E2B_TEMPLATE_OWNER = "platform";
