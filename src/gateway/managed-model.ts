import type { SelfBenchGatewayDeps } from "./platform.js";
import { MANAGED_MODEL_CREDENTIAL } from "./trial-key.js";

/** The org's credentials plus the platform's OpenRouter credential, when configured. */
export function withManagedModel(
  credentials: SelfBenchGatewayDeps["credentials"],
  managedKey: string | undefined,
): SelfBenchGatewayDeps["credentials"] {
  const managed = (id: string) => id === MANAGED_MODEL_CREDENTIAL;
  return {
    find: async (orgId, id) =>
      managed(id)
        ? managedKey
          ? { id, kind: "openrouter", auth: "api-key" }
          : undefined
        : credentials.find(orgId, id),
    secret: async (orgId, id) =>
      managed(id)
        ? managedKey
          ? { value: managedKey }
          : undefined
        : credentials.secret(orgId, id),
    renew: (orgId, id, value) => credentials.renew(orgId, id, value),
  };
}
