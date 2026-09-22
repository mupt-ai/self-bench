import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { managedModelKey, managedSandboxCredentials } from "../site/managed-generation.js";
import { readAccount, secretPath } from "./account.js";
import { validateEndpoint } from "./credentials.js";
import type { EncryptedRecordStore } from "./encrypted-records.js";
import { orgRecords } from "./org-records.js";
import type { EvaluationInput } from "./types.js";

export async function credentialExecution(
  input: EvaluationInput,
  home: string,
  env: NodeJS.ProcessEnv,
  records: EncryptedRecordStore,
) {
  if (!input.credentials || !input.credentialOwnerId || !input.comparisonId)
    throw new Error("Credential references missing");
  records = orgRecords(records, input.credentialOrgId);
  const account = await readAccount(records, input.credentialOwnerId);
  const saved = account.comparisons
    .find((entry) => entry.id === input.comparisonId && entry.repoId === input.repoId)
    ?.inputs.find((entry) => entry.id === input.id);
  if (!saved || !isDeepStrictEqual(saved, input))
    throw new Error("Execution does not match the reserved comparison");
  const managedModel = input.credentials.modelCredentialId === "managed-model";
  const managedSandbox = input.credentials.sandboxCredentialId === "managed-sandbox";
  const info = managedModel
    ? { id: "managed-model", kind: "openrouter" as const, auth: "api-key" as const }
    : account.credentials.find(
        (entry) => entry.id === input.credentials?.modelCredentialId && !entry.deleted,
      );
  const sandbox = managedSandbox
    ? { id: "managed-sandbox", kind: "e2b" as const }
    : account.credentials.find(
        (entry) => entry.id === input.credentials?.sandboxCredentialId && !entry.deleted,
      );
  if (
    !info ||
    !sandbox ||
    sandbox.kind !== input.sandbox ||
    info.kind !== input.credentials.provider
  )
    throw new Error("Credential unavailable");
  const modelSecret = managedModel
    ? managedModelKey(env)
    : (await records.read<{ value: string }>(secretPath(input.credentialOwnerId, info.id)))?.value
        .value;
  const managedE2B = managedSandbox ? managedSandboxCredentials(env) : undefined;
  const sandboxSecret = managedE2B
    ? { value: managedE2B.apiKey }
    : (
        await records.read<{ value: string; tokenId?: string }>(
          secretPath(input.credentialOwnerId, sandbox.id),
        )
      )?.value;
  if (!modelSecret || !sandboxSecret) throw new Error("Credential unavailable");
  const child: NodeJS.ProcessEnv = {
    PATH: env.PATH,
    HOME: home,
    TMPDIR: home,
    LANG: "C.UTF-8",
    PYTHONUNBUFFERED: "1",
  };
  const secrets = [modelSecret, sandboxSecret.value, sandboxSecret.tokenId ?? ""].filter(Boolean);
  if (info.auth === "codex-login") {
    if (input.harnesses.some((harness) => harness !== "codex"))
      throw new Error("Codex login requires Codex harness");
    const authPath = join(home, "codex-auth.json");
    await writeFile(authPath, modelSecret, { mode: 0o600 });
    child.CODEX_AUTH_JSON_PATH = authPath;
    const auth = JSON.parse(modelSecret);
    secrets.push(
      ...Object.values(auth.tokens).filter((value): value is string => typeof value === "string"),
    );
  } else {
    const name =
      info.kind === "anthropic"
        ? "ANTHROPIC_API_KEY"
        : info.kind === "openrouter"
          ? "OPENROUTER_API_KEY"
          : "OPENAI_API_KEY";
    child[name] = modelSecret;
  }
  if (info.kind === "custom")
    child.OPENAI_BASE_URL = await validateEndpoint(info.endpoint ?? "", env);
  if (sandbox.kind === "modal") {
    child.MODAL_TOKEN_ID = sandboxSecret.tokenId;
    child.MODAL_TOKEN_SECRET = sandboxSecret.value;
  } else if (sandbox.kind === "e2b") {
    child.E2B_API_KEY = sandboxSecret.value;
    if (managedE2B?.domain) child.E2B_DOMAIN = managedE2B.domain;
  } else if (sandbox.kind === "daytona") child.DAYTONA_API_KEY = sandboxSecret.value;
  return { profile: { model: input.modelName }, child, secrets };
}
