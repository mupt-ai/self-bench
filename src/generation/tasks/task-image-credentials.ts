import type { TaskImages } from "../../contracts/index.js";
import type { Vault } from "../../db/vault.js";
import {
  providerCredentialEnvironment,
  providerEnvironment,
} from "../../sandbox/provider-environment.js";
import { managedModalEnvironment, managedSandboxCredentials } from "../billing/managed.js";
import { generationRecordPath } from "../settings/credentials.js";
import type { GenerationReference } from "../settings/settings.js";

/** Resolve only the original verification account; historical model access is irrelevant. */
export async function exportEnvironment(
  vault: Pick<Vault, "records" | "credentials">,
  runId: string,
  provider: TaskImages["provider"],
  base: NodeJS.ProcessEnv,
): Promise<NodeJS.ProcessEnv> {
  const saved = await vault.records.read<GenerationReference>(generationRecordPath(runId));
  if (!saved) throw new Error("Original generation configuration is missing");
  const reference = saved.value;
  const settings = reference.settings;
  const runtime = providerEnvironment(base, "docker");
  if (settings.sandbox === "managed") {
    if (provider === "modal") return { ...runtime, ...managedModalEnvironment(base) };
    if (provider !== "e2b") throw new Error("Unexpected managed verification provider");
    const secret = managedSandboxCredentials(base);
    return { ...runtime, E2B_API_KEY: secret.apiKey, E2B_DOMAIN: secret.domain };
  }
  const orgId = reference.orgId ?? reference.ownerId;
  const original = settings.harborEnvironment ?? settings.sandbox;
  if (original !== provider)
    throw new Error("Saved verification provider does not match the task's images");
  const id = settings.harborEnvironment
    ? settings.harborCredentialId
    : settings.sandboxCredentialId;
  if (!id) throw new Error("Original verification credential is missing");
  const credential = await vault.credentials.find(orgId, id);
  if (!credential || credential.kind !== provider || credential.auth !== "api-key")
    throw new Error("Original verification credential is unavailable");
  const secret = await vault.credentials.secret(orgId, id);
  if (!secret?.value) throw new Error("Original verification credential is unavailable");
  // Start from the runtime whitelist, not the worker's provider credentials or overrides.
  return { ...runtime, ...providerCredentialEnvironment(provider, secret) };
}

/**
 * The provider a run's own account verified its tasks on, read from its saved settings. Managed
 * runs stamp theirs on the run instead, so they are refused rather than guessed.
 */
export async function verificationProvider(
  vault: Pick<Vault, "records">,
  runId: string,
): Promise<TaskImages["provider"]> {
  const saved = await vault.records.read<GenerationReference>(generationRecordPath(runId));
  if (!saved) throw new Error("Original generation configuration is missing");
  const settings = saved.value.settings;
  if (settings.sandbox === "managed")
    throw new Error("Managed runs do not save their verification provider");
  return settings.harborEnvironment ?? settings.sandbox;
}
