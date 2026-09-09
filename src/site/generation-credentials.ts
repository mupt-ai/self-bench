import { isDeepStrictEqual } from "node:util";
import { readAccount, secretPath } from "../evaluation/account.js";
import type { EncryptedRecordStore } from "../evaluation/encrypted-records.js";
import { orgRecords } from "../evaluation/org-records.js";
import type { GenerationReference, GenerationSettings } from "./generation-settings.js";

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
  if (model?.kind !== "openai" || model.auth !== "api-key")
    throw new Error("Choose an OpenAI API key from your credentials.");
  if (settings.sandbox === "modal") {
    const sandbox = account.credentials.find(
      (item) => item.id === settings.sandboxCredentialId && !item.deleted,
    );
    if (sandbox?.kind !== "modal") throw new Error("Choose a Modal credential from your account.");
  }
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
  await checkGenerationCredentials(records, reference.ownerId, reference.settings);
  const model = await records.read<{ value: string }>(
    secretPath(reference.ownerId, reference.settings.modelCredentialId),
  );
  if (!model?.value.value) throw new Error("Model credential is unavailable.");
  const env: NodeJS.ProcessEnv = { ...base, OPENAI_API_KEY: model.value.value };
  delete env.SELFBENCH_PI_AUTH_JSON;
  delete env.MODAL_TOKEN_ID;
  delete env.MODAL_TOKEN_SECRET;
  if (reference.settings.sandbox === "modal") {
    const sandbox = await records.read<{ value: string; tokenId?: string }>(
      secretPath(reference.ownerId, reference.settings.sandboxCredentialId ?? ""),
    );
    if (!sandbox?.value.value || !sandbox.value.tokenId)
      throw new Error("Modal credential is unavailable.");
    env.MODAL_TOKEN_ID = sandbox.value.tokenId;
    env.MODAL_TOKEN_SECRET = sandbox.value.value;
  }
  return env;
}
