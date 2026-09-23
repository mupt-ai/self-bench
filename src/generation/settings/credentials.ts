import { isDeepStrictEqual } from "node:util";
import {
  executionBackendLabels,
  type HostedExecutionBackend,
  type HostedHarborEnvironment,
  harborEnvironmentLabels,
} from "../../contracts/config/providers.js";
import type { CredentialStore } from "../../db/credentials.js";
import type { EncryptedRecordStore } from "../../db/encrypted-records.js";
import type { Vault } from "../../db/vault.js";
import { generationSubscriptionAuth } from "../../harnesses/codex/subscription.js";
import { VERIFICATION_CREDENTIALS } from "../../sandbox/provider-environment.js";
import {
  type ManagedOffer,
  managedModelKey,
  managedOffer,
  managedSandboxCredentials,
} from "../billing/managed.js";
import { generationModelCredentialKinds, generationModelRoute } from "./models.js";
import type { GenerationReference, GenerationSettings } from "./settings.js";

type ProviderCredential =
  | { role: "sandbox"; id: string | undefined; kind: HostedExecutionBackend }
  | { role: "harbor"; id: string | undefined; kind: HostedHarborEnvironment };

const credentialLabels = { ...harborEnvironmentLabels, ...executionBackendLabels };
const VERCEL_SANDBOX_CREDENTIALS = {
  VERCEL_TOKEN: "VERCEL_TOKEN",
  VERCEL_TEAM_ID: "VERCEL_TEAM_ID",
  VERCEL_PROJECT_ID: "VERCEL_PROJECT_ID",
} as const;

/** The generation sandbox credential plus its separate Harbor credential. */
function sandboxCredentials(settings: GenerationSettings): ProviderCredential[] {
  const credentials: ProviderCredential[] = [];
  if (settings.sandbox !== "managed")
    credentials.push({ role: "sandbox", id: settings.sandboxCredentialId, kind: settings.sandbox });
  if (settings.sandbox !== "managed" && settings.harborEnvironment)
    credentials.push({
      role: "harbor",
      id: settings.harborCredentialId,
      kind: settings.harborEnvironment,
    });
  return credentials;
}

export function generationRecordPath(runId: string) {
  if (!/^[a-z0-9][a-z0-9-]{2,62}$/.test(runId)) throw new Error("Invalid generation run ID");
  return `generations/${runId}`;
}

/** The submitter's GitHub token for this run; the hosted worker has no GH_TOKEN of its own. */
function generationGitHubTokenPath(runId: string) {
  return `${generationRecordPath(runId)}/github-token`;
}

/** Persist the run's configuration and GitHub token before any paid work starts. */
export async function saveGenerationRecords(
  records: EncryptedRecordStore,
  runId: string,
  reference: GenerationReference,
  githubToken: string,
) {
  await records.write(generationRecordPath(runId), reference, 0);
  await records.write(generationGitHubTokenPath(runId), { value: githubToken }, 0);
}

/** The organization whose credentials a run uses. */
export function credentialOrg(reference: GenerationReference): number {
  return reference.orgId ?? reference.ownerId;
}

/** Validates the selected credentials; managed selections only require the offered flag. */
export async function checkGenerationCredentials(
  credentials: CredentialStore,
  orgId: number,
  settings: GenerationSettings,
  offer: ManagedOffer,
) {
  if (settings.modelAccess === "managed") {
    if (!offer.models) throw new Error("Managed models are not available on this deployment.");
  } else {
    const model = await credentials.find(orgId, settings.modelCredentialId ?? "");
    const compatible =
      model &&
      (model.kind === "openai"
        ? ["api-key", "codex-login"].includes(model.auth)
        : model.kind !== "custom" && model.auth === "api-key") &&
      generationModelCredentialKinds(settings.authorModel).includes(model.kind) &&
      generationModelCredentialKinds(settings.verifierModel).includes(model.kind);
    if (!compatible)
      throw new Error(
        "Choose a model credential that can run both the author and verifier models.",
      );
  }
  if (settings.sandbox === "managed" && !offer.sandbox)
    throw new Error("Managed sandboxes are not available on this deployment.");
  for (const { id, kind } of sandboxCredentials(settings)) {
    const sandbox = await credentials.find(orgId, id ?? "");
    if (sandbox?.kind !== kind || sandbox.auth !== "api-key")
      throw new Error(`Choose a ${credentialLabels[kind]} credential from your account.`);
  }
}

/** The Pi provider and provider-specific model id one stage's model invocation uses. */
export async function stageAuthoring(
  credentials: CredentialStore,
  reference: GenerationReference,
  stage: "author" | "verifier",
): Promise<{ provider: string; model: string; reasoningEffort: string }> {
  const settings = reference.settings;
  const model = stage === "verifier" ? settings.verifierModel : settings.authorModel;
  if (settings.modelAccess === "managed")
    return {
      provider: "openrouter",
      model: generationModelRoute(model, undefined).model,
      reasoningEffort: settings.reasoning,
    };
  const credential = await credentials.find(
    credentialOrg(reference),
    settings.modelCredentialId ?? "",
  );
  const route = generationModelRoute(model, {
    kind: credential?.kind ?? "",
    auth: credential?.auth ?? "api-key",
  });
  return { ...route, reasoningEffort: settings.reasoning };
}

/** Resolves this run's environment, including only the selected stage's model credential. */
export async function generationEnvironment(
  { records, credentials }: Pick<Vault, "records" | "credentials">,
  runId: string,
  reference: GenerationReference,
  base: NodeJS.ProcessEnv,
): Promise<NodeJS.ProcessEnv> {
  const saved = await records.read<GenerationReference>(generationRecordPath(runId));
  if (!saved || !isDeepStrictEqual(saved.value, reference))
    throw new Error("Generation does not match its saved configuration.");
  const orgId = credentialOrg(reference);
  await checkGenerationCredentials(credentials, orgId, reference.settings, managedOffer(base));
  const settings = reference.settings;
  const env: NodeJS.ProcessEnv = { ...base };
  delete env.OPENAI_API_KEY;
  delete env.ANTHROPIC_API_KEY;
  delete env.OPENROUTER_API_KEY;
  delete env.SELFBENCH_PI_AUTH_JSON;
  // The platform OpenRouter key is not a run credential: managed runs re-inject it under
  // its sandbox name below, and credential runs must resolve their own subscription auth.
  delete env.SELFBENCH_MANAGED_OPENROUTER_API_KEY;
  const github = await records.read<{ value: string }>(generationGitHubTokenPath(runId));
  if (github?.value.value) env.GH_TOKEN = github.value.value;
  // A worker's own provider credentials must never reach a generation sandbox.
  for (const key of [
    "MODAL_TOKEN_ID",
    "MODAL_TOKEN_SECRET",
    "E2B_API_KEY",
    "E2B_DOMAIN",
    "VERCEL_TOKEN",
    "VERCEL_TEAM_ID",
    "VERCEL_PROJECT_ID",
    "VERCEL_OIDC_TOKEN",
    "DAYTONA_API_KEY",
    ...Object.values(VERIFICATION_CREDENTIALS),
  ])
    delete env[key];
  // Model credential: managed platform access, or one stored credential per stage.
  if (settings.modelAccess === "managed") {
    env.OPENROUTER_API_KEY = managedModelKey(base);
  } else {
    const credential = await credentials.find(orgId, settings.modelCredentialId ?? "");
    const secret = credential && (await credentials.secret(orgId, credential.id))?.value;
    if (!credential || !secret) throw new Error("Model credential is unavailable.");
    if (credential.auth === "codex-login")
      env.SELFBENCH_PI_AUTH_JSON = generationSubscriptionAuth(secret);
    else
      env[
        credential.kind === "anthropic"
          ? "ANTHROPIC_API_KEY"
          : credential.kind === "openrouter"
            ? "OPENROUTER_API_KEY"
            : "OPENAI_API_KEY"
      ] = secret;
  }
  // Sandbox: the platform's managed E2B account, or one credential per role.
  if (settings.sandbox === "managed") {
    const managed = managedSandboxCredentials(base);
    env.E2B_API_KEY = managed.apiKey;
    if (managed.domain) env.E2B_DOMAIN = managed.domain;
  } else
    for (const { role, id, kind } of sandboxCredentials(settings)) {
      const secret = await credentials.secret(orgId, id ?? "");
      if (!secret?.value) throw new Error(`${credentialLabels[kind]} credential is unavailable.`);
      if (kind === "modal") {
        if (!secret.tokenId) throw new Error("Modal credential is unavailable.");
        env.MODAL_TOKEN_ID = secret.tokenId;
        env.MODAL_TOKEN_SECRET = secret.value;
      } else if (kind === "e2b") {
        env[role === "harbor" ? VERIFICATION_CREDENTIALS.E2B_API_KEY : "E2B_API_KEY"] =
          secret.value;
      } else if (kind === "daytona") {
        env.DAYTONA_API_KEY = secret.value;
      } else {
        if (!secret.teamId || !secret.projectId)
          throw new Error("Vercel credential is unavailable.");
        const names = role === "harbor" ? VERIFICATION_CREDENTIALS : VERCEL_SANDBOX_CREDENTIALS;
        env[names.VERCEL_TOKEN] = secret.value;
        env[names.VERCEL_TEAM_ID] = secret.teamId;
        env[names.VERCEL_PROJECT_ID] = secret.projectId;
      }
    }
  return env;
}
