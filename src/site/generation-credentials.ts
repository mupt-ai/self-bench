import { isDeepStrictEqual } from "node:util";
import { readAccount, secretPath } from "../evaluation/account.js";
import type { EncryptedRecordStore } from "../evaluation/encrypted-records.js";
import { orgRecords } from "../evaluation/org-records.js";
import { HARBOR_E2B_API_KEY, HARBOR_VERCEL_CREDENTIALS } from "../harbor-environment.js";
import {
  executionBackendLabels,
  type HostedExecutionBackend,
  type HostedHarborEnvironment,
  harborEnvironmentLabels,
} from "../providers.js";
import type { GenerationReference, GenerationSettings } from "./generation-settings.js";
import { generationSubscriptionAuth } from "./generation-subscription.js";

type ProviderCredential =
  | { role: "sandbox"; id: string | undefined; kind: HostedExecutionBackend }
  | { role: "harbor"; id: string | undefined; kind: HostedHarborEnvironment };

const credentialLabels = { ...harborEnvironmentLabels, ...executionBackendLabels };
const VERCEL_SANDBOX_CREDENTIALS = {
  VERCEL_TOKEN: "VERCEL_TOKEN",
  VERCEL_TEAM_ID: "VERCEL_TEAM_ID",
  VERCEL_PROJECT_ID: "VERCEL_PROJECT_ID",
} as const;

/** The generation sandbox credential plus, for hosted-only backends, the separate Harbor credential. */
function sandboxCredentials(settings: GenerationSettings): ProviderCredential[] {
  const credentials: ProviderCredential[] = [
    { role: "sandbox", id: settings.sandboxCredentialId, kind: settings.sandbox },
  ];
  if ((settings.sandbox === "e2b" || settings.sandbox === "vercel") && settings.harborEnvironment)
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
export function generationGitHubTokenPath(runId: string) {
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

export async function checkGenerationCredentials(
  records: EncryptedRecordStore,
  ownerId: number,
  settings: GenerationSettings,
) {
  const account = await readAccount(records, ownerId);
  const model = account.credentials.find(
    (item) => item.id === settings.modelCredentialId && !item.deleted,
  );
  if (model?.kind !== "openai" || !["api-key", "codex-login"].includes(model.auth))
    throw new Error("Choose an OpenAI credential from your credentials.");
  for (const { id, kind } of sandboxCredentials(settings)) {
    const sandbox = account.credentials.find((item) => item.id === id && !item.deleted);
    if (sandbox?.kind !== kind || sandbox.auth !== "api-key")
      throw new Error(`Choose a ${credentialLabels[kind]} credential from your account.`);
  }
  return model;
}

export async function generationEnvironment(
  records: EncryptedRecordStore,
  runId: string,
  reference: GenerationReference,
  base: NodeJS.ProcessEnv,
) {
  const saved = await records.read<GenerationReference>(generationRecordPath(runId));
  if (!saved || !isDeepStrictEqual(saved.value, reference))
    throw new Error("Generation does not match its saved configuration.");
  const github = await records.read<{ value: string }>(generationGitHubTokenPath(runId));
  records = orgRecords(records, reference.orgId);
  const credential = await checkGenerationCredentials(
    records,
    reference.ownerId,
    reference.settings,
  );
  const model = await records.read<{ value: string }>(
    secretPath(reference.ownerId, reference.settings.modelCredentialId),
  );
  if (!model?.value.value) throw new Error("Model credential is unavailable.");
  const env: NodeJS.ProcessEnv = { ...base };
  delete env.OPENAI_API_KEY;
  delete env.SELFBENCH_PI_AUTH_JSON;
  if (github?.value.value) env.GH_TOKEN = github.value.value;
  if (credential.auth === "codex-login")
    env.SELFBENCH_PI_AUTH_JSON = generationSubscriptionAuth(model.value.value);
  else env.OPENAI_API_KEY = model.value.value;
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
    HARBOR_E2B_API_KEY,
    ...Object.values(HARBOR_VERCEL_CREDENTIALS),
  ])
    delete env[key];
  for (const { role, id, kind } of sandboxCredentials(reference.settings)) {
    const sandbox = await records.read<{
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
      env[role === "harbor" ? HARBOR_E2B_API_KEY : "E2B_API_KEY"] = secret.value;
    } else if (kind === "daytona") {
      env.DAYTONA_API_KEY = secret.value;
    } else {
      if (!secret.teamId || !secret.projectId) throw new Error("Vercel credential is unavailable.");
      const names = role === "harbor" ? HARBOR_VERCEL_CREDENTIALS : VERCEL_SANDBOX_CREDENTIALS;
      env[names.VERCEL_TOKEN] = secret.value;
      env[names.VERCEL_TEAM_ID] = secret.teamId;
      env[names.VERCEL_PROJECT_ID] = secret.projectId;
    }
  }
  return env;
}
