import { isDeepStrictEqual } from "node:util";
import { readAccount, secretPath } from "../evaluation/account.js";
import type { EncryptedRecordStore } from "../evaluation/encrypted-records.js";
import { orgRecords } from "../evaluation/org-records.js";
import { executionBackendLabels } from "../providers.js";
import type { GenerationReference, GenerationSettings } from "./generation-settings.js";
import { generationSubscriptionAuth } from "./generation-subscription.js";

function sandboxCredentials(settings: GenerationSettings) {
  const credentials: { id: string | undefined; kind: "modal" | "e2b" | "vercel" }[] = [];
  if (settings.sandbox !== "docker")
    credentials.push({ id: settings.sandboxCredentialId, kind: settings.sandbox });
  if (
    (settings.sandbox === "e2b" || settings.sandbox === "vercel") &&
    settings.harborEnvironment === "modal"
  )
    credentials.push({ id: settings.harborCredentialId, kind: "modal" });
  return credentials;
}

export function generationRecordPath(runId: string) {
  if (!/^[a-z0-9][a-z0-9-]{2,62}$/.test(runId)) throw new Error("Invalid generation run ID");
  return `generations/${runId}`;
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
      throw new Error(`Choose a ${executionBackendLabels[kind]} credential from your account.`);
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
  ])
    delete env[key];
  for (const { id, kind } of sandboxCredentials(reference.settings)) {
    const sandbox = await records.read<{
      value: string;
      tokenId?: string;
      teamId?: string;
      projectId?: string;
    }>(secretPath(reference.ownerId, id ?? ""));
    const secret = sandbox?.value;
    if (!secret?.value)
      throw new Error(`${executionBackendLabels[kind]} credential is unavailable.`);
    if (kind === "modal") {
      if (!secret.tokenId) throw new Error("Modal credential is unavailable.");
      env.MODAL_TOKEN_ID = secret.tokenId;
      env.MODAL_TOKEN_SECRET = secret.value;
    } else if (kind === "e2b") {
      env.E2B_API_KEY = secret.value;
    } else {
      if (!secret.teamId || !secret.projectId) throw new Error("Vercel credential is unavailable.");
      env.VERCEL_TOKEN = secret.value;
      env.VERCEL_TEAM_ID = secret.teamId;
      env.VERCEL_PROJECT_ID = secret.projectId;
    }
  }
  return env;
}
