import type { SelfBenchWorkerConfig } from "../contracts/config/index.js";
import type { HostedExecutionBackend } from "../contracts/config/providers.js";
import type { EncryptedRecordStore } from "../db/encrypted-records.js";
import {
  ensureManagedE2BTemplate,
  managedE2BTemplateReference,
} from "./providers/e2b/managed-template.js";

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

/** The provider account a runtime is built in, and the store holding its build lock. */
export interface SandboxRuntimeOwner {
  readonly credentialId: string | undefined;
  readonly records: EncryptedRecordStore;
  /** Called on every wait poll and build log so activities can heartbeat. */
  readonly onLog?: (message: string) => void;
  readonly signal?: AbortSignal;
}

/**
 * Make the runtime exist before the first sandbox boots from it. Only the managed E2B template
 * is built on demand; Modal builds its image itself and Vercel's is published ahead of time.
 */
export async function prepareSandboxRuntime(
  execution: SelfBenchWorkerConfig["execution"],
  owner: () => SandboxRuntimeOwner,
): Promise<void> {
  if (execution.kind !== "e2b" || execution.image !== managedE2BTemplateReference()) return;
  const { credentialId, ...build } = owner();
  if (!credentialId)
    throw new Error("Managed E2B template build is not configured on this worker.");
  await ensureManagedE2BTemplate({
    reference: execution.image,
    credentials: execution.credentials,
    credentialId,
    ...build,
  });
}
