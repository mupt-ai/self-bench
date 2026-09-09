import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
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
  const info = account.credentials.find(
    (entry) => entry.id === input.credentials?.modelCredentialId && !entry.deleted,
  );
  const sandbox = account.credentials.find(
    (entry) => entry.id === input.credentials?.sandboxCredentialId && !entry.deleted,
  );
  if (
    !info ||
    !sandbox ||
    sandbox.kind !== input.sandbox ||
    info.kind !== input.credentials.provider
  )
    throw new Error("Credential unavailable");
  const modelSecret = (
    await records.read<{ value: string }>(secretPath(input.credentialOwnerId, info.id))
  )?.value;
  const sandboxSecret = (
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
  const secrets = [modelSecret.value, sandboxSecret.value, sandboxSecret.tokenId ?? ""].filter(
    Boolean,
  );
  if (info.auth === "codex-login") {
    if (input.harnesses.some((harness) => harness !== "codex"))
      throw new Error("Codex login requires Codex harness");
    const authPath = join(home, "codex-auth.json");
    await writeFile(authPath, modelSecret.value, { mode: 0o600 });
    child.CODEX_AUTH_JSON_PATH = authPath;
    const auth = JSON.parse(modelSecret.value);
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
    child[name] = modelSecret.value;
  }
  if (info.kind === "custom")
    child.OPENAI_BASE_URL = await validateEndpoint(info.endpoint ?? "", env);
  if (sandbox.kind === "modal") {
    child.MODAL_TOKEN_ID = sandboxSecret.tokenId;
    child.MODAL_TOKEN_SECRET = sandboxSecret.value;
  } else if (sandbox.kind === "e2b") child.E2B_API_KEY = sandboxSecret.value;
  else if (sandbox.kind === "daytona") child.DAYTONA_API_KEY = sandboxSecret.value;
  return { profile: { model: input.modelName }, child, secrets };
}
