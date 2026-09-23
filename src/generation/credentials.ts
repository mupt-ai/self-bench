import { isDeepStrictEqual } from "node:util";
import {
  executionBackendLabels,
  type HostedExecutionBackend,
  type HostedHarborEnvironment,
  harborEnvironmentLabels,
} from "../contracts/config/providers.js";
import type { EncryptedRecordStore } from "../db/encrypted-records.js";
import { type CredentialInfo, readAccount, secretPath } from "../evaluation/account.js";
import { orgRecords } from "../evaluation/org-records.js";
import { generationSubscriptionAuth } from "../harnesses/codex/subscription.js";
import { VERIFICATION_CREDENTIALS } from "../sandbox/provider-environment.js";
import {
  type ManagedOffer,
  managedModelKey,
  managedOffer,
  managedSandboxCredentials,
} from "./managed/generation.js";
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

/** The stored credential backing the models; undefined under managed model access. */
function stageCredential(settings: GenerationSettings): string | undefined {
  return settings.modelAccess === "managed" ? undefined : settings.modelCredentialId;
}

/** Validates the selected credentials; managed selections only require the offered flag. */
export async function checkGenerationCredentials(
  records: EncryptedRecordStore,
  ownerId: number,
  settings: GenerationSettings,
  offer: ManagedOffer,
) {
  if (settings.modelAccess === "managed") {
    if (!offer.models) throw new Error("Managed models are not available on this deployment.");
  } else {
    const account = await readAccount(records, ownerId);
    const model = account.credentials.find(
      (item) => item.id === settings.modelCredentialId && !item.deleted,
    );
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
    const account = await readAccount(records, ownerId);
    const sandbox = account.credentials.find((item) => item.id === id && !item.deleted);
    if (sandbox?.kind !== kind || sandbox.auth !== "api-key")
      throw new Error(`Choose a ${credentialLabels[kind]} credential from your account.`);
  }
}

/** The Pi provider and provider-specific model id one stage's model invocation uses. */
export async function stageAuthoring(
  records: EncryptedRecordStore,
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
  const account = await readAccount(records, reference.ownerId);
  const credential = account.credentials.find(
    (item) => item.id === settings.modelCredentialId && !item.deleted,
  );
  const route = generationModelRoute(model, {
    kind: credential?.kind ?? "",
    auth: credential?.auth ?? "api-key",
  });
  return { ...route, reasoningEffort: settings.reasoning };
}

/** Resolves this run's environment, including only the selected stage's model credential. */
export async function generationStageEnvironment(
  records: EncryptedRecordStore,
  runId: string,
  reference: GenerationReference,
  base: NodeJS.ProcessEnv,
): Promise<NodeJS.ProcessEnv> {
  const saved = await records.read<GenerationReference>(generationRecordPath(runId));
  if (!saved || !isDeepStrictEqual(saved.value, reference))
    throw new Error("Generation does not match its saved configuration.");
  const scoped = reference.orgId ? orgRecords(records, reference.orgId) : records;
  await checkGenerationCredentials(
    scoped,
    reference.ownerId,
    reference.settings,
    managedOffer(base),
  );
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
    const credential = await readModelCredential(scoped, reference);
    if (credential.auth === "codex-login")
      env.SELFBENCH_PI_AUTH_JSON = generationSubscriptionAuth(credential.secret);
    else
      env[
        credential.kind === "anthropic"
          ? "ANTHROPIC_API_KEY"
          : credential.kind === "openrouter"
            ? "OPENROUTER_API_KEY"
            : "OPENAI_API_KEY"
      ] = credential.secret;
  }
  // Sandbox: the platform's managed E2B account, or one credential per role.
  if (settings.sandbox === "managed") {
    const managed = managedSandboxCredentials(base);
    env.E2B_API_KEY = managed.apiKey;
    if (managed.domain) env.E2B_DOMAIN = managed.domain;
  } else
    for (const { role, id, kind } of sandboxCredentials(settings)) {
      const sandbox = await scoped.read<{
        value: string;
        tokenId?: string;
        teamId?: string;
        projectId?: string;
      }>(secretPath(reference.ownerId, id ?? ""));
      const secret = sandbox?.value;
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

async function readModelCredential(
  records: EncryptedRecordStore,
  reference: GenerationReference,
): Promise<{ kind: CredentialInfo["kind"]; auth: CredentialInfo["auth"]; secret: string }> {
  const settings = reference.settings;
  const id = stageCredential(settings);
  const saved = (await readAccount(records, reference.ownerId)).credentials.find(
    (item) => item.id === id && !item.deleted,
  );
  if (!saved) throw new Error("Model credential is unavailable.");
  const secret = await records.read<{ value: string }>(secretPath(reference.ownerId, saved.id));
  if (!secret?.value.value) throw new Error("Model credential is unavailable.");
  return { kind: saved.kind, auth: saved.auth, secret: secret.value.value };
}

/** Legacy-shaped wrapper: resolves the author stage's environment. */
export async function generationEnvironment(
  records: EncryptedRecordStore,
  runId: string,
  reference: GenerationReference,
  base: NodeJS.ProcessEnv,
): Promise<NodeJS.ProcessEnv> {
  return await generationStageEnvironment(records, runId, reference, base);
}
