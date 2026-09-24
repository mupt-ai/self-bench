import type { HarborEnvironment } from "../../contracts/config/providers.js";

/**
 * Managed generation runs model calls and sandboxes on SelfBench's own provider accounts
 * instead of an organization's credentials. What the deployment offers follows directly
 * from which platform keys are set; there is no separate flag to keep in sync.
 */
export interface ManagedOffer {
  readonly models: boolean;
  readonly sandbox: boolean;
}

const MANAGED_MODEL_KEY = "SELFBENCH_MANAGED_OPENROUTER_API_KEY";
const MANAGED_SANDBOX_KEY = "SELFBENCH_MANAGED_E2B_API_KEY";
const MANAGED_SANDBOX_DOMAIN = "SELFBENCH_MANAGED_E2B_DOMAIN";
const MANAGED_MODAL_TOKEN_ID = "SELFBENCH_MANAGED_MODAL_TOKEN_ID";
const MANAGED_MODAL_TOKEN_SECRET = "SELFBENCH_MANAGED_MODAL_TOKEN_SECRET";
const MANAGED_MODAL_ENVIRONMENT = "SELFBENCH_MANAGED_MODAL_ENVIRONMENT";

/** Managed access is supported exactly when the matching platform key is configured. */
export function managedOffer(env: NodeJS.ProcessEnv = process.env): ManagedOffer {
  return {
    models: !!env[MANAGED_MODEL_KEY]?.trim(),
    sandbox: !!env[MANAGED_SANDBOX_KEY]?.trim(),
  };
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

/**
 * Managed runs verify on the platform Modal account when one is configured. Harbor's E2B
 * environment does not run Docker Compose, so task services only start on Modal; E2B remains
 * the fallback for deployments without a platform Modal token.
 */
export function managedHarborEnvironment(env: NodeJS.ProcessEnv): "modal" | "e2b" {
  return env[MANAGED_MODAL_TOKEN_ID]?.trim() && env[MANAGED_MODAL_TOKEN_SECRET]?.trim()
    ? "modal"
    : "e2b";
}

/**
 * The managed Harbor environment a run was created with. Workers honor the stamp rather than
 * the live keys, so enabling or rotating the platform Modal token never breaks in-flight runs.
 */
export function stampedManagedHarbor(stamped: HarborEnvironment): "modal" | "e2b" {
  return stamped === "modal" ? "modal" : "e2b";
}

/** The Modal SDK environment for managed Harbor verification on the platform account. */
export function managedModalEnvironment(env: NodeJS.ProcessEnv): {
  MODAL_TOKEN_ID: string;
  MODAL_TOKEN_SECRET: string;
  MODAL_ENVIRONMENT?: string;
} {
  const tokenId = env[MANAGED_MODAL_TOKEN_ID]?.trim();
  const tokenSecret = env[MANAGED_MODAL_TOKEN_SECRET]?.trim();
  if (!tokenId || !tokenSecret)
    throw new Error("Managed Modal verification is not configured on this worker (no token).");
  const environment = env[MANAGED_MODAL_ENVIRONMENT]?.trim();
  return {
    MODAL_TOKEN_ID: tokenId,
    MODAL_TOKEN_SECRET: tokenSecret,
    ...(environment ? { MODAL_ENVIRONMENT: environment } : {}),
  };
}

/** The lock owner for the managed E2B template, which is built in the platform account. */
export const MANAGED_E2B_TEMPLATE_OWNER = "platform";
