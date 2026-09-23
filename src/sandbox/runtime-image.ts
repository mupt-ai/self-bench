import type { HostedExecutionBackend } from "../contracts/config/providers.js";
import { managedE2BTemplateReference } from "./providers/e2b/managed-template.js";

/**
 * Worker configuration that selects a provider's sandbox runtime. Modal always builds from
 * Dockerfile.sandbox, E2B defaults to the managed template built from it, and Vercel runs an
 * image published from it.
 */
export function sandboxImageEnvironment(
  backend: HostedExecutionBackend,
  image: string | undefined,
): Record<string, string> {
  switch (backend) {
    case "modal":
      return {};
    case "vercel":
      return image ? { SELFBENCH_VERCEL_IMAGE: image } : {};
    case "e2b":
      return { SELFBENCH_E2B_TEMPLATE: image ?? managedE2BTemplateReference() };
  }
}
