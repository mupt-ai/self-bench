import type { HarborEnvironment } from "../../contracts/config/providers.js";

/**
 * Managed generation runs model calls and sandboxes on SelfBench's own provider accounts
 * instead of an organization's credentials. Within an enabled offering, what the deployment
 * offers follows from which platform keys are set.
 */
export interface ManagedOffer {
  readonly models: boolean;
  readonly sandbox: boolean;
}

const MANAGED_OFFERING_FLAG = "SELFBENCH_MANAGED_OFFERING";
const MANAGED_MODEL_KEY = "SELFBENCH_MANAGED_OPENROUTER_API_KEY";
const MANAGED_SANDBOX_KEY = "SELFBENCH_MANAGED_E2B_API_KEY";
const MANAGED_SANDBOX_DOMAIN = "SELFBENCH_MANAGED_E2B_DOMAIN";
const MANAGED_MODAL_TOKEN_ID = "SELFBENCH_MANAGED_MODAL_TOKEN_ID";
const MANAGED_MODAL_TOKEN_SECRET = "SELFBENCH_MANAGED_MODAL_TOKEN_SECRET";
const MANAGED_MODAL_ENVIRONMENT = "SELFBENCH_MANAGED_MODAL_ENVIRONMENT";

/**
 * The one switch for SelfBench's managed offering: managed models and sandboxes on the
 * platform's accounts, and the Stripe billing that charges for them. Off (the default), the
 * deployment is bring-your-own-key only: platform keys and Stripe settings are ignored, the
 * billing routes do not exist, and the app hides its Billing page.
 */
export function managedOfferingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env[MANAGED_OFFERING_FLAG]?.trim() ?? "";
  if (value === "true") return true;
  if (value === "false" || value === "") return false;
  // A typo must not quietly turn billing or managed access off.
  throw new Error(`${MANAGED_OFFERING_FLAG} must be "true" or "false"`);
}

/** A platform account value, read only while the managed offering is on. */
function platformValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  if (!managedOfferingEnabled(env)) return undefined;
  return env[name]?.trim() || undefined;
}

/** Managed access is supported exactly when the offering is on and the platform key is set. */
export function managedOffer(env: NodeJS.ProcessEnv = process.env): ManagedOffer {
  return {
    models: !!platformValue(env, MANAGED_MODEL_KEY),
    sandbox: !!platformValue(env, MANAGED_SANDBOX_KEY),
  };
}

/** The platform OpenRouter key, when the offering is on and it is set. */
export function platformModelKey(env: NodeJS.ProcessEnv): string | undefined {
  return platformValue(env, MANAGED_MODEL_KEY);
}

export function managedModelKey(env: NodeJS.ProcessEnv): string {
  const key = platformModelKey(env);
  if (!key)
    throw new Error("Managed model access is not configured on this worker (no platform key).");
  return key;
}

export function managedSandboxCredentials(env: NodeJS.ProcessEnv): {
  apiKey: string;
  domain?: string;
} {
  const apiKey = platformValue(env, MANAGED_SANDBOX_KEY);
  if (!apiKey)
    throw new Error("Managed sandboxes are not configured on this worker (no platform key).");
  const domain = platformValue(env, MANAGED_SANDBOX_DOMAIN);
  return { apiKey, ...(domain ? { domain } : {}) };
}

/**
 * Managed runs verify on the platform Modal account when one is configured. Harbor's E2B
 * environment does not run Docker Compose, so task services only start on Modal; E2B remains
 * the fallback for deployments without a platform Modal token.
 */
export function managedHarborEnvironment(env: NodeJS.ProcessEnv): "modal" | "e2b" {
  return platformValue(env, MANAGED_MODAL_TOKEN_ID) &&
    platformValue(env, MANAGED_MODAL_TOKEN_SECRET)
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
  const tokenId = platformValue(env, MANAGED_MODAL_TOKEN_ID);
  const tokenSecret = platformValue(env, MANAGED_MODAL_TOKEN_SECRET);
  if (!tokenId || !tokenSecret)
    throw new Error("Managed Modal verification is not configured on this worker (no token).");
  const environment = platformValue(env, MANAGED_MODAL_ENVIRONMENT);
  return {
    MODAL_TOKEN_ID: tokenId,
    MODAL_TOKEN_SECRET: tokenSecret,
    ...(environment ? { MODAL_ENVIRONMENT: environment } : {}),
  };
}

/** The lock owner for the managed E2B template, which is built in the platform account. */
export const MANAGED_E2B_TEMPLATE_OWNER = "platform";
